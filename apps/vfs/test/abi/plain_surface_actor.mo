// Compile-only ABI probe for the Files V3 plaintext boundary.
//
// Every argument and result type comes directly from backend/main.mo. The
// TypeScript ABI test emits this actor's Candid and checks strict structural
// equality with candid/files-plain-v3.did. No method body is executable.
import Debug "mo:core/Debug";
import Main "../../backend/main";

persistent actor {
    public query func files_plain_list_v3(
        _request : Main.FilesPlainListRequestV3,
    ) : async Main.FilesPlainListResponseV3 {
        Debug.todo();
    };

    public query func files_plain_stat_v3(
        _request : Main.FilesPlainStatRequestV3,
    ) : async Main.FilesPlainStatResponseV3 {
        Debug.todo();
    };

    public query func files_plain_read_chunk_v3(
        _request : Main.FilesPlainReadChunkRequestV3,
    ) : async Main.FilesPlainReadChunkOutputV3 {
        Debug.todo();
    };

    public shared func files_plain_write_block_v3(
        _request : Main.FilesPlainWriteBlockRequestV3,
    ) : async Main.FilesPlainWriteBlockResponseV3 {
        Debug.todo();
    };

    public shared func files_plain_mkdir_v3(
        _request : Main.FilesPlainMkdirRequestV3,
    ) : async Main.FilesPlainMutationResponseV3 {
        Debug.todo();
    };

    public shared func files_plain_move_v3(
        _request : Main.FilesPlainMoveRequestV3,
    ) : async Main.FilesPlainMutationResponseV3 {
        Debug.todo();
    };

    public shared func files_plain_remove_v3(
        _request : Main.FilesPlainRemoveRequestV3,
    ) : async Main.FilesPlainMutationResponseV3 {
        Debug.todo();
    };

    public shared func files_plain_abort_v3(
        _request : Main.FilesPlainAbortRequestV3,
    ) : async Main.FilesPlainMutationResponseV3 {
        Debug.todo();
    };

    public shared func files_plain_cleanup_v3(
        _request : Main.FilesPlainCleanupRequestV3,
    ) : async Main.FilesPlainMutationResponseV3 {
        Debug.todo();
    };
};
