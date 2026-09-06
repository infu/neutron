import Array "mo:core/Array";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Caps "mo:neutron-capabilities";
import Main "../backend/main";
import Memory "../backend/memory/evm_wallet/v1";
import EvidenceMemory "../backend/memory/evm_evidence/v1";
import Types "../backend/Types";
import Hex "../backend/evm/Hex";
import RpcTypes "../backend/rpc/Types";
import Json "../backend/rpc/Json";
import Fixtures "BackendFixtures";

// All wallet decisions, journaling, nonce allocation and signature validation
// are the production implementation. Only the external capabilities are a
// scripted transport, and both nonce RPC and signer actually await Gate.
persistent actor class Wallet(gateId : Principal) {
  type Gate = actor { hold : shared Text -> async (); release : shared (Text, Nat) -> async () };
  transient let gate : Gate = actor (Principal.toText(gateId));
  transient let mem = Memory.init();
  transient var attempts : [Attempt] = [];
  transient var broadcasts : [Text] = [];
  transient let signerErrors = Map.empty<Nat, Text>();
  type Attempt = { operation_id : Nat; caller : Memory.Caller; chain_id : Nat; nonce : ?Text; digest : Text };
  type Summary = {
    operation_id : Nat; caller : Memory.Caller; request_id : Text;
    chain_id : Nat; status : Text; review_revision : Nat;
    nonce : ?Text; transaction_hash : ?Text;
  };
  type Result = { #ok : Summary; #err : Text };

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
  func chain(service : RpcTypes.RpcService) : Nat {
    switch (service) { case (#EthMainnet(_)) 1; case (#ArbitrumOne(_)) 42161; case (_) { assert false; 0 } };
  };
  func performCall(request : Caps.BackendCallRequestV1) : async* Caps.BackendCallResultV1 {
    if (request.method == "requestCost" or Text.endsWith(request.method, #text("CyclesCost"))) {
      let cost : RpcTypes.RequestCostResult = #Ok(1_234);
      return #ok(to_candid(cost));
    };
    assert request.cycles == 1_234;
    if (request.method == "eth_sendRawTransaction") {
      let ?(_, _, raw) : ?(RpcTypes.RpcServices, ?RpcTypes.RpcConfig, Text) = from_candid(request.args) else { assert false; loop {} };
      var id : ?Nat = null;
      for ((_, c) in Map.entries(mem.commands)) {
        if (c.signed_raw == ?ok(Hex.decode(raw))) { assert c.transaction_hash != null; id := ?c.id };
      };
      let ?operationId = id else { assert false; loop {} };
      broadcasts := Array.concat(broadcasts, [raw]);
      await gate.hold("broadcast:" # Nat.toText(operationId));
      let result : RpcTypes.MultiSendRawTransactionResult = #Consistent(#Ok(#Ok(null)));
      return #ok(to_candid(result));
    };
    assert request.method == "request";
    let ?(provider, payload, _) : ?(RpcTypes.RpcService, Text, Nat64) = from_candid(request.args) else { assert false; loop {} };
    let body = ok(Json.parse(payload));
    let ?#string(method) = Json.field(body, "method") else { assert false; loop {} };
    if (method == "eth_getTransactionCount") await gate.hold("nonce:" # Nat.toText(chain(provider)));
    let result : Text = switch (method) {
      case ("eth_blockNumber") "\"0x64\"";
      case ("eth_getBalance") "\"0xde0b6b3a7640000\"";
      case ("eth_getTransactionCount") "\"0x0\"";
      case ("eth_estimateGas") "\"0x5208\"";
      case ("eth_call") "\"0x\"";
      case ("eth_getCode") "\"0x\"";
      case ("eth_getTransactionReceipt" or "eth_getTransactionByHash") "null";
      case (_) { assert false; "null" };
    };
    let response : RpcTypes.RequestResult = #Ok("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":" # result # "}");
    #ok(to_candid(response));
  };
  transient let calls : Caps.BackendCallsV1 = {
    canister_principal = Principal.fromText("aaaaa-aa");
    can_call = func(_ : Principal, _ : Text) : Bool { true };
    call = performCall;
    call_batch = func(requests : [Caps.BackendCallRequestV1]) : async* [Caps.BackendCallResultV1] {
      var replies : [Caps.BackendCallResultV1] = [];
      for (request in requests.vals()) replies := Array.concat(replies, [await* performCall(request)]);
      replies;
    };
  };
  transient let service = Main.Init({ stable_memory = { evm_wallet = mem; evm_evidence = EvidenceMemory.init() }; capabilities = { backend_calls = calls; wallet_custody_signing = signing } });

  public func prepare(identity : Memory.Identity, chainId : Nat, value : Text, message : Bool) : async Result {
    let tx : Memory.TransactionRequest = {
      to = "0x0000000000000000000000000000000000000002"; value; data = "0x";
      gas_limit = null; max_fee_per_gas = ?"100"; max_priority_fee_per_gas = ?"2";
      gas_price = null; transaction_type = ?"eip1559"; access_list = [];
    };
    let operation : Memory.Intent = { account_id = "main"; chain_id = chainId; operation = if (message) #personal_message({ message = "0x6869" }) else #transaction(tx) };
    summary(await* service.evm_wallet_prepare_v1({ identity; intent = operation }));
  };
  public func execute(identity : Memory.Identity, revision : Nat) : async Result {
    summary(await* service.evm_wallet_execute_v1({ identity; review_revision = revision }));
  };
  public func status(identity : Memory.Identity, refresh : Bool) : async Result {
    summary(await* service.evm_wallet_status_v1({ identity; refresh }));
  };
  public func signerError(operationId : Nat, error : Text) : async () {
    Map.add(signerErrors, Nat.compare, operationId, error);
  };
  public query func observations() : async { attempts : [Attempt]; broadcasts : [Text]; commands : Nat } {
    { attempts; broadcasts; commands = Map.size(mem.commands) };
  };
};
