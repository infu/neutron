import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Time "mo:core/Time";
import Memory "../memory/evm_evidence/v1";
import Wallet "../memory/evm_wallet/v1";
import Decode "Decode";
import Hex "../evm/Hex";
import Json "../rpc/Json";
import Rpc "../rpc/Client";

module {
  public type Client = { request : (Nat, Text, Text) -> async* Rpc.Result<Text> };
  public class Service(mem : Memory.Mem, rpc : Client) {
    public func get(id : Nat) : ?Memory.Evidence = Map.get(mem.observations, Nat.compare, id);
    public func clear(id : Nat) { ignore Map.remove(mem.observations, Nat.compare, id) };
    public func fail(id : Nat, error : Text) {
      switch (get(id)) {
        case null {};
        case (?previous) Map.add(mem.observations, Nat.compare, id, {
          previous with observed_at = Time.now(); balance = unavailable(error);
          allowance = switch (previous.allowance) { case null null; case (?_) ?unavailable(error) };
        });
      };
    };
    public func capture(id : Nat, tx : Wallet.Transaction, address : Text, atBlock : ?Text) : async* () {
      let to = switch (tx.to) { case null { clear(id); return }; case (?v) v };
      let decoded = switch (Decode.decode(to, address, tx.data)) { case null { clear(id); return }; case (?v) v };
      let base : Memory.Evidence = {
        chain_id = tx.chainId; contract = decoded.token; method = decoded.method;
        owner = decoded.owner; spender = decoded.spender; recipient = decoded.recipient;
        amount = Nat.toText(decoded.amount); recognition = "erc20_calldata";
        block_number = null; block_hash = null; block_error = null;
        observed_at = Time.now(); balance = unavailable("Observation has not completed");
        allowance = switch (decoded.allowance_call) { case null null; case (?_) ?unavailable("Observation has not completed") };
      };
      // Do not present a previous observation as if this refresh succeeded.
      Map.add(mem.observations, Nat.compare, id, base);
      let block = switch (atBlock) {
        case (?value) value;
        case null switch (await* rpc.request(tx.chainId, "eth_blockNumber", "[]")) {
          case (#err(error)) { failBlock(id, base, error); return };
          case (#ok(result)) switch (Json.stringResult(result)) {
            case null { failBlock(id, base, "RPC returned an invalid observation block"); return };
            case (?value) {
              switch (Json.quantityText(value)) { case (#err(error)) { failBlock(id, base, error); return }; case (_) {} };
              value;
            };
          };
        };
      };
      var block_hash : ?Text = null;
      var block_error : ?Text = null;
      switch (await* rpc.request(tx.chainId, "eth_getBlockByNumber", "[" # Json.quote(block) # ",false]")) {
        case (#err(error)) block_error := ?error;
        case (#ok(result)) switch (Json.parse(result)) {
          case (#err(error)) block_error := ?error;
          case (#ok(value)) switch (Json.field(value, "hash")) {
            case (?#string(hash)) switch (Hex.decode(hash)) {
              case (#ok(bytes)) { if (bytes.size() == 32) block_hash := ?Hex.encode(bytes) else block_error := ?"RPC returned an invalid observation block hash" };
              case (#err(error)) block_error := ?error;
            };
            case (_) block_error := ?"RPC did not return the observation block hash";
          };
        };
      };
      let balance = await* observe(tx.chainId, address, decoded.token, decoded.balance_call, block);
      let allowance = switch (decoded.allowance_call) {
        case null null;
        case (?data) ?(await* observe(tx.chainId, address, decoded.token, data, block));
      };
      Map.add(mem.observations, Nat.compare, id, {
        base with block_number = ?block; block_hash; block_error;
        observed_at = Time.now(); balance; allowance;
      });
    };
    func failBlock(id : Nat, base : Memory.Evidence, error : Text) {
      Map.add(mem.observations, Nat.compare, id, {
        base with block_error = ?error; observed_at = Time.now();
        balance = unavailable("No observation block: " # error);
        allowance = switch (base.allowance) { case null null; case (?_) ?unavailable("No observation block: " # error) };
      });
    };
    func observe(chain : Nat, from : Text, token : Text, data : Text, block : Text) : async* Memory.Observation {
      let params = "[{\"from\":" # Json.quote(from) # ",\"to\":" # Json.quote(token) # ",\"data\":" # Json.quote(data) # "}," # Json.quote(block) # "]";
      switch (await* rpc.request(chain, "eth_call", params)) {
        case (#err(error)) unavailable(error);
        case (#ok(result)) switch (Json.stringResult(result)) {
          case null unavailable("Contract read did not return hexadecimal bytes");
          case (?value) switch (Hex.decode(value)) {
            case (#err(error)) unavailable(error);
            case (#ok(bytes)) {
              if (bytes.size() != 32) unavailable("Contract read did not return an ERC20 uint256 word")
              else ({ value = ?Nat.toText(Hex.toNat(bytes)); error = null });
            };
          };
        };
      };
    };
  };
  func unavailable(error : Text) : Memory.Observation = { value = null; error = ?error };
};
