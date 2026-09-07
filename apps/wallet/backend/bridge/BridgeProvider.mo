import Blob "mo:core/Blob";
import Map "mo:core/Map";
import Memory "../memory/wallet_bridge_provider/v1";
import BridgeMemory "../memory/wallet_bridge/v1";
import Types "Types";
module {
    public type Binding = Memory.Binding;
    public type PrepareRequest = { bridge : Types.PrepareRequest; binding : Binding };
    public type BindingResult = { binding : ?Binding };

    public class Service(mem : Memory.Mem, bridge : BridgeMemory.Mem) {
        public func lookup(id : Blob) : BindingResult {
            { binding = switch (Map.get(mem.bindings, Blob.compare, id)) { case null null; case (?entry) ?entry.binding } };
        };

        // Reserve before minter discovery awaits. A failed preparation can retry
        // its exact intent, but neither a released root bridge nor another
        // account/caller can adopt this Wallet-provider execution identity.
        public func reserve(request : PrepareRequest) : Types.Result<()> {
            if (request.bridge.id.size() != 16) return #err("Bridge request ID must contain exactly 16 bytes");
            if (not request.binding.agent_mode) return #err("Provider deposits require the Agent execution identity");
            switch (request.bridge.source) {
                case (#evm_agent(source)) {
                    if (source.app_id != request.binding.app_id or source.installation_uid != request.binding.installation_uid) {
                        return #err("Provider deposit owner does not match its saved bridge source");
                    };
                };
                case (_) return #err("Provider deposits require their original Agent owner");
            };
            let intent = to_candid (request.bridge);
            switch (Map.get(mem.bindings, Blob.compare, request.bridge.id)) {
                case (?entry) {
                    if (entry.intent != intent or entry.binding != request.binding) return #err("Provider bridge ID already belongs to a different caller, account or intent");
                };
                case null {
                    if (Map.containsKey(bridge.intents, Blob.compare, request.bridge.id)) return #err("This saved deposit uses its released execution route; continue it with the original bridge tools");
                    Map.add(mem.bindings, Blob.compare, request.bridge.id, { binding = request.binding; intent });
                };
            };
            #ok(());
        };

        public func requireLegacy(id : Blob) : Types.Result<()> {
            switch (lookup(id).binding) {
                case null #ok(());
                case (?_) #err("This deposit uses the Wallet provider. Continue wallet_wrap_root_v1 with the original request ID.");
            };
        };
    };
};
