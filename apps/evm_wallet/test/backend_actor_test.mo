import Array "mo:core/Array";
import Runtime "mo:core/Runtime";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Text "mo:core/Text";
import Caps "mo:neutron-capabilities";
import Main "../backend/main";
import Memory "../backend/memory/evm_wallet/v1";
import EvidenceMemory "../backend/memory/evm_evidence/v1";
import Types "../backend/Types";
import Hex "../backend/evm/Hex";
import Json "../backend/rpc/Json";
import Fixtures "BackendFixtures";
import ERC20 "ERC20Fixtures";

persistent actor {
  public func run() : async Text {
    func ok<T>(result : Types.Result<T>) : T {
      switch (result) { case (#ok(v)) v; case (#err(e)) { Runtime.trap(e) } };
    };
    let mem = Memory.init();
    var signAttempts = 0;
    var signatures = 0;
    var signerError : ?Caps.ChainKeySigningErrorV1 = null;
    let blockHash = "0x" # Text.join(Array.repeat<Text>("ab", 32).vals(), "");
    let block = "{\"number\":\"0x64\",\"hash\":" # Json.quote(blockHash) # "}";
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
    // There is deliberately no backend_calls capability. The production
    // backend can prepare, sign and reconcile with browser observations only.
    let env : Main.AppBackendEnvironment = { stable_memory = { evm_wallet = mem; evm_evidence = EvidenceMemory.init() }; capabilities = { wallet_custody_signing = signing } };
    let service = Main.Init(env);
    func identity(id : Text) : Memory.Identity = { caller = { app_id = "consumer"; installation_uid = 10; endpoint = "tile" }; request_id = id };
    let observation = {
      block_number = "0x64"; balance = "1000000000000000000";
      pending_nonce = "0"; mined_nonce = "0"; gas_price = "100";
      max_priority_fee_per_gas = "2"; base_fee_per_gas = "49";
    };
    func prepare(wallet : Main.Init, request : Main.WalletPrepareRequest) : async* Main.WalletOperation {
      let candidate = ok(await* wallet.evm_wallet_prepare_browser_v1({ request; observation }));
      if (candidate.status != "preparing") return candidate;
      ok(wallet.evm_wallet_finish_prepare_browser_v1({ identity = request.identity; review_revision = candidate.review_revision; balance = "1000000000000000000"; pending_nonce = "0"; mined_nonce = "0"; gas_estimate = "21000"; gas_limit = "21000"; simulation = "0x" }));
    };
    func observe(wallet : Main.Init, identity : Memory.Identity, hash : Text, included : Bool, reverted : Bool, error : ?Text) : async* Main.WalletOperation {
      let receipt = "{\"transactionHash\":" # Json.quote(hash) # ",\"blockNumber\":\"0x64\",\"blockHash\":" # Json.quote(blockHash) # ",\"status\":" # (if (reverted) "\"0x0\"" else "\"0x1\"") # ",\"gasUsed\":\"0x5208\",\"effectiveGasPrice\":\"0x64\",\"logs\":[]}";
      ok(wallet.evm_wallet_observe_browser_v1({
        identity; transaction_hash = hash;
        transaction_json = if (error != null) "null" else "{\"hash\":" # Json.quote(hash) # "}";
        receipt_json = if (included) ?receipt else null;
        canonical_block_json = if (included) ?block else null;
        safe_block_json = if (included) ?block else null;
        finalized_block_json = if (included) ?block else null;
        broadcast_error = error;
      }));
    };
    let first = identity("00000000000000000000000000000001");
    let second = identity("00000000000000000000000000000002");
    let txRequest : Memory.TransactionRequest = { to = "0x0000000000000000000000000000000000000002"; value = "1"; data = "0x"; gas_limit = null; max_fee_per_gas = ?"100"; max_priority_fee_per_gas = ?"2"; gas_price = null; transaction_type = ?"eip1559"; access_list = [] };
    let intent : Memory.Intent = { account_id = "main"; chain_id = 1; operation = #transaction(txRequest) };
    let prepared = await* prepare(service, { identity = first; intent });
    assert prepared.status == "prepared" and prepared.address == "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";
    assert (await* prepare(service, { identity = first; intent })).operation_id == prepared.operation_id;
    switch (await* service.evm_wallet_prepare_browser_v1({ request = { identity = first; intent = { intent with chain_id = 42161 } }; observation })) { case (#err(_)) {}; case (_) assert false };
    // Concurrent preparations cannot each silently sign the same nonce.
    let competing = await* prepare(service, { identity = second; intent });
    signerError := ?#busy;
    assert ok(await* service.evm_wallet_execute_v1({ identity = first; review_revision = prepared.review_revision })).status == "prepared";
    signerError := ?#low_cycles;
    assert ok(await* service.evm_wallet_execute_v1({ identity = first; review_revision = prepared.review_revision })).status == "prepared";
    assert signatures == 0;
    signerError := null;
    let signed = ok(await* service.evm_wallet_execute_v1({ identity = first; review_revision = prepared.review_revision }));
    assert signed.status == "signed" and signed.transaction_hash == ?Fixtures.vectors[0].hash;
    let submission = ok(service.evm_wallet_submission_v1({ identity = first }));
    assert submission.raw_transaction == Fixtures.vectors[0].raw and submission.transaction_hash == Fixtures.vectors[0].hash and submission.chain_id == 1;
    assert ok(service.evm_wallet_transaction_request_matches_v1({ chain_id = 1; transaction_hash = Fixtures.vectors[0].hash; wallet_request = { caller_app_id = "consumer"; caller_installation_uid = 10; request_id = first.request_id } }));
    assert not ok(service.evm_wallet_transaction_request_matches_v1({ chain_id = 1; transaction_hash = Fixtures.vectors[0].hash; wallet_request = { caller_app_id = "consumer"; caller_installation_uid = 11; request_id = first.request_id } }));
    assert not ok(service.evm_wallet_transaction_request_matches_v1({ chain_id = 1; transaction_hash = Fixtures.vectors[0].hash; wallet_request = { caller_app_id = "consumer"; caller_installation_uid = 10; request_id = second.request_id } }));
    let unknown = await* observe(service, first, Fixtures.vectors[0].hash, false, false, ?"accepted remotely; response lost");
    assert unknown.status == "unknown" and unknown.transaction_hash == signed.transaction_hash;
    assert ok(await* service.evm_wallet_execute_v1({ identity = first; review_revision = prepared.review_revision })).status == "unknown";
    assert signatures == 1;
    // Reload restores the exact signed bytes even after a lost broadcast reply.
    // A status read cannot sign or broadcast; the browser may resend only this
    // retained payload, whose independently generated hash is already durable.
    let restored = Main.Init(env);
    assert ok(await* restored.evm_wallet_status_v1({ identity = first; refresh = true })).status == "unknown";
    assert ok(restored.evm_wallet_submission_v1({ identity = first })) == submission;
    assert signatures == 1;
    assert (await* observe(restored, first, Fixtures.vectors[0].hash, false, false, null)).status == "submitted";
    let changed = ok(await* restored.evm_wallet_execute_v1({ identity = second; review_revision = competing.review_revision }));
    assert changed.status == "preparing" and changed.review_revision == competing.review_revision + 1;
    let ?resolved = changed.prepared_transaction else { assert false; loop {} };
    assert resolved.nonce == "1" and resolved.to == ?txRequest.to and resolved.value == "1";
    assert signatures == 1;
    let resimulated = ok(restored.evm_wallet_finish_prepare_browser_v1({ identity = second; review_revision = changed.review_revision; balance = "1000000000000000000"; pending_nonce = "0"; mined_nonce = "0"; gas_estimate = "21000"; gas_limit = "21000"; simulation = "0x" }));
    assert resimulated.status == "prepared" and resimulated.review_revision == changed.review_revision + 1;
    switch (await* restored.evm_wallet_execute_v1({ identity = second; review_revision = competing.review_revision })) { case (#err(_)) {}; case (_) assert false };
    assert ok(await* restored.evm_wallet_execute_v1({ identity = second; review_revision = resimulated.review_revision })).transaction_hash == ?Fixtures.vectors[1].hash;
    assert signatures == 2;
    let confirmed = await* observe(restored, first, Fixtures.vectors[0].hash, true, false, null);
    assert confirmed.status == "confirmed" and confirmed.finality == ?"finalized" and confirmed.receipt_json != null;
    // A removed receipt invalidates old confirmation, without re-signing.
    assert (await* observe(restored, first, Fixtures.vectors[0].hash, false, false, null)).status != "confirmed";
    let replaceId = identity("00000000000000000000000000000003");
    let replaceIntent : Memory.Intent = { intent with operation = #replacement({ operation_id = prepared.operation_id; cancel = false; max_fee_per_gas = "200"; max_priority_fee_per_gas = "2" }) };
    let replacement = await* prepare(restored, { identity = replaceId; intent = replaceIntent });
    assert replacement.status == "prepared";
    let ?replacementTx = replacement.prepared_transaction else { assert false; loop {} };
    assert replacementTx.to == ?txRequest.to and replacementTx.value == "1" and replacementTx.data == "0x" and replacementTx.nonce == "0";
    let replacementSigned = ok(await* restored.evm_wallet_execute_v1({ identity = replaceId; review_revision = replacement.review_revision }));
    assert replacementSigned.transaction_hash == ?Fixtures.vectors[3].hash;
    let proof = ok(restored.evm_wallet_replacement_transaction_v1({ chain_id = 1; transaction_hash = Fixtures.vectors[3].hash; original_wallet_request = { caller_app_id = "consumer"; caller_installation_uid = 10; request_id = first.request_id } }));
    assert proof.wallet_replacement_matches and proof.source == "evm_wallet_journal";
    assert not ok(restored.evm_wallet_transaction_request_matches_v1({ chain_id = 1; transaction_hash = Fixtures.vectors[3].hash; wallet_request = { caller_app_id = "consumer"; caller_installation_uid = 10; request_id = first.request_id } }));
    let cancelId = identity("00000000000000000000000000000009");
    let cancel = await* prepare(restored, { identity = cancelId; intent = { intent with operation = #replacement({ operation_id = replacement.operation_id; cancel = true; max_fee_per_gas = "300"; max_priority_fee_per_gas = "2" }) } });
    let ?cancelTx = cancel.prepared_transaction else { assert false; loop {} };
    assert cancelTx.to == ?prepared.address and cancelTx.value == "0" and cancelTx.data == "0x" and cancelTx.nonce == "0";
    assert ok(restored.evm_wallet_reject_v1({ identity = cancelId })).status == "rejected";
    ignore await* observe(restored, replaceId, Fixtures.vectors[3].hash, false, false, null);
    let superseded = ok(await* restored.evm_wallet_status_v1({ identity = first; refresh = true }));
    assert superseded.replacement_hash == replacementSigned.transaction_hash;
    ignore await* observe(restored, replaceId, Fixtures.vectors[3].hash, true, false, null);
    let replaced = ok(await* restored.evm_wallet_status_v1({ identity = first; refresh = true }));
    assert replaced.status == "replaced" and replaced.replacement_hash == ?Fixtures.vectors[3].hash and replaced.receipt_json == null;
    // The original can no longer expose a broadcastable submission.
    switch (restored.evm_wallet_submission_v1({ identity = first })) { case (#err(_)) {}; case (_) assert false };
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
    let signedMessage = ok(await* restored.evm_wallet_execute_v1({ identity = signedId; review_revision = toSign.review_revision }));
    assert signedMessage.status == "signed" and signedMessage.signature != null and signedMessage.transaction_hash == null;
    let rejectId = identity("00000000000000000000000000000006");
    let toReject = await* prepare(restored, { identity = rejectId; intent });
    assert ok(restored.evm_wallet_reject_v1({ identity = rejectId })).status == "rejected";
    assert ok(await* restored.evm_wallet_execute_v1({ identity = rejectId; review_revision = toReject.review_revision })).status == "rejected";
    assert ok(restored.evm_wallet_snapshot_v1(())).networks.size() == 3;
    // Legacy RPC endpoints fail promptly instead of falling back to a costly
    // backend outcall. Browser reads are covered in the actual browser client.
    let beforeReads = (Map.size(mem.commands), Map.size(mem.nonce_next), signAttempts);
    switch (await* restored.evm_wallet_balances_v1({ account_id = "main"; chain_id = 1; tokens = [] })) { case (#err(_)) {}; case (_) assert false };
    switch (await* restored.evm_wallet_read_contract_v1({ chain_id = 1; to = txRequest.to; data = "0x"; block = "latest" })) { case (#err(_)) {}; case (_) assert false };
    switch (await* restored.evm_wallet_estimate_transaction_v1({ chain_id = 1; to = txRequest.to; value = "0"; data = "0x" })) { case (#err(_)) {}; case (_) assert false };
    assert beforeReads == (Map.size(mem.commands), Map.size(mem.nonce_next), signAttempts);
    // Shared address, isolated nonce spaces and independently verified chain IDs.
    let arbId = identity("00000000000000000000000000000007");
    let arb = await* prepare(restored, { identity = arbId; intent = { intent with chain_id = 42161 } });
    let ?arbTx = arb.prepared_transaction else { assert false; loop {} };
    assert arbTx.nonce == "0" and arbTx.gas_limit == "21000" and arb.address == prepared.address;
    assert ok(await* restored.evm_wallet_execute_v1({ identity = arbId; review_revision = arb.review_revision })).transaction_hash == ?Fixtures.vectors[2].hash;
    assert (await* observe(restored, arbId, Fixtures.vectors[2].hash, true, true, null)).status == "reverted";
    let legacyId = identity("00000000000000000000000000000008");
    let legacy = await* prepare(restored, { identity = legacyId; intent = { intent with chain_id = 11155111; operation = #transaction({ txRequest with transaction_type = ?"legacy"; max_fee_per_gas = null; max_priority_fee_per_gas = null }) } });
    let ?legacyTx = legacy.prepared_transaction else { assert false; loop {} };
    assert legacyTx.transaction_type == "legacy" and legacyTx.gas_price == ?"100";
    assert ok(await* restored.evm_wallet_execute_v1({ identity = legacyId; review_revision = legacy.review_revision })).transaction_hash == ?Fixtures.vectors[5].hash;

    // Exact ERC20 approval signing with independent viem/noble bytes. Browser
    // evidence refresh changes displayed facts/revision, never approved calldata.
    let approveMem = Memory.init();
    let evidenceMem = EvidenceMemory.init();
    var approveSigns = 0;
    let approveSigner : Caps.WalletCustodySigningV1 = {
      signing with sign_digest = func(request : Caps.WalletCustodySignDigestRequestV1) : async* Caps.WalletCustodySignatureResultV1 {
        assert Hex.encode(request.digest) == ERC20.approveDigest;
        approveSigns += 1;
        #ok({ slot = request.slot; algorithm = #ecdsa_secp256k1; digest = request.digest; signature = ok(Hex.decode(ERC20.approveSignature)) });
      };
    };
    let approveEnv : Main.AppBackendEnvironment = { stable_memory = { evm_wallet = approveMem; evm_evidence = evidenceMem }; capabilities = { wallet_custody_signing = approveSigner } };
    let approveService = Main.Init(approveEnv);
    let approveId = identity("0000000000000000000000000000000a");
    let approveIntent : Memory.Intent = { intent with operation = #transaction({ txRequest with data = ERC20.approveData; value = "0" }) };
    let approvePrepared = await* prepare(approveService, { identity = approveId; intent = approveIntent });
    assert approvePrepared.status == "prepared";
    let evidenceObservation = { block_number = ?"0x64"; block_hash = ?blockHash; block_error = null; balance = { value = ?"500"; error = null }; allowance = ?{ value = ?"7"; error = null } };
    let captured = ok(approveService.evm_wallet_observe_evidence_browser_v1({ identity = approveId; review_revision = approvePrepared.review_revision; observation = evidenceObservation }));
    let ?firstEvidence = captured.token_evidence else { assert false; loop {} };
    assert firstEvidence.method == "approve" and firstEvidence.amount == "100";
    assert firstEvidence.balance.value == ?"500" and firstEvidence.allowance == ?{ value = ?"7"; error = null };
    assert firstEvidence.block_number == ?"0x64" and firstEvidence.block_hash == ?blockHash;
    let refreshed = ok(approveService.evm_wallet_observe_evidence_browser_v1({ identity = approveId; review_revision = captured.operation.review_revision; observation = { evidenceObservation with allowance = ?{ value = ?"21"; error = null } } }));
    assert refreshed.operation.review_revision == captured.operation.review_revision + 1;
    assert refreshed.operation.prepared_transaction == approvePrepared.prepared_transaction;
    let ?newEvidence = refreshed.token_evidence else { assert false; loop {} };
    assert newEvidence.allowance == ?{ value = ?"21"; error = null };
    switch (await* approveService.evm_wallet_execute_v1({ identity = approveId; review_revision = captured.operation.review_revision })) { case (#err(_)) {}; case (_) assert false };
    assert approveSigns == 0;
    let approveRestored = Main.Init(approveEnv);
    let restoredReview = ok(await* approveRestored.evm_wallet_review_evidence_v1({ identity = approveId; review_revision = refreshed.operation.review_revision; refresh = true }));
    assert restoredReview.token_evidence == ?newEvidence;
    assert restoredReview.operation.review_revision == refreshed.operation.review_revision;
    let approved = ok(await* approveRestored.evm_wallet_execute_v1({ identity = approveId; review_revision = refreshed.operation.review_revision }));
    assert approved.status == "signed" and approved.transaction_hash == ?ERC20.approveHash and approveSigns == 1;
    assert ok(approveRestored.evm_wallet_submission_v1({ identity = approveId })).raw_transaction == ERC20.approveRaw;
    "Browser-prepared backend journal, signing, exact recovery, replacements and ERC20 review tests passed without backend RPC capabilities";
  };
};
