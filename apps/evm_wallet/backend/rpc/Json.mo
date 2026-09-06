import Array "mo:core/Array";
import Char "mo:core/Char";
import Float "mo:core/Float";
import List "mo:core/List";
import Map "mo:core/Map";
import Nat32 "mo:core/Nat32";
import Text "mo:core/Text";
import JSON "mo:json";

module {
    public type Value = JSON.Json;
    public type Result<T> = { #ok : T; #err : Text };

    func digit(c : Char) : ?Nat {
        let n = Nat32.toNat(Char.toNat32(c));
        if (n >= 48 and n <= 57) ?(n - 48)
        else if (n >= 65 and n <= 70) ?(n - 55)
        else if (n >= 97 and n <= 102) ?(n - 87)
        else null;
    };

    func fourHex(chars : [Char], start : Nat) : ?Nat {
        if (start + 4 > chars.size()) return null;
        var value = 0;
        var i = start;
        while (i < start + 4) {
            let ?n = digit(chars[i]) else return null;
            value := value * 16 + n;
            i += 1;
        };
        ?value;
    };

    // json@1.4.0 parses BMP escapes, but treats UTF-16 surrogate halves as
    // independent Motoko Chars. Combine pairs before calling its parser.
    // Invalid halves are errors; ordinary escaped backslashes stay escaped.
    func normalizeSurrogates(input : Text) : Result<Text> {
        let chars = Text.toArray(input);
        let output = List.empty<Char>();
        var i = 0;
        while (i < chars.size()) {
            if (chars[i] == '\\' and i + 1 < chars.size()) {
                if (chars[i + 1] == 'u') {
                    let ?first = fourHex(chars, i + 2) else return #err("Invalid Unicode escape");
                    if (first >= 0xd800 and first <= 0xdbff) {
                        if (i + 12 > chars.size() or chars[i + 6] != '\\' or chars[i + 7] != 'u') {
                            return #err("Unpaired high Unicode surrogate");
                        };
                        let ?second = fourHex(chars, i + 8) else return #err("Invalid low Unicode surrogate");
                        if (second < 0xdc00 or second > 0xdfff) return #err("Invalid low Unicode surrogate");
                        let scalar = 0x10000 + (first - 0xd800) * 0x400 + (second - 0xdc00);
                        List.add(output, Char.fromNat32(Nat32.fromNat(scalar)));
                        i += 12;
                    } else if (first >= 0xdc00 and first <= 0xdfff) {
                        return #err("Unpaired low Unicode surrogate");
                    } else {
                        // Leave BMP escapes to JSON so control characters stay
                        // escaped until it validates the surrounding string.
                        var j = i;
                        while (j < i + 6) { List.add(output, chars[j]); j += 1 };
                        i += 6;
                    };
                } else {
                    List.add(output, chars[i]);
                    List.add(output, chars[i + 1]);
                    i += 2;
                };
            } else {
                List.add(output, chars[i]);
                i += 1;
            };
        };
        #ok(Text.fromIter(List.values(output)));
    };

    func validate(value : Value) : ?Text {
        switch (value) {
            case (#object_(entries)) {
                let keys = Map.empty<Text, Bool>();
                for ((key, child) in entries.vals()) {
                    if (Map.containsKey(keys, Text.compare, key)) return ?("Duplicate JSON field: " # key);
                    Map.add(keys, Text.compare, key, true);
                    switch (validate(child)) { case (?error) return ?error; case (null) {} };
                };
                null;
            };
            case (#array(values)) {
                for (child in values.vals()) {
                    switch (validate(child)) { case (?error) return ?error; case (null) {} };
                };
                null;
            };
            case (#number(#float(number))) {
                // Reject non-finite numbers accepted by a floating parser;
                // they cannot be serialized as JSON numeric values.
                if (Float.isNaN(number) or Float.isNaN(number - number)) ?"Non-finite JSON number" else null;
            };
            case (_) null;
        };
    };

    public func parse(input : Text) : Result<Value> {
        let normalized = switch (normalizeSurrogates(input)) {
            case (#err(error)) return #err(error);
            case (#ok(value)) value;
        };
        switch (JSON.parse(normalized)) {
            case (#err(error)) #err(JSON.errToText(error));
            case (#ok(value)) switch (validate(value)) {
                case (?error) #err(error);
                case (null) #ok(value);
            };
        };
    };

    public func quote(input : Text) : Text { JSON.stringify(#string(input), null) };

    // JSON objects are unordered; arrays are ordered. Normalize recursively
    // before comparing independent provider results without losing fields.
    public func canonical(value : Value) : Value {
        switch (value) {
            case (#object_(entries)) {
                let normalized = Array.map<(Text, Value), (Text, Value)>(entries, func((key, child)) { (key, canonical(child)) });
                #object_(Array.sort<(Text, Value)>(normalized, func(a, b) { Text.compare(a.0, b.0) }));
            };
            case (#array(values)) #array(Array.map<Value, Value>(values, canonical));
            case (_) value;
        };
    };

    // json@1.4.0 escapes string values but not object keys. Serialize object
    // keys through the same string encoder so quoted/escaped keys round-trip.
    public func stringify(value : Value) : Text {
        switch (value) {
            case (#object_(entries)) {
                let fields = Array.map<(Text, Value), Text>(entries, func((key, child)) { quote(key) # ":" # stringify(child) });
                "{" # Text.join(fields.vals(), ",") # "}";
            };
            case (#array(values)) {
                "[" # Text.join(Array.map<Value, Text>(values, stringify).vals(), ",") # "]";
            };
            case (_) JSON.stringify(value, null);
        };
    };

    public func field(value : Value, name : Text) : ?Value {
        let #object_(entries) = value else return null;
        var found : ?Value = null;
        for ((key, item) in entries.vals()) {
            if (key == name) {
                if (found != null) return null;
                found := ?item;
            };
        };
        found;
    };

    public func string(value : Value) : ?Text {
        switch (value) { case (#string(text)) ?text; case (_) null };
    };

    public func text(value : Value) : Result<Text> {
        switch (string(value)) { case (?value) #ok(value); case (null) #err("Expected a JSON string") };
    };

    public func stringResult(input : Text) : ?Text {
        switch (parse(input)) { case (#ok(value)) string(value); case (_) null };
    };

    // Ethereum QUANTITY, distinct from padded DATA. Preserve arbitrary Nat
    // precision and reject empty/negative/decimal/noncanonical encodings.
    public func parseQuantity(input : Text) : ?Nat {
        let chars = input.chars();
        if (chars.next() != ?'0' or chars.next() != ?'x') return null;
        let ?first = chars.next() else return null;
        let ?start = digit(first) else return null;
        var value = start;
        var count = 1;
        for (char in chars) {
            let ?n = digit(char) else return null;
            value := value * 16 + n;
            count += 1;
        };
        if (start == 0 and count != 1) return null;
        ?value;
    };

    public func maybeQuantity(value : Value) : ?Nat {
        switch (string(value)) { case (?text) parseQuantity(text); case (null) null };
    };

    public func quantity(value : Value) : Result<Nat> {
        switch (maybeQuantity(value)) { case (?value) #ok(value); case (null) #err("Expected an Ethereum hex quantity") };
    };

    public func quantityText(value : Text) : Result<Nat> {
        switch (parseQuantity(value)) { case (?value) #ok(value); case (null) #err("Expected an Ethereum hex quantity") };
    };

    public func hexQuantity(value : Nat) : Text {
        if (value == 0) return "0x0";
        let digits = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "a", "b", "c", "d", "e", "f"];
        var n = value;
        var output = "";
        while (n != 0) { output := digits[n % 16] # output; n /= 16 };
        "0x" # output;
    };
};
