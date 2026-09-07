import DecoderMemory "../backend/memory/evm_decoders/v1";
import Array "mo:core/Array";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Set "mo:core/Set";
import Text "mo:core/Text";
import Caps "mo:neutron-capabilities";
import Main "../backend/main";
import Memory "../backend/memory/evm_wallet/v1";
import EvidenceMemory "../backend/memory/evm_evidence/v1";
import Types "../backend/Types";
import Hex "../backend/evm/Hex";
import Fixtures "BackendFixtures";

// All wallet decisions, journaling, nonce allocation and signature validation
// are the production implementation. Only the external capabilities are a
// scripted signer. A browser preparation gate and the signer actually await
// Gate so separate ingress messages can overlap the production state machine.
persistent actor class Wallet(gateId : Principal) {
  type Gate = actor { hold : shared Text -> async (); release : shared (Text, Nat) -> async () };
  transient let gate : Gate = actor (Principal.toText(gateId));
  transient let mem = Memory.init();
  transient var attempts : [Attempt] = [];
  transient let preparing = Set.empty<Nat>();
  transient let signerErrors = Map.empty<Nat, Text>();
  type Attempt = { operation_id : Nat; caller : Memory.Caller; chain_id : Nat; nonce : ?Text; digest : Text };
  type Summary = {
    operation_id : Nat; caller : Memory.Caller; request_id : Text;
    chain_id : Nat; status : Text; review_revision : Nat;
    nonce : ?Text; transaction_hash : ?Text;
  };
  type Result = { #ok : Summary; #err : Text };
  type SubmissionResult = { #ok : { chain_id : Nat; transaction_hash : Text; raw_transaction : Text }; #err : Text };

  func ok<T>(result : Types.Result<T>) : T {
    switch (result) { case (#ok(v)) v; case (#err(_)) { assert false; loop {} } };
  };
  func summary(result : Main.WalletOperationResult) : Result {
    switch (result) {
      case (#err(e)) #err(e);
      case (#ok(v)) #ok({
        operation_id = v.operation_id; caller = v.caller; request_id = v.request_id;
        chain_id = v.chain_id; status = v.status; review_revision = v.review_revision;
        nonce = switch (v.prepared_transaction) { case null null; case (?tx) ?tx.nonce };
        transaction_hash = v.transaction_hash;
      });
    };
  };
  transient let signing : Caps.WalletCustodySigningV1 = {
    public_key = func(slot : Text) : async* Caps.WalletCustodyPublicKeyResultV1 {
      #ok({ slot; algorithm = #ecdsa_secp256k1; public_key = ok(Hex.decode(Fixtures.publicKey)); key_fingerprint = "fixture"; namespace_version = 1 });
    };
    sign_digest = func(request : Caps.WalletCustodySignDigestRequestV1) : async* Caps.WalletCustodySignatureResultV1 {
      var command : ?Memory.Command = null;
      for ((_, candidate) in Map.entries(mem.commands)) {
        if (candidate.status == "signing" and candidate.digest == ?request.digest) {
          switch (command) { case null {}; case (?_) assert false };
          command := ?candidate;
        };
      };
      let ?c = command else { assert false; loop {} };
      attempts := Array.concat(attempts, [{
        operation_id = c.id; caller = c.identity.caller; chain_id = c.intent.chain_id;
        nonce = switch (c.transaction) { case null null; case (?tx) { assert c.reserved_nonce; ?Nat.toText(tx.nonce) } };
        digest = Hex.encode(request.digest);
      }]);
      let failure = Map.get(signerErrors, Nat.compare, c.id);
      await gate.hold("sign:" # Nat.toText(c.id));
      switch (failure) {
        case (?"busy") return #err(#busy);
        case (?"disabled") return #err(#disabled);
        case (?"outcome_unknown") return #err(#outcome_unknown);
        case (_) {};
      };
      for (vector in Fixtures.vectors.vals()) {
        if (Hex.encode(request.digest) == vector.digest) {
          return #ok({ slot = request.slot; algorithm = #ecdsa_secp256k1; digest = request.digest; signature = ok(Hex.decode(vector.signature)) });
        };
      };
      assert false; #err(#invalid_request);
    };
  };
  transient let service = Main.Init({ stable_memory = { evm_wallet = mem; evm_evidence = EvidenceMemory.init(); evm_decoders = DecoderMemory.init() }; capabilities = { wallet_custody_signing = signing } });

  public func prepare(identity : Memory.Identity, chainId : Nat, value : Text, message : Bool) : async Result {
    let tx : Memory.TransactionRequest = {
      to = "0x0000000000000000000000000000000000000002"; value; data = "0x";
      gas_limit = null; max_fee_per_gas = ?"100"; max_priority_fee_per_gas = ?"2";
      gas_price = null; transaction_type = ?"eip1559"; access_list = [];
    };
    let operation : Memory.Intent = { account_id = "main"; chain_id = chainId; operation = if (message) #personal_message({ message = "0x6869" }) else #transaction(tx) };
    let candidate = await* service.evm_wallet_prepare_browser_v1({
      request = { identity; intent = operation };
      observation = {
        block_number = "0x64"; balance = "1000000000000000000";
        pending_nonce = "0"; mined_nonce = "0"; gas_price = "100";
        max_priority_fee_per_gas = "2"; base_fee_per_gas = "40";
      };
    });
    let c = switch (candidate) { case (#err(_)) return summary(candidate); case (#ok(c)) c };
    if (c.status != "preparing" or Set.contains(preparing, Nat.compare, c.operation_id)) return summary(candidate);
    Set.add(preparing, Nat.compare, c.operation_id);
    // The browser is estimating and simulating the frozen candidate while a
    // second invocation may replay it or another installation prepares a swap.
    await gate.hold("prepare:" # Nat.toText(chainId));
    Set.remove(preparing, Nat.compare, c.operation_id);
    summary(service.evm_wallet_finish_prepare_browser_v1({
      identity; review_revision = c.review_revision;
      balance = "1000000000000000000"; pending_nonce = "0"; mined_nonce = "0"; gas_estimate = "21000"; gas_limit = "21000"; simulation = "0x";
    }));
  };
  public func finishPrepare(identity : Memory.Identity, revision : Nat) : async Result {
    summary(service.evm_wallet_finish_prepare_browser_v1({
      identity; review_revision = revision;
      balance = "1000000000000000000"; pending_nonce = "0"; mined_nonce = "0"; gas_estimate = "21000"; gas_limit = "21000"; simulation = "0x";
    }));
  };
  public func execute(identity : Memory.Identity, revision : Nat) : async Result {
    summary(await* service.evm_wallet_execute_v1({ identity; review_revision = revision }));
  };
  public func status(identity : Memory.Identity, refresh : Bool) : async Result {
    summary(await* service.evm_wallet_status_v1({ identity; refresh }));
  };
  public query func submission(identity : Memory.Identity) : async SubmissionResult {
    service.evm_wallet_submission_v1({ identity });
  };
  public func observePending(identity : Memory.Identity, hash : Text) : async Result {
    summary(service.evm_wallet_observe_browser_v1({
      identity; transaction_hash = hash;
      transaction_json = "{\"hash\":\"" # hash # "\",\"blockNumber\":null}";
      receipt_json = null; canonical_block_json = null;
      safe_block_json = null; finalized_block_json = null; broadcast_error = null;
    }));
  };
  public func signerError(operationId : Nat, error : Text) : async () {
    Map.add(signerErrors, Nat.compare, operationId, error);
  };
  public query func observations() : async { attempts : [Attempt]; commands : Nat } {
    { attempts; commands = Map.size(mem.commands) };
  };
};
