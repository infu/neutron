import Array "mo:core/Array";
import Blob "mo:core/Blob";
import List "mo:core/List";
import Result "mo:core/Result";
import Hex "Hex";
import Keccak "Keccak";
import Rlp "Rlp";

/// Authoritative EIP-155 and EIP-1559 transaction encoding. The frontend never
/// supplies a digest or serialized unsigned transaction for backend signing.
module {
  public type AccessEntry = { address : Text; storageKeys : [Text] };
  public type Fee = {
    #legacy : { gasPrice : Nat };
    #eip1559 : { maxFeePerGas : Nat; maxPriorityFeePerGas : Nat };
  };
  public type Transaction = {
    chainId : Nat;
    nonce : Nat;
    gasLimit : Nat;
    to : ?Text;
    value : Nat;
    data : Blob;
    accessList : [AccessEntry];
    fee : Fee;
  };
  public type Signature = { r : Nat; s : Nat; yParity : Nat };
  public type Signed = { raw : Blob; hash : Blob };
  let order : Nat = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141;

  func integer(n : Nat) : Rlp.Value = #bytes(Hex.nat(n));

  func address(text : Text) : Result.Result<Blob, Text> {
    switch (Hex.decode(text)) {
      case (#err(error)) #err(error);
      case (#ok(bytes)) {
        if (bytes.size() != 20) #err("Transaction addresses must contain exactly 20 bytes") else #ok(bytes)
      };
    }
  };

  public func validate(tx : Transaction) : Result.Result<(), Text> {
    // Widths below are Ethereum transaction protocol constraints, not quotas.
    if (tx.chainId >= Hex.uint256Limit) return #err("chainId exceeds uint256");
    // EIP-2681 reserves 2^64-1: a transaction's nonce must be lower.
    if (tx.nonce >= 0xffffffffffffffff) return #err("Transaction nonce exceeds the EIP-2681 range");
    if (tx.gasLimit >= 0x10000000000000000) return #err("gasLimit exceeds uint64");
    if (tx.value >= Hex.uint256Limit) return #err("Transaction value exceeds uint256");
    switch (tx.to) {
      case null {};
      case (?to) switch (address(to)) { case (#err(error)) return #err(error); case _ {} };
    };
    switch (tx.fee) {
      case (#legacy(fee)) {
        if (fee.gasPrice >= Hex.uint256Limit) return #err("gasPrice exceeds uint256");
        if (tx.accessList.size() != 0) return #err("Legacy transactions do not encode an access list");
      };
      case (#eip1559(fee)) {
        if (fee.maxFeePerGas >= Hex.uint256Limit or fee.maxPriorityFeePerGas >= Hex.uint256Limit) return #err("Transaction fees exceed uint256");
        if (fee.maxPriorityFeePerGas > fee.maxFeePerGas) return #err("maxPriorityFeePerGas exceeds maxFeePerGas");
      };
    };
    for (entry in tx.accessList.vals()) {
      switch (address(entry.address)) { case (#err(error)) return #err(error); case _ {} };
      for (key in entry.storageKeys.vals()) {
        switch (Hex.decode(key)) {
          case (#err(error)) return #err(error);
          case (#ok(bytes)) if (bytes.size() != 32) return #err("Access-list storage keys must contain exactly 32 bytes");
        };
      };
    };
    #ok(())
  };

  func fields(tx : Transaction) : Result.Result<[Rlp.Value], Text> {
    switch (validate(tx)) { case (#err(error)) return #err(error); case _ {} };
    let destination = switch (tx.to) {
      case null Blob.fromArray([]);
      case (?to) switch (address(to)) { case (#ok(bytes)) bytes; case (#err(error)) return #err(error) };
    };
    switch (tx.fee) {
      case (#legacy(fee)) #ok([
        integer(tx.nonce), integer(fee.gasPrice), integer(tx.gasLimit),
        #bytes(destination), integer(tx.value), #bytes(tx.data),
      ]);
      case (#eip1559(fee)) {
        let accessList = List.empty<Rlp.Value>();
        for (entry in tx.accessList.vals()) {
          let account = switch (address(entry.address)) { case (#ok(bytes)) bytes; case (#err(error)) return #err(error) };
          let keys = List.empty<Rlp.Value>();
          for (key in entry.storageKeys.vals()) {
            switch (Hex.decode(key)) { case (#ok(bytes)) List.add(keys, #bytes(bytes)); case (#err(error)) return #err(error) };
          };
          List.add(accessList, #list([#bytes(account), #list(List.toArray(keys))]));
        };
        #ok([
          integer(tx.chainId), integer(tx.nonce), integer(fee.maxPriorityFeePerGas),
          integer(fee.maxFeePerGas), integer(tx.gasLimit), #bytes(destination),
          integer(tx.value), #bytes(tx.data), #list(List.toArray(accessList)),
        ])
      };
    }
  };

  public func signingPayload(tx : Transaction) : Result.Result<Blob, Text> {
    let encodedFields = switch (fields(tx)) { case (#ok(value)) value; case (#err(error)) return #err(error) };
    #ok(switch (tx.fee) {
      case (#legacy(_)) Rlp.encode(#list(Array.concat(encodedFields, [integer(tx.chainId), integer(0), integer(0)])));
      case (#eip1559(_)) Hex.concat([Blob.fromArray([2]), Rlp.encode(#list(encodedFields))]);
    })
  };

  public func signingHash(tx : Transaction) : Result.Result<Blob, Text> {
    switch (signingPayload(tx)) { case (#ok(payload)) #ok(Keccak.hash(payload)); case (#err(error)) #err(error) }
  };

  /// Accepts only a verified Ethereum-compatible low-s signature from the
  /// Secp256k1 module. This layer rechecks encoding/range invariants as well.
  public func signed(tx : Transaction, signature : Signature) : Result.Result<Signed, Text> {
    if (signature.r == 0 or signature.r >= order or signature.s == 0 or signature.s > order / 2 or signature.yParity > 1) return #err("Invalid normalized Ethereum signature");
    let encodedFields = switch (fields(tx)) { case (#ok(value)) value; case (#err(error)) return #err(error) };
    let raw = switch (tx.fee) {
      case (#legacy(_)) Rlp.encode(#list(Array.concat(encodedFields, [
        integer(tx.chainId * 2 + 35 + signature.yParity), integer(signature.r), integer(signature.s),
      ])));
      case (#eip1559(_)) Hex.concat([Blob.fromArray([2]), Rlp.encode(#list(Array.concat(encodedFields, [
        integer(signature.yParity), integer(signature.r), integer(signature.s),
      ])))]);
    };
    #ok({ raw; hash = Keccak.hash(raw) })
  };
}
