// Persistent schema v1 -- RELEASED. Do not edit: every byte of this file
// (comments and blank lines excluded) is hashed into `neutron.lock.json`, and an
// installation that already holds v1 refuses any package whose v1 hash differs.
//
// v1 cached Nuance content in replicated canister state: a feed page, the tag
// list, the shards PostCore had reported, and a watermark. v0.1.5 moved every
// read into the browser, where those are free public queries, which left this
// cache costing the owner rent to store something free to fetch. v2 drops it;
// `v1_to_v2.mo` carries the parts that are genuinely this app's own state.
//
// Package imports are allowed; relative imports are forbidden so app-local types
// cannot drift.
module {
    public type SourceRef = {
        postId : Text;
        bucketCanisterId : Text;
    };
    public type Suggestion = {
        id : Text;
        ops : Text;
        note : Text;
        created : Int;
    };
    public type Draft = {
        id : Text;
        title : Text;
        subtitle : Text;
        tagIds : [Text];
        body : Text;
        revision : Nat;
        created : Int;
        modified : Int;
        modifiedBy : Text;
        sourcePostId : ?SourceRef;
        suggestions : [Suggestion];
    };
    public type Bookmark = {
        postId : Text;
        bucketCanisterId : Text;
        title : Text;
        handle : Text;
        saved : Int;
    };
    public type FeedRow = {
        postId : Text;
        bucketCanisterId : Text;
        title : Text;
        subtitle : Text;
        handle : Text;
        publishedDate : Text;
        claps : Text;
        views : Text;
        wordCount : Text;
        tags : [Text];
    };
    public type Mem = {
        var handle : Text;
        var displayName : Text;
        var registered : Bool;
        var identityChecked : Int;
        var buckets : [Principal];
        var seenBuckets : [Text];
        var tags : [(Text, Text)];
        var tagsFetched : Int;
        var latestWatermark : Text;
        var feedCache : [FeedRow];
        var feedSource : Text;
        var feedCached : Int;
        var bookmarks : [Bookmark];
        var drafts : [Draft];
        var activeDraftId : Text;
        var nextDraftId : Nat;
    };
    public func init() : Mem {
        {
            var handle = "";
            var displayName = "";
            var registered = false;
            var identityChecked = 0;
            var buckets = [];
            var seenBuckets = [];
            var tags = [];
            var tagsFetched = 0;
            var latestWatermark = "";
            var feedCache = [];
            var feedSource = "";
            var feedCached = 0;
            var bookmarks = [];
            var drafts = [];
            var activeDraftId = "";
            var nextDraftId = 1;
        };
    };
};

