import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Text "mo:core/Text";
import Config "../backend/Config";
import Memory "../backend/memory/evm_wallet/v1";

let fresh = Memory.init();
assert Map.size(fresh.accounts) == 0;
assert Map.size(fresh.commands) == 0;
assert Map.size(fresh.nonce_next) == 0;
assert fresh.next_operation_id == 1;
Config.initialize(fresh);
assert Map.size(fresh.networks) == 3;
assert Map.size(fresh.assets) == 2;

// This is a new root, so no prior production migration exists. A compatible
// same-schema upgrade must keep every root object, including unknown effects.
let installed = Memory.init();
let account : Memory.Account = { id = "main"; slot = "main"; address = "funded-address"; public_key = "key bytes"; key_fingerprint = "fingerprint"; namespace_version = 1 };
Map.add(installed.accounts, Text.compare, "main", account);
let network : Memory.Network = { chain_id = 1; name = "owner-network-label"; native_symbol = "ETH"; explorer_url = "https://etherscan.io"; testnet = false; finality_description = "owner-config" };
Map.add(installed.networks, Nat.compare, 1, network);
let asset : Memory.Asset = { chain_id = 1; address = "tracked-token"; symbol = "CUSTOM"; decimals = 8 };
Map.add(installed.assets, Text.compare, "token-key", asset);
Map.add(installed.nonce_next, Text.compare, "main-chain-key", 17);
let intent : Memory.Intent = { account_id = "main"; chain_id = 1; operation = #personal_message({ message = "0x01" }) };
let command : Memory.Command = {
  id = 42; identity = { caller = { app_id = "consumer"; installation_uid = 99; endpoint = "old-tile" }; request_id = "0123456789abcdef0123456789abcdef" };
  intent; intent_bytes = "canonical intent"; created_at = 123;
  var updated_at = 456; var status = "unknown"; var address = "funded-address"; var message = ?"Broadcast reply lost";
  var review_revision = 3; var review = null;
  var transaction = ?{ chainId = 1; nonce = 17; gasLimit = 21000; to = ?"recipient"; value = 10; data = "call bytes"; accessList = []; fee = #legacy({ gasPrice = 20 }) };
  var digest = ?"digest bytes"; var signature = ?"signature bytes";
  var signed_raw = ?"exact signed transaction bytes"; var transaction_hash = ?"original hash";
  var receipt_json = null; var finality = null; var replacement_hash = ?"replacement hash";
  var reserved_nonce = true;
};
Map.add(installed.commands, Text.compare, "caller-installation-request-key", command);
installed.next_operation_id := 43;

let restored : Memory.Mem = installed;
Config.initialize(restored);
assert Map.get(restored.accounts, Text.compare, "main") == ?account;
assert Map.get(restored.networks, Nat.compare, 1) == ?network;
assert Map.get(restored.assets, Text.compare, "token-key") == ?asset;
assert Map.get(restored.nonce_next, Text.compare, "main-chain-key") == ?17;
assert restored.next_operation_id == 43;
let ?pending = Map.get(restored.commands, Text.compare, "caller-installation-request-key") else { assert false; loop {} };
assert pending.status == "unknown";
assert pending.signed_raw == ?"exact signed transaction bytes";
assert pending.signature == ?"signature bytes";
assert pending.transaction_hash == ?"original hash" and pending.replacement_hash == ?"replacement hash";
assert pending.reserved_nonce;
pending.status := "submitted";
assert command.status == "submitted";
