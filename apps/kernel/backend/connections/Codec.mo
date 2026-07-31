import Char "mo:core/Char";
import List "mo:core/List";
import Nat8 "mo:core/Nat8";
import Nat32 "mo:core/Nat32";
import Text "mo:core/Text";
import JSON "mo:json.mo";

module {
    let hex = [
        "0", "1", "2", "3", "4", "5", "6", "7",
        "8", "9", "A", "B", "C", "D", "E", "F",
    ];

    public func percentEncode(value : Text) : Text {
        let encoded = List.empty<Text>();
        for (byte in Text.encodeUtf8(value).vals()) {
            let n = Nat8.toNat(byte);
            if (
                (n >= 65 and n <= 90) or
                (n >= 97 and n <= 122) or
                (n >= 48 and n <= 57) or
                n == 45 or n == 46 or n == 95 or n == 126
            ) {
                List.add(encoded, Char.toText(Char.fromNat32(Nat32.fromNat(n))));
            } else {
                List.add(encoded, "%" # hex[n / 16] # hex[n % 16]);
            };
        };
        Text.join(List.values(encoded), "");
    };

    public func jsonString(value : Text) : Text {
        let encoded = List.singleton<Text>("\"");
        for (char in value.chars()) {
            let code = Nat32.toNat(Char.toNat32(char));
            if (code == 0x22) List.add(encoded, "\\\"")
            else if (code == 0x5c) List.add(encoded, "\\\\")
            else if (code == 0x08) List.add(encoded, "\\b")
            else if (code == 0x0c) List.add(encoded, "\\f")
            else if (code == 0x0a) List.add(encoded, "\\n")
            else if (code == 0x0d) List.add(encoded, "\\r")
            else if (code == 0x09) List.add(encoded, "\\t")
            else if (code < 0x20) {
                List.add(encoded, "\\u00" # hex[code / 16] # hex[code % 16]);
            } else {
                List.add(encoded, Char.toText(char));
            };
        };
        List.add(encoded, "\"");
        Text.join(List.values(encoded), "");
    };

    public func parseStringField(value : Text, field : Text) : ?Text {
        switch (JSON.parse(value)) {
            case (?(#Object(entries))) {
                var found : ?Text = null;
                for ((name, item) in entries.vals()) {
                    if (name == field) {
                        if (found != null) return null;
                        switch (item) {
                            case (#String(text)) found := ?text;
                            case (_) return null;
                        };
                    };
                };
                found;
            };
            case (_) null;
        };
    };
};
