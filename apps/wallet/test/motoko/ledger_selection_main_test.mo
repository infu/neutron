import RefillMemory "../../backend/memory/wallet_refills/v1";
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
    transient var excludedCustody : ?Principal = null;
    transient var revokeLedgerOnAddress = false;

    func minterCalls() : Nat {
        var count = 0;
        for (request in dispatched.vals()) {
            if (request.canister == btcMinter) count += 1;
        };
        count;
    };

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
                if (revokeLedgerOnAddress) {
                    revokeLedgerOnAddress := false;
                    excludedCustody := ?btc;
                };
                #ok(to_candid ("bc1qtestwalletdepositaddress" : Text));
            };
            case ("update_balance") {
                assert request.canister == btcMinter;
                let result : { #Err : { #AlreadyProcessing } } = #Err(#AlreadyProcessing);
                #ok(to_candid(result));
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
        owns_principal = func(target : Principal) : Bool { target != unreserved and excludedCustody != ?target };
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
        stable_memory = { wallet_refills = RefillMemory.init();
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
        assert defaults.configured and defaults.ledgers.size() == 4;
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

        // The scheduled task receives its own capability object. The normal
        // app environment remains authorized, so using it accidentally would
        // dispatch network calls despite this task's missing principal grant.
        let unownedTaskCalls : Capabilities.BackendCalls = {
            calls with
            owns_principal = func(_ : Principal) : Bool { false };
            can_call = func(_ : Principal, _ : Text) : Bool { true };
        };
        for (ledger in Map.values(memory.ledgers)) {
            if (ledger.enabled) ledger.history.last_attempt_at := null;
        };
        let beforeTask = dispatched.size();
        await* restored.wallet_history_tick((), { backend_calls = unownedTaskCalls });
        assert dispatched.size() == beforeTask;
        for (ledger in Map.values(memory.ledgers)) {
            if (ledger.enabled) ledger.history.last_attempt_at := null;
        };
        await* restored.wallet_history_tick((), { backend_calls = calls });
        assert dispatched.size() > beforeTask;

        // Deposit discovery and mint refresh each require ownership of the
        // destination ledger and its minter. Exact calls remain authorized.
        let ?btcLedger = Map.get(memory.ledgers, Principal.compare, btc)
            else Runtime.trap("Selected Bitcoin ledger disappeared");
        let savedProgress : WalletMemory.NativeDepositProgress = {
            checked_at = 123;
            current_confirmations = ?1; required_confirmations = ?6;
            pending = [{ txid = "retained-deposit"; vout = 0; value = 12_345; confirmations = 1; required_confirmations = 6 }];
            processing = []; recent_minted = []; issues = [];
        };
        Map.add(memory.ledgers, Principal.compare, btc, {
            btcLedger with native_address = null; native_address_updated_at = ?111;
            native_refresh_updated_at = ?123; native_deposit_progress = ?savedProgress;
        });
        let beforeDeniedDeposits = minterCalls();
        for (missing in [btc, btcMinter].vals()) {
            excludedCustody := ?missing;
            assert calls.can_call(btcMinter, "get_btc_address") and calls.can_call(btcMinter, "update_balance");
            assert calls.owns_principal(if (missing == btc) btcMinter else btc);
            let denied = selected((await* restored.wallet_refresh_deposits(())).snapshot, btc);
            assert minterCalls() == beforeDeniedDeposits;
            assert denied.native_address == null and denied.native_address_updated_at == ?111;
            assert denied.native_refresh_updated_at == ?123 and denied.native_deposit_progress == ?savedProgress;
            assert denied.id == btcLedger.id and denied.balance == btcLedger.balance;
            assert denied.native_address_error != null and denied.native_refresh_error != null;
        };
        excludedCustody := null;
        let recovered = selected((await* restored.wallet_refresh_deposits(())).snapshot, btc);
        assert minterCalls() == beforeDeniedDeposits + 2;
        assert recovered.native_address == ?"bc1qtestwalletdepositaddress";
        assert recovered.native_address_error == null;
        assert recovered.native_refresh_error == ?"Minter is already checking this address";
        assert recovered.native_refresh_updated_at == ?123 and recovered.native_deposit_progress == ?savedProgress;

        // Losing the destination while the minter replies cannot publish that
        // newly discovered address or proceed to the update_balance mint call.
        let ?beforeRevocation = Map.get(memory.ledgers, Principal.compare, btc)
            else Runtime.trap("Bitcoin ledger disappeared after refresh");
        Map.add(memory.ledgers, Principal.compare, btc, { beforeRevocation with native_address = null });
        let beforeRevocationCalls = minterCalls();
        revokeLedgerOnAddress := true;
        let revoked = selected((await* restored.wallet_refresh_deposits(())).snapshot, btc);
        assert excludedCustody == ?btc;
        assert calls.owns_principal(btcMinter);
        assert minterCalls() == beforeRevocationCalls + 1;
        assert revoked.native_address == null;
        assert revoked.native_address_updated_at == beforeRevocation.native_address_updated_at;
        assert revoked.native_refresh_updated_at == ?123 and revoked.native_deposit_progress == ?savedProgress;
        let ?addressError = revoked.native_address_error else Runtime.trap("Revoked deposit address lacked an error");
        assert Text.contains(addressError, #text("changed"));
        assert revoked.native_refresh_error != null;
    };
};
