import Array "mo:core/Array";
import Nat "mo:core/Nat";
import Nat8 "mo:core/Nat8";
import Nat32 "mo:core/Nat32";
import Nat64 "mo:core/Nat64";
import VarArray "mo:core/VarArray";

module {
    let K : [Nat32] = [
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

    let initial : [Nat32] = [
        0xc1059ed8, 0x367cd507, 0x3070dd17, 0xf70e5939,
        0xffc00b31, 0x68581511, 0x64f98fa7, 0xbefa4fa4,
    ];

    public func sum(data : [Nat8]) : [Nat8] {
        let digest = Digest();
        digest.write(data);
        digest.finish();
    };

    class Digest() {
        let state = Array.toVarArray<Nat32>(initial);
        let pending = VarArray.repeat<Nat8>(0, 64);
        var pendingSize = 0;
        var length : Nat64 = 0;

        public func write(input : [Nat8]) : () {
            var offset = 0;
            length +%= Nat64.fromNat(input.size());
            if (pendingSize > 0) {
                let count = Nat.min(input.size(), 64 - pendingSize);
                var index = 0;
                while (index < count) {
                    pending[pendingSize + index] := input[index];
                    index += 1;
                };
                pendingSize += count;
                offset += count;
                if (pendingSize == 64) {
                    block(Array.fromVarArray(pending));
                    pendingSize := 0;
                };
            };
            while (offset + 64 <= input.size()) {
                block(Array.tabulate<Nat8>(64, func(index) { input[offset + index] }));
                offset += 64;
            };
            while (offset < input.size()) {
                pending[pendingSize] := input[offset];
                pendingSize += 1;
                offset += 1;
            };
        };

        public func finish() : [Nat8] {
            let bitLength = length << 3;
            let paddingSize = if (pendingSize < 56) 56 - pendingSize else 120 - pendingSize;
            let padding = VarArray.repeat<Nat8>(0, paddingSize + 8);
            padding[0] := 0x80;
            var index = 0;
            while (index < 8) {
                let shift = Nat64.fromNat((7 - index) * 8);
                padding[paddingSize + index] := Nat8.fromNat(
                    Nat64.toNat(bitLength >> shift) % 256,
                );
                index += 1;
            };
            writeWithoutLength(Array.fromVarArray(padding));

            Array.tabulate<Nat8>(28, func(outputIndex) {
                let word = state[outputIndex / 4];
                let shift = Nat32.fromNat((3 - (outputIndex % 4)) * 8);
                Nat8.fromNat(Nat32.toNat(word >> shift) % 256);
            });
        };

        func writeWithoutLength(input : [Nat8]) : () {
            var offset = 0;
            while (offset < input.size()) {
                pending[pendingSize] := input[offset];
                pendingSize += 1;
                offset += 1;
                if (pendingSize == 64) {
                    block(Array.fromVarArray(pending));
                    pendingSize := 0;
                };
            };
        };

        func block(data : [Nat8]) : () {
            let words = VarArray.repeat<Nat32>(0, 64);
            var index = 0;
            while (index < 16) {
                let offset = index * 4;
                words[index] := Nat32.fromNat(Nat8.toNat(data[offset])) << 24 |
                    Nat32.fromNat(Nat8.toNat(data[offset + 1])) << 16 |
                    Nat32.fromNat(Nat8.toNat(data[offset + 2])) << 8 |
                    Nat32.fromNat(Nat8.toNat(data[offset + 3]));
                index += 1;
            };
            while (index < 64) {
                let a = words[index - 2];
                let b = words[index - 15];
                let s1 = Nat32.bitrotRight(a, 17) ^ Nat32.bitrotRight(a, 19) ^ (a >> 10);
                let s0 = Nat32.bitrotRight(b, 7) ^ Nat32.bitrotRight(b, 18) ^ (b >> 3);
                words[index] := s1 +% words[index - 7] +% s0 +% words[index - 16];
                index += 1;
            };

            var a = state[0];
            var b = state[1];
            var c = state[2];
            var d = state[3];
            var e = state[4];
            var f = state[5];
            var g = state[6];
            var h = state[7];
            index := 0;
            while (index < 64) {
                let s1 = Nat32.bitrotRight(e, 6) ^ Nat32.bitrotRight(e, 11) ^ Nat32.bitrotRight(e, 25);
                let choose = (e & f) ^ (^e & g);
                let temp1 = h +% s1 +% choose +% K[index] +% words[index];
                let s0 = Nat32.bitrotRight(a, 2) ^ Nat32.bitrotRight(a, 13) ^ Nat32.bitrotRight(a, 22);
                let majority = (a & b) ^ (a & c) ^ (b & c);
                let temp2 = s0 +% majority;
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
            state[0] +%= a;
            state[1] +%= b;
            state[2] +%= c;
            state[3] +%= d;
            state[4] +%= e;
            state[5] +%= f;
            state[6] +%= g;
            state[7] +%= h;
        };
    };
};
