import Blob "mo:core/Blob";
import Nat "mo:core/Nat";
import Text "mo:core/Text";
import Hex "Hex";
import Keccak "Keccak";

/// ERC-191 personal_sign hashes the byte length, not Unicode character count.
module {
  public func hash(message : Blob) : Blob {
    Keccak.hash(Hex.concat([
      Blob.fromArray([0x19]),
      Text.encodeUtf8("Ethereum Signed Message:\n" # Nat.toText(message.size())),
      message,
    ]))
  };
}
