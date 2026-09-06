import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Char "mo:core/Char";
import List "mo:core/List";
import Nat8 "mo:core/Nat8";
import Nat32 "mo:core/Nat32";
import Result "mo:core/Result";
import Text "mo:core/Text";

/// Byte and integer encodings shared by the authoritative EVM protocol code.
module {
  public let uint256Limit : Nat = 0x10000000000000000000000000000000000000000000000000000000000000000;

  func digit(c : Char) : ?Nat {
    let n = Nat32.toNat(Char.toNat32(c));
    if (n >= 48 and n <= 57) ?(n - 48)
    else if (n >= 65 and n <= 70) ?(n - 55)
    else if (n >= 97 and n <= 102) ?(n - 87)
    else null
  };

  /// Hex byte strings are 0x-prefixed and contain complete bytes; 0x is empty.
  public func decode(input : Text) : Result.Result<Blob, Text> {
    let chars = Text.toArray(input);
    if (chars.size() < 2 or chars[0] != '0' or chars[1] != 'x') return #err("Expected a 0x-prefixed hexadecimal byte string");
    if (chars.size() % 2 != 0) return #err("Hexadecimal byte strings must contain complete bytes");
    let output = List.empty<Nat8>();
    var i = 2;
    while (i < chars.size()) {
      let ?a = digit(chars[i]) else return #err("Invalid hexadecimal digit");
      let ?b = digit(chars[i + 1]) else return #err("Invalid hexadecimal digit");
      List.add(output, Nat8.fromNat(a * 16 + b));
      i += 2;
    };
    #ok(Blob.fromArray(List.toArray(output)))
  };

  public func encode(input : Blob) : Text {
    let alphabet : [Char] = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f'];
    let output = List.empty<Char>();
    List.add(output, '0');
    List.add(output, 'x');
    for (byte in input.vals()) {
      let n = Nat8.toNat(byte);
      List.add(output, alphabet[n / 16]);
      List.add(output, alphabet[n % 16]);
    };
    Text.fromArray(List.toArray(output))
  };

  /// Minimal unsigned big-endian integer bytes. RLP encodes zero as empty.
  public func nat(value : Nat) : Blob {
    var remaining = value;
    let output = List.empty<Nat8>();
    while (remaining > 0) {
      List.add(output, Nat8.fromNat(remaining % 256));
      remaining /= 256;
    };
    Blob.fromArray(Array.reverse(List.toArray(output)))
  };

  public func toNat(bytes : Blob) : Nat {
    var result = 0;
    for (byte in bytes.vals()) result := result * 256 + Nat8.toNat(byte);
    result
  };

  public func word(value : Nat) : Result.Result<Blob, Text> {
    if (value >= uint256Limit) return #err("Integer is outside uint256");
    let bytes = Blob.toArray(nat(value));
    let padding = 32 - bytes.size();
    #ok(Blob.fromArray(Array.tabulate<Nat8>(32, func(i) {
      if (i < padding) 0 else bytes[i - padding]
    })))
  };

  /// Exact unsigned integer input. No whitespace, sign, exponent or fraction.
  public func parseNat(input : Text) : Result.Result<Nat, Text> {
    let chars = Text.toArray(input);
    if (chars.size() == 0) return #err("Expected an unsigned integer");
    let isHex = chars.size() >= 2 and chars[0] == '0' and chars[1] == 'x';
    let radix : Nat = if (isHex) 16 else 10;
    var i = if (isHex) 2 else 0;
    if (i == chars.size()) return #err("Expected integer digits");
    var value = 0;
    while (i < chars.size()) {
      let ?d = digit(chars[i]) else return #err("Invalid unsigned integer");
      if (d >= radix) return #err("Invalid unsigned integer digit");
      value := value * radix + d;
      i += 1;
    };
    #ok(value)
  };

  public func concat(parts : [Blob]) : Blob {
    let output = List.empty<Nat8>();
    for (part in parts.vals()) for (byte in part.vals()) List.add(output, byte);
    Blob.fromArray(List.toArray(output))
  };
}
