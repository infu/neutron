import Map "mo:core/Map";
import Journal "./Journal";
import Memory "./memory/evm_wallet/v1";

/// Evidence from the wallet's retained signing journal, not from a same-nonce
/// transaction discovered on a network. The consumer still checks the public
/// transaction payload: a proven replacement may be a cancellation.
module {
  func sameIdentity(a : Memory.Identity, b : Memory.Identity) : Bool {
    a.caller.app_id == b.caller.app_id and
    a.caller.installation_uid == b.caller.installation_uid and
    a.request_id == b.request_id
  };

  func signedFor(command : Memory.Command, account : Text, chain : Nat, nonce : Nat) : Bool {
    if (not command.reserved_nonce or command.intent.account_id != account or command.intent.chain_id != chain) return false;
    switch (command.intent.operation) {
      case (#transaction(_)) {};
      case (#replacement(_)) {};
      case _ return false;
    };
    let ?transaction = command.transaction else return false;
    if (transaction.chainId != chain or transaction.nonce != nonce) return false;
    let ?raw = command.signed_raw else return false;
    let ?hash = command.transaction_hash else return false;
    raw.size() > 0 and hash != ""
  };

  func reaches(store : Journal.Store, candidate : Memory.Command, original : Memory.Command, chain : Nat, nonce : Nat) : Bool {
    var current = candidate;
    loop {
      if (current.id <= original.id or not signedFor(current, original.intent.account_id, chain, nonce)) return false;
      let parentId = switch (current.intent.operation) {
        case (#replacement(request)) request.operation_id;
        case _ return false;
      };
      // Operation IDs increase when created. This both checks ancestry order
      // and guarantees malformed cycles terminate without a depth policy.
      if (parentId >= current.id) return false;
      let ?parent = store.byId(parentId) else return false;
      if (parent.id == original.id) {
        return sameIdentity(parent.identity, original.identity) and
          signedFor(parent, original.intent.account_id, chain, nonce) and
          parent.signed_raw == original.signed_raw and
          parent.transaction_hash == original.transaction_hash;
      };
      current := parent;
    }
  };

  /// Matches an explicitly signed descendant of the exact durable request
  /// identity. Endpoint changes do not change identity, matching Journal.key.
  /// Hash text is the canonical lowercase encoding stored by the backend.
  public func matches(mem : Memory.Mem, original : Memory.Identity, chainId : Nat, replacementHash : Text) : Bool {
    let store = Journal.Store(mem);
    let ?command = store.find(original) else return false;
    if (not sameIdentity(command.identity, original)) return false;
    let ?transaction = command.transaction else return false;
    if (not signedFor(command, command.intent.account_id, chainId, transaction.nonce)) return false;
    if (command.transaction_hash == ?replacementHash) return false;
    for ((_, candidate) in Map.entries(mem.commands)) {
      if (candidate.transaction_hash == ?replacementHash and reaches(store, candidate, command, chainId, transaction.nonce)) return true;
    };
    false
  };
}
