// Request builders and reply decoders for the Nuance canisters.
//
// Every outbound call goes through the kernel's `backend_calls` broker, so this
// module never touches a raw call primitive, an actor type, or cycles. It only
// turns app intent into `{ canister; method; args; cycles }` and turns the
// returned Candid blob back into typed values.
//
// This covers only the calls that must originate from this canister: writes to
// Nuance, and the two indexes Nuance scopes to the caller. Nuance's read surface
// is entirely public `query`, so the browser calls it directly and anonymously
// (`src/nuance/client.ts`) instead of paying for a replicated round trip here.
//
// Canister ids are compile-time constants and must match the
// `install_reservations` in `neutron.json`. Bucket shards are discovered at
// runtime from PostCore, so bucket calls take their principal as an argument.

import Principal "mo:core/Principal";
import Capabilities "../capabilities/Types";
import Types "Types";

module {

    public type Result<T> = { #ok : T; #err : Text };

    // Verified live on 2026-09-02 via PostCore.getBucketCanisters().
    //
    // These are functions rather than module-level `let` bindings because
    // `Principal.fromText` is a call, and Motoko requires module-level
    // definitions to be static expressions.
    public let postCoreId : Text = "322sd-3iaaa-aaaaf-qakgq-cai";
    public let userId : Text = "rtqeo-eyaaa-aaaaf-qaana-cai";

    public func postCore() : Principal = Principal.fromText(postCoreId);
    public func user() : Principal = Principal.fromText(userId);

    /// Bucket shards known at package time, seeded into the write allowlist on
    /// first use. PostCore may add more; the account view offers to register
    /// those once the owner grants a reservation for them.
    public let knownBuckets : [Text] = [
        "4hy47-uiaaa-aaaaf-qakuq-cai",
        "434go-diaaa-aaaaf-qakwq-cai",
        "3tzz7-naaaa-aaaaf-qakha-cai",
        "zjfrd-tqaaa-aaaaf-qakia-cai",
    ];

    func errorText(error : Capabilities.CallError) : Text {
        error.code # ": " # error.message;
    };

    // ------------------------------------------------- PostCore, caller-scoped

    public func myPublishedPostsRequest(from : Nat32, to : Nat32) : Capabilities.CallRequest {
        {
            canister = postCore();
            method = "getMyPublishedPosts";
            args = to_candid (from, to);
            cycles = 0;
        };
    };

    public func myDraftPostsRequest(from : Nat32, to : Nat32) : Capabilities.CallRequest {
        {
            canister = postCore();
            method = "getMyDraftPosts";
            args = to_candid (from, to);
            cycles = 0;
        };
    };

    // ------------------------------------------------------ PostCore writes

    public func saveRequest(model : Types.PostSaveModel) : Capabilities.CallRequest {
        {
            canister = postCore();
            method = "save";
            args = to_candid (model);
            cycles = 0;
        };
    };

    /// `clapPost` is declared oneway on PostCore: it replies immediately with an
    /// empty value and reports nothing about the outcome.
    public func clapRequest(postId : Text) : Capabilities.CallRequest {
        {
            canister = postCore();
            method = "clapPost";
            args = to_candid (postId);
            cycles = 0;
        };
    };

    // ----------------------------------------------------- PostBucket writes

    public func saveCommentRequest(
        bucket : Principal,
        model : Types.SaveCommentModel,
    ) : Capabilities.CallRequest {
        {
            canister = bucket;
            method = "saveComment";
            args = to_candid (model);
            cycles = 0;
        };
    };

    /// `vote` is one of "up", "down", "clear".
    public func voteCommentRequest(
        bucket : Principal,
        commentId : Text,
        vote : Text,
    ) : Capabilities.CallRequest {
        let method = switch (vote) {
            case ("up") "upvoteComment";
            case ("down") "downvoteComment";
            case (_) "removeCommentVote";
        };
        {
            canister = bucket;
            method;
            args = to_candid (commentId);
            cycles = 0;
        };
    };

    // ----------------------------------------------------------- User writes

    public func registerUserRequest(
        handle : Text,
        displayName : Text,
        avatar : Text,
    ) : Capabilities.CallRequest {
        {
            canister = user();
            method = "registerUser";
            args = to_candid (handle, displayName, avatar);
            cycles = 0;
        };
    };

    // ------------------------------------------------------------- decoders
    //
    // Each decoder is explicit because `from_candid` resolves against a concrete
    // static type. A decode failure is reported, never swallowed: Nuance can
    // change its interface at any time and a blank screen would hide that.

    public func decodeKeyPropertiesList(
        result : Capabilities.CallResult
    ) : Result<[Types.PostKeyProperties]> {
        switch (result) {
            case (#err(error)) #err(errorText(error));
            case (#ok(reply)) {
                let decoded : ?[Types.PostKeyProperties] = from_candid reply;
                switch (decoded) {
                    case (?value) #ok(value);
                    case null #err("Nuance returned an unexpected post list");
                };
            };
        };
    };

    public func decodeComments(
        result : Capabilities.CallResult
    ) : Result<Types.CommentsReturnType> {
        switch (result) {
            case (#err(error)) #err(errorText(error));
            case (#ok(reply)) {
                let decoded : ?Types.CommentsResult = from_candid reply;
                switch (decoded) {
                    case (? #ok(value)) #ok(value);
                    case (? #err(message)) #err(message);
                    case null #err("Nuance returned an unexpected comment list");
                };
            };
        };
    };

    public func decodeSavedPost(
        result : Capabilities.CallResult
    ) : Result<Types.SavedPost> {
        switch (result) {
            case (#err(error)) #err(errorText(error));
            case (#ok(reply)) {
                let decoded : ?Types.SavedPostResult = from_candid reply;
                switch (decoded) {
                    case (? #ok(value)) #ok(value);
                    case (? #err(message)) #err(message);
                    case null #err("Nuance returned an unexpected save result");
                };
            };
        };
    };

    public func decodeUserProfile(
        result : Capabilities.CallResult
    ) : Result<Types.UserProfile> {
        switch (result) {
            case (#err(error)) #err(errorText(error));
            case (#ok(reply)) {
                let decoded : ?Types.UserProfileResult = from_candid reply;
                switch (decoded) {
                    case (? #ok(value)) #ok(value);
                    case (? #err(message)) #err(message);
                    case null #err("Nuance returned an unexpected profile");
                };
            };
        };
    };

    /// A oneway reply carries no value; only transport failure is meaningful.
    public func decodeAcknowledgement(result : Capabilities.CallResult) : Result<()> {
        switch (result) {
            case (#err(error)) #err(errorText(error));
            case (#ok(_)) #ok(());
        };
    };
};
