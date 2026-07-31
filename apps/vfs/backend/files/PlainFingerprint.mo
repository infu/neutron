import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Nat32 "mo:core/Nat32";
import Nat64 "mo:core/Nat64";
import Nat8 "mo:core/Nat8";
import Sha256 "mo:sha2/Sha256";
import Text "mo:core/Text";
import Keys "Keys";
import Types "PlainTypes";
import Memory "../memory/files/v2";

// Frozen semantic fingerprints for plaintext V3 mutations.
//
// The encoding is independent of Candid and Motoko's `to_candid` output:
// variable-width values are length-prefixed, integers are fixed-width
// big-endian, and options/variants carry explicit one-byte tags. Each request
// kind has its own domain. Write bodies are hashed before the small request
// envelope is streamed into a second SHA-256 digest, so fingerprinting never
// constructs a body-sized intermediate value.
module {
    public type Fingerprint = Memory.Tag256;

    type Digest = {
        writeBlob : Blob -> ();
        sum : () -> Blob;
    };

    public func writeBlock(
        request : Types.WriteBlockRequest
    ) : Fingerprint {
        // Keep the only potentially large value out of the request envelope.
        let bodyDigest = Sha256.fromBlob(#sha256, request.body);
        let digest = begin("neutron.files.plain.request.write-block.v3");

        writeText(digest, request.request_id);
        writeSpace(digest, request.space);
        writeText(digest, request.path);
        writeOptionNat64(digest, request.stage_id);
        writeU32(digest, request.block_index);
        writeU32(digest, request.block_count);
        writeU64(digest, request.total_bytes);
        writeContentKind(digest, request.content_kind);
        writeText(digest, request.media_type);
        writeText(digest, request.etag_sha256);
        writePresentation(digest, request.presentation);
        writeOptionNat64(digest, request.expected_node_id);
        writeOptionNat64(digest, request.expected_revision);
        writeOptionText(digest, request.if_match);
        writeBool(digest, request.if_none_match);
        writeBool(digest, request.create_parents);
        writeBool(digest, request.final);
        writeOptionText(digest, request.safe_name);
        writeOptionBlob(digest, request.begin_nonce);
        writeOptionBlob(digest, request.commit_nonce);
        writeOptionBlob(digest, request.delete_nonce);
        writeMoveSource(digest, request.move_source);
        writeU32(digest, request.body_bytes);
        writeU64(digest, Nat64.fromNat(request.body.size()));
        // SHA-256 output is fixed at 32 bytes; no allocation or prefix needed.
        digest.writeBlob(bodyDigest);

        finish(digest);
    };

    public func mkdir(request : Types.MkdirRequest) : Fingerprint {
        let digest = begin("neutron.files.plain.request.mkdir.v3");
        writeText(digest, request.request_id);
        writeSpace(digest, request.space);
        writeText(digest, request.path);
        writeBool(digest, request.recursive);
        finish(digest);
    };

    public func move(request : Types.MoveRequest) : Fingerprint {
        let digest = begin("neutron.files.plain.request.move.v3");
        writeText(digest, request.request_id);
        writeSpace(digest, request.space);
        writeText(digest, request.from);
        writeText(digest, request.to);
        writeBool(digest, request.overwrite);
        writeU64(digest, request.expected_node_id);
        writeU64(digest, request.expected_revision);
        writeOptionText(digest, request.if_match);
        finish(digest);
    };

    public func remove(request : Types.RemoveRequest) : Fingerprint {
        let digest = begin("neutron.files.plain.request.remove.v3");
        writeText(digest, request.request_id);
        writeSpace(digest, request.space);
        writeText(digest, request.path);
        writeBool(digest, request.recursive);
        writeU64(digest, request.expected_node_id);
        writeU64(digest, request.expected_revision);
        writeOptionText(digest, request.if_match);
        writeOptionBlob(digest, request.delete_nonce);
        finish(digest);
    };

    public func abort(request : Types.AbortRequest) : Fingerprint {
        let digest = begin("neutron.files.plain.request.abort.v3");
        writeText(digest, request.request_id);
        writeSpace(digest, request.space);
        writeOptionNat64(digest, request.stage_id);
        finish(digest);
    };

    public func cleanup(request : Types.CleanupRequest) : Fingerprint {
        let digest = begin("neutron.files.plain.request.cleanup.v3");
        writeText(digest, request.request_id);
        writeU8(digest, request.limit);
        finish(digest);
    };

    public func body(value : Blob) : Fingerprint {
        fingerprint(Sha256.fromBlob(#sha256, value));
    };

    func begin(domain : Text) : Sha256.Digest {
        let digest = Sha256.Digest(#sha256);
        writeText(digest, domain);
        digest;
    };

    func finish(digest : Digest) : Fingerprint {
        fingerprint(digest.sum());
    };

    func fingerprint(value : Blob) : Fingerprint {
        switch (Keys.tag256FromBytes(value)) {
            case (?result) result;
            // SHA-256 always produces exactly 32 bytes.
            case null (0, 0, 0, 0);
        };
    };

    func writeSpace(digest : Digest, value : ?Types.Space) {
        switch (value) {
            case null writeU8(digest, 0);
            case (?space) {
                writeU8(digest, 1);
                switch (space) {
                    case (#shared_) writeU8(digest, 0);
                    case (#workspace) writeU8(digest, 1);
                };
            };
        };
    };

    func writeContentKind(
        digest : Digest,
        value : ?Types.ContentKind,
    ) {
        switch (value) {
            case null writeU8(digest, 0);
            case (?kind) {
                writeU8(digest, 1);
                switch (kind) {
                    case (#text) writeU8(digest, 0);
                    case (#binary) writeU8(digest, 1);
                };
            };
        };
    };

    func writePresentation(
        digest : Digest,
        value : ?Types.Presentation,
    ) {
        switch (value) {
            case null writeU8(digest, 0);
            case (?presentation) {
                writeU8(digest, 1);
                switch (presentation) {
                    case (#inline_text) writeU8(digest, 0);
                    case (#attachment) writeU8(digest, 1);
                };
            };
        };
    };

    func writeMoveSource(
        digest : Digest,
        value : ?Types.WriteMoveSource,
    ) {
        switch (value) {
            case null writeU8(digest, 0);
            case (?source) {
                writeU8(digest, 1);
                writeText(digest, source.path);
                writeU64(digest, source.expected_node_id);
                writeU64(digest, source.expected_revision);
                writeOptionText(digest, source.if_match);
            };
        };
    };

    func writeOptionNat64(digest : Digest, value : ?Nat64) {
        switch (value) {
            case null writeU8(digest, 0);
            case (?number) {
                writeU8(digest, 1);
                writeU64(digest, number);
            };
        };
    };

    func writeOptionText(digest : Digest, value : ?Text) {
        switch (value) {
            case null writeU8(digest, 0);
            case (?text) {
                writeU8(digest, 1);
                writeText(digest, text);
            };
        };
    };

    func writeOptionBlob(digest : Digest, value : ?Blob) {
        switch (value) {
            case null writeU8(digest, 0);
            case (?blob) {
                writeU8(digest, 1);
                writeBlob(digest, blob);
            };
        };
    };

    func writeText(digest : Digest, value : Text) {
        writeBlob(digest, Text.encodeUtf8(value));
    };

    func writeBlob(digest : Digest, value : Blob) {
        writeU64(digest, Nat64.fromNat(value.size()));
        digest.writeBlob(value);
    };

    func writeBool(digest : Digest, value : Bool) {
        writeU8(digest, if (value) 1 else 0);
    };

    func writeU8(digest : Digest, value : Nat8) {
        digest.writeBlob(Blob.fromArray([value]));
    };

    func writeU32(digest : Digest, value : Nat32) {
        digest.writeBlob(
            Blob.fromArray([
                Nat8.fromNat(Nat32.toNat(value >> 24) % 256),
                Nat8.fromNat(Nat32.toNat(value >> 16) % 256),
                Nat8.fromNat(Nat32.toNat(value >> 8) % 256),
                Nat8.fromNat(Nat32.toNat(value) % 256),
            ])
        );
    };

    func writeU64(digest : Digest, value : Nat64) {
        digest.writeBlob(
            Blob.fromArray(
                Array.tabulate<Nat8>(
                    8,
                    func(index) {
                        Nat8.fromNat(
                            Nat64.toNat(
                                value >>
                                Nat64.fromNat((7 - index) * 8)
                            ) % 256
                        );
                    },
                )
            )
        );
    };
};
