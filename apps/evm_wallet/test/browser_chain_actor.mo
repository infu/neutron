import DecoderMemory "../backend/memory/evm_decoders/v1";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
import Caps "mo:neutron-capabilities";
import Main "../backend/main";
import Memory "../backend/memory/evm_wallet/v1";
import EvidenceMemory "../backend/memory/evm_evidence/v1";
import Hex "../backend/evm/Hex";
import Fixtures "BackendFixtures";

// The browser integration runner supplies independently generated signatures
// for the private-key-1 fixture account. All wallet behavior, including nonce
// allocation, durable signing state and retained submission bytes, is Main.
// No backend RPC capability exists in this actor.
persistent actor {
  transient let mem = Memory.init();
  transient let evidenceMem = EvidenceMemory.init();
  transient let signatures = Map.empty<Text, Blob>();
  transient var signatureCount = 0;

  transient let signing : Caps.WalletCustodySigningV1 = {
    public_key = func(slot : Text) : async* Caps.WalletCustodyPublicKeyResultV1 {
      assert slot == "main";
      let publicKey = switch (Hex.decode(Fixtures.publicKey)) {
        case (#ok(value)) value;
        case (#err(error)) Runtime.trap(error);
      };
      #ok({ slot; algorithm = #ecdsa_secp256k1; public_key = publicKey; key_fingerprint = "fixture"; namespace_version = 1 });
    };
    sign_digest = func(request : Caps.WalletCustodySignDigestRequestV1) : async* Caps.WalletCustodySignatureResultV1 {
      assert request.slot == "main";
      var found = false;
      for ((_, command) in Map.entries(mem.commands)) {
        if (command.status == "signing" and command.digest == ?request.digest) {
          found := true;
          switch (command.transaction) {
            case null {};
            case (?transaction) {
              assert command.reserved_nonce;
              let ?review = command.review else Runtime.trap("Signing transaction has no durable review");
              assert review.nonce == Nat.toText(transaction.nonce);
            };
          };
        };
      };
      assert found;
      switch (Map.get(signatures, Text.compare, Hex.encode(request.digest))) {
        case null #err(#invalid_request);
        case (?signature) {
          signatureCount += 1;
          #ok({ slot = request.slot; algorithm = #ecdsa_secp256k1; digest = request.digest; signature });
        };
      };
    };
  };
  transient let env : Main.AppBackendEnvironment = {
    stable_memory = { evm_wallet = mem; evm_evidence = evidenceMem; evm_decoders = DecoderMemory.init() };
    capabilities = { wallet_custody_signing = signing };
  };
  transient var service = Main.Init(env);

  public func fixture_signature(digest : Blob, signature : Blob) : async () {
    assert digest.size() == 32 and signature.size() == 64;
    Map.add(signatures, Text.compare, Hex.encode(digest), signature);
  };
  public query func fixture_signature_count() : async Nat { signatureCount };
  public func fixture_reload() : async () { service := Main.Init(env) };

  // Unit input is one Candid null argument, matching the live app wire API.
  public func evm_wallet_accounts_v1(()) : async Main.WalletAccountsResult {
    await* service.evm_wallet_accounts_v1(());
  };
  public query func evm_wallet_operation_v1(request : Main.WalletIdentityRequest) : async Main.WalletOperationResult {
    service.evm_wallet_operation_v1(request);
  };
  public query func evm_wallet_submission_v1(request : Main.WalletIdentityRequest) : async Main.WalletSubmissionResult {
    service.evm_wallet_submission_v1(request);
  };
  public query func evm_wallet_superseding_v1(request : Main.WalletIdentityRequest) : async Main.WalletSupersedingResult {
    service.evm_wallet_superseding_v1(request);
  };
  public func evm_wallet_prepare_browser_v1(request : Main.WalletPrepareBrowserRequest) : async Main.WalletOperationResult {
    await* service.evm_wallet_prepare_browser_v1(request);
  };
  public func evm_wallet_finish_prepare_browser_v1(request : Main.WalletFinishPrepareBrowserRequest) : async Main.WalletOperationResult {
    service.evm_wallet_finish_prepare_browser_v1(request);
  };
  public func evm_wallet_preparation_error_browser_v1(request : Main.WalletPreparationErrorBrowserRequest) : async Main.WalletOperationResult {
    service.evm_wallet_preparation_error_browser_v1(request);
  };
  public func evm_wallet_execute_v1(request : Main.WalletExecuteRequest) : async Main.WalletOperationResult {
    await* service.evm_wallet_execute_v1(request);
  };
  public func evm_wallet_status_v1(request : Main.WalletStatusRequest) : async Main.WalletOperationResult {
    await* service.evm_wallet_status_v1(request);
  };
  public func evm_wallet_review_evidence_v1(request : Main.WalletEvidenceRequest) : async Main.WalletEvidenceResult {
    await* service.evm_wallet_review_evidence_v1(request);
  };
  public func evm_wallet_observe_evidence_browser_v1(request : Main.WalletObserveEvidenceRequest) : async Main.WalletEvidenceResult {
    service.evm_wallet_observe_evidence_browser_v1(request);
  };
  public func evm_wallet_observe_browser_v1(request : Main.WalletObserveBrowserRequest) : async Main.WalletOperationResult {
    service.evm_wallet_observe_browser_v1(request);
  };
  public query func evm_wallet_history_v1(request : Main.WalletHistoryRequest) : async Main.WalletHistoryResult {
    service.evm_wallet_history_v1(request);
  };
  public query func evm_wallet_snapshot_v1(()) : async Main.WalletSnapshotResult {
    service.evm_wallet_snapshot_v1(());
  };
};
