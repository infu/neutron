import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Text "mo:core/Text";
import Hex "../evm/Hex";

/// Recognizes canonical ERC-20-shaped calldata for transaction review.
/// A selector match does not establish that the target implements ERC-20.
module {
  public type Decoded = {
    method : Text;
    token : Text;
    owner : Text;
    spender : ?Text;
    recipient : ?Text;
    amount : Nat;
    balance_call : Text;
    allowance_call : ?Text;
  };

  func address(input : Text) : ?Blob {
    if (Text.size(input) != 42) return null;
    switch (Hex.decode(input)) {
      case (#ok(bytes)) if (bytes.size() == 20) ?bytes else null;
      case (#err(_)) null;
    }
  };

  // All callers first validate the complete calldata length and word offset.
  func slice(bytes : [Nat8], offset : Nat, size : Nat) : Blob {
    Blob.fromArray(Array.tabulate<Nat8>(size, func(i) { bytes[offset + i] }))
  };

  func addressAt(bytes : [Nat8], offset : Nat) : ?Blob {
    var i = 0;
    while (i < 12) {
      if (bytes[offset + i] != 0) return null;
      i += 1;
    };
    ?slice(bytes, offset + 12, 20)
  };

  func addressWord(address : Blob) : Blob {
    Hex.concat(["\00\00\00\00\00\00\00\00\00\00\00\00", address])
  };

  func evidence(method : Text, token : Blob, owner : Blob, spender : ?Blob, recipient : ?Blob, amount : Nat) : Decoded {
    let ownerWord = addressWord(owner);
    {
      method;
      token = Hex.encode(token);
      owner = Hex.encode(owner);
      spender = switch (spender) { case (?value) ?Hex.encode(value); case null null };
      recipient = switch (recipient) { case (?value) ?Hex.encode(value); case null null };
      amount;
      // balanceOf(address), allowance(address,address).
      balance_call = Hex.encode(Hex.concat(["\70\a0\82\31", ownerWord]));
      allowance_call = switch (spender) {
        case (?value) ?Hex.encode(Hex.concat(["\dd\62\ed\3e", ownerWord, addressWord(value)]));
        case null null;
      };
    }
  };

  /// Unrecognized selectors, malformed addresses, noncanonical address padding,
  /// truncated words and trailing data return null without partial decoding.
  public func decode(contract : Text, walletAddress : Text, data : Blob) : ?Decoded {
    if (data.size() != 68 and data.size() != 100) return null;
    let bytes = Blob.toArray(data);
    let selector = Hex.encode(slice(bytes, 0, 4));
    let method = switch (selector) {
      case "0x095ea7b3" { if (bytes.size() != 68) return null; "approve" };
      case "0xa9059cbb" { if (bytes.size() != 68) return null; "transfer" };
      case "0x23b872dd" { if (bytes.size() != 100) return null; "transferFrom" };
      case _ return null;
    };
    let ?token = address(contract) else return null;
    let ?wallet = address(walletAddress) else return null;
    let ?first = addressAt(bytes, 4) else return null;
    switch (method) {
      case "approve" ?evidence(method, token, wallet, ?first, null, Hex.toNat(slice(bytes, 36, 32)));
      case "transfer" ?evidence(method, token, wallet, null, ?first, Hex.toNat(slice(bytes, 36, 32)));
      case _ {
        let ?recipient = addressAt(bytes, 36) else return null;
        ?evidence(method, token, first, ?wallet, ?recipient, Hex.toNat(slice(bytes, 68, 32)))
      };
    }
  };
}
