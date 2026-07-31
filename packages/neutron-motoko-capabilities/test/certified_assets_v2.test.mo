import Caps "../src/lib";

let blob16 : Blob = "0123456789abcdef";
let blob32 : Blob = "0123456789abcdef0123456789abcdef";

let publicationLocator : Caps.Locator = #publication({
    publication_id = blob32;
    filename = "hello.txt";
});
let digestLocator : Caps.Locator = #body_sha256({ digest = blob32 });
let keyLocator : Caps.Locator = #key32({ key = blob32 });
let exactPathLocator : Caps.Locator = #exact_path;

let publicationTarget : Caps.Target = {
    collection = "shares";
    collection_generation = 3;
    locator = publicationLocator;
};
let digestTarget : Caps.Target = {
    collection = "posts";
    collection_generation = 4;
    locator = digestLocator;
};
let keyTarget : Caps.Target = {
    collection = "like_heads";
    collection_generation = 5;
    locator = keyLocator;
};
let exactPathTarget : Caps.Target = {
    collection = "profile";
    collection_generation = 6;
    locator = exactPathLocator;
};

let limits : Caps.Limits = {
    entries = 100_000;
    committed_bytes = 1_073_741_824;
    object_bytes = 1_048_576;
    staged_bytes = 1_048_576;
    pending_stages = 8;
    batch_operations = 16;
    batch_bytes = 1_048_576;
    general_receipts = 4_096;
    revocation_lanes = 100_000;
};

let collection : Caps.CollectionInfo = {
    id = "posts";
    kind = #immutable_blob;
    authority_epoch = 8;
    generation = 4;
    serving = #enabled;
    writes = #enabled;
    manifest_limits = limits;
    effective_limits = limits;
};
let _publicationCollection : Caps.CollectionInfo = {
    collection with
    id = "shares";
    kind = #publication;
};
let _keyedMutableCollection : Caps.CollectionInfo = {
    collection with
    id = "like_heads";
    kind = #mutable_blob;
};
let _exactPathMutableCollection : Caps.CollectionInfo = {
    collection with
    id = "profile";
    kind = #mutable_blob;
};

let scopeInfo : Caps.ScopeInfo = {
    installation_generation = 11;
    store_authority_epoch = 8;
    collections = [collection];
};

let fixedGeometry : Caps.StageGeometry = {
    block_bytes = 65_536;
    block_count = 1;
    expected_bytes = 5;
};

let recordIdentity : Caps.RecordIdentity = {
    target = digestTarget;
    kernel_revision = 1;
    content_tag = blob32;
    body_bytes = 5;
    geometry = fixedGeometry;
    block_hashes = [blob32];
};
let casIdentity : Caps.CasIdentity = {
    collection_generation = 4;
    kernel_revision = 1;
    content_tag = blob32;
    body_bytes = 5;
};
let deletedIdentity : Caps.DeletedIdentity = {
    target = digestTarget;
    kernel_revision = 2;
    prior_content_tag = blob32;
};
let lifecycle : Caps.LifecycleOutcome = {
    committed = recordIdentity;
};

let beginPublication : Caps.BeginStageInput = {
    nonce = blob16;
    target = #allocate_publication({
        collection = "shares";
        collection_generation = 3;
        filename = "hello.txt";
        presentation = #inline_text;
    });
    expected_bytes = 5;
};
let beginDigest : Caps.BeginStageInput = {
    nonce = blob16;
    target = #derive_body_sha256({
        collection = "posts";
        collection_generation = 4;
    });
    expected_bytes = 5;
};
let stageIdentity : Caps.StageIdentity = {
    collection = "posts";
    collection_generation = 4;
    computed_target = ?digestTarget;
};
let beginOk : Caps.BeginStageOk = {
    stage_id = 9;
    identity = stageIdentity;
    geometry = fixedGeometry;
    expires_at_ns = 3_600_000_000_000;
};
let chunkInput : Caps.PutChunkInput = {
    stage_id = 9;
    index = 0;
    body = "hello";
};
let chunkOk : Caps.ChunkOk = {
    stage_id = 9;
    index = 0;
    block_sha256 = blob32;
    accepted = #new;
    complete = true;
    raw_sha256 = ?blob32;
    computed_target = ?digestTarget;
};
let _replayedChunk : Caps.ChunkOk = {
    chunkOk with accepted = #replayed;
};

let progress : Caps.StageProgress = {
    next_block_index = 1;
    block_hashes = [blob32];
};
let terminal : Caps.StageTerminal = {
    stage_id = 9;
    identity = stageIdentity;
    geometry = fixedGeometry;
    terminal_at_ns = 100;
    reconcile_until_ns = 200;
};
let activeStatus : Caps.StageStatus = #active({
    stage_id = 9;
    identity = stageIdentity;
    geometry = fixedGeometry;
    progress;
    raw_sha256 = ?blob32;
    expires_at_ns = 150;
});
let _stageStatuses : [Caps.StageStatus] = [
    activeStatus,
    #active({
        stage_id = 10;
        identity = {
            collection = "shares";
            collection_generation = 3;
            computed_target = ?publicationTarget;
        };
        geometry = fixedGeometry;
        progress;
        raw_sha256 = null;
        expires_at_ns = 150;
    }),
    #consumed({ stage = terminal; lifecycle }),
    #aborted(terminal),
    #expired(terminal),
    #unknown,
];

let positiveBatch : Caps.CommitBatchInput = {
    nonce = blob16;
    operations = [
        #put({
            target = digestTarget;
            condition = #absent;
            body = #stage(9);
        }),
        #put({
            target = keyTarget;
            condition = #match({
                revision = 1;
                content_tag = blob32;
            });
            body = #inline("head");
        }),
    ];
    requires_present_after = [{
        target = digestTarget;
        content_tag = blob32;
        revision = ?1;
    }];
};
let deleteBatch : Caps.CommitBatchInput = {
    nonce = blob16;
    operations = [#delete({
        target = publicationTarget;
        condition = {
            revision = 1;
            content_tag = blob32;
        };
    })];
    requires_present_after = [];
};

let putReceipt : Caps.PutReceipt = {
    request_index = 0;
    lifecycle;
};
let deleteReceipt : Caps.DeleteReceipt = {
    request_index = 0;
    identity = deletedIdentity;
};
let batchReceipt : Caps.BatchReceipt = {
    operations = [#put(putReceipt), #delete(deleteReceipt)];
};

let _recordStatuses : [Caps.RecordStatus] = [
    #present(recordIdentity),
    #absent({ collection_generation = 4 }),
    #recently_deleted(deletedIdentity),
    #deleted_high_water(deletedIdentity),
];
let reclaimed : Caps.Reclaimed = {
    records = 1;
    bodies = 1;
    body_bytes = 5;
    charged_bytes = 128;
    authenticated_nodes = 4;
    receipts = 1;
};
let maintenance : Caps.MaintenancePageOk = {
    page = reclaimed;
    has_more = false;
    remaining_jobs = 0;
};
let counters : Caps.UsageCounters = {
    live_entries = 1;
    occupied_entry_slots = 1;
    committed_body_bytes = 5;
    reserved_committed_body_bytes = 5;
    allocated_body_bytes = 16;
    charged_metadata_bytes = 128;
    accepted_staged_bytes = 5;
    reserved_staged_bytes = 5;
    detached_charged_bytes = 0;
    active_stages = 1;
    reserved_entry_slots = 1;
    receipt_lanes = 3;
    general_receipt_lanes = 1;
    reserved_general_receipt_lanes = 1;
    reserved_revocation_lanes = 1;
    filled_revocation_lanes = 0;
    receipt_nonce_indexes = 1;
    receipt_expiry_indexes = 1;
    cleanup_jobs = 0;
};
let usage : Caps.Usage = {
    current = counters;
    manifest_limits = limits;
    effective_limits = limits;
};

let _errors : [Caps.Error] = [
    #invalid,
    #stale_scope,
    #stale_generation({ current = 4 }),
    #disabled,
    #frozen,
    #not_found,
    #retired_key,
    #conflict({ current = ?casIdentity }),
    #quota,
    #receipt_full,
    #aborted,
    #expired,
    #incomplete({ missing_blocks = [0] }),
    #not_ready,
    #generation_exhausted,
    #revision_exhausted,
    #low_cycles,
    #busy,
];

let _scopeResult : Caps.ScopeInfoResult = #ok(scopeInfo);
let _beginResult : Caps.BeginStageResult = #ok(beginOk);
let _chunkResult : Caps.ChunkResult = #ok(chunkOk);
let _statusResult : Caps.StageStatusResult = #ok(activeStatus);
let _batchResult : Caps.CommitBatchResult = #ok(batchReceipt);
let _recordResult : Caps.RecordStatusResult = #ok(#present(recordIdentity));
let _maintenanceResult : Caps.MaintenancePageResult = #ok(maintenance);
let _usageResult : Caps.UsageResult = #ok(usage);
let _result : Caps.Result = #ok;

let _handle : Caps.CertifiedAssetsV2 = {
    scope_info = func() : Caps.ScopeInfoResult { #ok(scopeInfo) };
    begin_stage = func(_input : Caps.BeginStageInput) : Caps.BeginStageResult {
        #ok(beginOk)
    };
    put_chunk = func(_input : Caps.PutChunkInput) : Caps.ChunkResult {
        #ok(chunkOk)
    };
    stage_status = func(_stageId : Nat64) : Caps.StageStatusResult {
        #ok(activeStatus)
    };
    abort_stage = func(_stageId : Nat64) : Caps.Result { #ok };
    commit_batch = func(_input : Caps.CommitBatchInput) : Caps.CommitBatchResult {
        #ok(batchReceipt)
    };
    record_status = func(_target : Caps.Target) : Caps.RecordStatusResult {
        #ok(#present(recordIdentity))
    };
    maintenance_page = func() : Caps.MaintenancePageResult {
        #ok(maintenance)
    };
    usage = func() : Caps.UsageResult { #ok(usage) };
};

ignore beginPublication;
ignore beginDigest;
ignore chunkInput;
ignore positiveBatch;
ignore deleteBatch;
ignore exactPathTarget;
