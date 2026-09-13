import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Map "mo:core/Map";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Capabilities "../../backend/capabilities/Types";
import Provider "../../backend/bridge/BridgeProvider";
import Minter "../../backend/bridge/Minter";
import Main "../../backend/main";
import Memory "../../backend/memory/wallet_bridge_provider/v1";
import BridgeMemory "../../backend/memory/wallet_bridge/v1";
import WalletMemory "../../backend/memory/wallet/v1";
import CommandMemory "../../backend/memory/wallet_commands/v1";
import TransferMemory "../../backend/memory/wallet_transfers/v1";
import ReplacementMemory "../../backend/memory/wallet_bridge_replacements/v1";
import ActivityMemory "../../backend/memory/wallet_bridge_activity/v1";
import RefillMemory "../../backend/memory/wallet_refills/v1";

persistent actor {
    public func run() : async () {
        let mem = Memory.init();
        let bridges = BridgeMemory.init();
        let service = Provider.Service(mem, bridges);
        let id = Blob.fromArray(Array.repeat<Nat8>(1, 16));
        let binding : Provider.Binding = { app_id = "agent"; installation_uid = "51"; agent_mode = true;
            key_fingerprint = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; namespace_version = "1" };
        let request : Provider.PrepareRequest = {
            binding;
            bridge = { id; ledger = Principal.fromText("ss2fx-dyaaa-aaaar-qacoq-cai");
                source = #evm_agent({ app_id = "agent"; installation_uid = "51" });
                account = "0x1111111111111111111111111111111111111111"; amount = 10; subaccount = null };
        };
        assert (service.lookup(id).binding == null);
        assert (service.reserve(request) == #ok(()));
        assert (service.reserve(request) == #ok(()));
        assert (service.lookup(id).binding == ?binding);
        assert (Map.size(mem.bindings) == 1);
        let restored = Provider.Service(mem, bridges);
        assert (restored.lookup(id).binding == ?binding);
        assert (restored.reserve(request) == #ok(()));
        switch (restored.requireLegacy(id)) { case (#err(_)) {}; case (_) assert false };
        for (changed in [
            { request with binding = { binding with installation_uid = "52" } },
            { request with binding = { binding with agent_mode = false } },
            { request with binding = { binding with namespace_version = "2" } },
            { request with bridge = { request.bridge with amount = 11 } },
            { request with bridge = { request.bridge with source = #evm } },
        ].vals()) {
            switch (restored.reserve(changed)) { case (#err(_)) {}; case (_) assert false };
        };
        assert (restored.lookup(id).binding == ?binding);
        assert (Map.size(mem.bindings) == 1);

        // Exercise the actual provider endpoint. A minter-only grant cannot
        // solicit a new deposit into a destination ledger Wallet does not own.
        let ledger = request.bridge.ledger;
        let minter = Principal.fromText("sv3dd-oaaaa-aaaar-qacoa-cai");
        var exclusiveLedger = false;
        var queries = 0;
        let info : Minter.Info = {
            minter_address = ?request.bridge.account;
            smart_contract_address = null;
            eth_helper_contract_address = null;
            erc20_helper_contract_address = null;
            deposit_with_subaccount_helper_contract_address = ?"0x2222222222222222222222222222222222222222";
            supported_ckerc20_tokens = null;
            cketh_ledger_id = ?ledger;
        };
        let calls : Capabilities.BackendCalls = {
            canister_principal = Principal.fromText("aaaaa-aa");
            owns_principal = func(target : Principal) : Bool { target == minter or (target == ledger and exclusiveLedger) };
            can_call = func(_ : Principal, _ : Text) : Bool { true };
            call = func(input : Capabilities.CallRequest) : async* Capabilities.CallResult {
                assert input.canister == minter and input.cycles == 0;
                queries += 1;
                switch (input.method) {
                    case ("get_minter_info") #ok(to_candid(info));
                    case ("get_events") {
                        let events : Minter.Events = { events = []; total_event_count = 50 };
                        #ok(to_candid(events));
                    };
                    case (_) Runtime.trap("Unexpected provider call: " # input.method);
                };
            };
            call_batch = func(_ : [Capabilities.CallRequest]) : async* [Capabilities.CallResult] {
                Runtime.trap("Bridge preparation must not batch calls");
            };
        };
        let providerMemory = Memory.init();
        let bridgeMemory = BridgeMemory.init();
        let env : Main.AppBackendEnvironment = {
            stable_memory = {
                wallet = WalletMemory.init(); wallet_commands = CommandMemory.init();
                wallet_transfers = TransferMemory.init(); wallet_bridge = bridgeMemory;
                wallet_bridge_provider = providerMemory; wallet_bridge_replacements = ReplacementMemory.init();
                wallet_bridge_activity = ActivityMemory.init(); wallet_refills = RefillMemory.init();
            };
            capabilities = { backend_calls = calls };
            app_calls = { contacts = {
                contacts_discover_v1 = func(_ : Main.DiscoverContactsRequestV1) : Main.DiscoverContactsResultV1 {
                    Runtime.trap("Bridge preparation does not use Contacts");
                };
            } };
        };
        let app = Main.Init(env);
        switch (await* app.wallet_bridge_provider_prepare_v1(request)) {
            case (#err(_)) {};
            case (_) Runtime.trap("Provider prepared a deposit without exclusive destination access");
        };
        assert queries == 0;
        assert Map.size(providerMemory.bindings) == 0 and Map.size(bridgeMemory.intents) == 0;
        exclusiveLedger := true;
        let prepared = switch (await* app.wallet_bridge_provider_prepare_v1(request)) {
            case (#ok(value)) value;
            case (#err(error)) Runtime.trap(error);
        };
        assert queries == 2;
        assert Map.size(providerMemory.bindings) == 1 and Map.size(bridgeMemory.intents) == 1;
        let ?savedBinding = Map.get(providerMemory.bindings, Blob.compare, id) else Runtime.trap("Provider binding was not saved");
        let savedBytes = to_candid(prepared);
        exclusiveLedger := false;
        let restoredApp = Main.Init(env);
        switch (await* restoredApp.wallet_bridge_provider_prepare_v1(request)) {
            case (#err(_)) {};
            case (_) Runtime.trap("Provider replay reused an unowned destination ledger");
        };
        let claim : Main.WalletBridgeClaimRequestV1 = {
            id; revision = prepared.revision; step = #deposit; operation_id = ?"agent-deposit";
        };
        switch (restoredApp.wallet_bridge_claim_v1(claim)) {
            case (#err(_)) {};
            case (_) Runtime.trap("Provider claimed an unowned destination ledger");
        };
        assert Map.get(providerMemory.bindings, Blob.compare, id) == ?savedBinding;
        switch (restoredApp.wallet_bridge_status_v1(id)) {
            case (#ok(value)) assert to_candid(value) == savedBytes;
            case (#err(error)) Runtime.trap(error);
        };
        assert queries == 2;
        exclusiveLedger := true;
        switch (restoredApp.wallet_bridge_claim_v1(claim)) {
            case (#ok(value)) assert value.steps[2].state == #unknown;
            case (#err(error)) Runtime.trap(error);
        };
    };
};
