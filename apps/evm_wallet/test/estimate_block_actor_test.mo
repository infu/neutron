import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Debug "mo:core/Debug";
import Map "mo:core/Map";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Caps "mo:neutron-capabilities";
import Main "../backend/main";
import Memory "../backend/memory/evm_wallet/v1";
import EvidenceMemory "../backend/memory/evm_evidence/v1";
import Types "../backend/Types";
import Journal "../backend/Journal";
import Hex "../backend/evm/Hex";
import RpcTypes "../backend/rpc/Types";
import Json "../backend/rpc/Json";
import Fixtures "BackendFixtures";

persistent actor {
  public func run() : async Text {
    func ok<T>(value : Types.Result<T>) : T {
      switch (value) { case (#ok(value)) value; case (#err(error)) { Debug.print(error); assert false; loop {} } };
    };
    // Actual approval fixture: setting a zero allowance needs 44,322 gas,
    // while the same write after the pending original needs only 24,437.
    let minedBlock = "0x9b1d";
    let token = "0x067c804bb006836469379d4a2a69a81803bd1f45";
    let approval = "0x095ea7b3000000000000000000000000eb4f9946985f6d0b1d28481b8f5b1543d85011fe0000000000000000000000000000000000000000000000006124fee993bc0000";
    let returnedTrue = Json.quote(Hex.encode(ok(Hex.word(1))));
    let blockHash = "0x" # Text.join(Array.repeat<Text>("ab", 32).vals(), "");
    var signatures = 0;
    for (chain in [1, 42161].vals()) {
      let mem = Memory.init();
      let store = Journal.Store(mem);
      var estimates = 0;
      var simulations = 0;
      var callsCount = 0;
      func identity(id : Text) : Memory.Identity = { caller = { app_id = "consumer"; installation_uid = 10; endpoint = "tile" }; request_id = id };
      let originalIdentity = identity("00000000000000000000000000000001");
      let txRequest : Memory.TransactionRequest = { to = token; value = "0"; data = approval; gas_limit = null; max_fee_per_gas = ?"1000000014"; max_priority_fee_per_gas = ?"1000000000"; gas_price = null; transaction_type = ?"eip1559"; access_list = [] };
      let intent : Memory.Intent = { account_id = "main"; chain_id = chain; operation = #transaction(txRequest) };
      let original = ok(store.start({ identity = originalIdentity; intent }, 1));
      original.transaction := ?{ chainId = chain; nonce = 8; gasLimit = 44_322; to = ?token; value = 0; data = ok(Hex.decode(approval)); accessList = []; fee = #eip1559({ maxFeePerGas = 1_000_000_014; maxPriorityFeePerGas = 1_000_000_000 }) };
      original.status := "submitted";
      original.reserved_nonce := true;
      // Retained bytes are opaque here; this test never requests a signature
      // or broadcast. Other actor tests independently verify their encoding.
      original.signed_raw := ?ok(Hex.decode(Fixtures.vectors[0].raw));
      original.transaction_hash := ?Fixtures.vectors[0].hash;
      let retained = (original.transaction, original.signed_raw, original.transaction_hash, original.reserved_nonce);
      let signing : Caps.WalletCustodySigningV1 = {
        public_key = func(slot : Text) : async* Caps.WalletCustodyPublicKeyResultV1 {
          #ok({ slot; algorithm = #ecdsa_secp256k1; public_key = ok(Hex.decode(Fixtures.publicKey)); key_fingerprint = "fixture"; namespace_version = 1 });
        };
        sign_digest = func(_ : Caps.WalletCustodySignDigestRequestV1) : async* Caps.WalletCustodySignatureResultV1 { signatures += 1; assert false; #err(#invalid_request) };
      };
      func reply(result : Text) : Caps.BackendCallResultV1 {
        let response : RpcTypes.RequestResult = #Ok("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":" # result # "}");
        #ok(to_candid(response));
      };
      func performCall(request : Caps.BackendCallRequestV1) : async* Caps.BackendCallResultV1 {
        callsCount += 1;
        if (request.method == "requestCost") {
          let cost : RpcTypes.RequestCostResult = #Ok(1234);
          return #ok(to_candid(cost));
        };
        assert request.method == "request" and request.cycles == 1234;
        let ?(_, payload, _) : ?(RpcTypes.RpcService, Text, Nat64) = from_candid(request.args) else { assert false; loop {} };
        let body = ok(Json.parse(payload));
        let ?#string(method) = Json.field(body, "method") else { assert false; loop {} };
        let ?#array(params) = Json.field(body, "params") else { assert false; loop {} };
        switch (method) {
          case ("eth_blockNumber") reply(Json.quote(minedBlock));
          case ("eth_getBalance") { assert params[1] == #string(minedBlock); reply("\"0xde0b6b3a7640000\"") };
          case ("eth_getTransactionCount") {
            reply(if (params[1] == #string("pending")) "\"0x9\"" else { assert params[1] == #string(minedBlock); "\"0x8\"" });
          };
          case ("eth_estimateGas") {
            estimates += 1;
            assert Json.field(params[0], "to") == ?#string(token);
            assert Json.field(params[0], "data") == ?#string(approval);
            assert Json.field(params[0], "type") == ?#string("0x2");
            assert Json.field(params[0], "accessList") == ?#array([]);
            assert Json.field(params[0], "gas") == null;
            // An unanchored estimate sees the already-effective pending
            // approval, so its gas cannot simulate the pinned zero state.
            reply(if (params.size() == 2 and params[1] == #string(minedBlock)) "\"0xad22\"" else "\"0x5f75\"");
          };
          case ("eth_call") {
            assert params[1] == #string(minedBlock);
            if (Json.field(params[0], "data") == ?#string(approval)) {
              simulations += 1;
              let ?gas = Json.field(params[0], "gas") else { assert false; loop {} };
              if (ok(Json.quantity(gas)) < 44_322) {
                let error : RpcTypes.RequestResult = #Ok("{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":-32603,\"message\":\"EVM error OutOfGas\"}}");
                return #ok(to_candid(error));
              };
              reply(returnedTrue);
            } else reply(Json.quote(Hex.encode(ok(Hex.word(0)))));
          };
          case ("eth_getBlockByNumber") { assert params[0] == #string(minedBlock); reply("{\"number\":\"0x9b1d\",\"hash\":" # Json.quote(blockHash) # ",\"baseFeePerGas\":\"0x7\"}") };
          case (_) { Debug.print(method); assert false; loop {} };
        };
      };
      let calls : Caps.BackendCallsV1 = {
        canister_principal = Principal.fromText("aaaaa-aa");
        can_call = func(_ : Principal, _ : Text) : Bool { true };
        call = performCall;
        call_batch = func(requests : [Caps.BackendCallRequestV1]) : async* [Caps.BackendCallResultV1] {
          var replies : [Caps.BackendCallResultV1] = [];
          for (request in requests.vals()) replies := Array.concat(replies, [await* performCall(request)]);
          replies;
        };
      };
      let service = Main.Init({ stable_memory = { evm_wallet = mem; evm_evidence = EvidenceMemory.init() }; capabilities = { backend_calls = calls; wallet_custody_signing = signing } });
      let replacementRequest : Main.WalletPrepareRequest = { identity = identity("00000000000000000000000000000002"); intent = { intent with operation = #replacement({ operation_id = original.id; cancel = false; max_fee_per_gas = "2000000029"; max_priority_fee_per_gas = "2000000001" }) } };
      let replacement = ok(await* service.evm_wallet_prepare_v1(replacementRequest));
      if (replacement.status != "prepared") Debug.print(debug_show(replacement.message));
      assert replacement.status == "prepared";
      let ?prepared = replacement.prepared_transaction else { assert false; loop {} };
      assert prepared.gas_limit == "44322" and prepared.nonce == "8";
      assert prepared.to == ?token and prepared.data == approval;
      assert prepared.max_fee_per_gas == ?"2000000029" and prepared.max_priority_fee_per_gas == ?"2000000001";
      assert estimates == 3 and simulations == 3 and signatures == 0;
      assert retained == (original.transaction, original.signed_raw, original.transaction_hash, original.reserved_nonce);
      let afterPreparation = callsCount;
      assert (ok(await* service.evm_wallet_prepare_v1(replacementRequest))).operation_id == replacement.operation_id;
      assert callsCount == afterPreparation;
      assert Map.size(mem.commands) == 2;
    };
    "Pending approval replacements use the same mined state for estimates and simulation on Ethereum and Arbitrum";
  };
};
