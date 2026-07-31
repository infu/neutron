import Blob "mo:core/Blob";
import Int "mo:core/Int";
import List "mo:core/List";
import Nat "mo:core/Nat";
import Nat8 "mo:core/Nat8";
import VarArray "mo:core/VarArray";

// Structural preflight for hostile inner Candid. `from_candid` is used only
// after this validator has consumed exactly one bounded, well-formed value.
// Files controls intentionally use only closed records, variants, options,
// vectors, fixed-width integers, bool, and (future-proofed) text/blob.
module {
    let MAX_TYPES = 256;
    let MAX_DEPTH = 32;
    let MAX_ELEMENTS = 4_096;

    type Field = { id : Nat; typ : Int };
    type TypeDef = {
        #opt : Int;
        #vec : Int;
        #record : [Field];
        #variant : [Field];
    };

    class Reader(bytes : Blob) {
        var cursor = 0;
        var decodedElements = 0;

        public func position() : Nat { cursor };
        public func finished() : Bool { cursor == bytes.size() };
        public func remaining() : Nat { bytes.size() - cursor };
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

        public func elements(count : Nat) : Bool {
            if (
                Nat.toInt(decodedElements) + Nat.toInt(count) >
                Nat.toInt(MAX_ELEMENTS)
            ) return false;
            decodedElements += count;
            true;
        };

        public func uleb(maximum : Nat) : ?Nat {
            var value = 0;
            var multiplier = 1;
            var groups = 0;
            label decoding loop {
                let ?raw = byte() else return null;
                let part = Nat8.toNat(raw);
                let low = part % 128;
                if (low > 0) {
                    let contribution = low * multiplier;
                    if (value + contribution > maximum) return null;
                    value += contribution;
                };
                groups += 1;
                if (part < 128) {
                    if (groups > 1 and low == 0) return null;
                    return ?value;
                };
                if (groups >= 10) return null;
                multiplier *= 128;
            };
            null;
        };

        public func sleb() : ?Int {
            var magnitude = 0;
            var multiplier = 1;
            var groups = 0;
            var previousLow = 0;
            label decoding loop {
                if (groups >= 10) return null;
                let ?raw = byte() else return null;
                let part = Nat8.toNat(raw);
                let low = part % 128;
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
                    let signed = if (low >= 64) {
                        Nat.toInt(magnitude) - Nat.toInt(multiplier * 128)
                    } else {
                        Nat.toInt(magnitude)
                    };
                    return ?signed;
                };
                previousLow := low;
                multiplier *= 128;
            };
            null;
        };
    };

    public func validOne(control : Blob, maximumBytes : Nat) : Bool {
        if (control.size() == 0 or control.size() > maximumBytes) return false;
        if (
            control.size() < 6 or control[0] != 0x44 or
            control[1] != 0x49 or control[2] != 0x44 or
            control[3] != 0x4c
        ) return false;
        let reader = Reader(control);
        if (not reader.skip(4)) return false;
        let ?typeCount = reader.uleb(MAX_TYPES) else return false;
        let definitions = List.empty<TypeDef>();
        var typeIndex = 0;
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
        let ?fieldCount = reader.uleb(MAX_ELEMENTS) else return null;
        if (not reader.elements(fieldCount)) return null;
        let fields = VarArray.tabulate<Field>(
            fieldCount,
            func(_) { { id = 0; typ = -1 } },
        );
        var fieldIndex = 0;
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
        let frozen = VarArray.toArray(fields);
        if (constructor == -20) ?#record(frozen) else ?#variant(frozen);
    };

    func validReferences(table : [TypeDef]) : Bool {
        for (definition in table.values()) {
            switch (definition) {
                case (#opt(typ)) if (not validReference(typ, table.size())) {
                    return false;
                };
                case (#vec(typ)) if (not validReference(typ, table.size())) {
                    return false;
                };
                case (#record(fields)) {
                    for (field in fields.values()) {
                        if (not validReference(field.typ, table.size())) {
                            return false;
                        };
                    };
                };
                case (#variant(fields)) {
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
        (typ <= -5 and typ >= -15) or typ == -16;
    };

    func readValue(
        reader : Reader,
        table : [TypeDef],
        typ : Int,
        depth : Nat,
    ) : Bool {
        if (depth > MAX_DEPTH) return false;
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
                    let ?count = reader.uleb(MAX_ELEMENTS) else return false;
                    if (not reader.elements(count)) return false;
                    var index = 0;
                    while (index < count) {
                        if (not readValue(reader, table, inner, depth + 1)) {
                            return false;
                        };
                        index += 1;
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
                    let ?tag = reader.uleb(fields.size() - 1) else return false;
                    readValue(reader, table, fields[tag].typ, depth + 1);
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
            switch (reader.uleb(18_446_744_073_709_551_615)) {
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
            let ?byteLength = reader.uleb(MAX_ELEMENTS * 128) else {
                return false;
            };
            reader.skip(byteLength);
        } else {
            false;
        };
    };
};
