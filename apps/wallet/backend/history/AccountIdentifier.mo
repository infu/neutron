import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Char "mo:core/Char";
import Iter "mo:core/Iter";
import List "mo:core/List";
import Nat8 "mo:core/Nat8";
import Nat32 "mo:core/Nat32";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import VarArray "mo:core/VarArray";
import Sha224 "Sha224";

module {
    let prefix : [Nat8] = [10, 97, 99, 99, 111, 117, 110, 116, 45, 105, 100];
    let hexDigits : [Char] = [
        '0', '1', '2', '3', '4', '5', '6', '7',
        '8', '9', 'a', 'b', 'c', 'd', 'e', 'f',
    ];

    public func fromPrincipal(principal : Principal) : Blob {
        derive(principal, Array.tabulate<Nat8>(32, func(_) { 0 }));
    };

    public func fromAccount(principal : Principal, subaccount : ?Blob) : ?Blob {
        let bytes = switch (subaccount) {
            case null Array.tabulate<Nat8>(32, func(_) { 0 });
            case (?value) {
                let bytes = Blob.toArray(value);
                if (bytes.size() != 32) return null;
                bytes;
            };
        };
        ?derive(principal, bytes);
    };

    func derive(principal : Principal, subaccount : [Nat8]) : Blob {
        let digest = Sha224.sum(Array.flatten<Nat8>([
            prefix,
            Blob.toArray(Principal.toBlob(principal)),
            subaccount,
        ]));
        let checksum = crc32(digest);
        Blob.fromArray(Array.concat<Nat8>([
            Nat8.fromNat(Nat32.toNat(checksum >> 24) % 256),
            Nat8.fromNat(Nat32.toNat(checksum >> 16) % 256),
            Nat8.fromNat(Nat32.toNat(checksum >> 8) % 256),
            Nat8.fromNat(Nat32.toNat(checksum) % 256),
        ], digest));
    };

    public func toHex(value : Blob) : Text {
        let chars = List.empty<Char>();
        for (byte in value.vals()) {
            List.add(chars, hexDigits[Nat8.toNat(byte) / 16]);
            List.add(chars, hexDigits[Nat8.toNat(byte) % 16]);
        };
        Text.fromIter(List.values(chars));
    };

    public func fromHex(value : Text) : ?Blob {
        let chars = Iter.toArray(value.chars());
        if (chars.size() != 64) return null;
        let bytes = VarArray.repeat<Nat8>(0, 32);
        var index = 0;
        while (index < 32) {
            let ?high = nibble(chars[index * 2]) else return null;
            let ?low = nibble(chars[index * 2 + 1]) else return null;
            bytes[index] := Nat8.fromNat(high * 16 + low);
            index += 1;
        };
        let decoded = Blob.fromArray(Array.fromVarArray(bytes));
        if (isValid(decoded)) ?decoded else null;
    };

    public func isValid(value : Blob) : Bool {
        let bytes = Blob.toArray(value);
        if (bytes.size() != 32) return false;
        let digest = Array.tabulate<Nat8>(28, func(index) { bytes[index + 4] });
        let expected = crc32(digest);
        bytes[0] == Nat8.fromNat(Nat32.toNat(expected >> 24) % 256) and
        bytes[1] == Nat8.fromNat(Nat32.toNat(expected >> 16) % 256) and
        bytes[2] == Nat8.fromNat(Nat32.toNat(expected >> 8) % 256) and
        bytes[3] == Nat8.fromNat(Nat32.toNat(expected) % 256);
    };

    func nibble(char : Char) : ?Nat {
        let code = Char.toNat32(char);
        if (code >= 48 and code <= 57) return ?Nat32.toNat(code - 48);
        if (code >= 65 and code <= 70) return ?Nat32.toNat(code - 55);
        if (code >= 97 and code <= 102) return ?Nat32.toNat(code - 87);
        null;
    };

    func crc32(bytes : [Nat8]) : Nat32 {
        var crc : Nat32 = 0xffffffff;
        for (byte in bytes.vals()) {
            crc ^= Nat32.fromNat(Nat8.toNat(byte));
            var bit = 0;
            while (bit < 8) {
                crc := if ((crc & 1) == 1) {
                    (crc >> 1) ^ 0xedb88320;
                } else crc >> 1;
                bit += 1;
            };
        };
        ^crc;
    };
};
