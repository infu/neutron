import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
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
import ERC20 "ERC20Fixtures";

persistent actor {
  public func run() : async Text {
    func ok<T>(result : Types.Result<T>) : T {
      switch (result) { case (#ok(v)) v; case (#err(e)) { assert false; loop {} } };
    };
    let mem = Memory.init();
    let store = Journal.Store(mem);
    var signAttempts = 0;
    var signatures = 0;
    var broadcasts : [Text] = [];
    var signerError : ?Caps.ChainKeySigningErrorV1 = null;
    var loseBroadcast = true;
    var receiptMode = 0;
    var expectedHash = Fixtures.vectors[0].hash;
    let blockHash = "0x" # Text.join(Array.repeat<Text>("ab", 32).vals(), "");
    let signing : Caps.WalletCustodySigningV1 = {
      public_key = func(slot : Text) : async* Caps.WalletCustodyPublicKeyResultV1 {
        assert slot == "main";
        #ok({ slot; algorithm = #ecdsa_secp256k1; public_key = ok(Hex.decode(Fixtures.publicKey)); key_fingerprint = "fixture"; namespace_version = 1 });
      };
      sign_digest = func(request : Caps.WalletCustodySignDigestRequestV1) : async* Caps.WalletCustodySignatureResultV1 {
        signAttempts += 1;
        // At every signing boundary the operation and nonce are already durable.
        var found = false;
        for ((_, c) in Map.entries(mem.commands)) {
          if (c.status == "signing" and c.digest == ?request.digest) {
            found := true;
            if (c.transaction != null) assert c.reserved_nonce;
          };
        };
        assert found;
        switch (signerError) { case (?e) return #err(e); case null {} };
        for (vector in Fixtures.vectors.vals()) {
          if (Hex.encode(request.digest) == vector.digest) {
            signatures += 1;
            return #ok({ slot = request.slot; algorithm = #ecdsa_secp256k1; digest = request.digest; signature = ok(Hex.decode(vector.signature)) });
          };
        };
        assert false; #err(#invalid_request);
      };
    };
    func receipt(hash : Text) : Text {
      "{\"transactionHash\":" # Json.quote(hash) # ",\"blockNumber\":\"0x64\",\"blockHash\":" # Json.quote(blockHash) # ",\"status\":" # (if (receiptMode == 2) "\"0x0\"" else "\"0x1\"") # ",\"gasUsed\":\"0x5208\",\"effectiveGasPrice\":\"0x64\",\"logs\":[]}";
    };
    func performCall(request : Caps.BackendCallRequestV1) : async* Caps.BackendCallResultV1 {
        if (request.method == "requestCost" or Text.endsWith(request.method, #text("CyclesCost"))) {
          assert request.cycles == 0;
          let cost : RpcTypes.RequestCostResult = #Ok(1_234);
          return #ok(to_candid(cost));
        };
        assert request.cycles == 1_234;
        if (request.method == "eth_sendRawTransaction") {
          let ?(_, _, raw) : ?(RpcTypes.RpcServices, ?RpcTypes.RpcConfig, Text) = from_candid(request.args) else { assert false; loop {} };
          // Signing bytes and the locally calculated hash exist BEFORE dispatch.
          var found = false;
          for ((_, c) in Map.entries(mem.commands)) {
            if (c.signed_raw == ?ok(Hex.decode(raw))) { assert c.transaction_hash != null; found := true };
          };
          assert found;
          broadcasts := Array.concat(broadcasts, [raw]);
          if (loseBroadcast) return #err({ code = "reply_lost"; message = "accepted remotely; response lost" });
          let result : RpcTypes.MultiSendRawTransactionResult = #Consistent(#Ok(#Ok(null)));
          return #ok(to_candid(result));
        };
        assert request.method == "request";
        let ?(_, payload, _) : ?(RpcTypes.RpcService, Text, Nat64) = from_candid(request.args) else { assert false; loop {} };
        let body = ok(Json.parse(payload));
        let ?#string(method) = Json.field(body, "method") else { assert false; loop {} };
        let ?#array(params) = Json.field(body, "params") else { assert false; loop {} };
        let result : Text = switch (method) {
          case ("eth_blockNumber") "\"0x64\"";
          case ("eth_getBalance") "\"0xde0b6b3a7640000\"";
          case ("eth_getTransactionCount") "\"0x0\"";
          case ("eth_maxPriorityFeePerGas") "\"0x2\"";
          case ("eth_gasPrice") "\"0x64\"";
          case ("eth_estimateGas") "\"0x5208\"";
          case ("eth_call") "\"0x\"";
          case ("eth_getCode") "\"0x6000\"";
          case ("eth_getBlockByNumber") "{\"number\":\"0x64\",\"hash\":" # Json.quote(blockHash) # ",\"baseFeePerGas\":\"0x31\"}";
          case ("eth_getTransactionReceipt") {
            let hash = ok(Json.text(params[0]));
            if (receiptMode != 0 and hash == expectedHash) receipt(hash) else "null";
          };
          case ("eth_getTransactionByHash") "null";
          case (_) { assert false; "null" };
        };
        let response : RpcTypes.RequestResult = #Ok("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":" # result # "}");
        #ok(to_candid(response));
      };
    let calls : Caps.BackendCallsV1 = {
      canister_principal = Principal.fromText("aaaaa-aa");
      can_call = func(_ : Principal, _ : Text) : Bool { true };
      call_batch = func(requests : [Caps.BackendCallRequestV1]) : async* [Caps.BackendCallResultV1] {
        var replies : [Caps.BackendCallResultV1] = [];
        for (request in requests.vals()) replies := Array.concat(replies, [await* performCall(request)]);
        replies;
      };
      call = performCall;
    };
    let env : Main.AppBackendEnvironment = { stable_memory = { evm_wallet = mem; evm_evidence = EvidenceMemory.init() }; capabilities = { backend_calls = calls; wallet_custody_signing = signing } };
    let service = Main.Init(env);
    func identity(id : Text) : Memory.Identity = { caller = { app_id = "consumer"; installation_uid = 10; endpoint = "tile" }; request_id = id };
    let first = identity("00000000000000000000000000000001");
    let second = identity("00000000000000000000000000000002");
    let txRequest : Memory.TransactionRequest = { to = "0x0000000000000000000000000000000000000002"; value = "1"; data = "0x"; gas_limit = null; max_fee_per_gas = ?"100"; max_priority_fee_per_gas = ?"2"; gas_price = null; transaction_type = ?"eip1559"; access_list = [] };
    let intent : Memory.Intent = { account_id = "main"; chain_id = 1; operation = #transaction(txRequest) };
    let prepared = ok(await* service.evm_wallet_prepare_v1({ identity = first; intent }));
    assert prepared.status == "prepared" and prepared.address == "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";
    assert ok(await* service.evm_wallet_prepare_v1({ identity = first; intent })).operation_id == prepared.operation_id;
    switch (await* service.evm_wallet_prepare_v1({ identity = first; intent = { intent with chain_id = 42161 } })) { case (#err(_)) {}; case (_) assert false };
    // Concurrent preparations do not each silently sign the same nonce.
    let competing = ok(await* service.evm_wallet_prepare_v1({ identity = second; intent }));
    assert competing.review_revision == 1;
    signerError := ?#busy;
    assert ok(await* service.evm_wallet_execute_v1({ identity = first; review_revision = prepared.review_revision })).status == "prepared";
    signerError := ?#low_cycles;
    assert ok(await* service.evm_wallet_execute_v1({ identity = first; review_revision = prepared.review_revision })).status == "prepared";
    assert signatures == 0 and broadcasts.size() == 0;
    signerError := null;
    let unknown = ok(await* service.evm_wallet_execute_v1({ identity = first; review_revision = prepared.review_revision }));
    assert unknown.status == "unknown" and unknown.transaction_hash == ?Fixtures.vectors[0].hash;
    let lookup = ok(await* service.evm_wallet_transaction_v1({ chain_id = 1; transaction_hash = Fixtures.vectors[0].hash; wallet_request = ?{ caller_app_id = "consumer"; caller_installation_uid = 10; request_id = first.request_id } }));
    assert lookup.wallet_request_matches == ?true;
    let wrongInstallation = ok(await* service.evm_wallet_transaction_v1({ chain_id = 1; transaction_hash = Fixtures.vectors[0].hash; wallet_request = ?{ caller_app_id = "consumer"; caller_installation_uid = 11; request_id = first.request_id } }));
    assert wrongInstallation.wallet_request_matches == ?false;
    let wrongCommand = ok(await* service.evm_wallet_transaction_v1({ chain_id = 1; transaction_hash = Fixtures.vectors[0].hash; wallet_request = ?{ caller_app_id = "consumer"; caller_installation_uid = 10; request_id = second.request_id } }));
    assert wrongCommand.wallet_request_matches == ?false;
    assert signatures == 1 and broadcasts.size() == 1 and broadcasts[0] == Fixtures.vectors[0].raw;
    assert ok(await* service.evm_wallet_execute_v1({ identity = first; review_revision = prepared.review_revision })).status == "unknown";
    assert signatures == 1 and broadcasts.size() == 1;
    // Reload restores exactly the accepted-but-unacknowledged raw transaction.
    let restored = Main.Init(env);
    loseBroadcast := false;
    assert ok(await* restored.evm_wallet_status_v1({ identity = first; refresh = true })).status == "submitted";
    assert broadcasts.size() == 2 and broadcasts[1] == broadcasts[0] and signatures == 1;
    let changed = ok(await* restored.evm_wallet_execute_v1({ identity = second; review_revision = competing.review_revision }));
    assert changed.status == "prepared" and changed.review_revision == 2;
    let ?resolved = changed.prepared_transaction else { assert false; loop {} };
    assert resolved.nonce == "1" and resolved.to == ?txRequest.to and resolved.value == "1";
    assert signatures == 1;
    switch (await* restored.evm_wallet_execute_v1({ identity = second; review_revision = 1 })) { case (#err(_)) {}; case (_) assert false };
    assert ok(await* restored.evm_wallet_execute_v1({ identity = second; review_revision = 2 })).transaction_hash == ?Fixtures.vectors[1].hash;
    assert signatures == 2;
    receiptMode := 1;
    let confirmed = ok(await* restored.evm_wallet_status_v1({ identity = first; refresh = true }));
    assert confirmed.status == "confirmed" and confirmed.finality == ?"finalized" and confirmed.receipt_json != null;
    receiptMode := 0;
    assert ok(await* restored.evm_wallet_status_v1({ identity = first; refresh = true })).status != "confirmed";
    // A dropped original must never be revived after a signed replacement.
    let replaceId = identity("00000000000000000000000000000003");
    let replaceIntent : Memory.Intent = { intent with operation = #replacement({ operation_id = prepared.operation_id; cancel = false; max_fee_per_gas = "200"; max_priority_fee_per_gas = "2" }) };
    let replacement = ok(await* restored.evm_wallet_prepare_v1({ identity = replaceId; intent = replaceIntent }));
    assert replacement.status == "prepared";
    let ?replacementTx = replacement.prepared_transaction else { assert false; loop {} };
    assert replacementTx.to == ?txRequest.to and replacementTx.value == "1" and replacementTx.data == "0x" and replacementTx.nonce == "0";
    let replacementSent = ok(await* restored.evm_wallet_execute_v1({ identity = replaceId; review_revision = replacement.review_revision }));
    assert replacementSent.transaction_hash == ?Fixtures.vectors[3].hash;
    let proof = ok(restored.evm_wallet_replacement_transaction_v1({
      chain_id = 1; transaction_hash = Fixtures.vectors[3].hash;
      original_wallet_request = { caller_app_id = "consumer"; caller_installation_uid = 10; request_id = first.request_id };
    }));
    assert proof.wallet_replacement_matches and proof.source == "evm_wallet_journal";
    let originalBinding = ok(await* restored.evm_wallet_transaction_v1({ chain_id = 1; transaction_hash = Fixtures.vectors[3].hash; wallet_request = ?{ caller_app_id = "consumer"; caller_installation_uid = 10; request_id = first.request_id } }));
    assert originalBinding.wallet_request_matches == ?false;
    let cancelId = identity("00000000000000000000000000000009");
    let cancel = ok(await* restored.evm_wallet_prepare_v1({ identity = cancelId; intent = { intent with operation = #replacement({ operation_id = replacement.operation_id; cancel = true; max_fee_per_gas = "300"; max_priority_fee_per_gas = "2" }) } }));
    let ?cancelTx = cancel.prepared_transaction else { assert false; loop {} };
    assert cancelTx.to == ?prepared.address and cancelTx.value == "0" and cancelTx.data == "0x" and cancelTx.nonce == "0";
    assert ok(restored.evm_wallet_reject_v1({ identity = cancelId })).status == "rejected";
    let sentBefore = broadcasts.size();
    let superseded = ok(await* restored.evm_wallet_status_v1({ identity = first; refresh = true }));
    assert superseded.status == "unknown" and superseded.replacement_hash == replacementSent.transaction_hash;
    assert broadcasts.size() == sentBefore;
    receiptMode := 1; expectedHash := Fixtures.vectors[3].hash;
    let replaced = ok(await* restored.evm_wallet_status_v1({ identity = first; refresh = true }));
    assert replaced.status == "replaced" and replaced.replacement_hash == ?expectedHash and replaced.receipt_json == null;
    assert broadcasts.size() == sentBefore;
    // Personal signature unknown outcomes cannot trigger a second signer call.
    let messageId = identity("00000000000000000000000000000004");
    let messageIntent : Memory.Intent = { intent with operation = #personal_message({ message = "0x6869" }) };
    let message = ok(await* restored.evm_wallet_prepare_v1({ identity = messageId; intent = messageIntent }));
    signerError := ?#outcome_unknown;
    assert ok(await* restored.evm_wallet_execute_v1({ identity = messageId; review_revision = message.review_revision })).status == "unknown";
    let attemptsBefore = signAttempts;
    signerError := null;
    assert ok(await* restored.evm_wallet_execute_v1({ identity = messageId; review_revision = message.review_revision })).status == "unknown";
    assert signAttempts == attemptsBefore;
    let signedId = identity("00000000000000000000000000000005");
    let toSign = ok(await* restored.evm_wallet_prepare_v1({ identity = signedId; intent = messageIntent }));
    let signed = ok(await* restored.evm_wallet_execute_v1({ identity = signedId; review_revision = toSign.review_revision }));
    assert signed.status == "signed" and signed.signature != null and signed.transaction_hash == null;
    let rejectId = identity("00000000000000000000000000000006");
    let toReject = ok(await* restored.evm_wallet_prepare_v1({ identity = rejectId; intent }));
    assert ok(restored.evm_wallet_reject_v1({ identity = rejectId })).status == "rejected";
    assert ok(await* restored.evm_wallet_execute_v1({ identity = rejectId; review_revision = toReject.review_revision })).status == "rejected";
    assert ok(restored.evm_wallet_snapshot_v1(())).networks.size() == 3;
    let balance = ok(await* restored.evm_wallet_balances_v1({ account_id = "main"; chain_id = 1; tokens = [] }));
    assert balance.native_balance == "1000000000000000000" and balance.block_number == "0x64";
    let read = ok(await* restored.evm_wallet_read_contract_v1({ chain_id = 1; to = txRequest.to; data = "0x"; block = "latest" }));
    assert read.code == "0x6000" and read.result == "0x" and read.block_number == "0x64";
    // The account address is shared, while nonce spaces and signed chain IDs
    // stay separate. Arbitrum gas estimate is used once, without L1 double add.
    let arbId = identity("00000000000000000000000000000007");
    let arb = ok(await* restored.evm_wallet_prepare_v1({ identity = arbId; intent = { intent with chain_id = 42161 } }));
    let ?arbTx = arb.prepared_transaction else { assert false; loop {} };
    assert arbTx.nonce == "0" and arbTx.gas_limit == "21000" and arb.address == prepared.address;
    assert ok(await* restored.evm_wallet_execute_v1({ identity = arbId; review_revision = arb.review_revision })).transaction_hash == ?Fixtures.vectors[2].hash;
    receiptMode := 2; expectedHash := Fixtures.vectors[2].hash;
    assert ok(await* restored.evm_wallet_status_v1({ identity = arbId; refresh = true })).status == "reverted";
    let legacyId = identity("00000000000000000000000000000008");
    let legacy = ok(await* restored.evm_wallet_prepare_v1({ identity = legacyId; intent = { intent with chain_id = 11155111; operation = #transaction({ txRequest with transaction_type = ?"legacy"; max_fee_per_gas = null; max_priority_fee_per_gas = null }) } }));
    let ?legacyTx = legacy.prepared_transaction else { assert false; loop {} };
    assert legacyTx.transaction_type == "legacy" and legacyTx.gas_price == ?"100";
    assert ok(await* restored.evm_wallet_execute_v1({ identity = legacyId; review_revision = legacy.review_revision })).transaction_hash == ?Fixtures.vectors[5].hash;
    let beforeEstimation = (Map.size(mem.commands), Map.size(mem.nonce_next), signAttempts, broadcasts.size());
    let estimate = ok(await* restored.evm_wallet_estimate_transaction_v1({ chain_id = 1; to = txRequest.to; value = "0"; data = "0x" }));
    assert estimate.status == "available" and estimate.estimated_fee == ?"1071000" and estimate.max_fee == ?"2100000";
    assert estimate.from == prepared.address and estimate.block_number == ?"100";
    assert beforeEstimation == (Map.size(mem.commands), Map.size(mem.nonce_next), signAttempts, broadcasts.size());

    // Exact ERC20 approval signing with independently generated viem/noble
    // bytes. Evidence refresh changes the displayed facts/revision only.
    let approveMem = Memory.init();
    let evidenceMem = EvidenceMemory.init();
    var approveSigns = 0;
    var approveBroadcasts = 0;
    var observedAllowance = 7;
    func approveCall(request : Caps.BackendCallRequestV1) : async* Caps.BackendCallResultV1 {
      if (request.method == "request") {
        let ?(_, payload, _) : ?(RpcTypes.RpcService, Text, Nat64) = from_candid(request.args) else { assert false; loop {} };
        let body = ok(Json.parse(payload));
        if (Json.field(body, "method") == ?#string("eth_call")) {
          let ?#array(params) = Json.field(body, "params") else { assert false; loop {} };
          let ?#string(data) = Json.field(params[0], "data") else { assert false; loop {} };
          if (Text.startsWith(data, #text("0x70a08231")) or Text.startsWith(data, #text("0xdd62ed3e"))) {
            assert params[1] == #string("0x64");
            let value = if (Text.startsWith(data, #text("0x70a08231"))) 500 else observedAllowance;
            let response : RpcTypes.RequestResult = #Ok("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":" # Json.quote(Hex.encode(ok(Hex.word(value)))) # "}");
            return #ok(to_candid(response));
          };
        };
      };
      if (request.method == "eth_sendRawTransaction") {
        let ?(_, _, raw) : ?(RpcTypes.RpcServices, ?RpcTypes.RpcConfig, Text) = from_candid(request.args) else { assert false; loop {} };
        assert raw == ERC20.approveRaw;
        let ?saved = Journal.Store(approveMem).find(identity("0000000000000000000000000000000a")) else { assert false; loop {} };
        assert saved.transaction_hash == ?ERC20.approveHash and saved.signed_raw == ?ok(Hex.decode(ERC20.approveRaw));
        approveBroadcasts += 1;
        let result : RpcTypes.MultiSendRawTransactionResult = #Consistent(#Ok(#Ok(null)));
        return #ok(to_candid(result));
      };
      await* performCall(request);
    };
    let approveCaps : Caps.BackendCallsV1 = {
      calls with call = approveCall;
      call_batch = func(requests : [Caps.BackendCallRequestV1]) : async* [Caps.BackendCallResultV1] {
        var replies : [Caps.BackendCallResultV1] = [];
        for (request in requests.vals()) replies := Array.concat(replies, [await* approveCall(request)]);
        replies;
      };
    };
    let approveSigner : Caps.WalletCustodySigningV1 = {
      signing with sign_digest = func(request : Caps.WalletCustodySignDigestRequestV1) : async* Caps.WalletCustodySignatureResultV1 {
        assert Hex.encode(request.digest) == ERC20.approveDigest;
        approveSigns += 1;
        #ok({ slot = request.slot; algorithm = #ecdsa_secp256k1; digest = request.digest; signature = ok(Hex.decode(ERC20.approveSignature)) });
      };
    };
    let approveEnv : Main.AppBackendEnvironment = {
      stable_memory = { evm_wallet = approveMem; evm_evidence = evidenceMem };
      capabilities = { backend_calls = approveCaps; wallet_custody_signing = approveSigner };
    };
    let approveService = Main.Init(approveEnv);
    let approveId = identity("0000000000000000000000000000000a");
    let approveIntent : Memory.Intent = { intent with operation = #transaction({ txRequest with data = ERC20.approveData; value = "0" }) };
    let approvePrepared = ok(await* approveService.evm_wallet_prepare_v1({ identity = approveId; intent = approveIntent }));
    assert approvePrepared.status == "prepared";
    let captured = ok(await* approveService.evm_wallet_review_evidence_v1({ identity = approveId; review_revision = approvePrepared.review_revision; refresh = false }));
    let ?firstEvidence = captured.token_evidence else { assert false; loop {} };
    assert firstEvidence.method == "approve" and firstEvidence.amount == "100";
    assert firstEvidence.balance.value == ?"500" and firstEvidence.allowance == ?{ value = ?"7"; error = null };
    assert firstEvidence.block_number == ?"0x64" and firstEvidence.block_hash == ?blockHash;
    observedAllowance := 21;
    let refreshed = ok(await* approveService.evm_wallet_review_evidence_v1({ identity = approveId; review_revision = approvePrepared.review_revision; refresh = true }));
    assert refreshed.operation.review_revision == approvePrepared.review_revision + 1;
    assert refreshed.operation.prepared_transaction == approvePrepared.prepared_transaction;
    let ?newEvidence = refreshed.token_evidence else { assert false; loop {} };
    assert newEvidence.allowance == ?{ value = ?"21"; error = null };
    switch (await* approveService.evm_wallet_execute_v1({ identity = approveId; review_revision = approvePrepared.review_revision })) { case (#err(_)) {}; case (_) assert false };
    assert approveSigns == 0 and approveBroadcasts == 0;
    let approveRestored = Main.Init(approveEnv);
    let restoredReview = ok(await* approveRestored.evm_wallet_review_evidence_v1({ identity = approveId; review_revision = refreshed.operation.review_revision; refresh = false }));
    assert restoredReview.token_evidence == ?newEvidence;
    let approved = ok(await* approveRestored.evm_wallet_execute_v1({ identity = approveId; review_revision = refreshed.operation.review_revision }));
    assert approved.transaction_hash == ?ERC20.approveHash and approveSigns == 1 and approveBroadcasts == 1;
    "Backend journal, signing, exact recovery, replacement, fee estimation and ERC20 review tests passed";
  };
};
