import IC "../aaa_interface";
import Types "Types";

module {
    public func management() : Types.Adapter {
        {
            random = func() : async Types.AdapterResult {
                try { #ok(await IC.management.raw_rand()) } catch (_) { #err };
            };
        }
    };
}
