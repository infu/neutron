import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Char "mo:core/Char";
import Int "mo:core/Int";
import List "mo:core/List";
import Nat "mo:core/Nat";
import Nat32 "mo:core/Nat32";
import Result "mo:core/Result";
import Text "mo:core/Text";
import Hex "Hex";
import Keccak "Keccak";

/// EIP-712 encoding, performed in the custody backend from the reviewed JSON.
/// https://eips.ethereum.org/EIPS/eip-712
/// JSON numbers retain their exact lexemes: no floating point conversion occurs.
/// Recursive type declarations are supported; JSON instances are finite trees.
module {
    type Json = { #Object : [(Text, Json)]; #array : [Json]; #string : Text; #number : Text; #boolean : Bool; #nil };
    type Kind = { #uint : Nat; #int : Nat; #bool; #address; #bytes : ?Nat; #string; #structure : Text; #array : (Kind, ?Nat) };
    type Field = { name : Text; spelling : Text; kind : Kind };
    type Types = [(Text, [Field])];
    type Document = { types : Types; primary : Text; domain : Json; message : Json };

    func digit(c : Char) : Bool { c >= '0' and c <= '9' };
    func code(c : Char) : Nat { Nat32.toNat(Char.toNat32(c)) };
    func hexDigit(c : Char) : ?Nat {
        if (digit(c)) ?(code(c) - 48)
        else if (c >= 'a' and c <= 'f') ?(code(c) - 87)
        else if (c >= 'A' and c <= 'F') ?(code(c) - 55)
        else null;
    };
    func part(chars : [Char], start : Nat, end : Nat) : Text {
        Text.fromArray(Array.tabulate<Char>(end - start, func(i) { chars[start + i] }));
    };
    func member(entries : [(Text, Json)], name : Text) : ?Json {
        for ((key, value) in entries.vals()) if (key == name) return ?value;
        null;
    };
    func hasName(names : [Text], name : Text) : Bool {
        for (item in names.vals()) if (item == name) return true;
        false;
    };

    // This parser rejects duplicate members at every level, invalid Unicode
    // escapes, invalid JSON number grammar, and trailing data. These checks make
    // the displayed request and the signed interpretation unambiguous.
    class Parser(input : Text) {
        let chars = Text.toArray(input);
        var pos = 0;
        var problem : ?Text = null;
        func fail<T>(message : Text) : ?T {
            if (problem == null) problem := ?(message # " at character " # Nat.toText(pos));
            null;
        };
        func peek(c : Char) : Bool { pos < chars.size() and chars[pos] == c };
        func ws() {
            while (pos < chars.size() and (chars[pos] == ' ' or chars[pos] == '\n' or chars[pos] == '\r' or chars[pos] == '\t')) pos += 1;
        };
        func unicodeUnit() : ?Nat {
            var n = 0;
            var count = 0;
            while (count < 4) {
                if (pos >= chars.size()) return fail("Incomplete Unicode escape");
                let d = switch (hexDigit(chars[pos])) { case (?value) value; case (_) return fail("Invalid Unicode escape") };
                n := n * 16 + d;
                pos += 1;
                count += 1;
            };
            ?n;
        };
        func string() : ?Text {
            if (not peek('\"')) return fail("Expected JSON string");
            pos += 1;
            let output = List.empty<Char>();
            while (pos < chars.size()) {
                let c = chars[pos];
                pos += 1;
                if (c == '\"') return ?Text.fromIter(List.values(output));
                if (code(c) < 32) return fail("Unescaped JSON control character");
                if (c != '\\') { List.add(output, c) } else {
                    if (pos >= chars.size()) return fail("Incomplete string escape");
                    let escaped = chars[pos];
                    pos += 1;
                    switch (escaped) {
                        case ('\"') List.add(output, '\"');
                        case ('\\') List.add(output, '\\');
                        case ('/') List.add(output, '/');
                        case ('b') List.add(output, '\u{8}');
                        case ('f') List.add(output, '\u{c}');
                        case ('n') List.add(output, '\n');
                        case ('r') List.add(output, '\r');
                        case ('t') List.add(output, '\t');
                        case ('u') {
                            var scalar = switch (unicodeUnit()) { case (?n) n; case (_) return null };
                            if (scalar >= 0xd800 and scalar <= 0xdbff) {
                                if (not peek('\\')) return fail("Unpaired high surrogate");
                                pos += 1;
                                if (not peek('u')) return fail("Unpaired high surrogate");
                                pos += 1;
                                let low = switch (unicodeUnit()) { case (?n) n; case (_) return null };
                                if (low < 0xdc00 or low > 0xdfff) return fail("Invalid low surrogate");
                                scalar := 0x10000 + (scalar - 0xd800) * 0x400 + (low - 0xdc00);
                            } else if (scalar >= 0xdc00 and scalar <= 0xdfff) return fail("Unpaired low surrogate");
                            List.add(output, Char.fromNat32(Nat32.fromNat(scalar)));
                        };
                        case (_) return fail("Invalid string escape");
                    };
                };
            };
            fail("Unterminated string");
        };
        func literal(expected : Text, value : Json) : ?Json {
            for (c in expected.chars()) {
                if (not peek(c)) return fail("Invalid JSON literal");
                pos += 1;
            };
            ?value;
        };
        func number() : ?Json {
            let start = pos;
            if (peek('-')) pos += 1;
            if (peek('0')) pos += 1 else {
                if (pos >= chars.size() or chars[pos] < '1' or chars[pos] > '9') return fail("Invalid JSON number");
                while (pos < chars.size() and digit(chars[pos])) pos += 1;
            };
            if (peek('.')) {
                pos += 1;
                let fraction = pos;
                while (pos < chars.size() and digit(chars[pos])) pos += 1;
                if (fraction == pos) return fail("Missing fractional digits");
            };
            if (peek('e') or peek('E')) {
                pos += 1;
                if (peek('+') or peek('-')) pos += 1;
                let exponent = pos;
                while (pos < chars.size() and digit(chars[pos])) pos += 1;
                if (exponent == pos) return fail("Missing exponent digits");
            };
            ?#number(part(chars, start, pos));
        };
        func value() : ?Json {
            ws();
            if (pos >= chars.size()) return fail("Expected JSON value");
            switch (chars[pos]) {
                case ('\"') switch (string()) { case (?s) ?#string(s); case (_) null };
                case ('t') literal("true", #boolean(true));
                case ('f') literal("false", #boolean(false));
                case ('n') literal("null", #nil);
                case ('{') {
                    pos += 1;
                    ws();
                    let entries = List.empty<(Text, Json)>();
                    if (peek('}')) { pos += 1; return ?#Object([]) };
                    loop {
                        let key = switch (string()) { case (?s) s; case (_) return null };
                        for ((previous, _) in List.values(entries)) if (previous == key) return fail("Duplicate JSON member: " # key);
                        ws();
                        if (not peek(':')) return fail("Expected colon");
                        pos += 1;
                        let item = switch (value()) { case (?v) v; case (_) return null };
                        List.add(entries, (key, item));
                        ws();
                        if (peek('}')) { pos += 1; return ?#Object(List.toArray(entries)) };
                        if (not peek(',')) return fail("Expected comma or closing brace");
                        pos += 1;
                        ws();
                    };
                };
                case ('[') {
                    pos += 1;
                    ws();
                    let items = List.empty<Json>();
                    if (peek(']')) { pos += 1; return ?#array([]) };
                    loop {
                        let item = switch (value()) { case (?v) v; case (_) return null };
                        List.add(items, item);
                        ws();
                        if (peek(']')) { pos += 1; return ?#array(List.toArray(items)) };
                        if (not peek(',')) return fail("Expected comma or closing bracket");
                        pos += 1;
                    };
                };
                case (_) number();
            };
        };
        public func parse() : Result.Result<Json, Text> {
            let parsed = value();
            ws();
            if (pos != chars.size() and problem == null) problem := ?("Unexpected trailing JSON at character " # Nat.toText(pos));
            switch (problem, parsed) {
                case (?message, _) #err(message);
                case (null, ?item) #ok(item);
                case (_) #err("Invalid JSON");
            };
        };
    };

    func identifier(value : Text) : Bool {
        var first = true;
        for (c in value.chars()) {
            if (not ((c >= 'a' and c <= 'z') or (c >= 'A' and c <= 'Z') or c == '_' or c == '$' or (not first and digit(c)))) return false;
            first := false;
        };
        not first;
    };
    // Some EIP-712 protocols qualify struct names (for example Hyperliquid's
    // "HyperliquidTransaction:ApproveAgent"). These names are hashed verbatim,
    // including the separator. Keep ordinary field identifiers unchanged and
    // reject empty/invalid components rather than accepting encodeType syntax.
    func typeIdentifier(value : Text) : Bool {
        for (component in Text.split(value, #char(':'))) {
            if (not identifier(component)) return false;
        };
        value.size() > 0;
    };
    func decimal(value : Text) : ?Nat {
        if (value.size() == 0) return null;
        var n = 0;
        for (c in value.chars()) {
            if (not digit(c)) return null;
            n := n * 10 + code(c) - 48;
        };
        ?n;
    };
    func parseKind(spelling : Text) : Result.Result<Kind, Text> {
        let chars = Text.toArray(spelling);
        var end = 0;
        while (end < chars.size() and chars[end] != '[') end += 1;
        let name = part(chars, 0, end);
        if (not typeIdentifier(name)) return #err("Invalid EIP-712 type: " # spelling);
        var kind : Kind = #structure(name);
        if (name == "address") kind := #address
        else if (name == "bool") kind := #bool
        else if (name == "string") kind := #string
        else if (name == "bytes") kind := #bytes(null)
        else if (name == "uint" or name == "int") return #err("EIP-712 requires explicit integer widths")
        else {
            let (prefix, suffix) = if (Text.startsWith(name, #text("uint"))) ("uint", part(chars, 4, end))
                else if (Text.startsWith(name, #text("int"))) ("int", part(chars, 3, end))
                else if (Text.startsWith(name, #text("bytes"))) ("bytes", part(chars, 5, end))
                else ("", "");
            // A named struct such as "interface" is not an integer type.
            if (prefix != "" and suffix.size() > 0) {
                switch (decimal(suffix)) {
                    case (?width) {
                        if (Nat.toText(width) != suffix) return #err("Noncanonical type width: " # spelling);
                        if (prefix == "bytes") {
                            if (width == 0 or width > 32) return #err("Invalid fixed bytes width: " # spelling);
                            kind := #bytes(?width);
                        } else {
                            if (width < 8 or width > 256 or width % 8 != 0) return #err("Invalid integer width: " # spelling);
                            kind := if (prefix == "uint") #uint(width) else #int(width);
                        };
                    };
                    case (_) {};
                };
            };
        };
        var pos = end;
        while (pos < chars.size()) {
            if (chars[pos] != '[') return #err("Invalid array type: " # spelling);
            pos += 1;
            let start = pos;
            while (pos < chars.size() and digit(chars[pos])) pos += 1;
            if (pos >= chars.size() or chars[pos] != ']') return #err("Invalid array type: " # spelling);
            let length = if (start == pos) null else switch (decimal(part(chars, start, pos))) {
                case (?n) {
                    if (n == 0 or Nat.toText(n) != part(chars, start, pos)) return #err("Invalid fixed array length: " # spelling);
                    ?n;
                };
                case (_) return #err("Invalid array length: " # spelling);
            };
            kind := #array(kind, length);
            pos += 1;
        };
        #ok(kind);
    };
    func fields(types : Types, name : Text) : ?[Field] {
        for ((key, values) in types.vals()) if (key == name) return ?values;
        null;
    };
    func referenced(kind : Kind) : ?Text {
        switch (kind) {
            case (#structure(name)) ?name;
            case (#array(element, _)) referenced(element);
            case (_) null;
        };
    };
    func readTypes(value : Json) : Result.Result<Types, Text> {
        let entries = switch (value) { case (#Object(v)) v; case (_) return #err("types must be a JSON object") };
        let output = List.empty<(Text, [Field])>();
        for ((name, definition) in entries.vals()) {
            if (not typeIdentifier(name)) return #err("Invalid struct name: " # name);
            switch (parseKind(name)) {
                case (#ok(#structure(_))) {};
                case (_) return #err("Struct name conflicts with an EIP-712 atomic type: " # name);
            };
            let rawFields = switch (definition) { case (#array(v)) v; case (_) return #err("Struct definition must be an array: " # name) };
            let members = List.empty<Field>();
            for (raw in rawFields.vals()) {
                let obj = switch (raw) { case (#Object(v)) v; case (_) return #err("Field definition must be an object") };
                if (obj.size() != 2) return #err("A field definition requires only name and type");
                let fieldName = switch (member(obj, "name")) { case (?#string(v)) v; case (_) return #err("Field requires a string name") };
                let spelling = switch (member(obj, "type")) { case (?#string(v)) v; case (_) return #err("Field requires a string type") };
                if (not identifier(fieldName)) return #err("Invalid field name: " # fieldName);
                for (previous in List.values(members)) if (previous.name == fieldName) return #err("Duplicate struct field: " # name # "." # fieldName);
                let kind = switch (parseKind(spelling)) { case (#ok(v)) v; case (#err(e)) return #err(e) };
                List.add(members, { name = fieldName; spelling; kind });
            };
            List.add(output, (name, List.toArray(members)));
        };
        let types = List.toArray(output);
        for ((_, members) in types.vals()) for (field in members.vals()) switch (referenced(field.kind)) {
            case (?name) if (fields(types, name) == null) return #err("Undefined struct type: " # name);
            case (_) {};
        };
        let domain = switch (fields(types, "EIP712Domain")) { case (?v) v; case (_) return #err("types must declare EIP712Domain") };
        for (field in domain.vals()) {
            let expected = switch (field.name) {
                case ("name" or "version") "string";
                case ("chainId") "uint256";
                case ("verifyingContract") "address";
                case ("salt") "bytes32";
                case (_) return #err("Unsupported EIP712Domain field: " # field.name);
            };
            if (field.spelling != expected) return #err("Invalid EIP712Domain type for " # field.name);
        };
        #ok(types);
    };
    func document(jsonText : Text) : Result.Result<Document, Text> {
        let parsed = switch (Parser(jsonText).parse()) { case (#ok(v)) v; case (#err(e)) return #err(e) };
        let obj = switch (parsed) { case (#Object(v)) v; case (_) return #err("Typed data must be a JSON object") };
        if (obj.size() != 4) return #err("Typed data requires exactly types, primaryType, domain, and message");
        let types = switch (member(obj, "types")) {
            case (?v) switch (readTypes(v)) { case (#ok(t)) t; case (#err(e)) return #err(e) };
            case (_) return #err("Missing types");
        };
        let primary = switch (member(obj, "primaryType")) { case (?#string(v)) v; case (_) return #err("Missing primaryType") };
        if (fields(types, primary) == null) return #err("Undefined primaryType: " # primary);
        let domain = switch (member(obj, "domain")) { case (?(#Object(v))) #Object(v); case (_) return #err("domain must be an object") };
        let message = switch (member(obj, "message")) { case (?(#Object(v))) #Object(v); case (_) return #err("message must be an object") };
        #ok({ types; primary; domain; message });
    };

    // Parse an integer from a decimal/hex string or an exact JSON number. The
    // protocol's 256-bit bound is checked before computing any exponentiation.
    func integer(value : Json) : Result.Result<Int, Text> {
        let (raw, isJsonNumber) = switch (value) {
            case (#number(v)) (v, true);
            case (#string(v)) (v, false);
            case (_) return #err("Integer must be a JSON number or a decimal/hex string");
        };
        let chars = Text.toArray(raw);
        if (chars.size() == 0) return #err("Empty integer");
        var pos = 0;
        let negative = chars[0] == '-';
        if (negative) pos += 1;
        if (pos == chars.size()) return #err("Invalid integer");
        if (not isJsonNumber and pos + 2 <= chars.size() and chars[pos] == '0' and chars[pos + 1] == 'x') {
            pos += 2;
            if (pos == chars.size()) return #err("Empty hexadecimal integer");
            var n = 0;
            while (pos < chars.size()) {
                let d = switch (hexDigit(chars[pos])) { case (?v) v; case (_) return #err("Invalid hexadecimal integer") };
                n := n * 16 + d;
                if (n >= 2 ** 256) return #err("Integer exceeds 256 bits");
                pos += 1;
            };
            return #ok(if (negative) -(n : Int) else n);
        };
        let digits = List.empty<Char>();
        var fractionDigits = 0;
        var fraction = false;
        while (pos < chars.size() and chars[pos] != 'e' and chars[pos] != 'E') {
            let c = chars[pos];
            if (c == '.' and isJsonNumber and not fraction) fraction := true else {
                if (not digit(c)) return #err("Invalid decimal integer");
                List.add(digits, c);
                if (fraction) fractionDigits += 1;
            };
            pos += 1;
        };
        var exponent : Int = 0;
        if (pos < chars.size()) {
            if (not isJsonNumber) return #err("String integers must not contain an exponent");
            pos += 1;
            var expNegative = false;
            if (pos < chars.size() and (chars[pos] == '+' or chars[pos] == '-')) { expNegative := chars[pos] == '-'; pos += 1 };
            let start = pos;
            var magnitude = 0;
            while (pos < chars.size()) {
                if (not digit(chars[pos])) return #err("Invalid exponent");
                magnitude := magnitude * 10 + code(chars[pos]) - 48;
                pos += 1;
            };
            if (pos == start) return #err("Missing exponent");
            exponent := if (expNegative) -(magnitude : Int) else magnitude;
        };
        let values = List.toArray(digits);
        if (values.size() == 0) return #err("Missing integer digits");
        var first = 0;
        while (first < values.size() and values[first] == '0') first += 1;
        if (first == values.size()) return #ok(0);
        var last = values.size();
        var scale : Int = exponent - fractionDigits;
        while (last > first and values[last - 1] == '0') { last -= 1; scale += 1 };
        if (scale < 0) return #err("Integer value has a fractional component");
        // 2^256 has 78 decimal digits. Avoid allocating 10^an_untrusted_exponent.
        if ((last - first : Nat) + scale > 78) return #err("Integer exceeds 256 bits");
        var n = 0;
        var i = first;
        while (i < last) { n := n * 10 + code(values[i]) - 48; i += 1 };
        n *= 10 ** Int.abs(scale);
        if (n >= 2 ** 256) return #err("Integer exceeds 256 bits");
        #ok(if (negative) -(n : Int) else n);
    };
    func concatenate(blobs : [Blob]) : Blob {
        let bytes = List.empty<Nat8>();
        for (blob in blobs.vals()) for (byte in blob.vals()) List.add(bytes, byte);
        Blob.fromArray(List.toArray(bytes));
    };
    func declaration(name : Text, members : [Field]) : Text {
        let parts = List.empty<Text>();
        for (field in members.vals()) List.add(parts, field.spelling # " " # field.name);
        name # "(" # Text.join(List.values(parts), ",") # ")";
    };
    func typeHash(types : Types, primary : Text) : Blob {
        let visited = List.empty<Text>();
        func visit(name : Text) {
            if (hasName(List.toArray(visited), name)) return;
            List.add(visited, name);
            switch (fields(types, name)) {
                case (?members) for (field in members.vals()) switch (referenced(field.kind)) { case (?target) visit(target); case (_) {} };
                case (_) {};
            };
        };
        visit(primary);
        let dependencies = Array.sort<Text>(Array.filter<Text>(List.toArray(visited), func(name) { name != primary }), Text.compare);
        let parts = List.empty<Text>();
        switch (fields(types, primary)) { case (?members) List.add(parts, declaration(primary, members)); case (_) {} };
        for (name in dependencies.vals()) switch (fields(types, name)) { case (?members) List.add(parts, declaration(name, members)); case (_) {} };
        Keccak.hash(Text.encodeUtf8(Text.join(List.values(parts), "")));
    };
    func structure(types : Types, name : Text, value : Json) : Result.Result<Blob, Text> {
        let members = switch (fields(types, name)) { case (?v) v; case (_) return #err("Undefined struct: " # name) };
        let obj = switch (value) { case (#Object(v)) v; case (_) return #err("Expected object for " # name) };
        if (obj.size() != members.size()) return #err("Missing or unknown fields in " # name);
        let encoded = List.singleton<Blob>(typeHash(types, name));
        for (field in members.vals()) {
            let raw = switch (member(obj, field.name)) { case (?v) v; case (_) return #err("Missing field " # name # "." # field.name) };
            let bytes = switch (encode(types, field.kind, raw)) { case (#ok(v)) v; case (#err(e)) return #err(name # "." # field.name # ": " # e) };
            List.add(encoded, bytes);
        };
        #ok(Keccak.hash(concatenate(List.toArray(encoded))));
    };
    func encode(types : Types, kind : Kind, value : Json) : Result.Result<Blob, Text> {
        switch (kind) {
            case (#structure(name)) structure(types, name, value);
            case (#array(element, length)) {
                let values = switch (value) { case (#array(v)) v; case (_) return #err("Expected array") };
                switch (length) { case (?n) if (n != values.size()) return #err("Incorrect fixed array length"); case (_) {} };
                let encoded = List.empty<Blob>();
                for (item in values.vals()) switch (encode(types, element, item)) { case (#ok(v)) List.add(encoded, v); case (#err(e)) return #err(e) };
                #ok(Keccak.hash(concatenate(List.toArray(encoded))));
            };
            case (#string) switch (value) { case (#string(v)) #ok(Keccak.hash(Text.encodeUtf8(v))); case (_) #err("Expected string") };
            case (#bool) switch (value) { case (#boolean(v)) Hex.word(if (v) 1 else 0); case (_) #err("Expected boolean") };
            case (#address) {
                let text = switch (value) { case (#string(v)) v; case (_) return #err("Expected address string") };
                let bytes = switch (Hex.decode(text)) { case (#ok(v)) v; case (#err(e)) return #err(e) };
                if (bytes.size() != 20) return #err("Address must contain exactly 20 bytes");
                #ok(concatenate([Blob.fromArray(Array.repeat<Nat8>(0, 12)), bytes]));
            };
            case (#bytes(length)) {
                let text = switch (value) { case (#string(v)) v; case (_) return #err("Expected hexadecimal bytes string") };
                let bytes = switch (Hex.decode(text)) { case (#ok(v)) v; case (#err(e)) return #err(e) };
                switch (length) {
                    case (null) #ok(Keccak.hash(bytes));
                    case (?n) {
                        if (bytes.size() != n) return #err("Incorrect fixed bytes length");
                        #ok(concatenate([bytes, Blob.fromArray(Array.repeat<Nat8>(0, 32 - n))]));
                    };
                };
            };
            case (#uint(width)) {
                let n = switch (integer(value)) { case (#ok(v)) v; case (#err(e)) return #err(e) };
                if (n < 0 or n >= (2 ** width : Nat)) return #err("Unsigned integer out of range");
                Hex.word(Int.abs(n));
            };
            case (#int(width)) {
                let n = switch (integer(value)) { case (#ok(v)) v; case (#err(e)) return #err(e) };
                let bound : Int = 2 ** (width - 1);
                if (n < -bound or n >= bound) return #err("Signed integer out of range");
                Hex.word(if (n < 0) Int.abs((2 ** 256 : Nat) + n) else Int.abs(n));
            };
        };
    };
    func digest(doc : Document) : Result.Result<Blob, Text> {
        let domain = switch (structure(doc.types, "EIP712Domain", doc.domain)) { case (#ok(v)) v; case (#err(e)) return #err(e) };
        // Domain-only typed data is used by eth_signTypedData_v4 clients.
        if (doc.primary == "EIP712Domain") {
            switch (doc.message) { case (#Object(v)) if (v.size() != 0) return #err("Domain-only typed data requires an empty message"); case (_) {} };
            return #ok(Keccak.hash(concatenate(["\19\01", domain])));
        };
        let message = switch (structure(doc.types, doc.primary, doc.message)) { case (#ok(v)) v; case (#err(e)) return #err(e) };
        #ok(Keccak.hash(concatenate(["\19\01", domain, message])));
    };
    public func hash(jsonText : Text) : Result.Result<Blob, Text> {
        switch (document(jsonText)) { case (#ok(doc)) digest(doc); case (#err(e)) #err(e) };
    };
    /// A declared domain chain must match the reviewed network. Standard
    /// chainless domains remain signable; recording an operation's network does
    /// not introduce chain binding that is absent from the signed document.
    public func hashForChain(jsonText : Text, chainId : Nat) : Result.Result<Blob, Text> {
        let doc = switch (document(jsonText)) { case (#ok(v)) v; case (#err(e)) return #err(e) };
        let obj = switch (doc.domain) { case (#Object(v)) v; case (_) return #err("Invalid domain") };
        let raw = switch (member(obj, "chainId")) { case (?v) v; case (_) return digest(doc) };
        let actual = switch (integer(raw)) { case (#ok(v)) v; case (#err(e)) return #err(e) };
        if (actual != chainId) return #err("domain.chainId does not match the selected network");
        digest(doc);
    };
};
