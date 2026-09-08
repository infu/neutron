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
