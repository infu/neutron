// v1 -> v2: drop the Nuance content cache.
//
// Everything v2 keeps is carried across byte for byte. What v1 held and v2 does
// not -- `feedCache`, `feedSource`, `feedCached`, `latestWatermark`, `tags`,
// `tagsFetched`, `seenBuckets` -- was a cache of public Nuance data, and since
// v0.1.5 the browser reads that directly as free anonymous queries. Nothing is
// lost that cannot be re-fetched for free, and nothing the owner authored is
// touched: the handle, the reading list, the drafts and their revisions, and the
// shard write-allowlist all survive.
//
// `nextDraftId` carries over too, so a draft id is never reused after the
// upgrade.

import V1 "./v1";
import V2 "./v2";

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
