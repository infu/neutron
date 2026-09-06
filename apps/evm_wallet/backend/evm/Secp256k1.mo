import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Nat8 "mo:core/Nat8";
import Result "mo:core/Result";
import Hex "Hex";
import Keccak "Keccak";

// Public-key processing and signature verification only. Secret keys never enter
// this module: the Kernel delegates signing to IC threshold ECDSA.
//
// Curve parameters: SEC 2 v2, section 2.4.1, https://www.secg.org/sec2-v2.pdf
// Verification: SEC 1 v2, section 4.1.4, https://www.secg.org/sec1-v2.pdf
// Jacobian formulas: Cohen–Miyaji–Ono add-1998-cmo-2 / dbl-1998-cmo-2,
// https://www.hyperelliptic.org/EFD/g1p/auto-shortw-jacobian.html
// The arithmetic is variable-time because every input here is public.
module {
    public type Point = { x : Nat; y : Nat };
    public type Signature = { r : Nat; s : Nat; yParity : Nat };
    type Jacobian = { x : Nat; y : Nat; z : Nat };

    let p : Nat = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f;
    let n : Nat = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141;
    let generator : Jacobian = {
        x = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798;
        y = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8;
        z = 1;
    };
    let infinity : Jacobian = { x = 0; y = 1; z = 0 };

    func readNat(bytes : [Nat8], offset : Nat, length : Nat) : Nat {
        var result = 0;
        var i = offset;
        let end = offset + length;
        while (i < end) {
            result := result * 256 + Nat8.toNat(bytes[i]);
            i += 1;
        };
        result;
    };

    func word(value : Nat) : [Nat8] {
        Array.tabulate<Nat8>(32, func(i) {
            Nat8.fromNat((value / (256 ** (31 - i))) % 256);
        });
    };

    func power(value : Nat, exponent : Nat, modulus : Nat) : Nat {
        var base = value % modulus;
        var remaining = exponent;
        var result = 1;
        while (remaining > 0) {
            if (remaining % 2 == 1) result := (result * base) % modulus;
            remaining /= 2;
            if (remaining > 0) base := (base * base) % modulus;
        };
        result;
    };

    // Both operands must already be reduced modulo p.
    func sub(a : Nat, b : Nat) : Nat {
        if (a >= b) a - b else p - (b - a);
    };

    func onCurve(point : Point) : Bool {
        point.x < p and point.y < p and
        (point.y * point.y) % p == (point.x * point.x % p * point.x + 7) % p;
    };

    public func decompressPublicKey(publicKey : Blob) : Result.Result<Point, Text> {
        let bytes = Blob.toArray(publicKey);
        if (bytes.size() == 33 and (bytes[0] == 2 or bytes[0] == 3)) {
            let x = readNat(bytes, 1, 32);
            if (x >= p) return #err("secp256k1 public key x coordinate is outside the field");
            let square = (x * x % p * x + 7) % p;
            let root = power(square, (p + 1) / 4, p);
            if (root * root % p != square) return #err("secp256k1 public key is not on the curve");
            let parity = Nat8.toNat(bytes[0]) % 2;
            let y = if (root % 2 == parity) root else p - root;
            let point = { x; y };
            if (not onCurve(point)) return #err("secp256k1 public key is not on the curve");
            #ok(point);
        } else if (bytes.size() == 65 and bytes[0] == 4) {
            let point = { x = readNat(bytes, 1, 32); y = readNat(bytes, 33, 32) };
            if (not onCurve(point)) return #err("secp256k1 public key is not on the curve");
            #ok(point);
        } else {
            #err("Expected a 33-byte compressed or 65-byte uncompressed SEC1 public key");
        };
    };

    public func address(publicKey : Blob) : Result.Result<Text, Text> {
        let point = switch (decompressPublicKey(publicKey)) {
            case (#err(error)) return #err(error);
            case (#ok(value)) value;
        };
        let x = word(point.x);
        let y = word(point.y);
        let uncompressed = Blob.fromArray(Array.tabulate<Nat8>(64, func(i) {
            if (i < 32) x[i] else y[i - 32];
        }));
        let hash = Blob.toArray(Keccak.hash(uncompressed));
        #ok(Hex.encode(Blob.fromArray(Array.tabulate<Nat8>(20, func(i) { hash[i + 12] }))));
    };

    func double(point : Jacobian) : Jacobian {
        if (point.z == 0 or point.y == 0) return infinity;
        let xx = point.x * point.x % p;
        let yy = point.y * point.y % p;
        let d = 4 * point.x * yy % p;
        let e = 3 * xx % p; // secp256k1 has a = 0.
        let x = sub(e * e % p, 2 * d % p);
        let y = sub(e * sub(d, x) % p, 8 * yy * yy % p);
        let z = 2 * point.y * point.z % p;
        { x; y; z };
    };

    func add(a : Jacobian, b : Jacobian) : Jacobian {
        if (a.z == 0) return b;
        if (b.z == 0) return a;
        let az2 = a.z * a.z % p;
        let bz2 = b.z * b.z % p;
        let u1 = a.x * bz2 % p;
        let u2 = b.x * az2 % p;
        let s1 = a.y * b.z % p * bz2 % p;
        let s2 = b.y * a.z % p * az2 % p;
        if (u1 == u2) {
            if (s1 == s2) return double(a) else return infinity;
        };
        let h = sub(u2, u1);
        let hh = h * h % p;
        let hhh = h * hh % p;
        let r = sub(s2, s1);
        let v = u1 * hh % p;
        let x = sub(sub(r * r % p, hhh), 2 * v % p);
        let y = sub(r * sub(v, x) % p, s1 * hhh % p);
        let z = a.z * b.z % p * h % p;
        { x; y; z };
    };

    // Shamir's joint multiplication uses one doubling per bit and avoids field
    // inversions inside the loop. z = 0 represents infinity, including Q = -G.
    func jointMultiply(a : Nat, b : Nat, point : Point) : Jacobian {
        let q : Jacobian = { x = point.x; y = point.y; z = 1 };
        let both = add(generator, q);
        var result = infinity;
        var mask : Nat = 0x8000000000000000000000000000000000000000000000000000000000000000;
        while (mask > 0) {
            result := double(result);
            let abit = a / mask % 2;
            let bbit = b / mask % 2;
            if (abit == 1 and bbit == 1) {
                result := add(result, both);
            } else if (abit == 1) {
                result := add(result, generator);
            } else if (bbit == 1) {
                result := add(result, q);
            };
            mask /= 2;
        };
        result;
    };

    public func normalizeSignature(
        publicKey : Blob,
        digest : Blob,
        signature : Blob,
    ) : Result.Result<Signature, Text> {
        if (digest.size() != 32) return #err("ECDSA requires an exact 32-byte digest");
        if (signature.size() != 64) return #err("Expected a 64-byte chain-key ECDSA signature (r || s)");
        let q = switch (decompressPublicKey(publicKey)) {
            case (#err(error)) return #err(error);
            case (#ok(value)) value;
        };
        let bytes = Blob.toArray(signature);
        let r = readNat(bytes, 0, 32);
        let originalS = readNat(bytes, 32, 32);
        if (r == 0 or r >= n or originalS == 0 or originalS >= n) {
            return #err("ECDSA signature r and s must be in the range 1..n-1");
        };
        // Negating a high s also negates the recovered nonce point. Derive
        // parity from the normalized signature so both representations agree.
        let s = if (originalS > n / 2) n - originalS else originalS;
        let inverse = power(s, n - 2, n);
        let z = readNat(Blob.toArray(digest), 0, 32) % n;
        let candidate = jointMultiply(z * inverse % n, r * inverse % n, q);
        if (candidate.z == 0) return #err("ECDSA signature does not verify for this key and digest");
        let inverseZ = power(candidate.z, p - 2, p);
        let inverseZ2 = inverseZ * inverseZ % p;
        let x = candidate.x * inverseZ2 % p;
        if (x % n != r) return #err("ECDSA signature does not verify for this key and digest");
        // Ethereum carries only y parity, not the additional x-overflow bit of
        // a general recoverable ECDSA signature. Never silently change sender.
        if (x >= n) return #err("ECDSA signature requires an x-overflow recovery bit that Ethereum cannot encode");
        let y = candidate.y * inverseZ2 % p * inverseZ % p;
        #ok({ r; s; yParity = y % 2 });
    };
};
