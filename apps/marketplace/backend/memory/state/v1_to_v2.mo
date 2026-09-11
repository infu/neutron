import V1 "./v1";
import V2 "./v2";

module {
    public func migrate(old : V1.Mem) : V2.Mem {
        {
            var seed = old.seed;
            var canister = old.canister;
            var host = old.host;
            var revision = old.revision;
            drafts = old.drafts;
            var discountCode = null;
        };
    };
};
