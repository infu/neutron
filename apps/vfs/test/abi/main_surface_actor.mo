// Compile-only ABI probe.
//
// Every argument and result type comes directly from backend/main.mo. The
// TypeScript ABI test emits this actor's Candid and checks strict structural
// equality with candid/files-v2.did. No method body is executable.
import Debug "mo:core/Debug";
import Main "../../backend/main";

persistent actor {
    public query func files_bootstrap_v2(
        _request : Main.FilesBootstrapRequestV2,
    ) : async Main.FilesBootstrapOutputV2 {
        Debug.todo();
    };

    public query func files_list_v2(
        _request : Main.FilesListRequestV2,
    ) : async Main.FilesListOutputV2 {
        Debug.todo();
    };

    public query func files_lookup_v2(
        _request : Main.FilesLookupRequestV2,
    ) : async Main.FilesLookupOutputV2 {
        Debug.todo();
    };

    public query func files_read_chunk_v2(
        _request : Main.FilesReadChunkRequestV2,
    ) : async Main.FilesReadChunkOutputV2 {
        Debug.todo();
    };

    public query func files_operation_status_v2(
        _request : Main.FilesOperationStatusRequestV2,
    ) : async Main.FilesOperationStatusResponseV2 {
        Debug.todo();
    };

    public shared func files_vault_write_v2(
        _request : Main.FilesVaultWriteRequestV2,
    ) : async Main.FilesVaultWriteResponseV2 {
        Debug.todo();
    };

    public shared func files_write_block_v2(
        _request : Main.FilesWriteBlockRequestV2,
    ) : async Main.FilesWriteBlockResponseV2 {
        Debug.todo();
    };

    public shared func files_mutate_v2(
        _request : Main.FilesMutateRequestV2,
    ) : async Main.FilesMutateResponseV2 {
        Debug.todo();
    };

    public shared func files_remove_v2(
        _request : Main.FilesRemoveRequestV2,
    ) : async Main.FilesRemoveResponseV2 {
        Debug.todo();
    };

    public shared func files_abort_v2(
        _request : Main.FilesAbortRequestV2,
    ) : async Main.FilesAbortResponseV2 {
        Debug.todo();
    };

    public shared func files_cleanup_v2(
        _request : Main.FilesCleanupRequestV2,
    ) : async Main.FilesCleanupResponseV2 {
        Debug.todo();
    };

};
