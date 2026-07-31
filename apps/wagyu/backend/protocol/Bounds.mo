import Nat32 "mo:core/Nat32";
import Text "mo:core/Text";

import Types "./Types";

module {
    public let HASH_BYTES : Nat = 32;
    public let NONCE_BYTES : Nat = 16;
    public let OPERATION_ID_BYTES : Nat = 16;
    public let SUBSCRIPTION_ID_BYTES : Nat = 16;

    public let MAX_MARKDOWN_BYTES : Nat = 8_192;
    public let MAX_PROOF_CANDID_BYTES : Nat = 5_500;
    public let MAX_LIKE_RECEIPT_CANDID_BYTES : Nat = 6_000;
    public let MAX_DISPLAY_NAME_BYTES : Nat = 80;
    public let MAX_DESCRIPTION_BYTES : Nat = 1_024;
    public let MAX_CAPABILITIES : Nat = 32;
    public let MAX_CAPABILITY_TOKEN_BYTES : Nat = 64;
    public let MAX_AVATAR_BYTES : Nat = 262_144;
    public let MAX_AVATAR_DIMENSION : Nat = 1_024;

    public let MAX_POST_OBJECT_BYTES : Nat = 1_044_480;
    public let MAX_ACTION_OBJECT_BYTES : Nat = 1_048_576;
    public let MAX_LIKE_BATCH_BYTES : Nat = 983_040;
    public let MAX_LIKE_HEAD_BYTES : Nat = 4_096;
    public let MAX_REPLY_INDEX_BYTES : Nat = 1_044_480;
    public let MAX_REPLY_INDEX_ENTRIES : Nat = 4_096;
    public let MAX_PROFILE_OBJECT_BYTES : Nat = 266_240;
    public let MAX_CERTIFIED_BATCH_BYTES : Nat = 1_048_576;
    public let MAX_CERTIFIED_BATCH_OBJECTS : Nat = 16;
    public let STAGING_BLOCK_BYTES : Nat = 65_536;
    public let MAX_STAGING_BLOCKS : Nat = 16;

    public let LIKE_BATCH_RECEIPTS : Nat = 150;
    public let MAX_FINAL_PARTIAL_RECEIPTS : Nat = 149;
    public let MAX_UNSEALED_LIKE_RECEIPTS : Nat = 299;
    public let MAX_DELIVERY_CREDITS : Nat = 128;
    public let RENEWAL_CREDIT_THRESHOLD : Nat = 8;
    public let FOLLOW_CREDIT_TRANCHE : Nat = 32;
    public let MAX_CREDITS_BEFORE_RENEWAL : Nat = 96;

    public let MAX_FEED_PAGE_ITEMS : Nat = 25;
    public let MAX_FEED_PAGE_EVENT_BYTES : Nat = 524_288;
    public let MAX_NOTIFICATION_PAGE_ITEMS : Nat = 50;
    public let MAX_FANOUT_BATCH : Nat = 20;
    public let MAX_SEND_QUOTE_RECIPIENT_PREVIEW : Nat = 8;

    public let FOLLOW_ROUTE : Text = "wagyu_v1:follow";
    public let UNFOLLOW_ROUTE : Text = "wagyu_v1:unfollow";
    public let DELIVER_ROUTE : Text = "wagyu_v1:deliver";
    public let LIKE_ROUTE : Text = "wagyu_v1:like";
    public let NOTICE_ROUTE : Text = "wagyu_v1:notice";

    public type RouteIdV1 = {
        #follow;
        #unfollow;
        #deliver;
        #like;
        #notice;
    };

    public type RouteSpecV1 = {
        id : RouteIdV1;
        route : Text;
        method : Text;
        max_request_bytes : Nat;
        max_response_bytes : Nat;
        max_calls_per_hour : Nat;
        required_cycles : Nat;
    };

    public let FOLLOW : RouteSpecV1 = {
        id = #follow;
        route = FOLLOW_ROUTE;
        method = "follow";
        max_request_bytes = 1_024;
        max_response_bytes = 256;
        max_calls_per_hour = 120;
        required_cycles = 7_000_000_000;
    };

    public let UNFOLLOW : RouteSpecV1 = {
        id = #unfollow;
        route = UNFOLLOW_ROUTE;
        method = "unfollow";
        max_request_bytes = 512;
        max_response_bytes = 128;
        max_calls_per_hour = 240;
        required_cycles = 50_000_000;
    };

    public let DELIVER : RouteSpecV1 = {
        id = #deliver;
        route = DELIVER_ROUTE;
        method = "deliver";
        max_request_bytes = 16_384;
        max_response_bytes = 512;
        max_calls_per_hour = 1_800;
        required_cycles = 200_000_000;
    };

    public let LIKE : RouteSpecV1 = {
        id = #like;
        route = LIKE_ROUTE;
        method = "like";
        max_request_bytes = 8_192;
        max_response_bytes = 512;
        max_calls_per_hour = 1_080;
        required_cycles = 250_000_000;
    };

    public let NOTICE : RouteSpecV1 = {
        id = #notice;
        route = NOTICE_ROUTE;
        method = "notice";
        max_request_bytes = 1_024;
        max_response_bytes = 256;
        max_calls_per_hour = 360;
        required_cycles = 100_000_000;
    };

    public func route(method : Text) : ?RouteSpecV1 {
        if (method == FOLLOW_ROUTE) return ?FOLLOW;
        if (method == UNFOLLOW_ROUTE) return ?UNFOLLOW;
        if (method == DELIVER_ROUTE) return ?DELIVER;
        if (method == LIKE_ROUTE) return ?LIKE;
        if (method == NOTICE_ROUTE) return ?NOTICE;
        null;
    };

    public func routeById(id : RouteIdV1) : RouteSpecV1 {
        switch (id) {
            case (#follow) FOLLOW;
            case (#unfollow) UNFOLLOW;
            case (#deliver) DELIVER;
            case (#like) LIKE;
            case (#notice) NOTICE;
        };
    };

    public func actionObjectBytes(kind : Types.ActionKindV1) : Nat {
        switch (kind) {
            case (#post) MAX_POST_OBJECT_BYTES;
            case (#share or #tombstone or #like) MAX_ACTION_OBJECT_BYTES;
        };
    };

    public func sendObjectBytes(kind : Types.SendKindV1) : Nat {
        switch (kind) {
            case (#post or #reply) MAX_POST_OBJECT_BYTES;
            case (#share or #tombstone) MAX_ACTION_OBJECT_BYTES;
        };
    };

    public func stagingBlockCount(byteLength : Nat) : ?Nat {
        if (byteLength > MAX_ACTION_OBJECT_BYTES) return null;
        if (byteLength == 0) return ?1;
        ?((byteLength + STAGING_BLOCK_BYTES - 1) / STAGING_BLOCK_BYTES);
    };

    public func bodyLengthWithin(
        length : Nat32,
        kind : Types.ActionKindV1,
    ) : Bool {
        Nat32.toNat(length) <= actionObjectBytes(kind);
    };
};
