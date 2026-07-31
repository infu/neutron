import Memory "../memory/wagyu/v3";

// Pure post-receipt-window reconciliation. The caller obtains an authenticated
// kernel RecordStatus and supplies Wagyu's latest durable mirror for the same
// target. A later local replacement or revocation may legitimately supersede
// the journal being retired, so the latest mirror is the comparison point.
module {
    public type ObservedStatus = {
        #present : Memory.KernelRecordIdentity;
        #absent : Nat64;
        #recently_deleted : Memory.CertifiedTarget;
        #deleted_high_water : Memory.CertifiedTarget;
    };

    public func matches(
        target : Memory.CertifiedTarget,
        current : ?Memory.KernelRecordIdentity,
        observed : ObservedStatus,
    ) : Bool {
        switch (current) {
            case (?identity) {
                identity.target == target and
                observed == #present(identity);
            };
            case null {
                switch (observed) {
                    case (#present(_)) false;
                    case (#absent(collectionGeneration)) {
                        collectionGeneration ==
                            target.collection_generation;
                    };
                    case (#recently_deleted(deletedTarget)) {
                        deletedTarget == target;
                    };
                    case (#deleted_high_water(deletedTarget)) {
                        deletedTarget == target;
                    };
                };
            };
        };
    };
};
