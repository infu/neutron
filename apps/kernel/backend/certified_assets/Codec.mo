import Array "mo:core/Array";
import Blob "mo:core/Blob";
import List "mo:core/List";
import Nat8 "mo:core/Nat8";
import Nat32 "mo:core/Nat32";
import Nat64 "mo:core/Nat64";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
import VarArray "mo:core/VarArray";
import SHA256 "mo:sha2/Sha256";
import Types "Types";

module {
    public let BEGIN_DOMAIN = "neutron.certified-assets.begin-stage.v4\00";
    public let POSITIVE_BATCH_DOMAIN = "neutron.certified-assets.positive-batch.v4\00";
    public let DELETE_DOMAIN = "neutron.certified-assets.delete.v4\00";

    public func sha256(body : Blob) : Blob {
        SHA256.fromBlob(#sha256, body);
    };

    public func sha256Chunks(chunks : [Blob]) : Blob {
        let digest = SHA256.Digest(#sha256);
        for (chunk in chunks.vals()) digest.writeBlob(chunk);
        digest.sum();
    };

    // Types owns this frozen persistent layout. The engine only transforms
    // immutable values of that single canonical type.
    public type Sha256State = Types.Sha256State;

    let SHA256_MAX_BYTES : Nat64 = 2_305_843_009_213_693_951;

    let SHA256_K : [Nat32] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
        0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
        0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
        0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
        0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
        0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
        0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
        0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];

    public func sha256Init() : Sha256State {
        {
            h0 = 0x6a09e667;
            h1 = 0xbb67ae85;
            h2 = 0x3c6ef372;
            h3 = 0xa54ff53a;
            h4 = 0x510e527f;
            h5 = 0x9b05688c;
            h6 = 0x1f83d9ab;
            h7 = 0x5be0cd19;
            total_bytes = 0;
            tail = "";
        };
    };

    public func sha256StateValid(state : Sha256State) : Bool {
        state.tail.size() < 64 and
        state.total_bytes <= SHA256_MAX_BYTES and
        Nat64.toNat(state.total_bytes % 64) == state.tail.size();
    };

    public func sha256Update(state : Sha256State, chunk : Blob) : Sha256State {
        assert sha256StateValid(state);
        let chunkBytes = Nat64.fromNat(chunk.size());
        assert chunkBytes <= SHA256_MAX_BYTES - state.total_bytes;
        let newTotal = state.total_bytes + chunkBytes;

        var working = state;
        var chunkOffset = 0;
        if (state.tail.size() > 0) {
            let needed = 64 - state.tail.size();
            if (chunk.size() < needed) {
                return {
                    state with
                    total_bytes = newTotal;
                    tail = concatTail(state.tail, chunk);
                };
            };
            let block = Blob.fromArray(
                Array.tabulate<Nat8>(
                    64,
                    func(index : Nat) : Nat8 {
                        if (index < state.tail.size()) {
                            state.tail[index];
                        } else {
                            chunk[index - state.tail.size()];
                        };
                    },
                )
            );
            working := sha256Compress(working, block, 0);
            chunkOffset := needed;
        };

        while (chunkOffset + 64 <= chunk.size()) {
            working := sha256Compress(working, chunk, chunkOffset);
            chunkOffset += 64;
        };

        let remaining = chunk.size() - chunkOffset;
        let tail = Blob.fromArray(
            Array.tabulate<Nat8>(
                remaining,
                func(index : Nat) : Nat8 { chunk[chunkOffset + index] },
            )
        );
        {
            working with
            total_bytes = newTotal;
            tail;
        };
    };

    public func sha256Finalize(state : Sha256State) : Blob {
        assert sha256StateValid(state);
        let tailBytes = state.tail.size();
        let finalBytes = if (tailBytes < 56) 64 else 128;
        let padded = VarArray.repeat<Nat8>(0, finalBytes);
        var index = 0;
        while (index < tailBytes) {
            padded[index] := state.tail[index];
            index += 1;
        };
        padded[tailBytes] := 0x80;

        let encodedLength = u64be(state.total_bytes * 8);
        index := 0;
        while (index < 8) {
            padded[finalBytes - 8 + index] := encodedLength[index];
            index += 1;
        };

        let finalBlob = Blob.fromVarArray(padded);
        var finalized = state;
        index := 0;
        while (index < finalBytes) {
            finalized := sha256Compress(finalized, finalBlob, index);
            index += 64;
        };

        let output = List.empty<Nat8>();
        append(output, u32be(finalized.h0));
        append(output, u32be(finalized.h1));
        append(output, u32be(finalized.h2));
        append(output, u32be(finalized.h3));
        append(output, u32be(finalized.h4));
        append(output, u32be(finalized.h5));
        append(output, u32be(finalized.h6));
        append(output, u32be(finalized.h7));
        Blob.fromArray(List.toArray(output));
    };

    func concatTail(left : Blob, right : Blob) : Blob {
        Blob.fromArray(
            Array.tabulate<Nat8>(
                left.size() + right.size(),
                func(index : Nat) : Nat8 {
                    if (index < left.size()) left[index] else {
                        right[index - left.size()];
                    };
                },
            )
        );
    };

    func sha256Compress(
        state : Sha256State,
        block : Blob,
        offset : Nat,
    ) : Sha256State {
        assert offset + 64 <= block.size();
        let words = VarArray.repeat<Nat32>(0, 64);
        var index = 0;
        while (index < 16) {
            let byteOffset = offset + index * 4;
            words[index] :=
                (Nat32.fromNat(Nat8.toNat(block[byteOffset])) << 24) |
                (Nat32.fromNat(Nat8.toNat(block[byteOffset + 1])) << 16) |
                (Nat32.fromNat(Nat8.toNat(block[byteOffset + 2])) << 8) |
                Nat32.fromNat(Nat8.toNat(block[byteOffset + 3]));
            index += 1;
        };
        while (index < 64) {
            let word15 = words[index - 15];
            let sigma0 =
                Nat32.bitrotRight(word15, 7) ^
                Nat32.bitrotRight(word15, 18) ^
                (word15 >> 3);
            let word2 = words[index - 2];
            let sigma1 =
                Nat32.bitrotRight(word2, 17) ^
                Nat32.bitrotRight(word2, 19) ^
                (word2 >> 10);
            words[index] :=
                words[index - 16] +% sigma0 +%
                words[index - 7] +% sigma1;
            index += 1;
        };

        var a = state.h0;
        var b = state.h1;
        var c = state.h2;
        var d = state.h3;
        var e = state.h4;
        var f = state.h5;
        var g = state.h6;
        var h = state.h7;
        index := 0;
        while (index < 64) {
            let sum1 =
                Nat32.bitrotRight(e, 6) ^
                Nat32.bitrotRight(e, 11) ^
                Nat32.bitrotRight(e, 25);
            let choose = (e & f) ^ (Nat32.bitnot(e) & g);
            let temp1 = h +% sum1 +% choose +% SHA256_K[index] +% words[index];
            let sum0 =
                Nat32.bitrotRight(a, 2) ^
                Nat32.bitrotRight(a, 13) ^
                Nat32.bitrotRight(a, 22);
            let majority = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = sum0 +% majority;

            h := g;
            g := f;
            f := e;
            e := d +% temp1;
            d := c;
            c := b;
            b := a;
            a := temp1 +% temp2;
            index += 1;
        };

        {
            state with
            h0 = state.h0 +% a;
            h1 = state.h1 +% b;
            h2 = state.h2 +% c;
            h3 = state.h3 +% d;
            h4 = state.h4 +% e;
            h5 = state.h5 +% f;
            h6 = state.h6 +% g;
            h7 = state.h7 +% h;
        };
    };

    public func hex(body : Blob) : Text {
        var result = "";
        for (byte in body.vals()) {
            let value = Nat8.toNat(byte);
            result #= nibble(value / 16);
            result #= nibble(value % 16);
        };
        result;
    };

    public func u32be(value : Nat32) : Blob {
        let n = Nat32.toNat(value);
        Blob.fromArray([
            Nat8.fromNat((n / 16_777_216) % 256),
            Nat8.fromNat((n / 65_536) % 256),
            Nat8.fromNat((n / 256) % 256),
            Nat8.fromNat(n % 256),
        ]);
    };

    public func u64be(value : Nat64) : Blob {
        let n = Nat64.toNat(value);
        Blob.fromArray([
            Nat8.fromNat((n / 72_057_594_037_927_936) % 256),
            Nat8.fromNat((n / 281_474_976_710_656) % 256),
            Nat8.fromNat((n / 1_099_511_627_776) % 256),
            Nat8.fromNat((n / 4_294_967_296) % 256),
            Nat8.fromNat((n / 16_777_216) % 256),
            Nat8.fromNat((n / 65_536) % 256),
            Nat8.fromNat((n / 256) % 256),
            Nat8.fromNat(n % 256),
        ]);
    };

    public func lpBlob(value : Blob) : Blob {
        let output = List.empty<Nat8>();
        append(output, u32be(Nat32.fromNat(value.size())));
        append(output, value);
        Blob.fromArray(List.toArray(output));
    };

    public func lpText(value : Text) : Blob {
        lpBlob(Text.encodeUtf8(value));
    };

    public func targetKey(target : Types.Target) : Text {
        target.collection # "\00" # Nat64.toText(target.collection_generation) # "\00" # (
        switch (target.locator) {
            case (#publication(locator)) {
                "p:" # hex(locator.publication_id) # ":" # locator.filename;
            };
            case (#body_sha256(locator)) "b:" # hex(locator.digest);
            case (#key32(locator)) "k:" # hex(locator.key);
            case (#exact_path) "x";
        });
    };

    public func beginFingerprint(input : Types.BeginStageInput) : Blob {
        let bytes = List.empty<Nat8>();
        append(bytes, Text.encodeUtf8(BEGIN_DOMAIN));
        encodeStageTarget(bytes, input.target);
        addU64(bytes, input.expected_bytes);
        sha256(Blob.fromArray(List.toArray(bytes)));
    };

    public func batchFingerprint(
        input : Types.CommitBatchInput,
        deleteBatch : Bool,
    ) : Blob {
        batchFingerprintFromInlineDigests(
            input,
            deleteBatch,
            inlineBodyDigests(input),
        );
    };

    // Service prevalidation calls this once after every inline body has
    // passed its structural and collection-policy bounds. The digest vector
    // is reused by the nonce fingerprint and content preparation, so a
    // body-sized Blob is never hashed twice.
    public func inlineBodyDigests(
        input : Types.CommitBatchInput,
    ) : [?Blob] {
        Array.map<Types.BatchOperation, ?Blob>(
            input.operations,
            func(operation) {
                switch (operation) {
                    case (#put(value)) {
                        switch (value.body) {
                            case (#inline(body)) ?sha256(body);
                            case (#stage(_)) null;
                        };
                    };
                    case (#delete(_)) null;
                };
            },
        );
    };

    public func batchFingerprintFromInlineDigests(
        input : Types.CommitBatchInput,
        deleteBatch : Bool,
        inlineDigests : [?Blob],
    ) : Blob {
        assert (inlineDigests.size() == input.operations.size());
        let bytes = List.empty<Nat8>();
        append(
            bytes,
            Text.encodeUtf8(if (deleteBatch) DELETE_DOMAIN else POSITIVE_BATCH_DOMAIN),
        );
        addU32(bytes, input.operations.size());
        var operationIndex = 0;
        for (operation in input.operations.vals()) {
            encodeOperation(
                bytes,
                operation,
                inlineDigests[operationIndex],
            );
            operationIndex += 1;
        };
        addU32(bytes, input.requires_present_after.size());
        for (requirement in input.requires_present_after.vals()) {
            encodeTarget(bytes, requirement.target);
            append(bytes, requirement.content_tag);
            switch (requirement.revision) {
                case null addByte(bytes, 0);
                case (?revision) {
                    addByte(bytes, 1);
                    append(bytes, u64be(revision));
                };
            };
        };
        sha256(Blob.fromArray(List.toArray(bytes)));
    };

    func encodeStageTarget(output : List.List<Nat8>, target : Types.StageTarget) : () {
        switch (target) {
            case (#allocate_publication(value)) {
                addByte(output, 0);
                addText(output, value.collection);
                append(output, u64be(value.collection_generation));
                addText(output, value.filename);
                encodePublicationPresentation(output, value.presentation);
            };
            case (#derive_body_sha256(value)) {
                addByte(output, 1);
                addText(output, value.collection);
                append(output, u64be(value.collection_generation));
            };
        };
    };

    func encodeOperation(
        output : List.List<Nat8>,
        operation : Types.BatchOperation,
        inlineDigest : ?Blob,
    ) : () {
        switch (operation) {
            case (#put(value)) {
                addByte(output, 0);
                encodeTarget(output, value.target);
                encodeCondition(output, value.condition);
                switch (value.body) {
                    case (#inline(body)) {
                        let ?digest = inlineDigest else {
                            Runtime.trap(
                                "Missing prevalidated inline body digest"
                            );
                        };
                        if (digest.size() != 32) {
                            Runtime.trap(
                                "Invalid prevalidated inline body digest"
                            );
                        };
                        addByte(output, 0);
                        addU64(output, body.size());
                        append(output, digest);
                    };
                    case (#stage(stageId)) {
                        if (inlineDigest != null) {
                            Runtime.trap(
                                "Unexpected digest for staged body"
                            );
                        };
                        addByte(output, 1);
                        append(output, u64be(stageId));
                    };
                };
            };
            case (#delete(value)) {
                if (inlineDigest != null) {
                    Runtime.trap(
                        "Unexpected digest for delete operation"
                    );
                };
                addByte(output, 1);
                encodeTarget(output, value.target);
                append(output, u64be(value.condition.revision));
                addBlob(output, value.condition.content_tag);
            };
        };
    };

    func encodeTarget(output : List.List<Nat8>, target : Types.Target) : () {
        addText(output, target.collection);
        append(output, u64be(target.collection_generation));
        switch (target.locator) {
            case (#publication(value)) {
                addByte(output, 0);
                addBlob(output, value.publication_id);
                addText(output, value.filename);
            };
            case (#body_sha256(value)) {
                addByte(output, 1);
                addBlob(output, value.digest);
            };
            case (#key32(value)) {
                addByte(output, 2);
                addBlob(output, value.key);
            };
            case (#exact_path) addByte(output, 3);
        };
    };

    func encodeCondition(output : List.List<Nat8>, condition : Types.Condition) : () {
        switch (condition) {
            case (#absent) addByte(output, 0);
            case (#match(value)) {
                addByte(output, 1);
                append(output, u64be(value.revision));
                addBlob(output, value.content_tag);
            };
        };
    };

    func encodePublicationPresentation(
        output : List.List<Nat8>,
        presentation : Types.PublicationPresentation,
    ) : () {
        switch (presentation) {
            case (#inline_text) addByte(output, 0);
            case (#attachment) addByte(output, 1);
        };
    };

    func addBlob(output : List.List<Nat8>, value : Blob) : () {
        append(output, lpBlob(value));
    };

    func addText(output : List.List<Nat8>, value : Text) : () {
        append(output, lpText(value));
    };

    func addU32(output : List.List<Nat8>, value : Nat) : () {
        append(output, u32be(Nat32.fromNat(value)));
    };

    func addU64(output : List.List<Nat8>, value : Nat) : () {
        append(output, u64be(Nat64.fromNat(value)));
    };

    func addByte(output : List.List<Nat8>, value : Nat) : () {
        List.add(output, Nat8.fromNat(value));
    };

    func append(output : List.List<Nat8>, bytes : Blob) : () {
        for (byte in bytes.vals()) List.add(output, byte);
    };

    func nibble(value : Nat) : Text {
        switch (value) {
            case (0) "0";
            case (1) "1";
            case (2) "2";
            case (3) "3";
            case (4) "4";
            case (5) "5";
            case (6) "6";
            case (7) "7";
            case (8) "8";
            case (9) "9";
            case (10) "a";
            case (11) "b";
            case (12) "c";
            case (13) "d";
            case (14) "e";
            case (15) "f";
            case (_) "";
        };
    };
};
