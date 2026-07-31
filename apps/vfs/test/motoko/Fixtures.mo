import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Nat32 "mo:core/Nat32";
import Nat64 "mo:core/Nat64";
import Nat8 "mo:core/Nat8";
import Capabilities "mo:neutron-capabilities";
import Frames "../../backend/files/Frames";
import Types "../../backend/files/Types";

module {
    public func id(value : Nat) : Types.Id128 {
        { hi = 0; lo = Nat64.fromNat(value) };
    };

    public func digest(value : Nat64) : Frames.Digest256 {
        { a = 0; b = 0; c = 0; d = value };
    };

    public func zeros(count : Nat) : Blob {
        Blob.fromArray(Array.tabulate<Nat8>(count, func(_) { 0 }));
    };

    public func pack(control : Blob, raw : Blob) : Blob {
        let length = Nat32.fromNat(control.size());
        Frames.append([
            Blob.fromArray([
                Nat8.fromNat(Nat32.toNat(length >> 24) % 256),
                Nat8.fromNat(Nat32.toNat(length >> 16) % 256),
                Nat8.fromNat(Nat32.toNat(length >> 8) % 256),
                Nat8.fromNat(Nat32.toNat(length) % 256),
            ]),
            control,
            raw,
        ]);
    };

    public func vaultInitializeBody(
        requestId : Types.Id128,
    ) : Blob {
        let control : Frames.VaultWriteFrameControl = {
            request_id = requestId;
            expected_record_revision = null;
            proposed_record_revision = 1;
            operation = ?#initialize({
                format = 2;
                vault_id = id(100);
                vault_salt = digest(1);
                slot_generation = 1;
                public_key_fingerprint = digest(2);
                root_commitment = digest(3);
                root_structural_revision = 1;
                root_metadata_revision = 1;
                root_children_revision = 0;
                ibe_wrapped_root_key = { offset = 0; length = 32 };
                encrypted_root_metadata = { offset = 32; length = 16 };
            });
            raw_payload_bytes = 48;
        };
        pack(to_candid (control), zeros(48));
    };

    public func zeroLimits() : Capabilities.Limits {
        {
            entries = 0;
            committed_bytes = 0;
            object_bytes = 0;
            staged_bytes = 0;
            pending_stages = 0;
            batch_operations = 0;
            batch_bytes = 0;
            general_receipts = 0;
            revocation_lanes = 0;
        };
    };

    public func zeroUsage() : Capabilities.Usage {
        {
            current = {
                live_entries = 0;
                occupied_entry_slots = 0;
                committed_body_bytes = 0;
                reserved_committed_body_bytes = 0;
                allocated_body_bytes = 0;
                charged_metadata_bytes = 0;
                accepted_staged_bytes = 0;
                reserved_staged_bytes = 0;
                detached_charged_bytes = 0;
                active_stages = 0;
                reserved_entry_slots = 0;
                receipt_lanes = 0;
                general_receipt_lanes = 0;
                reserved_general_receipt_lanes = 0;
                reserved_revocation_lanes = 0;
                filled_revocation_lanes = 0;
                receipt_nonce_indexes = 0;
                receipt_expiry_indexes = 0;
                cleanup_jobs = 0;
            };
            manifest_limits = zeroLimits();
            effective_limits = zeroLimits();
        };
    };

    public func assets(
        usageValue : Capabilities.Usage,
    ) : Capabilities.CertifiedAssetsV2 {
        {
            scope_info = func() : Capabilities.ScopeInfoResult {
                #err(#disabled);
            };
            begin_stage = func(
                _input : Capabilities.BeginStageInput,
            ) : Capabilities.BeginStageResult {
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
            usage = func() : Capabilities.UsageResult {
                #ok(usageValue);
            };
        };
    };
};
