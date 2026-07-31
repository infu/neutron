import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Nat8 "mo:core/Nat8";
import Principal "mo:core/Principal";

import Capabilities "mo:neutron-capabilities";

import Wagyu "../../backend/main";
import Memory "../../backend/memory/wagyu/v3";

func repeatBlob(size : Nat, byte : Nat8) : Blob {
    Blob.fromArray(Array.tabulate<Nat8>(size, func(_) { byte }));
};

func canister(last : Nat8) : Principal {
    Principal.fromBlob(Blob.fromArray([0, last, 1]));
};

let node = canister(1);
let networkId = repeatBlob(32, 0x2a);
let installationGeneration : Nat64 = 37;

let backendCalls : Capabilities.BackendCallsV1 = {
    canister_principal = node;
    can_call = func(_canister : Principal, _method : Text) { false };
    call = func(
        _request : Capabilities.BackendCallRequestV1
    ) : async* Capabilities.BackendCallResultV1 {
        #err({
            code = "disabled";
            message = "disabled in compile test";
        });
    };
    call_batch = func(
        _requests : [Capabilities.BackendCallRequestV1]
    ) : async* [Capabilities.BackendCallResultV1] {
        [];
    };
};

let disabledAssets : Capabilities.CertifiedAssetsV2 = {
    scope_info = func() : Capabilities.ScopeInfoResult {
        #err(#disabled);
    };
    begin_stage = func(
        _input : Capabilities.BeginStageInput
    ) : Capabilities.BeginStageResult {
        #err(#disabled);
    };
    put_chunk = func(
        _input : Capabilities.PutChunkInput
    ) : Capabilities.ChunkResult {
        #err(#disabled);
    };
    stage_status = func(
        _stageId : Nat64
    ) : Capabilities.StageStatusResult {
        #err(#disabled);
    };
    abort_stage = func(_stageId : Nat64) : Capabilities.Result {
        #err(#disabled);
    };
    commit_batch = func(
        _input : Capabilities.CommitBatchInput
    ) : Capabilities.CommitBatchResult {
        #err(#disabled);
    };
    record_status = func(
        _target : Capabilities.Target
    ) : Capabilities.RecordStatusResult {
        #err(#disabled);
    };
    maintenance_page = func() : Capabilities.MaintenancePageResult {
        #err(#disabled);
    };
    usage = func() : Capabilities.UsageResult {
        #err(#disabled);
    };
};

let deferredTimers : Capabilities.DeferredTimersV1 = {
    arm = func(
        _input : Capabilities.DeferredTimerArmInputV1
    ) : async* Capabilities.DeferredTimerArmResultV1 {
        #err(#source_gone);
    };
    status = func(_key : Text) {
        null;
    };
};

let assetLimits : Capabilities.Limits = {
    entries = 100_000;
    committed_bytes = 1_073_741_824;
    object_bytes = 1_048_576;
    staged_bytes = 1_048_576;
    pending_stages = 1;
    batch_operations = 16;
    batch_bytes = 1_048_576;
    general_receipts = 4_096;
    revocation_lanes = 1;
};

func collection(
    id : Text,
    kind : Capabilities.CollectionKind,
    generation : Nat64,
) : Capabilities.CollectionInfo {
    {
        id;
        kind;
        authority_epoch = 1;
        generation;
        serving = #enabled;
        writes = #enabled;
        manifest_limits = assetLimits;
        effective_limits = assetLimits;
    };
};

var scopeInfoCalls = 0;
let activeAssets : Capabilities.CertifiedAssetsV2 = {
    scope_info = func() : Capabilities.ScopeInfoResult {
        scopeInfoCalls += 1;
        #ok({
            installation_generation = installationGeneration;
            store_authority_epoch = 1;
            collections = [
                collection("like_batches", #immutable_blob, 41),
                collection("like_heads", #mutable_blob, 42),
                collection("likes", #immutable_blob, 43),
                collection("posts", #immutable_blob, 44),
                collection("profile", #mutable_blob, 47),
                collection("reply_indexes", #mutable_blob, 46),
                collection("shares", #immutable_blob, 48),
                collection("tombstones", #immutable_blob, 49),
            ];
        });
    };
    begin_stage = disabledAssets.begin_stage;
    put_chunk = disabledAssets.put_chunk;
    stage_status = disabledAssets.stage_status;
    abort_stage = disabledAssets.abort_stage;
    commit_batch = disabledAssets.commit_batch;
    record_status = disabledAssets.record_status;
    maintenance_page = disabledAssets.maintenance_page;
    usage = disabledAssets.usage;
};

let mem = Memory.init();
let environment : Wagyu.AppBackendEnvironment = {
    installation = { network_id = networkId };
    stable_memory = { wagyu = mem };
    capabilities = {
        backend_calls = backendCalls;
        deferred_timers = deferredTimers;
        certified_assets = activeAssets;
    };
};
let wagyu = Wagyu.Init(environment);

// Bind every app-owned surface to the exact shape expected by generated
// wrappers. Binary values stay in ordinary Candid records; kernel-supplied
// callers and task capabilities remain distinct physical arguments.
let _status : Wagyu.EmptyRequestV1 -> Wagyu.WagyuStatusV1 =
    wagyu.wagyu_status;
let _profile : Wagyu.EmptyRequestV1 -> Wagyu.ProfileViewV1 =
    wagyu.wagyu_profile;
let _feed :
    Wagyu.FeedPageRequestV1 -> Wagyu.FeedPageV1 =
    wagyu.wagyu_get_feed_page_v1;
let _notifications :
    Wagyu.NotificationPageRequestV1 -> Wagyu.NotificationPageV1 =
    wagyu.wagyu_get_notification_page_v1;
let _notificationEvidence :
    Wagyu.NotificationEvidenceRequestV1 -> Wagyu.NotificationEvidenceV1 =
    wagyu.wagyu_get_notification_evidence_v1;
let _sendQuote :
    Wagyu.SendQuoteRequestV1 -> Wagyu.SendQuoteV1 =
    wagyu.wagyu_get_send_quote_v1;
let _profileEdit :
    Wagyu.ProfileEditRequestV1 -> Wagyu.ProfileEditResultV1 =
    wagyu.wagyu_profile_edit_v1;
let _profileEditRequest : Wagyu.ProfileEditRequestV1 = {
    expected_profile_generation = 1;
    expected_revision = 2;
    display_name = "Wagyu";
    description = "Nested binary owner input";
    avatar = ?{
        media_type = ?#png;
        width = 1;
        height = 1;
        bytes = Blob.fromArray([0x89]);
    };
};
let _sharePrepareRequest : Wagyu.SharePrepareSelfRequestV1 = {
    nonce_hex = null;
    exact_original_post_ref_candid = Blob.fromArray([0x44, 0x49, 0x44, 0x4c]);
};
let _finalizeRequest : Wagyu.FinalizeSelfRequestV1 = {
    action_id_hex = "00";
    object_digest_hex = "00";
    exact_proof_candid = Blob.fromArray([0x44, 0x49, 0x44, 0x4c]);
};
ignore _profileEditRequest;
ignore _sharePrepareRequest;
ignore _finalizeRequest;
let _relationships :
    Wagyu.RelationshipPageRequestV1 -> Wagyu.RelationshipsV1 =
    wagyu.wagyu_relationships;
let _blockStatuses :
    Wagyu.BlockStatusesSelfRequestV1 ->
        Wagyu.BlockStatusesSelfOutputV1 =
    wagyu.wagyu_block_statuses_self_v1;
let _follow :
    Wagyu.FollowRequestV1 ->
        Wagyu.RelationshipSummaryLocalResultV1 =
    wagyu.wagyu_follow;
let _unfollow :
    Wagyu.NodeRequestV1 ->
        Wagyu.RelationshipSummaryLocalResultV1 =
    wagyu.wagyu_unfollow;
let _block :
    Wagyu.NodeRequestV1 ->
        Wagyu.RelationshipSummaryLocalResultV1 =
    wagyu.wagyu_block;
let _unblock :
    Wagyu.NodeRequestV1 ->
        Wagyu.RelationshipSummaryLocalResultV1 =
    wagyu.wagyu_unblock;
let _post :
    Wagyu.PostPublishRequestV1 ->
        Wagyu.PublishLocalResultV1 =
    wagyu.wagyu_post_publish;
let _share :
    Wagyu.SharePublishRequestV1 ->
        Wagyu.PublishLocalResultV1 =
    wagyu.wagyu_share_publish;
let _like :
    Wagyu.LikePublishRequestV1 ->
        Wagyu.PublishLocalResultV1 =
    wagyu.wagyu_like_publish;
let _finalize :
    Wagyu.ActionFinalizeRequestV1 ->
        Wagyu.PublishLocalResultV1 =
    wagyu.wagyu_action_finalize;
let _delete :
    Wagyu.PostDeleteRequestV1 ->
        Wagyu.PublishLocalResultV1 =
    wagyu.wagyu_post_delete;
let _seal :
    Wagyu.LikeSealRequestV1 ->
        Wagyu.PublishLocalResultV1 =
    wagyu.wagyu_like_seal;
let _withdrawal :
    Wagyu.PostDeleteRequestV1 ->
        Wagyu.PublishLocalResultV1 =
    wagyu.wagyu_withdrawal_advance;
let _feedPromote :
    Wagyu.FeedPromoteRequestV1 -> Wagyu.Nat64LocalResultV1 =
    wagyu.wagyu_feed_promote;
let _feedReject :
    Wagyu.FeedRejectRequestV1 -> Wagyu.Nat64LocalResultV1 =
    wagyu.wagyu_feed_reject;
let _notificationPromote :
    Wagyu.NotificationPromoteRequestV1 ->
        async* Wagyu.Nat64LocalResultV1 =
    wagyu.wagyu_notification_promote;
let _markRead :
    Wagyu.NotificationsMarkReadRequestV1 -> Wagyu.Nat64LocalResultV1 =
    wagyu.wagyu_notifications_mark_read;
let _authored :
    Wagyu.AuthoredPageRequestV1 -> Wagyu.AuthoredPageV1 =
    wagyu.wagyu_authored_page;
let _outbox :
    Wagyu.OutboxPageRequestV1 -> Wagyu.OutboxPageV1 =
    wagyu.wagyu_outbox_page;
let _drain :
    Wagyu.OutboxDrainRequestV1 -> async* Wagyu.OutboxDrainResultV1 =
    wagyu.wagyu_outbox_drain;
let _retry :
    Wagyu.OutboxRetryRequestV1 -> async* Wagyu.OutboxDrainResultV1 =
    wagyu.wagyu_outbox_retry;
let _tick :
    ((), Wagyu.TaskCapabilities) -> async* () =
    wagyu.wagyu_outbox_tick;
let _ingressFollow :
    (Wagyu.WagyuIngressV1, Principal) -> Wagyu.WagyuRouteResultV1 =
    wagyu.wagyu_ingress_follow_v1;
let _ingressUnfollow :
    (Wagyu.WagyuIngressV1, Principal) -> Wagyu.UnfollowRouteResultV1 =
    wagyu.wagyu_ingress_unfollow_v1;
let _ingressDeliver :
    (Wagyu.WagyuIngressV1, Principal) -> Wagyu.WagyuRouteResultV1 =
    wagyu.wagyu_ingress_deliver_v1;
let _ingressLike :
    (Wagyu.WagyuIngressV1, Principal) -> Wagyu.WagyuRouteResultV1 =
    wagyu.wagyu_ingress_like_v1;
let _ingressNotice :
    (Wagyu.WagyuIngressV1, Principal) -> Wagyu.WagyuRouteResultV1 =
    wagyu.wagyu_ingress_notice_v1;

let taskCapabilities : Wagyu.TaskCapabilities = {
    backend_calls = backendCalls;
};
ignore taskCapabilities;

assert (scopeInfoCalls == 0);
assert (mem.profile == null);

let initialStatus = wagyu.wagyu_status({});
assert (initialStatus.node == node);
assert (
    initialStatus.network_id ==
        "2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a"
);
assert (initialStatus.protocol == "wagyu_v1");
assert (initialStatus.profile_generation == installationGeneration);
assert (initialStatus.profile_revision == 0);
assert (initialStatus.state_revision == 1);
assert (not initialStatus.outbound_work_pending);
assert (initialStatus.outbox_queued_count == 0);
assert (initialStatus.certified_assets_ready);

let initialProfile = wagyu.wagyu_profile({});
assert (initialProfile.node == node);
assert (initialProfile.profile_generation == installationGeneration);
assert (initialProfile.revision == 0);
assert (initialProfile.compatible);
assert (not initialProfile.avatar_present);
assert (mem.profile == null);

// Reconstructing the runtime does not create a profile or call the ordinary
// capability. The exact-path mutable object remains absent until the first
// owner edit.
let _afterUpgrade = Wagyu.Init(environment);
// Status resolves the previously unknown installation context once and then
// checks current store readiness once. Profile and reconstruction reuse the
// stored context without another lookup.
assert (scopeInfoCalls == 2);
assert (mem.profile == null);
