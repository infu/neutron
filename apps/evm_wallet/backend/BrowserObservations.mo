import Text "mo:core/Text";
import Hex "./evm/Hex";
import Keccak "./evm/Keccak";
import Json "./rpc/Json";
import Memory "./memory/evm_wallet/v1";
import Types "./Types";

/// Browser RPC observations update the retained signing journal without an
/// HTTPS outcall. They never supply signing bytes, a nonce, or a new intent.
module {
  public type Observation = {
    identity : Memory.Identity;
    transaction_hash : Text;
    transaction_json : Text;
    receipt_json : ?Text;
    canonical_block_json : ?Text;
    safe_block_json : ?Text;
    finalized_block_json : ?Text;
    broadcast_error : ?Text;
  };
  public type Submission = {
    chain_id : Nat;
    transaction_hash : Text;
    raw_transaction : Text;
  };

  func sameIdentity(a : Memory.Identity, b : Memory.Identity) : Bool {
    a.caller.app_id == b.caller.app_id and
    a.caller.installation_uid == b.caller.installation_uid and
    a.request_id == b.request_id
  };

  func textField(value : Json.Value, name : Text) : Types.Result<Text> {
    switch (Json.field(value, name)) {
      case (?#string(value)) #ok(value);
      case (_) #err("RPC result lacks string field " # name);
    }
  };

  func natField(value : Json.Value, name : Text) : Types.Result<Nat> {
    switch (textField(value, name)) {
      case (#err(error)) #err(error);
      case (#ok(value)) Json.quantityText(value);
    }
  };

  func retainedHash(command : Memory.Command) : Types.Result<Text> {
    let ?raw = command.signed_raw else return #err("Operation has no retained signed transaction");
    let ?hash = command.transaction_hash else return #err("Operation has no retained transaction hash");
    if (raw.size() == 0 or Hex.encode(Keccak.hash(raw)) != Text.toLower(hash)) {
      return #err("Retained transaction bytes do not match their hash");
    };
    #ok(Text.toLower(hash))
  };

  public func superseding(command : Memory.Command, commands : [Memory.Command]) : ?Memory.Command {
    let ?tx = command.transaction else return null;
    var selected : ?Memory.Command = null;
    for (candidate in commands.vals()) {
      if (candidate.id > command.id and candidate.intent.chain_id == command.intent.chain_id and candidate.intent.account_id == command.intent.account_id and candidate.reserved_nonce) {
        switch (candidate.transaction) {
          case (?other) if (other.nonce == tx.nonce and (candidate.signed_raw != null or candidate.status == "signing" or candidate.status == "unknown")) {
            switch (selected) {
              case null selected := ?candidate;
              case (?previous) if (candidate.id > previous.id) selected := ?candidate;
            };
          };
          case (_) {};
        };
      };
    };
    selected
  };

  func sameNonce(a : Memory.Command, b : Memory.Command) : Bool {
    if (a.intent.account_id != b.intent.account_id or a.intent.chain_id != b.intent.chain_id) return false;
    switch (a.transaction, b.transaction) {
      case (?first, ?second) first.nonce == second.nonce;
      case (_) false;
    }
  };

  func canonical(command : Memory.Command) : Bool {
    command.receipt_json != null and command.transaction_hash != null and
    (command.status == "confirmed" or command.status == "reverted")
  };

  // The original may win the mining race after its replacement was signed.
  // A known canonical nonce consumer takes precedence over creation order.
  func canonicalWinner(command : Memory.Command, commands : [Memory.Command]) : ?Memory.Command {
    var selected : ?Memory.Command = null;
    for (candidate in commands.vals()) {
      if (candidate.id != command.id and sameNonce(command, candidate) and canonical(candidate)) {
        switch (selected) {
          case null selected := ?candidate;
          case (?previous) if (candidate.id > previous.id) selected := ?candidate;
        };
      };
    };
    selected
  };

  public func submission(command : Memory.Command, commands : [Memory.Command]) : Types.Result<Submission> {
    let hash = switch (retainedHash(command)) { case (#err(error)) return #err(error); case (#ok(value)) value };
    let ?transaction = command.transaction else return #err("Operation is not a transaction");
    if (transaction.chainId != command.intent.chain_id) return #err("Retained transaction chain does not match the operation");
    switch (canonicalWinner(command, commands)) {
      case (?_) return #err("Another retained transaction has a canonical receipt for this nonce; these bytes will not be rebroadcast");
      case null {};
    };
    switch (superseding(command, commands)) {
      case (?_) return #err("A later same-nonce replacement supersedes this operation; the original bytes will not be rebroadcast");
      case null {};
    };
    if (command.receipt_json != null) return #err("Operation already has an observed canonical receipt");
    let ?raw = command.signed_raw else return #err("Operation has no retained signed transaction");
    #ok({ chain_id = transaction.chainId; transaction_hash = hash; raw_transaction = Hex.encode(raw) })
  };

  func optionalNat(value : Json.Value, name : Text, expected : Nat) : Types.Result<()> {
    switch (Json.field(value, name)) {
      case null #ok(());
      case (?field) switch (Json.quantity(field)) {
        case (#err(error)) #err("Invalid transaction " # name # ": " # error);
        case (#ok(actual)) if (actual == expected) #ok(()) else #err("Observed transaction " # name # " does not match the signed transaction");
      };
    }
  };

  func optionalText(value : Json.Value, name : Text, expected : Text) : Types.Result<()> {
    switch (Json.field(value, name)) {
      case null #ok(());
      case (?#string(actual)) if (Text.toLower(actual) == Text.toLower(expected)) #ok(()) else #err("Observed transaction " # name # " does not match the signed transaction");
      case (_) #err("Invalid transaction " # name);
    }
  };

  func validateTransaction(command : Memory.Command, value : Json.Value, hash : Text) : Types.Result<()> {
    switch (value) { case (#null_) return #ok(()); case (_) {} };
    let actualHash = switch (textField(value, "hash")) { case (#err(error)) return #err(error); case (#ok(value)) Text.toLower(value) };
    if (actualHash != hash) return #err("Observed transaction hash does not match the signed transaction");
    let ?tx = command.transaction else return #err("Operation is not a transaction");
    for ((name, expected) in [("chainId", tx.chainId), ("nonce", tx.nonce), ("value", tx.value), ("gas", tx.gasLimit)].vals()) {
      switch (optionalNat(value, name, expected)) { case (#err(error)) return #err(error); case (_) {} };
    };
    for ((name, expected) in [("from", command.address), ("input", Hex.encode(tx.data)), ("data", Hex.encode(tx.data))].vals()) {
      switch (optionalText(value, name, expected)) { case (#err(error)) return #err(error); case (_) {} };
    };
    switch (Json.field(value, "to"), tx.to) {
      case (null, _) {};
      case (?#null_, null) {};
      case (?#string(actual), ?expected) {
        if (Text.toLower(actual) != Text.toLower(expected)) return #err("Observed transaction destination does not match the signed transaction");
      };
      case (_) return #err("Observed transaction destination does not match the signed transaction");
    };
    #ok(())
  };

  func optionalJson(raw : ?Text) : Types.Result<Json.Value> {
    switch (raw) { case null #ok(#null_); case (?value) Json.parse(value) }
  };

  func finality(raw : ?Text, number : Nat) : Types.Result<Bool> {
    let head = switch (optionalJson(raw)) { case (#err(error)) return #err(error); case (#ok(value)) value };
    switch (head) { case (#null_) return #ok(false); case (_) {} };
    switch (natField(head, "number")) { case (#err(error)) #err(error); case (#ok(n)) #ok(n >= number) }
  };

  func markConsumed(command : Memory.Command, winner : Memory.Command, now : Int) {
    command.status := "replaced";
    command.receipt_json := null;
    command.finality := null;
    command.replacement_hash := winner.transaction_hash;
    command.message := switch (winner.transaction_hash) {
      case (?hash) ?("Nonce consumed by the canonical transaction " # hash);
      case null null;
    };
    command.updated_at := now;
  };

  func markSuperseded(command : Memory.Command, replacement : Memory.Command, now : Int) {
    command.status := "unknown";
    command.receipt_json := null;
    command.finality := null;
    command.replacement_hash := replacement.transaction_hash;
    command.message := ?"A later same-nonce replacement supersedes this operation. The original bytes will not be rebroadcast.";
    command.updated_at := now;
  };

  func classifyConsumed(command : Memory.Command, commands : [Memory.Command], now : Int) : Bool {
    switch (canonicalWinner(command, commands)) {
      case (?winner) { markConsumed(command, winner, now); return true };
      case null {};
    };
    switch (superseding(command, commands)) {
      case (?replacement) { markSuperseded(command, replacement, now); true };
      case null false;
    }
  };

  func synchronizeSiblings(command : Memory.Command, commands : [Memory.Command], now : Int) {
    let won = canonical(command);
    for (sibling in commands.vals()) {
      if (sibling.id != command.id and sibling.signed_raw != null and sameNonce(command, sibling)) {
        if (won) {
          // This newly validated inclusion also invalidates any older receipt
          // retained for another transaction at the same account/chain/nonce.
          markConsumed(sibling, command, now);
        } else if (sibling.receipt_json == null and not classifyConsumed(sibling, commands, now) and sibling.status == "replaced") {
          // The known consumer was reorganized out. Its signed competitors
          // remain available, subject to any later signing reservation.
          sibling.status := "unknown";
          sibling.replacement_hash := null;
          sibling.finality := null;
          sibling.message := ?"The transaction previously observed consuming this nonce is no longer canonical. Recovery can use the retained signed bytes.";
          sibling.updated_at := now;
        };
      };
    };
  };

  /// Validate the complete observation before changing state. A missing receipt
  /// is a legitimate pending/reorganization observation, not a failed request.
  public func apply(command : Memory.Command, input : Observation, commands : [Memory.Command], now : Int) : Types.Result<()> {
    if (not sameIdentity(command.identity, input.identity)) return #err("Observation identity does not match the retained operation");
    let hash = switch (retainedHash(command)) { case (#err(error)) return #err(error); case (#ok(value)) value };
    if (Text.toLower(input.transaction_hash) != hash) return #err("Observation hash does not match the retained operation");
    let transaction = switch (Json.parse(input.transaction_json)) { case (#err(error)) return #err(error); case (#ok(value)) value };
    switch (validateTransaction(command, transaction, hash)) { case (#err(error)) return #err(error); case (_) {} };
    let receipt = switch (optionalJson(input.receipt_json)) { case (#err(error)) return #err(error); case (#ok(value)) value };
    switch (receipt) {
      case (#null_) {
        let disappeared = command.receipt_json != null;
        command.receipt_json := null;
        command.finality := null;
        switch (superseding(command, commands)) {
          case (?replacement) markSuperseded(command, replacement, now);
          case null {
            command.replacement_hash := null;
            switch (transaction) {
              case (#null_) {
                command.status := "unknown";
                command.message := switch (input.broadcast_error) {
                  case (?error) ?("Broadcast outcome requires reconciliation: " # error);
                  case null if (disappeared) ?"Previously observed receipt disappeared; possible reorganization." else ?"Transaction is not yet visible to the provider. Recovery can rebroadcast the retained signed bytes.";
                };
              };
              case (_) {
                command.status := "submitted";
                command.message := if (disappeared) ?"Previously observed receipt disappeared; the transaction is pending again after a possible reorganization." else ?"Transaction is known to the provider and awaits a receipt.";
              };
            };
            command.updated_at := now;
          };
        };
      };
      case (_) {
        let receiptHash = switch (textField(receipt, "transactionHash")) { case (#err(error)) return #err(error); case (#ok(value)) Text.toLower(value) };
        if (receiptHash != hash) return #err("RPC receipt hash does not match the signed transaction");
        let number = switch (natField(receipt, "blockNumber")) { case (#err(error)) return #err(error); case (#ok(value)) value };
        let status = switch (natField(receipt, "status")) { case (#err(error)) return #err(error); case (#ok(value)) value };
        if (status > 1) return #err("Unexpected receipt execution status");
        let receiptBlockHash = switch (textField(receipt, "blockHash")) { case (#err(error)) return #err(error); case (#ok(value)) Text.toLower(value) };
        let block = switch (optionalJson(input.canonical_block_json)) { case (#err(error)) return #err(error); case (#ok(value)) value };
        let blockHash = switch (textField(block, "hash")) { case (#err(error)) return #err(error); case (#ok(value)) Text.toLower(value) };
        let blockNumber = switch (natField(block, "number")) { case (#err(error)) return #err(error); case (#ok(value)) value };
        if (blockNumber != number) return #err("Canonical block number does not match the receipt");
        let safe = switch (finality(input.safe_block_json, number)) { case (#err(error)) return #err(error); case (#ok(value)) value };
        let finalized = switch (finality(input.finalized_block_json, number)) { case (#err(error)) return #err(error); case (#ok(value)) value };
        if (blockHash != receiptBlockHash) {
          command.status := "unknown"; command.receipt_json := null; command.finality := null;
          command.replacement_hash := null;
          command.message := ?"Receipt belongs to a block no longer canonical";
        } else {
          command.receipt_json := input.receipt_json;
          command.status := if (status == 1) "confirmed" else "reverted";
          command.replacement_hash := null;
          command.finality := ?(if (finalized) "finalized" else if (safe) "safe" else "included");
          command.message := null;
        };
        command.updated_at := now;
      };
    };
    if (command.receipt_json == null) ignore classifyConsumed(command, commands, now);
    synchronizeSiblings(command, commands, now);
    #ok(())
  };
}
