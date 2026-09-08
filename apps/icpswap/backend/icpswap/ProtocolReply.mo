/// Decode the small mutation replies returned by deployed ICPSwap pools.
/// A malformed remote reply must remain an unknown operation outcome: the
/// language's Candid decoder can trap on invalid bytes after an awaited effect.
/// This reader never indexes or allocates from an unchecked wire length, and
/// accepts additional primitive record fields for width subtyping. Unsupported
/// wire types return an ordinary unknown result instead of trapping.
import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Int "mo:core/Int";
import List "mo:core/List";
import Nat8 "mo:core/Nat8";
import Text "mo:core/Text";

module {
    public type Outcome<T> = { #ok : T; #rejected : Text; #unknown : Text };
    public type Amounts = { amount0 : Nat; amount1 : Nat };
    type Field = { id : Nat; valueType : Int };
    type WireType = { #record : [Field]; #variant : [Field] };

    func labelHash(name : Text) : Nat {
        var value = 0;
        for (byte in Text.encodeUtf8(name).vals()) {
            value := (value * 223 + Nat8.toNat(byte)) % 4_294_967_296;
        };
        value;
    };

    class Reader(blob : Blob) {
        let bytes = Blob.toArray(blob);
        var offset = 0;
        var failure : ?Text = null;
        var types : [WireType] = [];

        public func error() : Text {
            switch (failure) { case (?message) message; case null "unexpected reply shape" };
        };
        func fail<T>(message : Text) : ?T {
            if (failure == null) failure := ?message;
            null;
        };
        func remaining() : Nat { bytes.size() - offset };
        func byte() : ?Nat {
            if (offset >= bytes.size()) return fail("truncated Candid reply");
            let result = Nat8.toNat(bytes[offset]);
            offset += 1;
            ?result;
        };

        // LEB128 is arbitrary precision in Candid. Every continuation consumes
        // one remaining input byte; no finite amount or application quota is
        // imposed here, and an unterminated value cannot read beyond the blob.
        func leb() : ?{ value : Nat; multiplier : Nat; last : Nat } {
            var value = 0;
            var multiplier = 1;
            loop {
                let current = switch (byte()) { case (?value) value; case null return null };
                value += (current % 128) * multiplier;
                multiplier *= 128;
                if (current < 128) return ?{ value; multiplier; last = current };
            };
        };
        public func nat() : ?Nat {
            switch (leb()) { case (?value) ?value.value; case null null };
        };
        func signed() : ?Int {
            switch (leb()) {
                case null null;
                case (?value) ?(if (value.last >= 64) (value.value : Int) - value.multiplier else value.value);
            };
        };
        public func text() : ?Text {
            let size = switch (nat()) { case (?value) value; case null return null };
            if (size > remaining()) return fail("truncated Candid text");
            let start = offset;
            offset += size;
            switch (Text.decodeUtf8(Blob.fromArray(Array.tabulate<Nat8>(size, func(index) { bytes[start + index] })))) {
                case (?value) ?value;
                case null fail("invalid UTF-8 in Candid text");
            };
        };
        func validReference(reference : Int) : Bool {
            if (reference >= 0) return Int.abs(reference) < types.size();
            reference == -1 or reference == -3 or reference == -15;
        };
        public func header() : ?Int {
            for (expected in [68, 73, 68, 76].vals()) {
                switch (byte()) {
                    case (?value) { if (value != expected) return fail("missing Candid DIDL header") };
                    case null return null;
                };
            };
            let count = switch (nat()) { case (?value) value; case null return null };
            // Each supported table entry needs at least its opcode and field
            // count. This is an input-size fact, not a protocol policy limit.
            if (count > remaining() / 2) return fail("truncated Candid type table");
            let table = List.empty<WireType>();
            var index = 0;
            while (index < count) {
                let kind = switch (signed()) { case (?value) value; case null return null };
                if (kind != -20 and kind != -21) return fail("unsupported Candid type constructor");
                let fieldCount = switch (nat()) { case (?value) value; case null return null };
                if (fieldCount > remaining() / 2) return fail("truncated Candid field table");
                let fields = List.empty<Field>();
                var previous : ?Nat = null;
                var fieldIndex = 0;
                while (fieldIndex < fieldCount) {
                    let fieldId = switch (nat()) { case (?value) value; case null return null };
                    if (fieldId >= 4_294_967_296) return fail("Candid field label exceeds uint32");
                    switch (previous) {
                        case (?prior) { if (fieldId <= prior) return fail("Candid fields are not strictly ordered") };
                        case null {};
                    };
                    let valueType = switch (signed()) { case (?value) value; case null return null };
                    List.add(fields, { id = fieldId; valueType });
                    previous := ?fieldId;
                    fieldIndex += 1;
                };
                List.add(table, if (kind == -20) #record(List.toArray(fields)) else #variant(List.toArray(fields)));
                index += 1;
            };
            types := List.toArray(table);
            for (entry in types.vals()) {
                let fields = switch (entry) { case (#record(value)) value; case (#variant(value)) value };
                for (field in fields.vals()) {
                    if (not validReference(field.valueType)) return fail("unsupported or invalid Candid type reference");
                };
            };
            let values = switch (nat()) { case (?value) value; case null return null };
            if (values != 1) return fail("expected one Candid result value");
            let valueType = switch (signed()) { case (?value) value; case null return null };
            if (not validReference(valueType)) return fail("unsupported or invalid Candid result type");
            ?valueType;
        };
        public func variant(reference : Int) : ?Field {
            if (reference < 0 or Int.abs(reference) >= types.size()) return fail("expected Candid result variant");
            let fields = switch (types[Int.abs(reference)]) {
                case (#variant(value)) value;
                case (_) return fail("expected Candid result variant");
            };
            let index = switch (nat()) { case (?value) value; case null return null };
            if (index >= fields.size()) return fail("Candid variant index is out of range");
            ?fields[index];
        };
        public func record(reference : Int) : ?[Field] {
            if (reference < 0 or Int.abs(reference) >= types.size()) return fail("expected Candid amount record");
            switch (types[Int.abs(reference)]) {
                case (#record(fields)) ?fields;
                case (_) fail("expected Candid amount record");
            };
        };
        public func skip(reference : Int) : Bool {
            // Deployed amount records contain Nat leaves. Preserve width
            // subtyping for additional leaves, without expanding arbitrary
            // recursive or shared composite graphs supplied by a remote pool.
            if (reference == -1) true else if (reference == -3) nat() != null
            else if (reference == -15) text() != null else {
                ignore fail<()>("unsupported composite Candid record field");
                false;
            };
        };
        public func complete() : Bool {
            if (remaining() != 0) {
                ignore fail<()>("trailing bytes after Candid result");
                return false;
            };
            failure == null;
        };
    };

    func rejection(reader : Reader, valueType : Int) : ?Text {
        let selected = switch (reader.variant(valueType)) { case (?value) value; case null return null };
        if (selected.id == labelHash("CommonError") and selected.valueType == -1) return ?"common error";
        if (selected.id == labelHash("InsufficientFunds") and selected.valueType == -1) return ?"insufficient funds";
        if (selected.valueType == -15) {
            let prefix = if (selected.id == labelHash("InternalError")) "internal error: " else if (selected.id == labelHash("UnsupportedToken")) "unsupported token: " else return null;
            switch (reader.text()) { case (?message) ?(prefix # message); case null null };
        } else null;
    };

    func decode<T>(bytes : Blob, success : (Reader, Int) -> ?T) : Outcome<T> {
        let reader = Reader(bytes);
        let root = switch (reader.header()) { case (?value) value; case null return #unknown(reader.error()) };
        let selected = switch (reader.variant(root)) { case (?value) value; case null return #unknown(reader.error()) };
        if (selected.id == labelHash("ok")) {
            let value = switch (success(reader, selected.valueType)) { case (?value) value; case null return #unknown(reader.error()) };
            if (reader.complete()) #ok(value) else #unknown(reader.error());
        } else if (selected.id == labelHash("err")) {
            let message = switch (rejection(reader, selected.valueType)) { case (?value) value; case null return #unknown(reader.error()) };
            if (reader.complete()) #rejected(message) else #unknown(reader.error());
        } else #unknown("unrecognized Candid result variant");
    };

    public func decodeNat(bytes : Blob) : Outcome<Nat> {
        decode<Nat>(bytes, func(reader, valueType) {
            if (valueType != -3) null else reader.nat();
        });
    };

    public func decodeAmounts(bytes : Blob) : Outcome<Amounts> {
        decode<Amounts>(bytes, func(reader, valueType) {
            let fields = switch (reader.record(valueType)) { case (?value) value; case null return null };
            var amount0 : ?Nat = null;
            var amount1 : ?Nat = null;
            for (field in fields.vals()) {
                if (field.id == labelHash("amount0")) {
                    if (field.valueType != -3) return null;
                    amount0 := reader.nat();
                    if (amount0 == null) return null;
                } else if (field.id == labelHash("amount1")) {
                    if (field.valueType != -3) return null;
                    amount1 := reader.nat();
                    if (amount1 == null) return null;
                } else if (not reader.skip(field.valueType)) return null;
            };
            switch (amount0, amount1) { case (?first, ?second) ?{ amount0 = first; amount1 = second }; case (_) null };
        });
    };
}
