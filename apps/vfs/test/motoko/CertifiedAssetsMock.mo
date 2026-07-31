import Nat64 "mo:core/Nat64";
import Capabilities "mo:neutron-capabilities";

module {
    public class Mock(initialUsage : Capabilities.Usage) {
        public var scope_info_result : Capabilities.ScopeInfoResult =
            #err(#disabled);
        public var begin_stage_result : Capabilities.BeginStageResult =
            #err(#disabled);
        public var put_chunk_result : Capabilities.ChunkResult =
            #err(#disabled);
        public var stage_status_result : Capabilities.StageStatusResult =
            #err(#disabled);
        public var abort_stage_result : Capabilities.Result =
            #err(#disabled);
        public var commit_batch_result : Capabilities.CommitBatchResult =
            #err(#disabled);
        public var commit_batch_results : [
            Capabilities.CommitBatchResult
        ] = [];
        public var commit_batch_result_index = 0;
        public var record_status_result : Capabilities.RecordStatusResult =
            #err(#disabled);
        public var maintenance_page_result :
            Capabilities.MaintenancePageResult = #err(#disabled);
        public var usage_result : Capabilities.UsageResult =
            #ok(initialUsage);

        public var scope_info_calls = 0;
        public var begin_stage_calls = 0;
        public var put_chunk_calls = 0;
        public var stage_status_calls = 0;
        public var abort_stage_calls = 0;
        public var commit_batch_calls = 0;
        public var record_status_calls = 0;
        public var maintenance_page_calls = 0;
        public var usage_calls = 0;

        public var last_begin_stage : ?Capabilities.BeginStageInput = null;
        public var last_put_chunk : ?Capabilities.PutChunkInput = null;
        public var last_stage_status : ?Nat64 = null;
        public var last_abort_stage : ?Nat64 = null;
        public var last_commit_batch : ?Capabilities.CommitBatchInput = null;
        public var last_record_status : ?Capabilities.Target = null;

        public func handle() : Capabilities.CertifiedAssetsV2 {
            {
                scope_info = func() : Capabilities.ScopeInfoResult {
                    scope_info_calls += 1;
                    scope_info_result;
                };
                begin_stage = func(
                    input : Capabilities.BeginStageInput,
                ) : Capabilities.BeginStageResult {
                    begin_stage_calls += 1;
                    last_begin_stage := ?input;
                    begin_stage_result;
                };
                put_chunk = func(
                    input : Capabilities.PutChunkInput,
                ) : Capabilities.ChunkResult {
                    put_chunk_calls += 1;
                    last_put_chunk := ?input;
                    put_chunk_result;
                };
                stage_status = func(
                    stageId : Nat64,
                ) : Capabilities.StageStatusResult {
                    stage_status_calls += 1;
                    last_stage_status := ?stageId;
                    stage_status_result;
                };
                abort_stage = func(
                    stageId : Nat64,
                ) : Capabilities.Result {
                    abort_stage_calls += 1;
                    last_abort_stage := ?stageId;
                    abort_stage_result;
                };
                commit_batch = func(
                    input : Capabilities.CommitBatchInput,
                ) : Capabilities.CommitBatchResult {
                    commit_batch_calls += 1;
                    last_commit_batch := ?input;
                    if (
                        commit_batch_result_index <
                        commit_batch_results.size()
                    ) {
                        let result =
                            commit_batch_results[
                                commit_batch_result_index
                            ];
                        commit_batch_result_index += 1;
                        result;
                    } else {
                        commit_batch_result;
                    };
                };
                record_status = func(
                    target : Capabilities.Target,
                ) : Capabilities.RecordStatusResult {
                    record_status_calls += 1;
                    last_record_status := ?target;
                    record_status_result;
                };
                maintenance_page =
                    func() : Capabilities.MaintenancePageResult {
                        maintenance_page_calls += 1;
                        maintenance_page_result;
                    };
                usage = func() : Capabilities.UsageResult {
                    usage_calls += 1;
                    usage_result;
                };
            };
        };
    };
};
