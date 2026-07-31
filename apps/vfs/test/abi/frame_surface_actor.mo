// Compile-only inner frame ABI probe.
//
// Each method round-trips one canonical root control through the public types
// exported by backend/files/Frames.mo. The ABI test emits this actor's Candid
// and checks strict structural equality in both directions against
// candid/files-v2-frames.did with the matching synthetic service appended.
import Frames "../../backend/files/Frames";

persistent actor {
    public query func frame_vault_read(
        value : Frames.VaultReadFrameControl,
    ) : async Frames.VaultReadFrameControl {
        value;
    };

    public query func frame_vault_write(
        value : Frames.VaultWriteFrameControl,
    ) : async Frames.VaultWriteFrameControl {
        value;
    };

    public query func frame_list(
        value : Frames.ListFrameControl,
    ) : async Frames.ListFrameControl {
        value;
    };

    public query func frame_lookup(
        value : Frames.LookupFrameControl,
    ) : async Frames.LookupFrameControl {
        value;
    };

    public query func frame_read_block(
        value : Frames.ReadBlockFrameControl,
    ) : async Frames.ReadBlockFrameControl {
        value;
    };

    public query func frame_mutate(
        value : Frames.MutateFrameControl,
    ) : async Frames.MutateFrameControl {
        value;
    };

    public query func frame_write_block(
        value : Frames.WriteBlockFrameControl,
    ) : async Frames.WriteBlockFrameControl {
        value;
    };
};
