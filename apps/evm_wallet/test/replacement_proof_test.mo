import Debug "mo:core/Debug";
import Map "mo:core/Map";
import Text "mo:core/Text";
import Journal "../backend/Journal";
import Memory "../backend/memory/evm_wallet/v1";
import Proof "../backend/ReplacementProof";

let identity : Memory.Identity = {
  caller = { app_id = "consumer"; installation_uid = 10; endpoint = "old-tile" };
  request_id = "00000000000000000000000000000001";
};
let tx : Memory.Transaction = {
  chainId = 1; nonce = 7; gasLimit = 21000;
  to = ?"0x2222222222222222222222222222222222222222";
  value = 123; data = ""; accessList = [];
  fee = #eip1559({ maxFeePerGas = 10; maxPriorityFeePerGas = 1 });
};
let originalIntent : Memory.Intent = {
  account_id = "main"; chain_id = 1;
  operation = #transaction({
    to = "0x2222222222222222222222222222222222222222";
    value = "123"; data = "0x"; gas_limit = null;
    max_fee_per_gas = null; max_priority_fee_per_gas = null;
    gas_price = null; transaction_type = null; access_list = [];
  });
};
let originalHash = "0x1111111111111111111111111111111111111111111111111111111111111111";
let speedupHash = "0x2222222222222222222222222222222222222222222222222222222222222222";
let cancelHash = "0x3333333333333333333333333333333333333333333333333333333333333333";
let unrelatedHash = "0x4444444444444444444444444444444444444444444444444444444444444444";

func replacement(parent : Nat, cancel : Bool) : Memory.Intent {
  { originalIntent with operation = #replacement({ operation_id = parent; cancel; max_fee_per_gas = "20"; max_priority_fee_per_gas = "2" }) }
};
func caller(request : Text) : Memory.Identity {
  // Replacements approved in EVM Wallet may originate from another app than
  // the original request. The explicit ancestry, not caller equality, binds it.
  { caller = { app_id = "evm_wallet"; installation_uid = 22; endpoint = "wallet" }; request_id = request }
};
func insert(mem : Memory.Mem, id : Nat, identity : Memory.Identity, intent : Memory.Intent, transaction : Memory.Transaction, hash : Text) : Memory.Command {
  let command : Memory.Command = {
    id; identity; intent; intent_bytes = to_candid(intent); created_at = 0;
    var updated_at = 0; var status = "submitted";
    var address = "0x1111111111111111111111111111111111111111";
    var message = null; var review_revision = 1; var review = null;
    var transaction = ?transaction; var digest = null; var signature = null;
    var signed_raw = ?"retained signed transaction bytes";
    var transaction_hash = ?hash; var receipt_json = null; var finality = null;
    var replacement_hash = null; var reserved_nonce = true;
  };
  Map.add(mem.commands, Text.compare, Journal.key(identity), command);
  command
};

let mem = Memory.init();
let original = insert(mem, 1, identity, originalIntent, tx, originalHash);
let speedup = insert(mem, 2, caller("00000000000000000000000000000002"), replacement(1, false), { tx with fee = #eip1559({ maxFeePerGas = 20; maxPriorityFeePerGas = 2 }) }, speedupHash);
let cancel = insert(mem, 3, caller("00000000000000000000000000000003"), replacement(2, true), { tx with value = 0; to = ?original.address }, cancelHash);
assert Proof.matches(mem, identity, 1, speedupHash);
assert Proof.matches(mem, identity, 1, cancelHash);
assert Proof.matches(mem, speedup.identity, 1, cancelHash);
assert not Proof.matches(mem, identity, 1, originalHash);
assert not Proof.matches(mem, speedup.identity, 1, speedupHash);
assert not Proof.matches(mem, cancel.identity, 1, speedupHash);
assert not Proof.matches(mem, identity, 42161, speedupHash);
assert not Proof.matches(mem, identity, 1, unrelatedHash);
let reconnect = { identity with caller = { identity.caller with endpoint = "new-tile" } };
assert Proof.matches(mem, reconnect, 1, cancelHash);
assert not Proof.matches(mem, { identity with caller = { identity.caller with installation_uid = 11 } }, 1, cancelHash);
assert not Proof.matches(mem, { identity with caller = { identity.caller with app_id = "other" } }, 1, cancelHash);
assert not Proof.matches(mem, { identity with request_id = "000000000000000000000000000000ff" }, 1, cancelHash);

// Merely sharing the account and nonce does not establish replacement ancestry.
ignore insert(mem, 4, caller("00000000000000000000000000000004"), originalIntent, tx, unrelatedHash);
assert not Proof.matches(mem, identity, 1, unrelatedHash);

// Every link must carry the retained signing evidence and nonce reservation.
for (link in [original, speedup, cancel].vals()) {
  let raw = link.signed_raw;
  link.signed_raw := null;
  assert not Proof.matches(mem, identity, 1, cancelHash);
  link.signed_raw := ?"";
  assert not Proof.matches(mem, identity, 1, cancelHash);
  link.signed_raw := raw;
  let hash = link.transaction_hash;
  link.transaction_hash := null;
  assert not Proof.matches(mem, identity, 1, cancelHash);
  link.transaction_hash := hash;
  link.reserved_nonce := false;
  assert not Proof.matches(mem, identity, 1, cancelHash);
  link.reserved_nonce := true;
  let storedTransaction = link.transaction;
  link.transaction := null;
  assert not Proof.matches(mem, identity, 1, cancelHash);
  link.transaction := ?{ tx with nonce = 8 };
  assert not Proof.matches(mem, identity, 1, cancelHash);
  link.transaction := ?{ tx with chainId = 42161 };
  assert not Proof.matches(mem, identity, 1, cancelHash);
  link.transaction := storedTransaction;
};
assert Proof.matches(mem, identity, 1, cancelHash);

// Same hash and ancestry IDs cannot cross the account or declared chain.
for (badIntent in [
  { replacement(1, false) with account_id = "other-account" },
  { replacement(1, false) with chain_id = 42161 },
].vals()) {
  let badMem = Memory.init();
  ignore insert(badMem, 1, identity, originalIntent, tx, originalHash);
  ignore insert(badMem, 2, speedup.identity, badIntent, tx, speedupHash);
  assert not Proof.matches(badMem, identity, 1, speedupHash);
};

// Missing targets, self loops, and forward/cyclic links fail without recursion.
for (badParent in [2, 3, 99].vals()) {
  let badMem = Memory.init();
  ignore insert(badMem, 1, identity, originalIntent, tx, originalHash);
  ignore insert(badMem, 2, speedup.identity, replacement(badParent, false), tx, speedupHash);
  ignore insert(badMem, 3, cancel.identity, replacement(2, true), tx, cancelHash);
  assert not Proof.matches(badMem, identity, 1, speedupHash);
  assert not Proof.matches(badMem, identity, 1, cancelHash);
};
let missingParent = Memory.init();
ignore insert(missingParent, 1, identity, originalIntent, tx, originalHash);
ignore insert(missingParent, 3, cancel.identity, replacement(2, true), tx, cancelHash);
assert not Proof.matches(missingParent, identity, 1, cancelHash);

let absentMem = Memory.init();
ignore insert(absentMem, 2, speedup.identity, replacement(1, false), tx, speedupHash);
assert not Proof.matches(absentMem, identity, 1, speedupHash);
// The map key alone does not substitute for a command's original caller scope.
Map.add(absentMem.commands, Text.compare, Journal.key(identity), speedup);
assert not Proof.matches(absentMem, identity, 1, speedupHash);
Debug.print("Replacement ancestry proof passed");
