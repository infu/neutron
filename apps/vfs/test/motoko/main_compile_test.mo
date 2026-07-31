import Capabilities "mo:neutron-capabilities";
import Files "../../backend/main";
import Memory "../../backend/memory/files/v2";

var beginStageCalls = 0;

let disabledAssets : Capabilities.CertifiedAssetsV2 = {
    scope_info = func() : Capabilities.ScopeInfoResult { #err(#disabled) };
    begin_stage = func(
        _input : Capabilities.BeginStageInput,
    ) : Capabilities.BeginStageResult {
        beginStageCalls += 1;
        #err(#disabled);
    };
    put_chunk = func(
        _input : Capabilities.PutChunkInput,
    ) : Capabilities.ChunkResult {
        #err(#disabled);
    };
    stage_status = func(
        _stageId : Nat64,
    ) : Capabilities.StageStatusResult {
        #err(#disabled);
    };
    abort_stage = func(_stageId : Nat64) : Capabilities.Result {
        #err(#disabled);
    };
    commit_batch = func(
        _input : Capabilities.CommitBatchInput,
    ) : Capabilities.CommitBatchResult {
        #err(#disabled);
    };
    record_status = func(
        _target : Capabilities.Target,
    ) : Capabilities.RecordStatusResult {
        #err(#disabled);
    };
    maintenance_page = func() : Capabilities.MaintenancePageResult {
        #err(#disabled);
    };
    usage = func() : Capabilities.UsageResult { #err(#disabled) };
};

let files = Files.Init({
    stable_memory = {
        files = Memory.init();
    };
    capabilities = {
        certified_assets = disabledAssets;
    };
});

let _bootstrap :
    Files.FilesBootstrapRequestV2 -> Files.FilesBootstrapOutputV2 =
    files.files_bootstrap_v2;
let _list : Files.FilesListRequestV2 -> Files.FilesListOutputV2 =
    files.files_list_v2;
let _lookup :
    Files.FilesLookupRequestV2 -> Files.FilesLookupOutputV2 =
    files.files_lookup_v2;
let _read :
    Files.FilesReadChunkRequestV2 -> Files.FilesReadChunkOutputV2 =
    files.files_read_chunk_v2;
let _status :
    Files.FilesOperationStatusRequestV2 ->
        Files.FilesOperationStatusResponseV2 =
    files.files_operation_status_v2;
let _vaultWrite :
    Files.FilesVaultWriteRequestV2 ->
        Files.FilesVaultWriteResponseV2 =
    files.files_vault_write_v2;
let _write :
    Files.FilesWriteBlockRequestV2 ->
        Files.FilesWriteBlockResponseV2 =
    files.files_write_block_v2;
let _mutate :
    Files.FilesMutateRequestV2 -> Files.FilesMutateResponseV2 =
    files.files_mutate_v2;
let _remove :
    Files.FilesRemoveRequestV2 -> Files.FilesRemoveResponseV2 =
    files.files_remove_v2;
let _abort : Files.FilesAbortRequestV2 -> Files.FilesAbortResponseV2 =
    files.files_abort_v2;
let _cleanup :
    Files.FilesCleanupRequestV2 -> Files.FilesCleanupResponseV2 =
    files.files_cleanup_v2;
let _plainList :
    Files.FilesPlainListRequestV3 -> Files.FilesPlainListResponseV3 =
    files.files_plain_list_v3;
let _plainStat :
    Files.FilesPlainStatRequestV3 -> Files.FilesPlainStatResponseV3 =
    files.files_plain_stat_v3;
let _plainRead :
    Files.FilesPlainReadChunkRequestV3 ->
        Files.FilesPlainReadChunkOutputV3 =
    files.files_plain_read_chunk_v3;
let _plainWrite :
    Files.FilesPlainWriteBlockRequestV3 ->
        Files.FilesPlainWriteBlockResponseV3 =
    files.files_plain_write_block_v3;
let _plainMkdir :
    Files.FilesPlainMkdirRequestV3 ->
        Files.FilesPlainMutationResponseV3 =
    files.files_plain_mkdir_v3;
let _plainMove :
    Files.FilesPlainMoveRequestV3 ->
        Files.FilesPlainMutationResponseV3 =
    files.files_plain_move_v3;
let _plainRemove :
    Files.FilesPlainRemoveRequestV3 ->
        Files.FilesPlainMutationResponseV3 =
    files.files_plain_remove_v3;
let _plainAbort :
    Files.FilesPlainAbortRequestV3 ->
        Files.FilesPlainMutationResponseV3 =
    files.files_plain_abort_v3;
let _plainCleanup :
    Files.FilesPlainCleanupRequestV3 ->
        Files.FilesPlainMutationResponseV3 =
    files.files_plain_cleanup_v3;

// Mirror the compiler-created wrappers. Blob fields remain inside the named
// request records and every wrapper has exactly the authored argument list.
func generatedBootstrap(
    request : Files.files_bootstrap_v2_Input,
) : Files.files_bootstrap_v2_Output {
    files.files_bootstrap_v2(request);
};
func generatedLookup(
    request : Files.files_lookup_v2_Input,
) : Files.files_lookup_v2_Output {
    files.files_lookup_v2(request);
};
func generatedVaultWrite(
    request : Files.files_vault_write_v2_Input,
) : Files.files_vault_write_v2_Output {
    files.files_vault_write_v2(request);
};
func generatedWrite(
    request : Files.files_write_block_v2_Input,
) : Files.files_write_block_v2_Output {
    files.files_write_block_v2(request);
};
func generatedMutate(
    request : Files.files_mutate_v2_Input,
) : Files.files_mutate_v2_Output {
    files.files_mutate_v2(request);
};
ignore generatedBootstrap;
ignore generatedLookup;
ignore generatedVaultWrite;
ignore generatedWrite;
ignore generatedMutate;

switch (files.files_bootstrap_v2({}).value.outcome) {
    case (?#rejected({ reason = ?#temporarily_unavailable })) {};
    case (_) assert false;
};

assert (beginStageCalls == 0);
