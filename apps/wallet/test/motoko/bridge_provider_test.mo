import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Map "mo:core/Map";
import Principal "mo:core/Principal";
import Provider "../../backend/bridge/BridgeProvider";
import Memory "../../backend/memory/wallet_bridge_provider/v1";
import BridgeMemory "../../backend/memory/wallet_bridge/v1";

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
    };
};
