import DecoderMemory "../backend/memory/evm_decoders/v1";
import Runtime "mo:core/Runtime";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Text "mo:core/Text";
import Caps "mo:neutron-capabilities";
import Main "../backend/main";
import Memory "../backend/memory/evm_wallet/v1";
import EvidenceMemory "../backend/memory/evm_evidence/v1";
import Types "../backend/Types";
import Journal "../backend/Journal";
import Hex "../backend/evm/Hex";
import Fixtures "BackendFixtures";

persistent actor {
  public func run() : async Text {
    func ok<T>(value : Types.Result<T>) : T {
      switch (value) { case (#ok(value)) value; case (#err(error)) { Runtime.trap(error) } };
    };
    // Actual approval fixture: setting a zero allowance needs 44,322 gas,
    // while the same write after the pending original needs only 24,437.
    // Browser-client tests check that estimation and simulation use one mined
    // block; this actor verifies the journal accepts that exact observation and
    // cannot sign a lower reviewed gas limit or alter the pending original.
    let token = "0x067c804bb006836469379d4a2a69a81803bd1f45";
    let approval = "0x095ea7b3000000000000000000000000eb4f9946985f6d0b1d28481b8f5b1543d85011fe0000000000000000000000000000000000000000000000006124fee993bc0000";
    var signatures = 0;
    for (chain in [1, 42161].vals()) {
      let mem = Memory.init();
      let store = Journal.Store(mem);
      func identity(id : Text) : Memory.Identity = { caller = { app_id = "consumer"; installation_uid = 10; endpoint = "tile" }; request_id = id };
      let originalIdentity = identity("00000000000000000000000000000001");
      let txRequest : Memory.TransactionRequest = { to = token; value = "0"; data = approval; gas_limit = null; max_fee_per_gas = ?"1000000014"; max_priority_fee_per_gas = ?"1000000000"; gas_price = null; transaction_type = ?"eip1559"; access_list = [] };
      let intent : Memory.Intent = { account_id = "main"; chain_id = chain; operation = #transaction(txRequest) };
      let original = ok(store.start({ identity = originalIdentity; intent }, 1));
      original.transaction := ?{ chainId = chain; nonce = 8; gasLimit = 44_322; to = ?token; value = 0; data = ok(Hex.decode(approval)); accessList = []; fee = #eip1559({ maxFeePerGas = 1_000_000_014; maxPriorityFeePerGas = 1_000_000_000 }) };
      original.status := "submitted";
      original.reserved_nonce := true;
      // Retained bytes are opaque here; independent vectors in the backend
      // execution test verify actual signing and transaction hashes.
      original.signed_raw := ?ok(Hex.decode(Fixtures.vectors[0].raw));
      original.transaction_hash := ?Fixtures.vectors[0].hash;
      let retained = (original.transaction, original.signed_raw, original.transaction_hash, original.reserved_nonce);
      let signing : Caps.WalletCustodySigningV1 = {
        public_key = func(slot : Text) : async* Caps.WalletCustodyPublicKeyResultV1 {
          #ok({ slot; algorithm = #ecdsa_secp256k1; public_key = ok(Hex.decode(Fixtures.publicKey)); key_fingerprint = "fixture"; namespace_version = 1 });
        };
        sign_digest = func(_ : Caps.WalletCustodySignDigestRequestV1) : async* Caps.WalletCustodySignatureResultV1 { signatures += 1; assert false; #err(#invalid_request) };
      };
      let service = Main.Init({ stable_memory = { evm_wallet = mem; evm_evidence = EvidenceMemory.init(); evm_decoders = DecoderMemory.init() }; capabilities = { wallet_custody_signing = signing } });
      let observation = { block_number = "0x9b1d"; balance = "1000000000000000000"; pending_nonce = "9"; mined_nonce = "8"; gas_price = "1000000014"; max_priority_fee_per_gas = "1000000000"; base_fee_per_gas = "7" };
      let replacementRequest : Main.WalletPrepareRequest = { identity = identity("00000000000000000000000000000002"); intent = { intent with operation = #replacement({ operation_id = original.id; cancel = false; max_fee_per_gas = "2000000029"; max_priority_fee_per_gas = "2000000001" }) } };
      let candidate = ok(await* service.evm_wallet_prepare_browser_v1({ request = replacementRequest; observation }));
      assert candidate.status == "preparing";
      let ?candidateTx = candidate.prepared_transaction else { assert false; loop {} };
      assert candidateTx.nonce == "8" and candidateTx.to == ?token and candidateTx.data == approval;
      let lower = service.evm_wallet_finish_prepare_browser_v1({ identity = replacementRequest.identity; review_revision = candidate.review_revision; balance = "1000000000000000000"; pending_nonce = "9"; mined_nonce = "8"; gas_estimate = "44322"; gas_limit = "24437"; simulation = Hex.encode(ok(Hex.word(1))) });
      switch (lower) { case (#err(_)) {}; case (#ok(value)) { assert value.status != "prepared" } };
      assert signatures == 0;
      let refreshedCandidate = ok(await* service.evm_wallet_prepare_browser_v1({ request = replacementRequest; observation }));
      let replacement = ok(service.evm_wallet_finish_prepare_browser_v1({ identity = replacementRequest.identity; review_revision = refreshedCandidate.review_revision; balance = "1000000000000000000"; pending_nonce = "9"; mined_nonce = "8"; gas_estimate = "44322"; gas_limit = "53187"; simulation = Hex.encode(ok(Hex.word(1))) }));
      assert replacement.status == "prepared";
      let ?prepared = replacement.prepared_transaction else { assert false; loop {} };
      assert prepared.gas_limit == "53187" and prepared.nonce == "8";
      assert prepared.to == ?token and prepared.data == approval;
      assert prepared.max_fee_per_gas == ?"2000000029" and prepared.max_priority_fee_per_gas == ?"2000000001";
      assert signatures == 0;
      assert retained == (original.transaction, original.signed_raw, original.transaction_hash, original.reserved_nonce);
      assert (ok(await* service.evm_wallet_prepare_browser_v1({ request = replacementRequest; observation }))).operation_id == replacement.operation_id;
      assert Map.size(mem.commands) == 2;
      // A browser observation that the original nonce is already mined rejects
      // a fresh replacement before its payload can become approvable.
      let minedRequest = { replacementRequest with identity = identity("00000000000000000000000000000003") };
      let mined = await* service.evm_wallet_prepare_browser_v1({ request = minedRequest; observation = { observation with mined_nonce = "9" } });
      switch (mined) { case (#err(_)) {}; case (#ok(value)) { assert value.status != "prepared" and value.status != "preparing" } };
      assert retained == (original.transaction, original.signed_raw, original.transaction_hash, original.reserved_nonce);
      // A nonce mined after candidate construction forces a new simulation;
      // it cannot pass through the earlier review with stale browser facts.
      let freshRequest : Main.WalletPrepareRequest = { identity = identity("00000000000000000000000000000004"); intent };
      let fresh = ok(await* service.evm_wallet_prepare_browser_v1({ request = freshRequest; observation }));
      let ?freshTx = fresh.prepared_transaction else { assert false; loop {} };
      assert freshTx.nonce == "9";
      let updated = ok(service.evm_wallet_finish_prepare_browser_v1({ identity = freshRequest.identity; review_revision = fresh.review_revision; balance = "1000000000000000000"; pending_nonce = "10"; mined_nonce = "10"; gas_estimate = "44322"; gas_limit = "53187"; simulation = "0x" }));
      assert updated.status == "preparing" and updated.review_revision == fresh.review_revision + 1;
      let ?updatedTx = updated.prepared_transaction else { assert false; loop {} };
      assert updatedTx.nonce == "10";
      switch (service.evm_wallet_finish_prepare_browser_v1({ identity = freshRequest.identity; review_revision = updated.review_revision; balance = "0"; pending_nonce = "10"; mined_nonce = "10"; gas_estimate = "44322"; gas_limit = "53187"; simulation = "0x" })) { case (#err(_)) {}; case (_) assert false };
      let finalReview = ok(service.evm_wallet_finish_prepare_browser_v1({ identity = freshRequest.identity; review_revision = updated.review_revision; balance = "1000000000000000000"; pending_nonce = "10"; mined_nonce = "10"; gas_estimate = "44322"; gas_limit = "53187"; simulation = "0x" }));
      assert finalReview.status == "prepared";
      assert signatures == 0;
    };
    "Browser-prepared pending approvals retain the original nonce and bytes and reject insufficient gas limits on Ethereum and Arbitrum";
  };
};
