import Cycles "mo:core/Cycles";
import IC "../aaa_interface";
import Types "Types";

module {
    public func management() : Types.Adapter {
        {
            random = random;
            cycle_balance = Cycles.balance;
        };
    };

    func random() : async Types.AdapterResult {
        try {
            #ok(await IC.management.raw_rand());
        } catch (_) {
            #err;
        };
    };
};
