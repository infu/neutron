import Array "mo:core/Array";
import List "mo:core/List";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Text "mo:core/Text";
import Hex "./evm/Hex";
import Memory "./memory/evm_wallet/v1";
import Types "./Types";

module {
  public func key(identity : Memory.Identity) : Text {
    // Candid framing avoids delimiter collisions; endpoint is deliberately not
    // part of durable identity so a replacement tile can recover its command.
    Hex.encode(to_candid(identity.caller.app_id, identity.caller.installation_uid, identity.request_id));
  };
  public func nonceKey(account : Text, chain : Nat) : Text {
    Hex.encode(to_candid(account, chain));
  };
  public func validateIdentity(identity : Memory.Identity) : Types.Result<()> {
    if (identity.caller.app_id == "" or identity.caller.installation_uid == 0) {
      return #err("Authenticated app and installation identity are required");
    };
    if (identity.request_id.size() != 32) return #err("request_id must be 32 lowercase hexadecimal characters");
    for (c in identity.request_id.chars()) {
      if (not ((c >= '0' and c <= '9') or (c >= 'a' and c <= 'f'))) {
        return #err("request_id must be 32 lowercase hexadecimal characters");
      };
    };
    #ok(());
  };
  public func view(command : Memory.Command) : Types.Operation {
    {
      operation_id = command.id; request_id = command.identity.request_id;
      caller = command.identity.caller;
      account_id = command.intent.account_id; chain_id = command.intent.chain_id;
      kind = switch (command.intent.operation) {
        case (#transaction(_)) "transaction"; case (#replacement(_)) "transaction";
        case (#personal_message(_)) "message"; case (#typed_data(_)) "typed_data";
      };
      status = command.status; address = command.address;
      transaction_hash = command.transaction_hash;
      signature = switch (command.signature) { case null null; case (?v) ?Hex.encode(v) };
      message = command.message; review_revision = command.review_revision;
      replacement_hash = command.replacement_hash;
      review = command.review; receipt_json = command.receipt_json; finality = command.finality;
      created_at = command.created_at; updated_at = command.updated_at; intent = command.intent;
      prepared_transaction = switch (command.transaction) {
        case null null;
        case (?tx) ?{
          to = tx.to; value = Nat.toText(tx.value); data = Hex.encode(tx.data); access_list = tx.accessList;
          chain_id = tx.chainId; nonce = Nat.toText(tx.nonce); gas_limit = Nat.toText(tx.gasLimit);
          transaction_type = switch (tx.fee) { case (#legacy(_)) "legacy"; case (_) "eip1559" };
          max_fee_per_gas = switch (tx.fee) { case (#eip1559(f)) ?Nat.toText(f.maxFeePerGas); case (_) null };
          max_priority_fee_per_gas = switch (tx.fee) { case (#eip1559(f)) ?Nat.toText(f.maxPriorityFeePerGas); case (_) null };
          gas_price = switch (tx.fee) { case (#legacy(f)) ?Nat.toText(f.gasPrice); case (_) null };
        };
      };
    };
  };
  public class Store(mem : Memory.Mem) {
    public func find(identity : Memory.Identity) : ?Memory.Command {
      Map.get(mem.commands, Text.compare, key(identity));
    };
    public func byId(id : Nat) : ?Memory.Command {
      for ((_, command) in Map.entries(mem.commands)) { if (command.id == id) return ?command };
      null;
    };
    public func start(request : Types.PrepareRequest, now : Int) : Types.Result<Memory.Command> {
      switch (validateIdentity(request.identity)) { case (#err(e)) return #err(e); case (_) {} };
      let bytes = to_candid(request.intent);
      switch (find(request.identity)) {
        case (?command) {
          if (command.intent_bytes != bytes) return #err("request_conflict: this caller installation already used request_id for a different intent");
          return #ok(command);
        };
        case null {};
      };
      let command : Memory.Command = {
        id = mem.next_operation_id; identity = request.identity;
        intent = request.intent; intent_bytes = bytes; created_at = now;
        var updated_at = now; var status = "preparing"; var address = "";
        var message = null; var review_revision = 0; var review = null;
        var transaction = null; var digest = null; var signature = null;
        var signed_raw = null; var transaction_hash = null;
        var receipt_json = null; var finality = null; var replacement_hash = null; var reserved_nonce = false;
      };
      mem.next_operation_id += 1;
      Map.add(mem.commands, Text.compare, key(request.identity), command);
      #ok(command);
    };
    public func nextNonce(account : Text, chain : Nat, observed : Nat) : Nat {
      var candidate = switch (Map.get(mem.nonce_next, Text.compare, nonceKey(account, chain))) {
        case null observed; case (?value) Nat.max(value, observed);
      };
      // Find the first unreserved nonce at or above the observed chain floor.
      // An unsigned request released after a pre-dispatch failure can fill its
      // old slot even if a different request reserved a higher nonce meanwhile.
      var found = true;
      while (found) {
        found := false;
        for ((_, command) in Map.entries(mem.commands)) {
          if (command.reserved_nonce and command.intent.account_id == account and command.intent.chain_id == chain) {
            switch (command.transaction) { case (?tx) if (tx.nonce == candidate) { candidate += 1; found := true }; case (_) {} };
          };
        };
      };
      candidate;
    };
    public func observeNonce(account : Text, chain : Nat, observed : Nat) {
      let k = nonceKey(account, chain);
      let previous = switch (Map.get(mem.nonce_next, Text.compare, k)) { case null 0; case (?n) n };
      Map.add(mem.nonce_next, Text.compare, k, Nat.max(previous, observed));
    };
    public func reserve(command : Memory.Command) : Types.Result<Bool> {
      if (command.reserved_nonce) return #ok(true);
      let tx = switch (command.transaction) { case null return #ok(true); case (?v) v };
      let replacement = switch (command.intent.operation) { case (#replacement(_)) true; case (_) false };
      let next = nextNonce(command.intent.account_id, command.intent.chain_id, tx.nonce);
      if (not replacement and next != tx.nonce) {
        command.transaction := ?{ tx with nonce = next };
        command.review := switch (command.review) {
          case null null; case (?r) ?{ r with nonce = Nat.toText(next) };
        };
        command.review_revision += 1;
        command.message := ?"Another approved transaction reserved this nonce. Review the updated nonce and approve again.";
        return #ok(false);
      };
      let k = nonceKey(command.intent.account_id, command.intent.chain_id);
      if (not Map.containsKey(mem.nonce_next, Text.compare, k)) Map.add(mem.nonce_next, Text.compare, k, tx.nonce);
      command.reserved_nonce := true;
      #ok(true);
    };
    public func history(request : Types.HistoryRequest) : Types.History {
      let all = Array.sort<Memory.Command>(Array.fromIter(Map.values(mem.commands)), func(a, b) { Nat.compare(b.id, a.id) });
      let result = List.empty<Types.Operation>();
      var i = request.offset;
      while (i < all.size() and List.size(result) < request.limit) {
        List.add(result, view(all[i])); i += 1;
      };
      { operations = List.toArray(result); total = all.size() };
    };
  };
};
