import Array "mo:core/Array";
import Error "mo:core/Error";
import Map "mo:core/Map";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
import Capabilities "../../backend/capabilities/Types";
import IcrcLedger "../../backend/history/IcrcLedger";
import IcrcTypes "../../backend/icrc1/Types";
import Main "../../backend/main";
import WalletMemory "../../backend/memory/wallet/v1";
import ActivityMemory "../../backend/memory/wallet_bridge_activity/v1";
import BridgeMemory "../../backend/memory/wallet_bridge/v1";
import ProviderMemory "../../backend/memory/wallet_bridge_provider/v1";
import ReplacementMemory "../../backend/memory/wallet_bridge_replacements/v1";
import CommandMemory "../../backend/memory/wallet_commands/v1";
import TransferMemory "../../backend/memory/wallet_transfers/v1";

persistent actor Self {
    transient let first = Principal.fromBlob("\01\01");
    transient let second = Principal.fromBlob("\02\01");
    transient let unreserved = Principal.fromBlob("\03\01");
    transient let btc = Principal.fromText("mxzaz-hqaaa-aaaar-qaada-cai");
    transient let btcMinter = Principal.fromText("mqygn-kiaaa-aaaar-qaadq-cai");
    transient let memory = WalletMemory.init();
    transient var dispatched : [Capabilities.CallRequest] = [];

    func balance(principal : Principal) : Nat {
        if (principal == first) 9_007_199_254_740_993_123_456_789_012_345
        else if (principal == second) 17
        else if (principal == btc) 81_234_567
        else Runtime.trap("Unexpected balance target");
    };

    func call(request : Capabilities.CallRequest) : async* Capabilities.CallResult {
        assert request.canister != unreserved;
        assert request.cycles == 0;
        dispatched := Array.concat(dispatched, [request]);
        switch (request.method) {
            case ("icrc1_metadata") {
                let metadata : IcrcTypes.Metadata = [
                    ("icrc1:name", #Text("Test token")),
                    ("icrc1:symbol", #Text(if (request.canister == btc) "ckBTC" else "TEST")),
                    ("icrc1:decimals", #Nat(8)),
                    ("icrc1:fee", #Nat(10)),
                ];
                #ok(to_candid (metadata));
            };
            case ("icrc1_balance_of") {
                let ?account = (from_candid (request.args) : ?IcrcTypes.Account)
                    else Runtime.trap("Invalid balance request");
                assert account.owner == Principal.fromActor(Self);
                assert account.subaccount == null;
                #ok(to_candid (balance(request.canister)));
            };
            case ("icrc3_get_blocks") {
                let ?args = (from_candid (request.args) : ?[IcrcLedger.GetBlocksArg])
                    else Runtime.trap("Invalid history request");
                assert args == [{ start = 0; length = 0 }];
                let reply : IcrcLedger.GetBlocksReply = {
                    log_length = 100; blocks = []; archived_blocks = [];
                };
                #ok(to_candid (reply));
            };
            case ("get_btc_address") {
                assert request.canister == btcMinter;
                #ok(to_candid ("bc1qtestwalletdepositaddress" : Text));
            };
            case ("get_account_transactions") {
                // The native token's index can be temporarily behind without
                // losing its selection, metadata, balance, or deposit address.
                #err({ code = "temporarily_unavailable"; message = "Index catching up" });
            };
            case (_) Runtime.trap("Adding a ledger must not dispatch financial calls: " # request.method);
        };
    };

    transient let calls : Capabilities.BackendCalls = {
        canister_principal = Principal.fromActor(Self);
        can_call = func(target : Principal, _method : Text) : Bool {
            target != unreserved;
        };
        call;
        call_batch = func(requests : [Capabilities.CallRequest]) : async* [Capabilities.CallResult] {
            var results : [Capabilities.CallResult] = [];
            for (request in requests.vals()) {
                results := Array.concat(results, [await* call(request)]);
            };
            results;
        };
    };
    transient let env : Main.AppBackendEnvironment = {
        stable_memory = {
            wallet = memory; wallet_commands = CommandMemory.init();
            wallet_transfers = TransferMemory.init(); wallet_bridge = BridgeMemory.init();
            wallet_bridge_replacements = ReplacementMemory.init();
            wallet_bridge_provider = ProviderMemory.init(); wallet_bridge_activity = ActivityMemory.init();
        };
        capabilities = { backend_calls = calls };
        app_calls = { contacts = {
            contacts_discover_v1 = func(_request : Main.DiscoverContactsRequestV1) : Main.DiscoverContactsResultV1 {
                Runtime.trap("Adding a ledger does not need Contacts");
            };
        } };
    };

    func selected(snapshot : Main.WalletSnapshot, principal : Principal) : Main.LedgerView {
        var found : ?Main.LedgerView = null;
        for (ledger in snapshot.ledgers.vals()) {
            if (ledger.principal == principal) {
                assert found == null;
                found := ?ledger;
            };
        };
        switch (found) { case (?value) value; case null Runtime.trap("Selected ledger disappeared") };
    };

    // Use an IC message boundary to observe the backend's existing reservation
    // trap and verify that a rejected addition leaves the durable root intact.
    public func addUnreserved() : async () {
        ignore await* Main.Init(env).wallet_add_ledger_v1(unreserved);
    };

    public func run() : async () {
        let app = Main.Init(env);
        let defaults = app.wallet_snapshot(());
        assert defaults.configured and defaults.ledgers.size() == 3;
        assert dispatched.size() == 0;
        let initial = await* app.wallet_set_ledgers([first]);
        assert initial.configured and initial.ledgers.size() == 1;
        let original = selected(initial, first);
        assert original.balance == ?balance(first);
        assert original.metadata_error == null and original.balance_error == null;

        let added = await* app.wallet_add_ledger_v1(second);
        assert added.ledgers.size() == 2;
        assert selected(added, first).id == original.id;
        assert selected(added, first).balance == original.balance;
        assert selected(added, second).balance == ?17;
        let ?oldLedger = Map.get(memory.ledgers, Principal.compare, first)
            else Runtime.trap("Original durable ledger disappeared");
        assert oldLedger.history.checkpoint != null;
        assert Map.size(oldLedger.history.adjustments) == 1;

        let native = await* app.wallet_add_ledger_v1(btc);
        assert native.ledgers.size() == 3;
        assert selected(native, btc).native_address == ?"bc1qtestwalletdepositaddress";
        assert selected(native, btc).balance == ?balance(btc);
        assert selected(native, first).balance == original.balance;
        assert selected(native, second).balance == ?17;

        let count = dispatched.size();
        let nextId = memory.next_id;
        let metadataEpoch = memory.metadata_epoch;
        let balanceEpoch = memory.balance_epoch;
        let nativeEpoch = memory.native_epoch;
        // Rebuild over the released roots, then replay the same additions.
        // Neither action may refresh metadata/history or allocate another ID.
        let restored = Main.Init(env);
        assert restored.wallet_snapshot(()) == native;
        assert (await* restored.wallet_add_ledger_v1(second)) == native;
        assert (await* restored.wallet_add_ledger_v1(btc)) == native;
        assert dispatched.size() == count;
        assert memory.next_id == nextId;
        assert memory.metadata_epoch == metadataEpoch;
        assert memory.balance_epoch == balanceEpoch;
        assert memory.native_epoch == nativeEpoch;

        var rejected = false;
        try { await Self.addUnreserved() } catch (error) {
            rejected := true;
            assert Text.contains(Error.message(error), #text("Ledger is not reserved for Wallet"));
        };
        assert rejected;
        assert Main.Init(env).wallet_snapshot(()) == native;
        switch (Map.get(memory.ledgers, Principal.compare, unreserved)) {
            case null {};
            case (?_) Runtime.trap("Unreserved ledger was retained");
        };
        assert memory.next_id == nextId;
        assert dispatched.size() == count;
    };
};
