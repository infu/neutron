import Text "mo:core/Text";
import Observations "../backend/BrowserObservations";
import Hex "../backend/evm/Hex";
import Keccak "../backend/evm/Keccak";
import Journal "../backend/Journal";
import Memory "../backend/memory/evm_wallet/v1";
import Types "../backend/Types";

func ok<T>(result : Types.Result<T>) : T {
  switch (result) { case (#ok(value)) value; case (#err(error)) { assert false; loop {} } }
};
func fails<T>(result : Types.Result<T>) {
  switch (result) { case (#err(_)) {}; case (_) assert false }
};

let mem = Memory.init();
let store = Journal.Store(mem);
let address = "0x0000000000000000000000000000000000000011";
let destination = "0x0000000000000000000000000000000000000022";
let transaction : Memory.Transaction = {
  chainId = 1; nonce = 7; gasLimit = 21000; to = ?destination; value = 1;
  data = ""; accessList = []; fee = #eip1559({ maxFeePerGas = 10; maxPriorityFeePerGas = 1 });
};
let intent : Memory.Intent = {
  account_id = "main"; chain_id = 1;
  operation = #transaction({
    to = destination; value = "1"; data = "0x"; gas_limit = null;
    max_fee_per_gas = null; max_priority_fee_per_gas = null; gas_price = null;
    transaction_type = null; access_list = [];
  });
};
func createIntent(id : Text, raw : Blob, chosenIntent : Memory.Intent) : Memory.Command {
  let identity : Memory.Identity = {
    caller = { app_id = "consumer"; installation_uid = 10; endpoint = "old" };
    request_id = id;
  };
  let command = ok(store.start({ identity; intent = chosenIntent }, 1));
  command.transaction := ?{ transaction with chainId = chosenIntent.chain_id };
  command.address := address;
  command.signed_raw := ?raw;
  command.transaction_hash := ?Hex.encode(Keccak.hash(raw));
  command.reserved_nonce := true;
  command.status := "signed";
  command
};
func create(id : Text, raw : Blob) : Memory.Command { createIntent(id, raw, intent) };
let command = create("00000000000000000000000000000001", "\01\02");
let hash = switch (command.transaction_hash) { case (?value) value; case null { assert false; loop {} } };
let receipt = "{\"transactionHash\":\"" # hash # "\",\"blockNumber\":\"0x10\",\"blockHash\":\"0xabc\",\"status\":\"0x1\"}";
let pendingJson = "{\"hash\":\"" # hash # "\",\"from\":\"" # address # "\",\"to\":\"" # destination # "\",\"nonce\":\"0x7\",\"value\":\"0x1\",\"gas\":\"0x5208\",\"chainId\":\"0x1\",\"input\":\"0x\"}";
let observation : Observations.Observation = {
  identity = command.identity; transaction_hash = hash; transaction_json = pendingJson;
  receipt_json = null; canonical_block_json = null; safe_block_json = null;
  finalized_block_json = null; broadcast_error = null;
};
let submission = ok(Observations.submission(command, [command]));
assert submission.chain_id == 1 and submission.transaction_hash == hash and submission.raw_transaction == "0x0102";
command.status := "unknown";
assert ok(Observations.submission(command, [command])).raw_transaction == "0x0102";
command.transaction_hash := ?"0xwrong";
fails(Observations.submission(command, [command]));
command.transaction_hash := ?hash;

// Endpoint replacement preserves identity; installation and request do not.
ok(Observations.apply(command, { observation with identity = { command.identity with caller = { command.identity.caller with endpoint = "new" } } }, [command], 2));
assert command.status == "submitted" and command.updated_at == 2;
fails(Observations.apply(command, { observation with identity = { command.identity with caller = { command.identity.caller with installation_uid = 11 } } }, [command], 3));
fails(Observations.apply(command, { observation with identity = { command.identity with request_id = "00000000000000000000000000000002" } }, [command], 3));
fails(Observations.apply(command, { observation with transaction_hash = "0xwrong" }, [command], 3));
fails(Observations.apply(command, { observation with transaction_json = "{\"hash\":\"0xwrong\"}" }, [command], 3));
assert command.updated_at == 2 and command.status == "submitted";

// A familiar hash cannot label a different returned payload as this request.
for (field in ["\"nonce\":\"0x8\"", "\"value\":\"0x2\"", "\"chainId\":\"0xa4b1\"", "\"input\":\"0x01\"", "\"to\":null", "\"from\":\"0xwrong\""].vals()) {
  fails(Observations.apply(command, { observation with transaction_json = "{\"hash\":\"" # hash # "\"," # field # "}" }, [command], 3));
  assert command.updated_at == 2;
};
// Providers may omit optional payload fields. A hash-only response is enough
// to say the exact retained transaction is known, but not enough for inclusion.
ok(Observations.apply(command, { observation with transaction_json = "{\"hash\":\"" # hash # "\"}"; broadcast_error = ?"response lost" }, [command], 4));
assert command.status == "submitted";
ok(Observations.apply(command, { observation with transaction_json = "null"; broadcast_error = ?"response lost" }, [command], 5));
assert command.status == "unknown" and command.message == ?"Broadcast outcome requires reconciliation: response lost";
assert ok(Observations.submission(command, [command])).raw_transaction == "0x0102";

let included = {
  observation with receipt_json = ?receipt;
  canonical_block_json = ?"{\"number\":\"0x10\",\"hash\":\"0xabc\"}";
};
fails(Observations.apply(command, { included with canonical_block_json = null }, [command], 6));
fails(Observations.apply(command, { included with canonical_block_json = ?"{\"number\":\"0x11\",\"hash\":\"0xabc\"}" }, [command], 6));
fails(Observations.apply(command, { included with receipt_json = ?Text.replace(receipt, #text(hash), "0xwrong") }, [command], 6));
fails(Observations.apply(command, { included with receipt_json = ?Text.replace(receipt, #text("\"status\":\"0x1\""), "\"status\":\"0x2\"") }, [command], 6));
fails(Observations.apply(command, { included with finalized_block_json = ?"{broken" }, [command], 6));
assert command.updated_at == 5 and command.receipt_json == null;
ok(Observations.apply(command, included, [command], 7));
assert command.status == "confirmed" and command.finality == ?"included" and command.receipt_json == ?receipt;
fails(Observations.submission(command, [command]));
ok(Observations.apply(command, { included with safe_block_json = ?"{\"number\":\"0x10\"}" }, [command], 8));
assert command.finality == ?"safe";
ok(Observations.apply(command, { included with safe_block_json = ?"{\"number\":\"0x11\"}"; finalized_block_json = ?"{\"number\":\"0x10\"}" }, [command], 9));
assert command.finality == ?"finalized";
ok(Observations.apply(command, { included with safe_block_json = ?"{\"number\":\"0xf\"}"; finalized_block_json = ?"null" }, [command], 10));
assert command.finality == ?"included";
ok(Observations.apply(command, { included with receipt_json = ?Text.replace(receipt, #text("\"status\":\"0x1\""), "\"status\":\"0x0\"") }, [command], 11));
assert command.status == "reverted";

// Reorganization observations remove stale finality and preserve signed bytes.
ok(Observations.apply(command, { included with canonical_block_json = ?"{\"number\":\"0x10\",\"hash\":\"0xdef\"}" }, [command], 12));
assert command.status == "unknown" and command.receipt_json == null and command.finality == null;
assert ok(Observations.submission(command, [command])).raw_transaction == "0x0102";
ok(Observations.apply(command, included, [command], 13));
ok(Observations.apply(command, observation, [command], 14));
assert command.status == "submitted" and command.receipt_json == null and command.finality == null;
assert switch (command.message) { case (?message) Text.contains(message, #text("disappeared")); case null false };
ok(Observations.apply(command, included, [command], 15));
ok(Observations.apply(command, { observation with transaction_json = "null"; receipt_json = ?"null" }, [command], 16));
assert command.status == "unknown" and command.finality == null;

// Merely reviewing a replacement cannot stop recovery. Once its signature may
// have been released, neither a lost reply nor a missing hash revives the old tx.
let replacement = create("00000000000000000000000000000002", "\03\04");
let replacementHash = switch (replacement.transaction_hash) { case (?value) value; case null { assert false; loop {} } };
replacement.signed_raw := null; replacement.transaction_hash := null; replacement.status := "prepared";
assert ok(Observations.submission(command, [command, replacement])).raw_transaction == "0x0102";
replacement.status := "signing";
fails(Observations.submission(command, [command, replacement]));
ok(Observations.apply(command, observation, [command, replacement], 17));
assert command.status == "unknown" and command.replacement_hash == null;
replacement.status := "unknown";
fails(Observations.submission(command, [command, replacement]));
replacement.reserved_nonce := false; replacement.status := "rejected";
assert ok(Observations.submission(command, [command, replacement])).raw_transaction == "0x0102";
replacement.signed_raw := ?"\03\04"; replacement.transaction_hash := ?replacementHash; replacement.reserved_nonce := true; replacement.status := "submitted";
fails(Observations.submission(command, [command, replacement]));
let replacementObservation : Observations.Observation = {
  observation with identity = replacement.identity; transaction_hash = replacementHash;
  transaction_json = Text.replace(pendingJson, #text(hash), replacementHash);
  receipt_json = ?Text.replace(receipt, #text(hash), replacementHash);
  canonical_block_json = included.canonical_block_json;
};
ok(Observations.apply(replacement, replacementObservation, [command, replacement], 18));
assert replacement.status == "confirmed" and command.status == "replaced";
assert command.replacement_hash == ?replacementHash and command.receipt_json == null;
// A dropped replacement receipt reverses the journal's replaced classification,
// but keeps the original ineligible for rebroadcast.
ok(Observations.apply(replacement, { replacementObservation with receipt_json = null }, [command, replacement], 19));
assert command.status == "unknown" and command.replacement_hash == ?replacementHash;
fails(Observations.submission(command, [command, replacement]));
assert ok(Observations.submission(replacement, [command, replacement])).raw_transaction == "0x0304";

// Another network or account's nonce reservation never supersedes this one.
let unrelated = create("00000000000000000000000000000003", "\05\06");
unrelated.transaction := ?{ transaction with nonce = 8 };
let otherNetwork = createIntent("00000000000000000000000000000004", "\07\08", { intent with chain_id = 42161 });
let otherAccount = createIntent("00000000000000000000000000000005", "\09\0a", { intent with account_id = "another" });
assert ok(Observations.submission(replacement, [replacement, unrelated, otherNetwork, otherAccount])).raw_transaction == "0x0304";

// Mining order is independent of signing order: the already-broadcast original
// can consume the nonce before its signed replacement reaches a provider.
let raceOriginal = create("00000000000000000000000000000006", "\0b\0c");
let raceReplacement = create("00000000000000000000000000000007", "\0d\0e");
let originalHash = ok(Observations.submission(raceOriginal, [raceOriginal])).transaction_hash;
let newerHash = ok(Observations.submission(raceReplacement, [raceReplacement])).transaction_hash;
let siblings = [raceOriginal, raceReplacement, unrelated, otherNetwork, otherAccount];
raceOriginal.status := "unknown"; raceReplacement.status := "unknown";
let originalIncluded : Observations.Observation = {
  included with identity = raceOriginal.identity; transaction_hash = originalHash;
  transaction_json = Text.replace(pendingJson, #text(hash), originalHash);
  receipt_json = ?Text.replace(receipt, #text(hash), originalHash);
};
let newerPending : Observations.Observation = {
  observation with identity = raceReplacement.identity; transaction_hash = newerHash;
  transaction_json = "null"; broadcast_error = ?"nonce too low";
};
assert ok(Observations.submission(raceReplacement, siblings)).raw_transaction == "0x0d0e";
ok(Observations.apply(raceOriginal, originalIncluded, siblings, 20));
assert raceOriginal.status == "confirmed" and raceOriginal.receipt_json == originalIncluded.receipt_json;
assert raceReplacement.status == "replaced" and raceReplacement.replacement_hash == ?originalHash;
assert raceReplacement.transaction_hash == ?newerHash and raceReplacement.receipt_json == null and raceReplacement.finality == null;
fails(Observations.submission(raceReplacement, siblings));
// A subsequent absent-receipt observation must not undo the known winner.
ok(Observations.apply(raceReplacement, newerPending, siblings, 21));
assert raceReplacement.status == "replaced" and raceReplacement.replacement_hash == ?originalHash;
fails(Observations.submission(raceReplacement, siblings));
assert unrelated.status == "signed" and otherNetwork.status == "signed" and otherAccount.status == "signed";

// The canonical block changing removes the original's evidence and makes the
// latest retained replacement recoverable again, without reviving the old tx.
ok(Observations.apply(raceOriginal, { originalIncluded with canonical_block_json = ?"{\"number\":\"0x10\",\"hash\":\"0xdef\"}" }, siblings, 22));
assert raceOriginal.status == "unknown" and raceOriginal.receipt_json == null and raceOriginal.finality == null;
assert raceOriginal.transaction_hash == ?originalHash and raceOriginal.replacement_hash == ?newerHash;
assert raceReplacement.status == "unknown" and raceReplacement.replacement_hash == null;
assert ok(Observations.submission(raceReplacement, siblings)).raw_transaction == "0x0d0e";
fails(Observations.submission(raceOriginal, siblings));

// A reverted original still consumes the nonce. Receipt disappearance removes
// that conclusion just as a changed canonical block does.
ok(Observations.apply(raceOriginal, { originalIncluded with receipt_json = ?Text.replace(Text.replace(receipt, #text(hash), originalHash), #text("\"status\":\"0x1\""), "\"status\":\"0x0\"") }, siblings, 23));
assert raceOriginal.status == "reverted" and raceReplacement.status == "replaced";
fails(Observations.submission(raceReplacement, siblings));
ok(Observations.apply(raceOriginal, { originalIncluded with receipt_json = null; transaction_json = "null" }, siblings, 24));
assert raceOriginal.receipt_json == null and raceReplacement.status == "unknown";
assert raceReplacement.replacement_hash == null and raceReplacement.transaction_hash == ?newerHash;
assert ok(Observations.submission(raceReplacement, siblings)).raw_transaction == "0x0d0e";

// A fresh canonical sibling observation also clears an older, stale receipt
// if that older operation has not itself been refreshed since the reorg.
ok(Observations.apply(raceOriginal, originalIncluded, siblings, 25));
let newerIncluded : Observations.Observation = {
  originalIncluded with identity = raceReplacement.identity; transaction_hash = newerHash;
  transaction_json = Text.replace(pendingJson, #text(hash), newerHash);
  receipt_json = ?Text.replace(Text.replace(receipt, #text(hash), newerHash), #text("0xabc"), "0xdef");
  canonical_block_json = ?"{\"number\":\"0x10\",\"hash\":\"0xdef\"}";
};
ok(Observations.apply(raceReplacement, newerIncluded, siblings, 26));
assert raceReplacement.status == "confirmed" and raceReplacement.receipt_json == newerIncluded.receipt_json;
assert raceOriginal.status == "replaced" and raceOriginal.receipt_json == null and raceOriginal.finality == null;
assert raceOriginal.transaction_hash == ?originalHash and raceOriginal.replacement_hash == ?newerHash;
fails(Observations.submission(raceOriginal, siblings));
fails(Observations.submission(raceReplacement, siblings));
