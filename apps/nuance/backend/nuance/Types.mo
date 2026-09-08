// Candid shapes for the Nuance canisters.
//
// Two different disciplines are used here on purpose:
//
//   * Types we SEND (PostSaveModel, SaveCommentModel) are complete. Nuance
//     declares those fields as required, so omitting one makes the call
//     undecodable on their side.
//
//   * Types we RECEIVE are deliberately minimal projections. Candid record
//     subtyping lets a receiver declare a subset of the wire fields and ignore
//     the rest, so Nuance can add fields without breaking us. Only fields this
//     app actually reads are declared.
//
// Field names and types are copied verbatim from the Nuance repository's
// generated `.did` files. Candid hashes record labels, so a rename here is a
// wire break, not a cosmetic change.
module {

    // ---------------------------------------------------------------- shared

    public type PostTagModel = {
        tagId : Text;
        tagName : Text;
    };

    public type TagModel = {
        id : Text;
        value : Text;
        createdDate : Text;
    };

    // ------------------------------------------------------------- PostCore

    /// PostCore index row. Carries the shard id and engagement counters but no
    /// title -- the title lives in the bucket projection below.
    public type PostKeyProperties = {
        postId : Text;
        bucketCanisterId : Text;
        handle : Text;
        claps : Text;
        views : Text;
        created : Text;
        modified : Text;
        publishedDate : Text;
        isDraft : Bool;
        tags : [PostTagModel];
    };

    public type GetPostsByFollowers = {
        posts : [PostKeyProperties];
        totalCount : Text;
    };

    /// Sent to PostCore.save. Complete by necessity.
    public type PremiumSaveModel = {
        icpPrice : Nat;
        maxSupply : Nat;
        thumbnail : Text;
    };

    public type PostSaveModel = {
        postId : Text;
        title : Text;
        subtitle : Text;
        content : Text;
        category : Text;
        handle : Text;
        creatorHandle : Text;
        headerImage : Text;
        isDraft : Bool;
        isMembersOnly : Bool;
        isPublication : Bool;
        premium : ?PremiumSaveModel;
        scheduledPublishedDate : ?Int;
        tagIds : [Text];
    };

    /// PostCore.save reply projection.
    public type SavedPost = {
        postId : Text;
        bucketCanisterId : Text;
        handle : Text;
        title : Text;
        url : Text;
        isDraft : Bool;
        publishedDate : Text;
        wordCount : Text;
    };

    // ----------------------------------------------------------- PostBucket

    /// Bucket projection. In list mode (`getPostsByPostIds`) Nuance truncates
    /// `title` to 60 characters, `subtitle` to 200, and returns `content = ""`.
    /// Only `getPost` returns the real title and body.
    public type PostBucketType = {
        postId : Text;
        bucketCanisterId : Text;
        title : Text;
        subtitle : Text;
        content : Text;
        handle : Text;
        creatorHandle : Text;
        headerImage : Text;
        url : Text;
        wordCount : Text;
        publishedDate : Text;
        created : Text;
        modified : Text;
        isDraft : Bool;
        isPremium : Bool;
        isMembersOnly : Bool;
        isPublication : Bool;
        postOwnerPrincipal : Text;
    };

    /// Recursive comment tree. `handle` and `avatar` arrive empty from the
    /// bucket; they are filled in from the User canister by the caller.
    public type Comment = {
        commentId : Text;
        postId : Text;
        bucketCanisterId : Text;
        content : Text;
        creator : Text;
        handle : Text;
        avatar : Text;
        createdAt : Text;
        editedAt : ?Text;
        isCensored : Bool;
        isVerified : Bool;
        upVotes : [Text];
        downVotes : [Text];
        repliedCommentId : ?Text;
        replies : [Comment];
    };

    public type CommentsReturnType = {
        comments : [Comment];
        totalNumberOfComments : Text;
    };

    /// Sent to PostBucket.saveComment. Complete by necessity.
    public type SaveCommentModel = {
        postId : Text;
        content : Text;
        commentId : ?Text;
        replyToCommentId : ?Text;
    };

    // ----------------------------------------------------------------- User

    public type UserListItem = {
        principal : Text;
        handle : Text;
        displayName : Text;
        avatar : Text;
        isVerified : Bool;
    };

    /// Projection of the large Nuance `User` record.
    public type UserProfile = {
        handle : Text;
        displayName : Text;
        avatar : Text;
    };

    // -------------------------------------------------------------- results

    // Nuance uses lower-case `ok`/`err` variants throughout the surfaces we
    // touch. Each alias exists because `from_candid` needs a concrete type.

    public type PostKeyPropertiesResult = { #ok : PostKeyProperties; #err : Text };
    public type SavedPostResult = { #ok : SavedPost; #err : Text };
    public type PostBucketResult = { #ok : PostBucketType; #err : Text };
    public type CommentsResult = { #ok : CommentsReturnType; #err : Text };
    public type UserProfileResult = { #ok : UserProfile; #err : Text };
};
