import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Nat16 "mo:core/Nat16";
import Nat32 "mo:core/Nat32";
import Nat64 "mo:core/Nat64";
import Nat8 "mo:core/Nat8";
import Sha256 "mo:sha2/Sha256";
import Text "mo:core/Text";
import Frames "Frames";
import Keys "Keys";
import Memory "../memory/files/v1";
import Types "Types";

// Frozen, domain-separated semantic fingerprints. These never depend on
// Motoko's `to_candid` byte choices. Exact attachment bytes enter through
// their SHA-256 digest.
module {
    public func vaultWrite(
        request : Types.VaultWriteRequest,
        frameDigest : Types.Digest256,
    ) : Types.Digest256 {
        hash([
            lpText("neutron.files.request.vault-write.v2"),
            Keys.id128Bytes(request.request_id),
            optionVariant(
                switch (request.operation) {
                    case null null;
                    case (?#initialize) ?0;
                    case (?#rewrap) ?1;
                }
            ),
            optionNat64(request.expected_record_revision),
            u64(request.proposed_record_revision),
            u32(request.body_bytes),
            Keys.tag256Bytes(frameDigest),
        ]);
    };

    public func writeFirst(
        request : Types.WriteBlockRequest,
        frameDigest : Types.Digest256,
    ) : Types.Digest256 {
        hash([
            lpText("neutron.files.request.write-first.v2"),
            Keys.id128Bytes(request.request_id),
            optionNat64(request.stage_id),
            u8(request.frame_ordinal),
            bool(request.final),
            u32(request.body_bytes),
            Keys.tag256Bytes(frameDigest),
        ]);
    };

    public func writeFrame(
        request : Types.WriteBlockRequest,
        frameDigest : Types.Digest256,
    ) : Types.Digest256 {
        hash([
            lpText("neutron.files.request.write-frame.v2"),
            Keys.id128Bytes(request.request_id),
            optionNat64(request.stage_id),
            u8(request.frame_ordinal),
            bool(request.final),
            u32(request.body_bytes),
            Keys.tag256Bytes(frameDigest),
        ]);
    };

    public func storedWriteFramePlan(
        value : Memory.FramePlan
    ) : Types.Digest256 {
        let parts = Array.tabulate<Blob>(
            value.blocks.size() + 4,
            func(index) {
                if (index == 0) {
                    lpText("neutron.files.write-frame-plan.v2")
                } else if (index == 1) {
                    u8(value.ordinal)
                } else if (index == 2) {
                    u32(value.encoded_bytes)
                } else if (index == 3) {
                    u32(Nat32.fromNat(value.blocks.size()))
                } else {
                    let block = value.blocks[index - 4];
                    hashFramePlanBlock(
                        block.content_id,
                        block.block_index,
                        block.ciphertext_bytes,
                        block.frame_ordinal,
                        block.payload_offset,
                        block.payload_length,
                    )
                };
            },
        );
        hash(parts);
    };

    public func continuationWriteFramePlan(
        value : Frames.WriteContinuationFrame
    ) : Types.Digest256 {
        let parts = Array.tabulate<Blob>(
            value.blocks.size() + 4,
            func(index) {
                if (index == 0) {
                    lpText("neutron.files.write-frame-plan.v2")
                } else if (index == 1) {
                    u8(value.frame_ordinal)
                } else if (index == 2) {
                    u32(value.raw_payload_bytes)
                } else if (index == 3) {
                    u32(Nat32.fromNat(value.blocks.size()))
                } else {
                    let block = value.blocks[index - 4];
                    hashFramePlanBlock(
                        block.content_id,
                        block.block_index,
                        block.ciphertext_bytes,
                        value.frame_ordinal,
                        block.payload.offset,
                        block.payload.length,
                    )
                };
            },
        );
        hash(parts);
    };

    public func mutate(
        request : Types.MutateRequest,
        frameDigest : Types.Digest256,
    ) : Types.Digest256 {
        hash([
            lpText("neutron.files.request.mutate.v2"),
            Keys.id128Bytes(request.request_id),
            optionVariant(
                switch (request.action) {
                    case null null;
                    case (?#create_folder) ?0;
                    case (?#rename) ?1;
                    case (?#move) ?2;
                }
            ),
            u32(request.body_bytes),
            Keys.tag256Bytes(frameDigest),
        ]);
    };

    public func remove(request : Types.RemoveRequest) : Types.Digest256 {
        hash([
            lpText("neutron.files.request.remove.v2"),
            Keys.id128Bytes(request.request_id),
            Keys.id128Bytes(request.node_id),
            u64(request.expected_structural_revision),
            Keys.id128Bytes(request.expected_parent_id),
            u64(request.expected_parent_children_revision),
            bool(request.recursive),
        ]);
    };

    public func abort(request : Types.AbortRequest) : Types.Digest256 {
        hash([
            lpText("neutron.files.request.abort.v2"),
            Keys.id128Bytes(request.request_id),
            u64(request.stage_id),
        ]);
    };

    public func body(body : Blob) : Types.Digest256 {
        let digest = Sha256.fromBlob(#sha256, body);
        switch (Keys.tag256FromBytes(digest)) {
            case (?tag) tag;
            case null Types.ZERO_TAG;
        };
    };

    public func hash(parts : [Blob]) : Types.Digest256 {
        let digest = Sha256.fromBlob(#sha256, Frames.append(parts));
        switch (Keys.tag256FromBytes(digest)) {
            case (?tag) tag;
            case null Types.ZERO_TAG;
        };
    };

    public func lpText(value : Text) : Blob { lp(Text.encodeUtf8(value)) };

    public func lp(value : Blob) : Blob {
        Frames.append([u32(Nat32.fromNat(value.size())), value]);
    };

    public func u8(value : Nat8) : Blob { Blob.fromArray([value]) };

    public func u16(value : Nat16) : Blob {
        Blob.fromArray([
            Nat8.fromNat(Nat16.toNat(value >> 8) % 256),
            Nat8.fromNat(Nat16.toNat(value) % 256),
        ]);
    };

    public func u32(value : Nat32) : Blob {
        Blob.fromArray([
            Nat8.fromNat(Nat32.toNat(value >> 24) % 256),
            Nat8.fromNat(Nat32.toNat(value >> 16) % 256),
            Nat8.fromNat(Nat32.toNat(value >> 8) % 256),
            Nat8.fromNat(Nat32.toNat(value) % 256),
        ]);
    };

    public func u64(value : Nat64) : Blob {
        Blob.fromArray(
            Array.tabulate<Nat8>(
                8,
                func(index) {
                    Nat8.fromNat(
                        Nat64.toNat(value >> Nat64.fromNat((7 - index) * 8)) %
                        256
                    );
                },
            )
        );
    };

    public func bool(value : Bool) : Blob {
        if (value) Blob.fromArray([1]) else Blob.fromArray([0]);
    };

    func hashFramePlanBlock(
        contentId : Types.Id128,
        blockIndex : Nat32,
        ciphertextBytes : Nat32,
        frameOrdinal : Nat8,
        payloadOffset : Nat32,
        payloadLength : Nat32,
    ) : Blob {
        Frames.append([
            Keys.id128Bytes(contentId),
            u32(blockIndex),
            u32(ciphertextBytes),
            u8(frameOrdinal),
            u32(payloadOffset),
            u32(payloadLength),
        ]);
    };

    func optionVariant(value : ?Nat8) : Blob {
        switch (value) {
            case null Blob.fromArray([0]);
            case (?tag) Blob.fromArray([1, tag]);
        };
    };

    func optionNat64(value : ?Nat64) : Blob {
        switch (value) {
            case null Blob.fromArray([0]);
            case (?number) Frames.append([Blob.fromArray([1]), u64(number)]);
        };
    };

};
