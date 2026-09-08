import V1 "d6e05b198cc93289c36a5a2cff5d65330a35b2fd5ba0bd48e993ce17fec1f07f";
import V2 "fbfad45abcabc8194d73dbdc1746dbac12cc670e0b4feb02acf540d1ebd3f258";
module {
    public func migrate(old : V1.Mem) : V2.Mem {
        {
            var handle = old.handle;
            var displayName = old.displayName;
            var registered = old.registered;
            var identityChecked = old.identityChecked;
            var buckets = old.buckets;
            var bookmarks = old.bookmarks;
            var drafts = old.drafts;
            var activeDraftId = old.activeDraftId;
            var nextDraftId = old.nextDraftId;
        };
    };
};
