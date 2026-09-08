// Persistent schema v2. Keep this file immutable now that it is released.
// Package imports are allowed; relative imports are forbidden so app-local types
// cannot drift.
//
// This root holds only what the browser cannot: the Nuance identity cache, the
// shared human+agent drafts, the reading list, and the shard allowlist.
//
// v1 additionally cached a feed page, the tag list, the shard ids PostCore had
// reported, and a "latest seen" watermark. Those are gone: `v1_to_v2.mo` drops
// them and carries everything else across unchanged.
//
// It deliberately holds no cache of Nuance content. Reads happen directly from
// the browser as free anonymous queries, so caching an article or a feed page in
// replicated canister state would cost the owner cycles to store something that
// is already free to fetch.
module {

    /// Points at a published Nuance article. `postId` is Nuance's own id and
    /// `bucketCanisterId` is the shard that stores its body.
    public type SourceRef = {
        postId : Text;
        bucketCanisterId : Text;
    };

    /// An agent edit held back for human review. `ops` is the canonical JSON
    /// encoding of the patch op list so the schema does not have to freeze the
    /// op variant shape.
    public type Suggestion = {
        id : Text;
        ops : Text;
        note : Text;
        created : Int;
    };

    /// A shared draft. Both the tile and the resident background mutate this
    /// through compare-and-swap on `revision`, so neither can silently clobber
    /// the other. `body` is plain text, never HTML: patch ops match over text and
    /// markup is generated once at publish time.
    public type Draft = {
        id : Text;
        title : Text;
        subtitle : Text;
        tagIds : [Text];
        body : Text;
        revision : Nat;
        created : Int;
        modified : Int;
        // "human" | "agent" | "" -- provenance of the last accepted mutation.
        modifiedBy : Text;
        // Set when the draft was loaded from a live article and will update it.
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

    public type Mem = {
        // Nuance identity of this Neutron. The handle is a cache of what the
        // User canister reports; the browser re-reads the live profile for free.
        var handle : Text;
        var displayName : Text;
        var registered : Bool;
        var identityChecked : Int;

        // Shard canisters this app may *write* to -- comments and votes go to a
        // bucket directly. Reads need no entry here because they never touch the
        // backend. Stored as principals, never text: `Principal.fromText` traps
        // on malformed input and PostCore is free to hand us an unknown shard id.
        // New shards are registered by the trusted frontend after the owner
        // grants a reservation, which is where the text is safely validated.
        var buckets : [Principal];

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
            var bookmarks = [];
            var drafts = [];
            var activeDraftId = "";
            var nextDraftId = 1;
        };
    };
};
