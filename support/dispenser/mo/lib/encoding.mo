// Adapted from Aviate Labs encoding.mo Binary.mo at revision
// 2711d18727e954b11afc0d37945608512b5fbce2 (Apache-2.0).
// Modified by Neutron in 2026 for current Motoko Core imports and the
// Dispenser's local byte-order API.
import Array "mo:core/Array";
import Nat8 "mo:core/Nat8";
import Nat16 "mo:core/Nat16";
import Nat32 "mo:core/Nat32";
import Nat64 "mo:core/Nat64";
import Result "mo:core/Result";
import VarArray "mo:core/VarArray";

module {
    public type ByteOrder = {
        fromNat16 : (Nat16) -> [Nat8];
	    fromNat32 : (Nat32) -> [Nat8];
	    fromNat64 : (Nat64) -> [Nat8];
        toNat16 : ([Nat8]) -> Nat16;
	    toNat32 : ([Nat8]) -> Nat32;
	    toNat64 : ([Nat8]) -> Nat64;
    };

    private func nat16to8 (n : Nat16) : Nat8 = Nat8.fromIntWrap(Nat16.toNat(n)); 
    private func nat8to16 (n : Nat8) : Nat16 = Nat16.fromIntWrap(Nat8.toNat(n));

    private func nat32to8 (n : Nat32) : Nat8 = Nat8.fromIntWrap(Nat32.toNat(n)); 
    private func nat8to32 (n : Nat8) : Nat32 = Nat32.fromIntWrap(Nat8.toNat(n));

    private func nat64to8 (n : Nat64) : Nat8 = Nat8.fromIntWrap(Nat64.toNat(n));
    private func nat8to64 (n : Nat8) : Nat64 = Nat64.fromIntWrap(Nat8.toNat(n));

    public let LittleEndian : ByteOrder = {
        toNat16 = func (src : [Nat8]) : Nat16 {
            nat8to16(src[0]) | nat8to16(src[1]) << 8;
        };

        fromNat16 = func (n : Nat16) : [Nat8] {
            let b = VarArray.repeat<Nat8>(0x00, 2);
            b[0] := nat16to8(n);
            b[1] := nat16to8(n >> 8);
            Array.fromVarArray(b);
        };

        toNat32 = func (src : [Nat8]) : Nat32 {
            nat8to32(src[0]) | nat8to32(src[1]) << 8 | nat8to32(src[2]) << 16 | nat8to32(src[3]) << 24;
        };

        fromNat32 = func (n : Nat32) : [Nat8] {
            let b = VarArray.repeat<Nat8>(0x00, 4);
            b[0] := nat32to8(n);
            b[1] := nat32to8(n >> 8);
            b[2] := nat32to8(n >> 16);
            b[3] := nat32to8(n >> 24);
            Array.fromVarArray(b);
        };

        toNat64 = func (src : [Nat8]) : Nat64 {
            nat8to64(src[0])       | nat8to64(src[1]) << 8  | nat8to64(src[2]) << 16 | nat8to64(src[3]) << 24 |
            nat8to64(src[4]) << 32 | nat8to64(src[5]) << 40 | nat8to64(src[6]) << 48 | nat8to64(src[7]) << 56;
        };

        fromNat64 = func (n : Nat64) : [Nat8] {
            let b = VarArray.repeat<Nat8>(0x00, 8);
            b[0] := nat64to8(n);
            b[1] := nat64to8(n >> 8);
            b[2] := nat64to8(n >> 16);
            b[3] := nat64to8(n >> 24);
            b[4] := nat64to8(n >> 32);
            b[5] := nat64to8(n >> 40);
            b[6] := nat64to8(n >> 48);
            b[7] := nat64to8(n >> 56);
            Array.fromVarArray(b);
        };
    };

    public let BigEndian : ByteOrder = {
        toNat16 = func (src : [Nat8]) : Nat16 {
            nat8to16(src[1]) | nat8to16(src[0]) << 8;
        };

        fromNat16 = func (n : Nat16) : [Nat8] {
            let b = VarArray.repeat<Nat8>(0x00, 2);
            b[0] := nat16to8(n >> 8);
            b[1] := nat16to8(n);
            Array.fromVarArray(b);
        };

        toNat32 = func (src : [Nat8]) : Nat32 {
            nat8to32(src[3]) | nat8to32(src[2]) << 8 | nat8to32(src[1]) << 16 | nat8to32(src[0]) << 24;
        };

        fromNat32 = func (n : Nat32) : [Nat8] {
            let b = VarArray.repeat<Nat8>(0x00, 4);
            b[0] := nat32to8(n >> 24);
            b[1] := nat32to8(n >> 16);
            b[2] := nat32to8(n >> 8);
            b[3] := nat32to8(n);
            Array.fromVarArray(b);
        };

        toNat64 = func (src : [Nat8]) : Nat64 {
            nat8to64(src[7])       | nat8to64(src[6]) << 8  | nat8to64(src[5]) << 16 | nat8to64(src[4]) << 24 |
            nat8to64(src[3]) << 32 | nat8to64(src[2]) << 40 | nat8to64(src[1]) << 48 | nat8to64(src[0]) << 56;
        };

        fromNat64 = func (n : Nat64) : [Nat8] {
            let b = VarArray.repeat<Nat8>(0x00, 8);
            b[0] := nat64to8(n >> 56);
            b[1] := nat64to8(n >> 48);
            b[2] := nat64to8(n >> 40);
            b[3] := nat64to8(n >> 32);
            b[4] := nat64to8(n >> 24);
            b[5] := nat64to8(n >> 16);
            b[6] := nat64to8(n >> 8);
            b[7] := nat64to8(n);
            Array.fromVarArray(b);
        };
    };
};
