// Additive execution provenance for provider-mediated Agent deposits. Released
// wallet_bridge/v1 intents and their direct-root signing identity stay intact.
import Map "mo:core/Map";
module {
    public type Binding = {
        app_id : Text;
        installation_uid : Text;
        agent_mode : Bool;
        key_fingerprint : Text;
        namespace_version : Text;
    };
    public type Entry = { binding : Binding; intent : Blob };
    public type Mem = { bindings : Map.Map<Blob, Entry> };
    public func init() : Mem { { bindings = Map.empty<Blob, Entry>() } };
};
