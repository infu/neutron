import Blob "mo:core/Blob";
import Nat8 "mo:core/Nat8";
import List "mo:core/List";
import Hex "Hex";

/// Ethereum RLP canonical encoder. Protocol integers must use Hex.nat first.
module {
  public type Value = { #bytes : Blob; #list : [Value] };

  func prefix(length : Nat, shortBase : Nat, longBase : Nat) : Blob {
    if (length < 56) return Blob.fromArray([Nat8.fromNat(shortBase + length)]);
    let lengthBytes = Hex.nat(length);
    Hex.concat([Blob.fromArray([Nat8.fromNat(longBase + lengthBytes.size())]), lengthBytes])
  };

  public func encode(value : Value) : Blob {
    switch (value) {
      case (#bytes(bytes)) {
        let data = Blob.toArray(bytes);
        if (data.size() == 1 and data[0] < 0x80) return bytes;
        Hex.concat([prefix(bytes.size(), 0x80, 0xb7), bytes])
      };
      case (#list(values)) {
        let encoded = List.empty<Blob>();
        var length = 0;
        for (item in values.vals()) {
          let bytes = encode(item);
          length += bytes.size();
          List.add(encoded, bytes);
        };
        let body = Hex.concat(List.toArray(encoded));
        Hex.concat([prefix(length, 0xc0, 0xf7), body])
      };
    }
  };
}
