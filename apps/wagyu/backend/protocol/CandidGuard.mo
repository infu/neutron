import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Int "mo:core/Int";
import List "mo:core/List";
import Nat "mo:core/Nat";
import Nat8 "mo:core/Nat8";
import Text "mo:core/Text";
import VarArray "mo:core/VarArray";

// Bounded structural preflight used before `from_candid` touches hostile
// nested bytes. Motoko returns null for a valid value of the wrong type, but
// traps for malformed Candid; this parser consumes exactly one syntactically
// valid, bounded value first.
module {
    let MAX_TYPES : Nat = 128;
    let MAX_DEPTH : Nat = 32;
    let MAX_LOGICAL_VALUES : Nat = 32_768;
    let MAX_NAT64 : Nat = 18_446_744_073_709_551_615;
    let MAX_PRINCIPAL_BYTES : Nat = 29;

    type Field = { id : Nat; typ : Int };
    type TypeDef = {
        #opt : Int;
        #vec : Int;
        #record : [Field];
        #variant : [Field];
    };

    class Reader(bytes : Blob) {
        var cursor : Nat = 0;
        var visited : Nat = 0;

        public func finished() : Bool { cursor == bytes.size() };
        public func remaining() : Nat { bytes.size() - cursor };

        public func visit() : Bool {
            if (visited >= MAX_LOGICAL_VALUES) return false;
            visited += 1;
            true;
        };

        public func byte() : ?Nat8 {
            if (cursor >= bytes.size()) return null;
            let value = bytes[cursor];
            cursor += 1;
            ?value;
        };

        public func skip(count : Nat) : Bool {
            if (count > remaining()) return false;
            cursor += count;
            true;
        };

        public func take(count : Nat) : ?Blob {
            if (count > remaining()) return null;
            let start = cursor;
            cursor += count;
            ?Array.toBlob(
                Array.tabulate<Nat8>(count, func(index) {
                    bytes[start + index]
                })
            );
        };

        public func uleb(maximum : Nat) : ?Nat {
            var value : Nat = 0;
            var multiplier : Nat = 1;
            var groups : Nat = 0;
            label decoding loop {
                let ?raw = byte() else return null;
                let part = Nat8.toNat(raw);
                let low = part % 128;
                if (
                    low > maximum or multiplier > maximum or
                    value > maximum or
                    low > (maximum - value) / multiplier
                ) return null;
                value += low * multiplier;
                groups += 1;
                if (part < 128) {
                    // Reject redundant unsigned encodings such as 80 00.
                    if (groups > 1 and low == 0) return null;
                    return ?value;
                };
                if (groups >= 10 or multiplier > maximum / 128) return null;
                multiplier *= 128;
            };
            null;
        };

        public func sleb() : ?Int {
            var magnitude : Nat = 0;
            var multiplier : Nat = 1;
            var groups : Nat = 0;
            var previousLow : Nat = 0;
            label decoding loop {
                let ?raw = byte() else return null;
                let part = Nat8.toNat(raw);
                let low = part % 128;
                if (groups >= 10) return null;
                magnitude += low * multiplier;
                groups += 1;
                if (part < 128) {
                    if (
                        groups > 1 and
                        (
                            (low == 0 and previousLow < 64) or
                            (low == 127 and previousLow >= 64)
                        )
                    ) return null;
                    if (low >= 64) {
                        return ?(
                            Nat.toInt(magnitude) -
                            Nat.toInt(multiplier * 128)
                        );
                    };
                    return ?Nat.toInt(magnitude);
                };
                previousLow := low;
                if (multiplier > MAX_NAT64 / 128) return null;
                multiplier *= 128;
            };
            null;
        };
    };

    public func validOne(value : Blob, maximumBytes : Nat) : Bool {
        if (
            value.size() == 0 or value.size() > maximumBytes or
            value.size() < 6 or
            value[0] != 0x44 or value[1] != 0x49 or
            value[2] != 0x44 or value[3] != 0x4c
        ) return false;

        let reader = Reader(value);
        if (not reader.skip(4)) return false;
        let ?typeCount = reader.uleb(MAX_TYPES) else return false;
        let definitions = List.empty<TypeDef>();
        var typeIndex : Nat = 0;
        while (typeIndex < typeCount) {
            let ?definition = readTypeDefinition(reader) else return false;
            List.add(definitions, definition);
            typeIndex += 1;
        };
        let table = List.toArray(definitions);
        if (not validReferences(table)) return false;

        let ?argumentCount = reader.uleb(1) else return false;
        if (argumentCount != 1) return false;
        let ?argumentType = reader.sleb() else return false;
        if (not validReference(argumentType, table.size())) return false;
        if (not readValue(reader, table, argumentType, 0)) return false;
        reader.finished();
    };

    func readTypeDefinition(reader : Reader) : ?TypeDef {
        let ?constructor = reader.sleb() else return null;
        if (constructor == -18) {
            let ?typ = reader.sleb() else return null;
            return ?#opt(typ);
        };
        if (constructor == -19) {
            let ?typ = reader.sleb() else return null;
            return ?#vec(typ);
        };
        if (constructor != -20 and constructor != -21) return null;

        let ?fieldCount = reader.uleb(MAX_LOGICAL_VALUES) else return null;
        let fields = VarArray.tabulate<Field>(
            fieldCount,
            func(_) { { id = 0; typ = -1 } },
        );
        var fieldIndex : Nat = 0;
        var previousId : ?Nat = null;
        while (fieldIndex < fieldCount) {
            let ?fieldId = reader.uleb(4_294_967_295) else return null;
            switch (previousId) {
                case (?prior) if (fieldId <= prior) return null;
                case (_) {};
            };
            let ?fieldType = reader.sleb() else return null;
            fields[fieldIndex] := { id = fieldId; typ = fieldType };
            previousId := ?fieldId;
            fieldIndex += 1;
        };
        let frozen = Array.fromVarArray(fields);
        if (constructor == -20) ?#record(frozen) else ?#variant(frozen);
    };

    func validReferences(table : [TypeDef]) : Bool {
        for (definition in table.values()) {
            switch (definition) {
                case (#opt(typ) or #vec(typ)) {
                    if (not validReference(typ, table.size())) return false;
                };
                case (#record(fields) or #variant(fields)) {
                    for (field in fields.values()) {
                        if (not validReference(field.typ, table.size())) {
                            return false;
                        };
                    };
                };
            };
        };
        true;
    };

    func validReference(typ : Int, tableSize : Nat) : Bool {
        if (typ >= 0) return Int.abs(typ) < tableSize;
        typ == -1 or typ == -2 or typ == -3 or typ == -4 or
        (typ <= -5 and typ >= -16) or typ == -24;
    };

    func readValue(
        reader : Reader,
        table : [TypeDef],
        typ : Int,
        depth : Nat,
    ) : Bool {
        if (depth > MAX_DEPTH or not reader.visit()) return false;
        if (typ >= 0) {
            let index = Int.abs(typ);
            if (index >= table.size()) return false;
            switch (table[index]) {
                case (#opt(inner)) {
                    let ?tag = reader.byte() else return false;
                    if (tag == 0) return true;
                    tag == 1 and readValue(reader, table, inner, depth + 1);
                };
                case (#vec(inner)) {
                    // Blob is vec nat8. Skip it directly after a bounded count
                    // rather than charging one recursive visit per byte.
                    if (inner == -5) {
                        let ?count = reader.uleb(reader.remaining()) else {
                            return false;
                        };
                        return reader.skip(count);
                    };
                    let ?count = reader.uleb(MAX_LOGICAL_VALUES) else {
                        return false;
                    };
                    var itemIndex : Nat = 0;
                    while (itemIndex < count) {
                        if (
                            not readValue(
                                reader,
                                table,
                                inner,
                                depth + 1,
                            )
                        ) return false;
                        itemIndex += 1;
                    };
                    true;
                };
                case (#record(fields)) {
                    for (field in fields.values()) {
                        if (
                            not readValue(
                                reader,
                                table,
                                field.typ,
                                depth + 1,
                            )
                        ) return false;
                    };
                    true;
                };
                case (#variant(fields)) {
                    if (fields.size() == 0) return false;
                    let ?tag = reader.uleb(fields.size() - 1) else {
                        return false;
                    };
                    readValue(
                        reader,
                        table,
                        fields[tag].typ,
                        depth + 1,
                    );
                };
            };
        } else if (typ == -1 or typ == -16) {
            true;
        } else if (typ == -2) {
            switch (reader.byte()) {
                case (?0) true;
                case (?1) true;
                case (_) false;
            };
        } else if (typ == -3) {
            switch (reader.uleb(MAX_NAT64)) {
                case null false;
                case (_) true;
            };
        } else if (typ == -4) {
            switch (reader.sleb()) {
                case null false;
                case (_) true;
            };
        } else if (typ == -5 or typ == -9) {
            reader.skip(1);
        } else if (typ == -6 or typ == -10) {
            reader.skip(2);
        } else if (typ == -7 or typ == -11 or typ == -13) {
            reader.skip(4);
        } else if (typ == -8 or typ == -12 or typ == -14) {
            reader.skip(8);
        } else if (typ == -15) {
            let ?byteLength = reader.uleb(reader.remaining()) else {
                return false;
            };
            let ?utf8 = reader.take(byteLength) else return false;
            switch (Text.decodeUtf8(utf8)) {
                case null false;
                case (?_) true;
            };
        } else if (typ == -24) {
            let ?tag = reader.byte() else return false;
            if (tag != 1) return false;
            let ?byteLength = reader.uleb(MAX_PRINCIPAL_BYTES) else {
                return false;
            };
            reader.skip(byteLength);
        } else {
            false;
        };
    };
};
