// All rights reserved. See ../LICENSE.
import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Char "mo:core/Char";
import Nat8 "mo:core/Nat8";
import Nat32 "mo:core/Nat32";
import Text "mo:core/Text";
import Sha256 "mo:sha2/Sha256";

module {
  public func hash(data : Blob) : Blob { Sha256.fromBlob(#sha256, data) };
  public func hashText(value : Text) : Blob { hash(Text.encodeUtf8(value)) };

  public func hex(data : Blob) : Text {
    let alphabet = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f'];
    let bytes = data.toArray();
    Text.fromIter(Array.tabulate<Char>(bytes.size() * 2, func(index) {
      let value = Nat8.toNat(bytes[index / 2]);
      alphabet[if (index % 2 == 0) value / 16 else value % 16];
    }).vals());
  };

  public func isHex(value : Text, bytes : Nat) : Bool {
    if (value.size() != bytes * 2) return false;
    for (character in value.chars()) {
      if (not ((character >= '0' and character <= '9') or (character >= 'a' and character <= 'f'))) return false;
    };
    true;
  };

  public func quote(value : Text) : Text {
    var output = "\"";
    for (character in value.chars()) {
      if (Char.toNat32(character) == 34) output #= "\\\""
      else if (character == '\\') output #= "\\\\"
      else if (character == '\n') output #= "\\n"
      else if (character == '\r') output #= "\\r"
      else if (character == '\t') output #= "\\t"
      else if (Char.toNat32(character) < 32) {
        let code = Nat8.fromNat(Nat32.toNat(Char.toNat32(character)));
        output #= "\\u00" # hex(Blob.fromArray([code]));
      } else output #= Char.toText(character);
    };
    output # "\"";
  };
}
