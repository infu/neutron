import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Result "mo:core/Result";
import Text "mo:core/Text";
import Time "mo:core/Time";
import Memory "../memory/evm_evidence/v1";
import Wallet "../memory/evm_wallet/v1";
import Decode "Decode";
import Hex "../evm/Hex";
import Json "../rpc/Json";

module {
  /// The wallet frontend reads the public RPC at one explicit block and submits
  /// the observed values with the operation's identity and review revision.
  /// Attribution is always decoded from the retained transaction below.
  public type Observation = {
    block_number : ?Text; block_hash : ?Text; block_error : ?Text;
    balance : Memory.Observation; allowance : ?Memory.Observation;
  };

  public class Service(mem : Memory.Mem) {
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

    /// This method never performs a canister outcall. It records display evidence
    /// only; transaction preparation and signing retain their independent checks.
    /// Validate the complete observation before replacing an existing reading.
    public func capture(id : Nat, tx : Wallet.Transaction, address : Text, observation : Observation) : Result.Result<(), Text> {
      let to = switch (tx.to) { case null { clear(id); return #ok(()) }; case (?v) v };
      let decoded = switch (Decode.decode(to, address, tx.data)) { case null { clear(id); return #ok(()) }; case (?v) v };
      let base : Memory.Evidence = {
        chain_id = tx.chainId; contract = decoded.token; method = decoded.method;
        owner = decoded.owner; spender = decoded.spender; recipient = decoded.recipient;
        amount = Nat.toText(decoded.amount); recognition = "erc20_calldata";
        block_number = null; block_hash = null; block_error = null;
        observed_at = Time.now(); balance = unavailable("Observation has not completed");
        allowance = switch (decoded.allowance_call) { case null null; case (?_) ?unavailable("Observation has not completed") };
      };
      let block = switch (observation.block_number) {
        case null {
          let error = switch (observation.block_error) { case null "RPC did not return an observation block"; case (?value) value };
          Map.add(mem.observations, Nat.compare, id, {
            base with block_error = ?error;
            balance = unavailable("No observation block: " # error);
            allowance = switch (base.allowance) { case null null; case (?_) ?unavailable("No observation block: " # error) };
          });
          return #ok(());
        };
        case (?value) switch (Json.quantityText(value)) {
          case (#err(error)) return #err("Invalid observation block: " # error);
          case (#ok(number)) Json.hexQuantity(number);
        };
      };
      let (block_hash, block_error) : (?Text, ?Text) = switch (observation.block_hash) {
        case null (null, switch (observation.block_error) { case null ?"RPC did not return the observation block hash"; case (?error) ?error });
        case (?hash) {
          if (observation.block_error != null) return #err("Observation block hash cannot include an error");
          switch (Hex.decode(hash)) {
            case (#err(error)) return #err("Invalid observation block hash: " # error);
            case (#ok(bytes)) {
              if (bytes.size() != 32) return #err("Observation block hash must contain 32 bytes");
              (?Hex.encode(bytes), null);
            };
          };
        };
      };
      let balance = switch (validate(observation.balance)) { case (#err(error)) return #err("Invalid balance observation: " # error); case (#ok(value)) value };
      let allowance = switch (decoded.allowance_call, observation.allowance) {
        case (null, null) null;
        case (null, ?_) return #err("This transaction does not have an allowance observation");
        case (?_, null) return #err("This transaction requires an allowance observation or its read error");
        case (?_, ?value) switch (validate(value)) { case (#err(error)) return #err("Invalid allowance observation: " # error); case (#ok(value)) ?value };
      };
      Map.add(mem.observations, Nat.compare, id, {
        base with block_number = ?block; block_hash; block_error; balance; allowance;
      });
      #ok(())
    };
  };

  func validate(observation : Memory.Observation) : Result.Result<Memory.Observation, Text> {
    switch (observation.value, observation.error) {
      case (null, ?error) #ok(unavailable(error));
      case (?value, null) {
        if (Text.startsWith(value, #text("0x"))) return #err("Expected decimal atomic units");
        switch (Hex.parseNat(value)) {
          case (#err(error)) #err(error);
          case (#ok(number)) {
            if (number >= Hex.uint256Limit) return #err("Observed amount is outside uint256");
            #ok({ value = ?Nat.toText(number); error = null });
          };
        };
      };
      case _ #err("Expected exactly one observed value or read error");
    }
  };
  func unavailable(error : Text) : Memory.Observation = { value = null; error = ?error };
};
