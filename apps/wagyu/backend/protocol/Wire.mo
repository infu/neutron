import Blob "mo:core/Blob";
import Text "mo:core/Text";

import Bounds "./Bounds";
import CandidGuard "./CandidGuard";
import Hash "./Hash";
import Types "./Types";

// Safe boundaries for Candid nested inside opaque blobs. Every decoder checks
// byte bounds and syntactic well-formedness before invoking `from_candid`.
module {
    public type PreparedIngressV1 = {
        request : Types.PublicIngressRequestV1;
        physical_args : Blob;
        ingress_candid : Blob;
        body_candid : Blob;
        payload_digest : Blob;
    };

    public func prepare(
        method : Text,
        operationId : Blob,
        exactBodyCandid : Blob,
    ) : ?PreparedIngressV1 {
        let ?route = Bounds.route(method) else return null;
        if (
            operationId.size() != Bounds.OPERATION_ID_BYTES or
            exactBodyCandid.size() == 0 or
            exactBodyCandid.size() > route.max_request_bytes or
            not CandidGuard.validOne(
                exactBodyCandid,
                route.max_request_bytes,
            )
        ) return null;
        let ingress : Types.WagyuIngressV1 = {
            operation_id = operationId;
            body_candid = exactBodyCandid;
        };
        let ingressCandid = encodeIngress(ingress);
        // Kernel route accounting applies to request.payload, which is this
        // exact nested WagyuIngress Candid, not the physical call arguments.
        if (ingressCandid.size() > route.max_request_bytes) return null;
        let request : Types.PublicIngressRequestV1 = {
            method = route.method;
            payload = ingressCandid;
        };
        ?{
            request;
            physical_args = encodePublicIngressRequest(request);
            ingress_candid = ingressCandid;
            body_candid = exactBodyCandid;
            payload_digest = Hash.payloadDigest(exactBodyCandid);
        };
    };

    public func encodePublicIngressRequest(
        value : Types.PublicIngressRequestV1
    ) : Blob {
        to_candid (value);
    };

    public func encodeIngress(value : Types.WagyuIngressV1) : Blob {
        to_candid (value);
    };

    public func decodeIngress(
        exactCandid : Blob,
        maximumBytes : Nat,
    ) : ?Types.WagyuIngressV1 {
        if (not preflight(exactCandid, maximumBytes)) return null;
        let decoded : ?Types.WagyuIngressV1 = from_candid exactCandid;
        decoded;
    };

    public func decodeIngressForRoute(
        method : Text,
        exactCandid : Blob,
    ) : ?Types.WagyuIngressV1 {
        let ?route = Bounds.route(method) else return null;
        let ?ingress = decodeIngress(exactCandid, route.max_request_bytes)
            else return null;
        if (
            ingress.operation_id.size() != Bounds.OPERATION_ID_BYTES or
            ingress.body_candid.size() == 0 or
            ingress.body_candid.size() > route.max_request_bytes or
            not CandidGuard.validOne(
                ingress.body_candid,
                route.max_request_bytes,
            )
        ) return null;
        ?ingress;
    };

    public func encodeFollowBody(value : Types.FollowBodyV1) : Blob {
        to_candid (value);
    };

    public func decodeFollowBody(
        exactCandid : Blob
    ) : ?Types.FollowBodyV1 {
        if (
            not preflight(
                exactCandid,
                Bounds.FOLLOW.max_request_bytes,
            )
        ) return null;
        let decoded : ?Types.FollowBodyV1 = from_candid exactCandid;
        decoded;
    };

    public func encodeUnfollowBody(value : Types.UnfollowBodyV1) : Blob {
        to_candid (value);
    };

    public func decodeUnfollowBody(
        exactCandid : Blob
    ) : ?Types.UnfollowBodyV1 {
        if (
            not preflight(
                exactCandid,
                Bounds.UNFOLLOW.max_request_bytes,
            )
        ) return null;
        let decoded : ?Types.UnfollowBodyV1 = from_candid exactCandid;
        decoded;
    };

    public func encodeDeliverBody(value : Types.DeliverBodyV1) : Blob {
        to_candid (value);
    };

    public func decodeDeliverBody(
        exactCandid : Blob
    ) : ?Types.DeliverBodyV1 {
        if (
            not preflight(
                exactCandid,
                Bounds.DELIVER.max_request_bytes,
            )
        ) return null;
        let decoded : ?Types.DeliverBodyV1 = from_candid exactCandid;
        decoded;
    };

    public func encodeLikeBody(value : Types.LikeBodyV1) : Blob {
        to_candid (value);
    };

    public func decodeLikeBody(exactCandid : Blob) : ?Types.LikeBodyV1 {
        if (
            not preflight(
                exactCandid,
                Bounds.LIKE.max_request_bytes,
            )
        ) return null;
        let decoded : ?Types.LikeBodyV1 = from_candid exactCandid;
        decoded;
    };

    public func encodeNoticeBody(value : Types.NoticeBodyV1) : Blob {
        to_candid (value);
    };

    public func decodeNoticeBody(
        exactCandid : Blob
    ) : ?Types.NoticeBodyV1 {
        if (
            not preflight(
                exactCandid,
                Bounds.NOTICE.max_request_bytes,
            )
        ) return null;
        let decoded : ?Types.NoticeBodyV1 = from_candid exactCandid;
        decoded;
    };

    public func encodeRouteResult(
        value : Types.WagyuRouteResultV1
    ) : Blob {
        to_candid (value);
    };

    public func decodeRouteResult(
        exactRouteResultCandid : Blob,
        maximumBytes : Nat,
    ) : ?Types.WagyuRouteResultV1 {
        if (
            not preflight(exactRouteResultCandid, maximumBytes)
        ) return null;
        let decoded : ?Types.WagyuRouteResultV1 =
            from_candid exactRouteResultCandid;
        decoded;
    };

    public func decodePublicIngressResult(
        exactReplyCandid : Blob,
        maximumOkBytes : Nat,
    ) : ?Types.PublicIngressResultV1 {
        // Error results have bounded fixed framing. Leave headroom for the
        // frozen outer type table while bounding a successful Blob by the
        // logical route's response ceiling below.
        if (maximumOkBytes > 65_536) return null;
        if (
            not preflight(
                exactReplyCandid,
                maximumOkBytes + 1_024,
            )
        ) return null;
        let decoded : ?Types.PublicIngressResultV1 =
            from_candid exactReplyCandid;
        let ?result = decoded else return null;
        switch (result) {
            case (#ok(payload)) {
                if (payload.size() > maximumOkBytes) null else ?result;
            };
            case (#err(_)) ?result;
        };
    };

    public func encodePostBody(value : Types.PostBodyV1) : Blob {
        to_candid (value);
    };

    public func decodePostBody(
        exactCandid : Blob
    ) : ?Types.PostBodyV1 {
        if (
            not preflight(
                exactCandid,
                Bounds.MAX_POST_OBJECT_BYTES,
            )
        ) return null;
        let decoded : ?Types.PostBodyV1 = from_candid exactCandid;
        decoded;
    };

    public func encodeCertifiedPostRef(
        value : Types.CertifiedPostRefV1
    ) : Blob {
        to_candid (value);
    };

    public func decodeCertifiedPostRef(
        exactCandid : Blob
    ) : ?Types.CertifiedPostRefV1 {
        if (
            not preflight(
                exactCandid,
                Bounds.DELIVER.max_request_bytes,
            )
        ) return null;
        let decoded : ?Types.CertifiedPostRefV1 =
            from_candid exactCandid;
        decoded;
    };

    public func encodeCertifiedActionRef(
        value : Types.CertifiedActionRefV1
    ) : Blob {
        to_candid (value);
    };

    public func decodeCertifiedActionRef(
        exactCandid : Blob
    ) : ?Types.CertifiedActionRefV1 {
        if (
            not preflight(
                exactCandid,
                Bounds.DELIVER.max_request_bytes,
            )
        ) return null;
        let decoded : ?Types.CertifiedActionRefV1 =
            from_candid exactCandid;
        decoded;
    };

    public func encodeShareAction(value : Types.ShareActionV1) : Blob {
        to_candid (value);
    };

    public func decodeShareAction(
        exactCandid : Blob
    ) : ?Types.ShareActionV1 {
        if (
            not preflight(
                exactCandid,
                Bounds.MAX_ACTION_OBJECT_BYTES,
            )
        ) return null;
        let decoded : ?Types.ShareActionV1 = from_candid exactCandid;
        decoded;
    };

    public func encodeCertifiedShareDelivery(
        value : Types.CertifiedShareDeliveryV1
    ) : Blob {
        to_candid (value);
    };

    public func decodeCertifiedShareDelivery(
        exactCandid : Blob
    ) : ?Types.CertifiedShareDeliveryV1 {
        if (
            not preflight(
                exactCandid,
                Bounds.DELIVER.max_request_bytes,
            )
        ) return null;
        let decoded : ?Types.CertifiedShareDeliveryV1 =
            from_candid exactCandid;
        decoded;
    };

    public func encodeLikeAction(value : Types.LikeActionV1) : Blob {
        to_candid (value);
    };

    public func decodeLikeAction(
        exactCandid : Blob
    ) : ?Types.LikeActionV1 {
        if (
            not preflight(
                exactCandid,
                Bounds.MAX_ACTION_OBJECT_BYTES,
            )
        ) return null;
        let decoded : ?Types.LikeActionV1 = from_candid exactCandid;
        decoded;
    };

    public func encodeCertifiedLikeReceipt(
        value : Types.CertifiedLikeReceiptV1
    ) : Blob {
        to_candid (value);
    };

    public func decodeCertifiedLikeReceipt(
        exactCandid : Blob
    ) : ?Types.CertifiedLikeReceiptV1 {
        if (
            not preflight(
                exactCandid,
                Bounds.MAX_LIKE_RECEIPT_CANDID_BYTES,
            )
        ) return null;
        let decoded : ?Types.CertifiedLikeReceiptV1 =
            from_candid exactCandid;
        decoded;
    };

    public func encodeTombstoneAction(
        value : Types.TombstoneActionV1
    ) : Blob {
        to_candid (value);
    };

    public func decodeTombstoneAction(
        exactCandid : Blob
    ) : ?Types.TombstoneActionV1 {
        if (
            not preflight(
                exactCandid,
                Bounds.MAX_ACTION_OBJECT_BYTES,
            )
        ) return null;
        let decoded : ?Types.TombstoneActionV1 =
            from_candid exactCandid;
        decoded;
    };

    public func encodeCertifiedTombstone(
        value : Types.CertifiedTombstoneV1
    ) : Blob {
        to_candid (value);
    };

    public func decodeCertifiedTombstone(
        exactCandid : Blob
    ) : ?Types.CertifiedTombstoneV1 {
        if (
            not preflight(
                exactCandid,
                Bounds.DELIVER.max_request_bytes,
            )
        ) return null;
        let decoded : ?Types.CertifiedTombstoneV1 =
            from_candid exactCandid;
        decoded;
    };

    public func encodeProfile(value : Types.ProfileV1) : Blob {
        to_candid (value);
    };

    public func decodeProfile(exactCandid : Blob) : ?Types.ProfileV1 {
        if (
            not preflight(
                exactCandid,
                Bounds.MAX_PROFILE_OBJECT_BYTES,
            )
        ) return null;
        let decoded : ?Types.ProfileV1 = from_candid exactCandid;
        decoded;
    };

    public func encodeLikeBatch(value : Types.LikeBatchV1) : Blob {
        to_candid (value);
    };

    public func decodeLikeBatch(
        exactCandid : Blob
    ) : ?Types.LikeBatchV1 {
        if (
            not preflight(
                exactCandid,
                Bounds.MAX_LIKE_BATCH_BYTES,
            )
        ) return null;
        let decoded : ?Types.LikeBatchV1 = from_candid exactCandid;
        decoded;
    };

    public func encodeLikeHead(value : Types.LikeHeadV1) : Blob {
        to_candid (value);
    };

    public func decodeLikeHead(exactCandid : Blob) : ?Types.LikeHeadV1 {
        if (
            not preflight(
                exactCandid,
                Bounds.MAX_LIKE_HEAD_BYTES,
            )
        ) return null;
        let decoded : ?Types.LikeHeadV1 = from_candid exactCandid;
        decoded;
    };

    func preflight(
        exactCandid : Blob,
        maximumBytes : Nat,
    ) : Bool {
        CandidGuard.validOne(exactCandid, maximumBytes);
    };
};
