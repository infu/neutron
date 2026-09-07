import Runtime "mo:core/Runtime";
import Map "mo:core/Map";
import Caps "mo:neutron-capabilities";
import Main "../backend/main";
import Memory "../backend/memory/evm_wallet/v1";
import EvidenceMemory "../backend/memory/evm_evidence/v1";
import DecoderMemory "../backend/memory/evm_decoders/v1";
import Types "../backend/Types";
import Journal "../backend/Journal";
import Hex "../backend/evm/Hex";
import Fixtures "BackendFixtures";

persistent actor {
  public func run() : async Text {
    func ok<T>(result : Types.Result<T>) : T {
      switch (result) { case (#ok(value)) value; case (#err(error)) Runtime.trap(error) };
    };
    let mem = Memory.init();
    var signatures = 0;
    let signing : Caps.WalletCustodySigningV1 = {
      public_key = func(slot : Text) : async* Caps.WalletCustodyPublicKeyResultV1 {
        #ok({ slot; algorithm = #ecdsa_secp256k1; public_key = ok(Hex.decode(Fixtures.publicKey)); key_fingerprint = "fixture"; namespace_version = 1 });
      };
      sign_digest = func(_ : Caps.WalletCustodySignDigestRequestV1) : async* Caps.WalletCustodySignatureResultV1 {
        signatures += 1; Runtime.trap("Preparation must never sign");
      };
    };
    let env : Main.AppBackendEnvironment = { stable_memory = { evm_wallet = mem; evm_evidence = EvidenceMemory.init(); evm_decoders = DecoderMemory.init() }; capabilities = { wallet_custody_signing = signing } };
    let service = Main.Init(env);
    func identity(id : Text) : Memory.Identity = { caller = { app_id = "aave"; installation_uid = 10; endpoint = "background" }; request_id = id };
    let txRequest : Memory.TransactionRequest = { to = "0x0000000000000000000000000000000000000002"; value = "7"; data = "0x12345678"; gas_limit = null; max_fee_per_gas = null; max_priority_fee_per_gas = null; gas_price = null; transaction_type = null; access_list = [] };
    let intent : Memory.Intent = { account_id = "main"; chain_id = 1; operation = #transaction(txRequest) };
    let request : Main.WalletPrepareRequest = { identity = identity("00000000000000000000000000000001"); intent };
    let old = { block_number = "0x64"; balance = "1000000000000000000"; pending_nonce = "0"; mined_nonce = "0"; gas_price = "3"; max_priority_fee_per_gas = "1"; base_fee_per_gas = "1" };
    let fresh = { old with block_number = "0x65"; gas_price = "103"; max_priority_fee_per_gas = "3"; base_fee_per_gas = "100" };
    let first = ok(await* service.evm_wallet_prepare_browser_v1({ request; observation = old }));
    let ?firstTx = first.prepared_transaction else Runtime.trap("Initial candidate missing");
    assert first.status == "preparing" and firstTx.max_fee_per_gas == ?"3";
    // A concurrent matching retry must not invalidate the first browser's
    // in-flight simulation when the actual candidate has not changed.
    let matching = ok(await* service.evm_wallet_prepare_browser_v1({ request; observation = old }));
    assert matching.review_revision == first.review_revision;
    assert matching.prepared_transaction == first.prepared_transaction and matching.review == first.review;

    // Simulate a reload after candidate persistence but before gas estimation.
    // The current base fee is now greater than the candidate's old maximum;
    // keeping that maximum would make every retry fail RPC simulation.
    let restored = Main.Init(env);
    let refreshed = ok(await* restored.evm_wallet_prepare_browser_v1({ request; observation = fresh }));
    let ?refreshedTx = refreshed.prepared_transaction else Runtime.trap("Refreshed candidate missing");
    if (refreshedTx.max_fee_per_gas != ?"203") Runtime.trap("The refreshed unsigned candidate still has its old fee maximum instead of the current 203");
    assert refreshedTx.max_priority_fee_per_gas == ?"3";
    assert refreshedTx.to == firstTx.to and refreshedTx.value == firstTx.value and refreshedTx.data == firstTx.data;
    assert refreshed.operation_id == first.operation_id and refreshed.request_id == first.request_id;
    assert refreshed.review_revision == first.review_revision + 1 and refreshed.status == "preparing";
    assert refreshedTx.gas_limit == "0";
    let matchingRefresh = ok(await* restored.evm_wallet_prepare_browser_v1({ request; observation = fresh }));
    assert matchingRefresh.review_revision == refreshed.review_revision and matchingRefresh.prepared_transaction == refreshed.prepared_transaction;
    func finish(revision : Nat) : Main.WalletOperationResult {
      restored.evm_wallet_finish_prepare_browser_v1({ identity = request.identity; review_revision = revision; balance = fresh.balance; pending_nonce = "0"; mined_nonce = "0"; gas_estimate = "25000"; gas_limit = "25000"; simulation = "0x" });
    };
    switch (finish(first.review_revision)) { case (#err(_)) {}; case (_) Runtime.trap("Stale simulation completed a refreshed candidate") };
    let prepared = ok(finish(refreshed.review_revision));
    assert prepared.status == "prepared";
    let replay = ok(await* restored.evm_wallet_prepare_browser_v1({ request; observation = old }));
    assert replay.review_revision == prepared.review_revision and replay.prepared_transaction == prepared.prepared_transaction;

    // Explicit fee choices remain part of the immutable request on recovery.
    let explicitRequest = { request with identity = identity("00000000000000000000000000000002"); intent = { intent with operation = #transaction({ txRequest with gas_limit = ?"30000"; max_fee_per_gas = ?"500"; max_priority_fee_per_gas = ?"4" }) } };
    let explicit = ok(await* restored.evm_wallet_prepare_browser_v1({ request = explicitRequest; observation = old }));
    let explicitRefreshed = ok(await* restored.evm_wallet_prepare_browser_v1({ request = explicitRequest; observation = fresh }));
    let ?explicitTx = explicitRefreshed.prepared_transaction else Runtime.trap("Explicit candidate missing");
    assert explicitTx.max_fee_per_gas == ?"500" and explicitTx.max_priority_fee_per_gas == ?"4" and explicitTx.gas_limit == "30000";
    assert explicitRefreshed.operation_id == explicit.operation_id;
    let legacyRequest = { request with identity = identity("00000000000000000000000000000003"); intent = { intent with operation = #transaction({ txRequest with transaction_type = ?"legacy" }) } };
    ignore ok(await* restored.evm_wallet_prepare_browser_v1({ request = legacyRequest; observation = old }));
    let legacy = ok(await* restored.evm_wallet_prepare_browser_v1({ request = legacyRequest; observation = fresh }));
    let ?legacyTx = legacy.prepared_transaction else Runtime.trap("Legacy candidate missing");
    assert legacyTx.gas_price == ?"103";

    // A released root can also retain a preparing request with no candidate.
    // A compatible restore must recover that exact request using fresh facts.
    let interruptedRequest = { request with identity = identity("00000000000000000000000000000004") };
    let interrupted = ok(Journal.Store(mem).start(interruptedRequest, 1));
    assert interrupted.transaction == null and interrupted.status == "preparing";
    let recovered = ok(await* restored.evm_wallet_prepare_browser_v1({ request = interruptedRequest; observation = fresh }));
    let ?recoveredTx = recovered.prepared_transaction else Runtime.trap("Interrupted candidate missing");
    assert recovered.operation_id == interrupted.id and recoveredTx.max_fee_per_gas == ?"203";
    assert Map.size(mem.commands) == 4 and signatures == 0;
    "Preparing transactions refresh implicit fees after reload, retain exact requests and explicit fees, and invalidate stale simulations without signing";
  };
};
