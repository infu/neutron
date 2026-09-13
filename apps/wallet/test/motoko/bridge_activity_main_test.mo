import RefillMemory "../../backend/memory/wallet_refills/v1";
import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Map "mo:core/Map";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Capabilities "../../backend/capabilities/Types";
import Main "../../backend/main";
import WalletMemory "../../backend/memory/wallet/v1";
import BridgeMemory "../../backend/memory/wallet_bridge/v1";
import ActivityMemory "../../backend/memory/wallet_bridge_activity/v1";
import ProviderMemory "../../backend/memory/wallet_bridge_provider/v1";
import ReplacementMemory "../../backend/memory/wallet_bridge_replacements/v1";
import CommandMemory "../../backend/memory/wallet_commands/v1";
import TransferMemory "../../backend/memory/wallet_transfers/v1";

persistent actor {
    public func run() : async () {
        let eth = Principal.fromText("ss2fx-dyaaa-aaaar-qacoq-cai");
        let usdc = Principal.fromText("xevnm-gaaaa-aaaar-qafnq-cai");
        func id(byte : Nat8) : Blob { Blob.fromArray(Array.repeat<Nat8>(byte, 16)) };
        func ok(result : Main.WalletBridgeIntentResultV1) : BridgeMemory.Intent {
            switch (result) { case (#ok(value)) value; case (#err(error)) Runtime.trap(error) };
        };
        let bridge = BridgeMemory.init();
        let activity = ActivityMemory.init();
        let approvalHash = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let depositHash = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        // Seed exactly the released v1 shape: approval succeeded but the browser
        // lost the deposit outcome. No migration may reclassify that payment.
        let approved : BridgeMemory.Intent = {
            id = id(1);
            quote = {
                chain_id = 1; ledger = usdc;
                minter = Principal.fromText("sv3dd-oaaaa-aaaar-qacoa-cai");
                helper_address = "0x1111111111111111111111111111111111111111";
                helper_mode = #subaccount;
                minter_address = "0x2222222222222222222222222222222222222222";
                token_address = ?"0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
                recipient = Principal.fromText("aaaaa-aa");
                principal_word = "0x0000000000000000000000000000000000000000000000000000000000000000";
                subaccount_word = "0x0000000000000000000000000000000000000000000000000000000000000000";
            };
            source = #evm; account = "0x3333333333333333333333333333333333333333";
            amount = 3_000_000; subaccount = null;
            steps = [
                { kind = #reset_approval; state = #ready; operation_id = null; transaction_hash = null; error = null },
                { kind = #approval; state = #confirmed; operation_id = ?"saved-approval"; transaction_hash = ?approvalHash; error = null },
                { kind = #deposit; state = #unknown; operation_id = ?"saved-deposit"; transaction_hash = null; error = ?"Ethereum RPC unavailable" },
            ];
            revision = 7; created_at = 10_000; updated_at = 10_100;
            event_cursor = 5_000; accepted_deposit = null; mint = null;
            error = ?"Could not check Ethereum";
        };
        let other : BridgeMemory.Intent = {
            approved with id = id(2); quote = { approved.quote with ledger = eth; token_address = null };
        };
        Map.add(bridge.intents, Blob.compare, approved.id, approved);
        Map.add(bridge.intents, Blob.compare, other.id, other);
        let noCalls : Capabilities.BackendCalls = {
            canister_principal = Principal.fromText("aaaaa-aa");
            owns_principal = func(_ : Principal) : Bool { false };
            can_call = func(_ : Principal, _ : Text) : Bool { Runtime.trap("Activity cannot need network permissions") };
            call = func(_ : Capabilities.CallRequest) : async* Capabilities.CallResult { Runtime.trap("Activity cannot call Ethereum, minters or ledgers") };
            call_batch = func(_ : [Capabilities.CallRequest]) : async* [Capabilities.CallResult] { Runtime.trap("Activity cannot send a call batch") };
        };
        let env : Main.AppBackendEnvironment = {
            stable_memory = { wallet_refills = RefillMemory.init();
                wallet = WalletMemory.init(); wallet_commands = CommandMemory.init();
                wallet_transfers = TransferMemory.init(); wallet_bridge = bridge;
                wallet_bridge_replacements = ReplacementMemory.init();
                wallet_bridge_provider = ProviderMemory.init(); wallet_bridge_activity = activity;
            };
            capabilities = { backend_calls = noCalls };
            app_calls = { contacts = { contacts_discover_v1 = func(_ : Main.DiscoverContactsRequestV1) : Main.DiscoverContactsResultV1 {
                Runtime.trap("Activity cannot need a contact or wallet connection");
            } } };
        };
        let app = Main.Init(env);
        assert (app.wallet_bridge_activity_v1({ ledger = null }).records == []);
        assert (ok(app.wallet_bridge_step_v2(#dismiss({ id = approved.id; dismissed = true }))) == approved);
        assert (ok(app.wallet_bridge_status_v1(approved.id)) == approved);
        assert (Map.size(bridge.intents) == 2);
        let first = app.wallet_bridge_activity_v1({ ledger = ?usdc }).records;
        assert (first.size() == 1 and first[0].id == approved.id and first[0].dismissed_at > 0);
        assert (app.wallet_bridge_activity_v1({ ledger = ?eth }).records == []);

        // A dismissal retried hours later must retain its original timestamp.
        Map.add(activity.dismissed, Blob.compare, approved.id, 123 : Int);
        let restored = Main.Init(env);
        assert (ok(restored.wallet_bridge_step_v2(#dismiss({ id = approved.id; dismissed = true }))) == approved);
        assert (restored.wallet_bridge_activity_v1({ ledger = ?usdc }).records == [{ id = approved.id; dismissed_at = 123 }]);
        assert (ok(restored.wallet_bridge_step_v2(#dismiss({ id = other.id; dismissed = true }))) == other);
        assert (restored.wallet_bridge_activity_v1({ ledger = null }).records.size() == 2);
        assert (restored.wallet_bridge_activity_v1({ ledger = ?eth }).records.size() == 1);
        for (dismissed in [true, false].vals()) {
            switch (restored.wallet_bridge_step_v2(#dismiss({ id = id(99); dismissed }))) {
                case (#err(_)) {};
                case (_) Runtime.trap("An unknown operation must not gain an activity marker");
            };
        };
        assert (Map.size(activity.dismissed) == 2);

        // A late already-dispatched financial result still updates its exact
        // journal, but cannot resurrect a reminder the owner dismissed.
        let updated = ok(restored.wallet_bridge_step_v2(#record({
            id = approved.id; revision = approved.revision; step = #deposit;
            state = #submitted; transaction_hash = ?depositHash; error = null;
        })));
        assert (updated.id == approved.id and updated.revision == approved.revision + 1);
        assert (updated.steps[1] == approved.steps[1]);
        assert (updated.steps[2].operation_id == ?"saved-deposit");
        assert (updated.steps[2].transaction_hash == ?depositHash);
        assert (restored.wallet_bridge_activity_v1({ ledger = ?usdc }).records == [{ id = approved.id; dismissed_at = 123 }]);
        let final = Main.Init(env);
        assert (ok(final.wallet_bridge_step_v2(#dismiss({ id = approved.id; dismissed = false }))) == updated);
        assert (ok(final.wallet_bridge_step_v2(#dismiss({ id = approved.id; dismissed = false }))) == updated);
        assert (ok(final.wallet_bridge_status_v1(approved.id)) == updated);
        assert (final.wallet_bridge_activity_v1({ ledger = ?usdc }).records == []);
        assert (final.wallet_bridge_activity_v1({ ledger = ?eth }).records.size() == 1);
        // Full journal APIs retain dismissed records for exact recovery/history.
        assert (final.wallet_bridge_list_v1({ ledger = null; after = null; limit = 10 }).records.size() == 2);
    };
};
