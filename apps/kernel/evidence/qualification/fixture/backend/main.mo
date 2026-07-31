import Capabilities "mo:neutron-capabilities";

module {
    public type Environment = {
        capabilities : {
            certified_assets : Capabilities.CertifiedAssetsV2;
        };
    };

    // This actor is deliberately policy-free. Qualification drives the same
    // closed app capability that production actors receive and supplies all
    // scenario data from the fixed synthetic plan.
    public class Init(environment : Environment) {
        let assets = environment.capabilities.certified_assets;

        public func /*query*/qualification_scope_info() : Capabilities.ScopeInfoResult {
            assets.scope_info()
        };

        public func /*update*/qualification_begin_stage(
            input : Capabilities.BeginStageInput
        ) : Capabilities.BeginStageResult {
            assets.begin_stage(input)
        };

        public func /*update*/qualification_put_chunk(
            input : Capabilities.PutChunkInput
        ) : Capabilities.ChunkResult {
            assets.put_chunk(input)
        };

        public func /*query*/qualification_stage_status(
            stageId : Nat64
        ) : Capabilities.StageStatusResult {
            assets.stage_status(stageId)
        };

        public func /*update*/qualification_abort_stage(
            stageId : Nat64
        ) : Capabilities.Result {
            assets.abort_stage(stageId)
        };

        public func /*update*/qualification_commit_batch(
            input : Capabilities.CommitBatchInput
        ) : Capabilities.CommitBatchResult {
            assets.commit_batch(input)
        };

        public func /*query*/qualification_record_status(
            target : Capabilities.Target
        ) : Capabilities.RecordStatusResult {
            assets.record_status(target)
        };

        public func /*update*/qualification_maintenance_page() : Capabilities.MaintenancePageResult {
            assets.maintenance_page()
        };

        public func /*query*/qualification_usage() : Capabilities.UsageResult {
            assets.usage()
        };
    };
};
