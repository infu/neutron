import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Text "mo:core/Text";
import Config "../backend/Config";
import Packs "../backend/DecoderPacks";
import Decoders "../backend/memory/evm_decoders/v1";
import Wallet "../backend/memory/evm_wallet/v1";
import Evidence "../backend/memory/evm_evidence/v1";

func document(version : Text, name : Text) : Text {
  "{\"format\":1,\"id\":\"owner.example\",\"version\":\"" # version # "\",\"name\":\"" # name # "\",\"description\":\"A decoder imported by the owner\",\"deployments\":[{\"chainId\":\"1\",\"address\":\"0x1111111111111111111111111111111111111111\"}],\"functions\":[{\"signature\":\"deposit(uint256 amount)\",\"title\":\"Deposit\",\"value\":\"zero\",\"fields\":[{\"path\":\"args.0\",\"label\":\"Deposit amount\",\"format\":\"tokenAmount\",\"tokenAddress\":\"0x2222222222222222222222222222222222222222\",\"role\":\"amount\"}]}]}";
};
func request(version : Text, name : Text, enabled : Bool) : Packs.SetRequest {
  let document_json = document(version, name);
  { id = "owner.example"; version; name; document_json; sha256 = Packs.digest(document_json); enabled };
};
func ok(value : Packs.Result<Decoders.Pack>) : Decoders.Pack {
  switch (value) { case (#ok(pack)) pack; case (#err(_)) { assert false; loop {} } };
};
func error(value : Packs.Result<Decoders.Pack>) {
  switch (value) { case (#err(_)) {}; case (#ok(_)) assert false };
};

// Independent SHA-256 vectors prove that the backend derives the actual
// document digest, rather than treating supplied hash text as an authority.
assert Packs.digest("abc") == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
assert Packs.digest("") == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
assert Packs.digest("{}") == "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";

let memory = Decoders.init();
let store = Packs.Store(memory);
assert store.list().packs == [];
let firstRequest = request("1", "Example protocol", true);
let first = ok(store.set(firstRequest, 100));
assert first.document_json == firstRequest.document_json;
assert first.sha256 == firstRequest.sha256;
assert first.enabled and first.created_at == 100 and first.updated_at == 100;
assert store.list().packs == [first];

// A restored root exposes exact original bytes and owner-selected state.
let restored : Decoders.Mem = memory;
let reloaded = Packs.Store(restored);
assert reloaded.list().packs == [first];
let disabled = ok(reloaded.set({ firstRequest with enabled = false }, 200));
assert not disabled.enabled;
assert disabled.created_at == 100 and disabled.updated_at == 200;
assert disabled.document_json == first.document_json and disabled.sha256 == first.sha256;
let enabled = ok(reloaded.set(firstRequest, 300));
assert enabled.enabled and enabled.created_at == 100 and enabled.updated_at == 300;

// Metadata and hashes must bind to this exact JSON document; malformed and
// duplicate fields cannot cause backend/JavaScript identity disagreement.
error(reloaded.set({ firstRequest with sha256 = "not-the-document-digest" }, 400));
error(reloaded.set({ firstRequest with name = "Misleading metadata" }, 400));
error(reloaded.set({ firstRequest with id = "different-id" }, 400));
error(reloaded.set({ firstRequest with version = "2" }, 400));
error(reloaded.set({ firstRequest with id = "Invalid ID" }, 400));
let malformed = "{\"id\":\"owner.example\"";
error(reloaded.set({ firstRequest with document_json = malformed; sha256 = Packs.digest(malformed) }, 400));
let duplicate = "{\"format\":1,\"id\":\"owner.example\",\"id\":\"owner.example\",\"version\":\"1\",\"name\":\"Example protocol\",\"description\":\"x\"}";
error(reloaded.set({ firstRequest with document_json = duplicate; sha256 = Packs.digest(duplicate) }, 400));
let nestedDuplicate = "{\"format\":1,\"id\":\"owner.example\",\"version\":\"1\",\"name\":\"Example protocol\",\"description\":\"x\",\"nested\":{\"x\":1,\"x\":2}}";
error(reloaded.set({ firstRequest with document_json = nestedDuplicate; sha256 = Packs.digest(nestedDuplicate) }, 400));
let unsupportedFormat = "{\"format\":2,\"id\":\"owner.example\",\"version\":\"1\",\"name\":\"Example protocol\",\"description\":\"x\"}";
error(reloaded.set({ firstRequest with document_json = unsupportedFormat; sha256 = Packs.digest(unsupportedFormat) }, 400));
let missingDescription = "{\"format\":1,\"id\":\"owner.example\",\"version\":\"1\",\"name\":\"Example protocol\"}";
error(reloaded.set({ firstRequest with document_json = missingDescription; sha256 = Packs.digest(missingDescription) }, 400));
assert reloaded.list().packs == [enabled];

// Released decoder artifact identities are immutable; even equivalent JSON
// with different whitespace has different exact bytes and requires an update.
let changedBytes = firstRequest.document_json # " ";
error(reloaded.set({ firstRequest with document_json = changedBytes; sha256 = Packs.digest(changedBytes) }, 500));
error(reloaded.set(request("1", "Changed at same version", true), 500));
for (version in ["0", "01", "-1", "+1", "1.0", "1e2", " 1", ""].vals()) {
  error(reloaded.set(request(version, "Invalid version", true), 500));
};
assert reloaded.list().packs == [enabled];

let second = ok(reloaded.set(request("2", "Updated protocol", false), 600));
assert second.version == "2" and second.name == "Updated protocol";
assert not second.enabled and second.created_at == 100 and second.updated_at == 600;
error(reloaded.set(firstRequest, 700));
assert reloaded.list().packs == [second];
let tenth = ok(reloaded.set(request("10", "Tenth release", true), 800));
assert tenth.version == "10";
error(reloaded.set(request("9", "Ninth release", true), 900));
let large = ok(reloaded.set(request("9007199254740993", "Exact large version", true), 1000));
assert large.version == "9007199254740993";
error(reloaded.set(request("9007199254740992", "Older adjacent large version", true), 1100));
assert reloaded.list().packs == [large];

// Explicit owner removal is idempotent and permits a later fresh import.
assert not reloaded.remove("absent");
assert reloaded.remove("owner.example");
assert not reloaded.remove("owner.example");
assert Map.size(memory.packs) == 0;
let importedAgain = ok(reloaded.set(firstRequest, 1200));
assert importedAgain.created_at == 1200 and importedAgain.updated_at == 1200;
assert importedAgain.version == "1";

// Adding this independent root next to populated production roots does not
// reset account ownership, signed bytes, nonce reservations, or observations.
let installedWallet = Wallet.init();
let installedEvidence = Evidence.init();
let account : Wallet.Account = { id = "main"; slot = "main"; address = "funded-address"; public_key = "public-key"; key_fingerprint = "fingerprint"; namespace_version = 1 };
Map.add(installedWallet.accounts, Text.compare, "main", account);
Map.add(installedWallet.nonce_next, Text.compare, "main-chain-key", 17);
installedWallet.next_operation_id := 43;
let command : Wallet.Command = {
  id = 42; identity = { caller = { app_id = "aave"; installation_uid = 99; endpoint = "tile" }; request_id = "0123456789abcdef0123456789abcdef" };
  intent = { account_id = "main"; chain_id = 1; operation = #personal_message({ message = "0x01" }) };
  intent_bytes = "canonical intent"; created_at = 123;
  var updated_at = 456; var status = "unknown"; var address = "funded-address";
  var message = ?"Broadcast reply lost"; var review_revision = 3; var review = null;
  var transaction = ?{ chainId = 1; nonce = 17; gasLimit = 21000; to = ?"recipient"; value = 10; data = "call bytes"; accessList = []; fee = #legacy({ gasPrice = 20 }) };
  var digest = ?"digest"; var signature = ?"signature"; var signed_raw = ?"exact signed bytes";
  var transaction_hash = ?"original hash"; var receipt_json = null; var finality = null;
  var replacement_hash = ?"replacement hash"; var reserved_nonce = true;
};
Map.add(installedWallet.commands, Text.compare, "caller-installation-request", command);
let observation : Evidence.Evidence = {
  chain_id = 1; contract = "token"; method = "approve"; owner = "account";
  spender = ?"spender"; recipient = null; amount = "100";
  recognition = "erc20_calldata"; block_number = ?"0x64"; block_hash = ?"observed block";
  block_error = null; observed_at = 789;
  balance = { value = ?"123456789012345678901234567890"; error = null };
  allowance = ?{ value = null; error = ?"Provider unavailable" };
};
Map.add(installedEvidence.observations, Nat.compare, 42, observation);
let stableMemory = { evm_wallet = installedWallet; evm_evidence = installedEvidence; evm_decoders = Decoders.init() };
Config.initialize(stableMemory.evm_wallet);
let newStore = Packs.Store(stableMemory.evm_decoders);
assert newStore.list().packs == [];
ignore ok(newStore.set(firstRequest, 1300));
assert newStore.remove("owner.example");
assert Map.get(stableMemory.evm_wallet.accounts, Text.compare, "main") == ?account;
assert Map.get(stableMemory.evm_wallet.nonce_next, Text.compare, "main-chain-key") == ?17;
assert stableMemory.evm_wallet.next_operation_id == 43;
let ?pending = Map.get(stableMemory.evm_wallet.commands, Text.compare, "caller-installation-request") else { assert false; loop {} };
assert pending.status == "unknown" and pending.reserved_nonce;
assert pending.signed_raw == ?"exact signed bytes" and pending.signature == ?"signature";
assert pending.transaction_hash == ?"original hash" and pending.replacement_hash == ?"replacement hash";
assert Map.get(stableMemory.evm_evidence.observations, Nat.compare, 42) == ?observation;
