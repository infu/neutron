// New independent managed root. The released evm_wallet v1 schema and
// its command/signature/nonce history remain byte-identical.
import Map "mo:core/Map";
module {
  public type Observation = { value : ?Text; error : ?Text };
  public type Evidence = {
    chain_id : Nat; contract : Text; method : Text;
    owner : Text; spender : ?Text; recipient : ?Text; amount : Text;
    recognition : Text;
    block_number : ?Text; block_hash : ?Text; block_error : ?Text;
    observed_at : Int;
    balance : Observation; allowance : ?Observation;
  };
  public type Mem = { observations : Map.Map<Nat, Evidence> };
  public func init() : Mem = { observations = Map.empty() };
};
