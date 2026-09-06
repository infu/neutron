import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Error "mo:core/Error";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Nat8 "mo:core/Nat8";
import Set "mo:core/Set";
import Text "mo:core/Text";
import Time "mo:core/Time";
import Caps "mo:neutron-capabilities";
import Config "./Config";
import Journal "./Journal";
import Memory "./memory/evm_wallet/v1";
import EvidenceMemory "./memory/evm_evidence/v1";
import TokenEvidence "./token/Evidence";
import ReplacementProof "./ReplacementProof";
import BrowserObservations "./BrowserObservations";
import Types "./Types";
import Hex "./evm/Hex";
import Personal "./evm/Personal";
import Eip712 "./evm/Eip712";
import Secp256k1 "./evm/Secp256k1";
import Transaction "./evm/Transaction";

module {
  // PUBLIC WIRE TYPES BEGIN
  // The method-schema compiler reads local public aliases. Keep these closed
  // Candid records structurally identical to Types.mo and the v1 memory schema.
  public type WalletAccount = {
    id : Text; slot : Text; address : Text; public_key : Blob;
    key_fingerprint : Blob; namespace_version : Nat;
  };
  public type WalletNetwork = {
    chain_id : Nat; name : Text; native_symbol : Text; explorer_url : Text;
    testnet : Bool; finality_description : Text;
  };
  public type WalletAsset = { chain_id : Nat; address : Text; symbol : Text; decimals : Nat };
  public type WalletCaller = { app_id : Text; installation_uid : Nat64; endpoint : Text };
  public type WalletIdentity = { caller : WalletCaller; request_id : Text };
  public type WalletAccessEntry = { address : Text; storageKeys : [Text] };
  public type WalletTransactionRequest = {
    to : Text; value : Text; data : Text; gas_limit : ?Text;
    max_fee_per_gas : ?Text; max_priority_fee_per_gas : ?Text; gas_price : ?Text;
    transaction_type : ?Text;
    access_list : [WalletAccessEntry];
  };
  public type WalletIntent = {
    account_id : Text; chain_id : Nat;
    operation : {
      #transaction : WalletTransactionRequest;
      #personal_message : { message : Text };
      #typed_data : { json : Text };
      #replacement : {
        operation_id : Nat; cancel : Bool;
        max_fee_per_gas : Text; max_priority_fee_per_gas : Text;
      };
    };
  };
  public type WalletTransaction = {
    chainId : Nat; nonce : Nat; gasLimit : Nat; to : ?Text; value : Nat;
    data : Blob; accessList : [WalletAccessEntry];
    fee : {
      #legacy : { gasPrice : Nat };
      #eip1559 : { maxFeePerGas : Nat; maxPriorityFeePerGas : Nat };
    };
  };
  public type WalletReview = {
    nonce : Text; gas_limit : Text; max_fee_per_gas : ?Text;
    max_priority_fee_per_gas : ?Text; gas_price : ?Text; balance : Text;
    simulation : Text; observed_at : Int;
  };
  public type WalletTokenObservation = { value : ?Text; error : ?Text };
  public type WalletTokenEvidence = {
    chain_id : Nat; contract : Text; method : Text;
    owner : Text; spender : ?Text; recipient : ?Text; amount : Text;
    recognition : Text;
    block_number : ?Text; block_hash : ?Text; block_error : ?Text;
    observed_at : Int; balance : WalletTokenObservation; allowance : ?WalletTokenObservation;
  };
  public type WalletOperation = {
    operation_id : Nat; request_id : Text; account_id : Text; chain_id : Nat;
    caller : WalletCaller;
    kind : Text; status : Text; address : Text; transaction_hash : ?Text;
    signature : ?Text; message : ?Text; review_revision : Nat; review : ?WalletReview;
    replacement_hash : ?Text;
    receipt_json : ?Text; finality : ?Text; created_at : Int; updated_at : Int;
    intent : WalletIntent;
    prepared_transaction : ?{
      to : ?Text; value : Text; data : Text; access_list : [WalletAccessEntry];
      chain_id : Nat; nonce : Text; gas_limit : Text; transaction_type : Text;
      max_fee_per_gas : ?Text; max_priority_fee_per_gas : ?Text; gas_price : ?Text;
    };
  };
  public type WalletSnapshot = {
    accounts : [WalletAccount]; networks : [WalletNetwork]; assets : [WalletAsset];
    lifecycle : Text;
  };
  public type WalletPrepareRequest = { identity : WalletIdentity; intent : WalletIntent };
  public type WalletPreparationObservation = {
    block_number : Text; balance : Text; pending_nonce : Text; mined_nonce : Text;
    gas_price : Text; max_priority_fee_per_gas : Text; base_fee_per_gas : Text;
  };
  public type WalletPrepareBrowserRequest = { request : WalletPrepareRequest; observation : WalletPreparationObservation };
  public type WalletFinishPrepareBrowserRequest = {
    identity : WalletIdentity; review_revision : Nat; balance : Text; pending_nonce : Text; mined_nonce : Text;
    gas_estimate : Text; gas_limit : Text; simulation : Text;
  };
  public type WalletSubmission = { chain_id : Nat; transaction_hash : Text; raw_transaction : Text };
  public type WalletSubmissionResult = { #ok : WalletSubmission; #err : Text };
  public type WalletSupersedingResult = { #ok : ?WalletOperation; #err : Text };
  public type WalletObserveBrowserRequest = {
    identity : WalletIdentity; transaction_hash : Text; transaction_json : Text;
    receipt_json : ?Text; canonical_block_json : ?Text; safe_block_json : ?Text;
    finalized_block_json : ?Text; broadcast_error : ?Text;
  };
  public type WalletObserveEvidenceRequest = {
    identity : WalletIdentity; review_revision : Nat;
    observation : {
      block_number : ?Text; block_hash : ?Text; block_error : ?Text;
      balance : WalletTokenObservation; allowance : ?WalletTokenObservation;
    };
  };
  public type WalletTransactionMatchesRequest = {
    chain_id : Nat; transaction_hash : Text;
    wallet_request : { caller_app_id : Text; caller_installation_uid : Nat64; request_id : Text };
  };
  public type WalletBoolResult = { #ok : Bool; #err : Text };
  public type WalletExecuteRequest = { identity : WalletIdentity; review_revision : Nat };
  public type WalletEvidenceRequest = { identity : WalletIdentity; review_revision : Nat; refresh : Bool };
  public type WalletEvidenceReview = { operation : WalletOperation; token_evidence : ?WalletTokenEvidence };
  public type WalletEvidenceResult = { #ok : WalletEvidenceReview; #err : Text };
  public type WalletStatusRequest = { identity : WalletIdentity; refresh : Bool };
  public type WalletIdentityRequest = { identity : WalletIdentity };
  public type WalletHistoryRequest = { offset : Nat; limit : Nat };
  public type WalletHistory = { operations : [WalletOperation]; total : Nat };
  public type WalletBalanceRequest = { account_id : Text; chain_id : Nat; tokens : [Text] };
  public type WalletTokenBalance = {
    address : Text; balance : ?Text; decimals : ?Nat; symbol : ?Text; error : ?Text;
  };
  public type WalletBalance = {
    account_id : Text; chain_id : Nat; address : Text; native_balance : Text;
    tokens : [WalletTokenBalance]; block_number : Text; observed_at : Int; completeness : Text;
  };
  public type WalletReadRequest = { chain_id : Nat; to : Text; data : Text; block : Text };
  public type WalletReadResult = {
    chain_id : Nat; to : Text; data : Text; result : Text; code : Text;
    block_number : Text; observed_at : Int;
  };
  public type WalletTransactionLookupRequest = {
    chain_id : Nat; transaction_hash : Text;
    wallet_request : ?{ caller_app_id : Text; caller_installation_uid : Nat64; request_id : Text };
  };
  public type WalletTransactionLookup = {
    chain_id : Nat; transaction_hash : Text; transaction_json : Text;
    receipt_json : ?Text; finality : ?Text; observed_at : Int;
    wallet_request_matches : ?Bool;
  };
  public type WalletSnapshotResult = { #ok : WalletSnapshot; #err : Text };
  public type WalletAccountsResult = { #ok : [WalletAccount]; #err : Text };
  public type WalletHistoryResult = { #ok : WalletHistory; #err : Text };
  public type WalletBalanceResult = { #ok : WalletBalance; #err : Text };
  public type WalletReadResultResult = { #ok : WalletReadResult; #err : Text };
  public type WalletTransactionLookupResult = { #ok : WalletTransactionLookup; #err : Text };
  public type WalletOperationResult = { #ok : WalletOperation; #err : Text };
  public type WalletEstimateRequest = { chain_id : Nat; to : Text; value : Text; data : Text };
  public type WalletEstimate = {
    chain_id : Nat; from : Text; to : Text; value : Text; data : Text; status : Text;
    gas_limit : ?Text; gas_price : ?Text; base_fee_per_gas : ?Text;
    max_priority_fee_per_gas : ?Text; max_fee_per_gas : ?Text;
    estimated_fee : ?Text; max_fee : ?Text; block_number : ?Text; observed_at : Int;
    fee_basis : Text; posting_costs : Text; reasons : [Text];
  };
  public type WalletEstimateResult = { #ok : WalletEstimate; #err : Text };
  public type WalletRequestReference = { caller_app_id : Text; caller_installation_uid : Nat64; request_id : Text };
  public type WalletReplacementProofRequest = {
    chain_id : Nat; transaction_hash : Text; original_wallet_request : WalletRequestReference;
  };
  public type WalletReplacementProof = {
    chain_id : Nat; transaction_hash : Text; original_wallet_request : WalletRequestReference;
    wallet_replacement_matches : Bool; observed_at : Int; source : Text;
  };
  public type WalletReplacementProofResult = { #ok : WalletReplacementProof; #err : Text };
  // PUBLIC WIRE TYPES END

  public type AppBackendEnvironment = {
    stable_memory : { evm_wallet : Memory.Mem; evm_evidence : EvidenceMemory.Mem };
    capabilities : {
      wallet_custody_signing : Caps.WalletCustodySigningV1;
    };
  };
  public class Init(env : AppBackendEnvironment) {
    let mem = env.stable_memory.evm_wallet;
    let journal = Journal.Store(mem);
    let evidence = TokenEvidence.Service(env.stable_memory.evm_evidence);
    let signing = env.capabilities.wallet_custody_signing;
    // Only transient invocation locks live outside managed memory. Persisted
    // signing/submission phases are reconciled, never repeated after reload.
    let running = Set.empty<Nat>();
    Config.initialize(mem);

    public func /*query*/evm_wallet_snapshot_v1(()) : WalletSnapshotResult {
      #ok(snapshot());
    };
    public func /*update*/evm_wallet_accounts_v1(()) : async* WalletAccountsResult {
      switch (await* account("main")) { case (#err(e)) #err(e); case (#ok(a)) #ok([a]) };
    };
    public func /*query*/evm_wallet_history_v1(request : WalletHistoryRequest) : WalletHistoryResult {
      #ok(journal.history(request));
    };
    public func /*update*/evm_wallet_asset_set_v1(asset : WalletAsset) : WalletSnapshotResult {
      if (not supported(asset.chain_id)) return #err("Unsupported network");
      let address = switch (validateAddress(asset.address)) { case (#err(e)) return #err(e); case (#ok(a)) a };
      if (asset.decimals > 255) return #err("ERC20 decimals must fit uint8");
      Map.add(mem.assets, Text.compare, Config.assetKey(asset.chain_id, address), { asset with address });
      #ok(snapshot());
    };
    public func /*update*/evm_wallet_balances_v1(request : WalletBalanceRequest) : async* WalletBalanceResult { #err(browserRequired) };
    public func /*update*/evm_wallet_read_contract_v1(request : WalletReadRequest) : async* WalletReadResultResult { #err(browserRequired) };
    public func /*update*/evm_wallet_estimate_transaction_v1(request : WalletEstimateRequest) : async* WalletEstimateResult { #err(browserRequired) };
    public func /*query*/evm_wallet_replacement_transaction_v1(request : WalletReplacementProofRequest) : WalletReplacementProofResult {
      if (not supported(request.chain_id)) return #err("Unsupported network");
      let hash = switch (Hex.decode(request.transaction_hash)) {
        case (#err(error)) return #err(error);
        case (#ok(bytes)) { if (bytes.size() != 32) return #err("Transaction hash must be 32 bytes"); Hex.encode(bytes) };
      };
      let expected = request.original_wallet_request;
      let identity : Memory.Identity = {
        caller = { app_id = expected.caller_app_id; installation_uid = expected.caller_installation_uid; endpoint = "" };
        request_id = expected.request_id;
      };
      switch (Journal.validateIdentity(identity)) { case (#err(error)) return #err(error); case (_) {} };
      #ok({
        chain_id = request.chain_id; transaction_hash = hash; original_wallet_request = expected;
        wallet_replacement_matches = ReplacementProof.matches(mem, identity, request.chain_id, hash);
        observed_at = Time.now(); source = "evm_wallet_journal";
      });
    };
    public func /*update*/evm_wallet_transaction_v1(request : WalletTransactionLookupRequest) : async* WalletTransactionLookupResult { #err(browserRequired) };
    public func /*query*/evm_wallet_transaction_request_matches_v1(request : WalletTransactionMatchesRequest) : WalletBoolResult {
      if (not supported(request.chain_id)) return #err("Unsupported network");
      let hash = switch (Hex.decode(request.transaction_hash)) { case (#err(e)) return #err(e); case (#ok(bytes)) { if (bytes.size() != 32) return #err("Transaction hash must be 32 bytes"); Hex.encode(bytes) } };
      let expected = request.wallet_request;
      let identity : Memory.Identity = { caller = { app_id = expected.caller_app_id; installation_uid = expected.caller_installation_uid; endpoint = "" }; request_id = expected.request_id };
      switch (Journal.validateIdentity(identity)) { case (#err(e)) return #err(e); case (_) {} };
      #ok(switch (journal.find(identity)) { case null false; case (?command) command.intent.chain_id == request.chain_id and command.transaction_hash == ?hash and command.signed_raw != null });
    };
    public func /*query*/evm_wallet_operation_v1(request : WalletIdentityRequest) : WalletOperationResult {
      switch (journal.find(request.identity)) { case null #err("not_found"); case (?command) #ok(view(command)) };
    };
    public func /*query*/evm_wallet_submission_v1(request : WalletIdentityRequest) : WalletSubmissionResult {
      let command = switch (journal.find(request.identity)) { case null return #err("not_found"); case (?value) value };
      BrowserObservations.submission(command, Array.fromIter(Map.values(mem.commands)));
    };
    public func /*query*/evm_wallet_superseding_v1(request : WalletIdentityRequest) : WalletSupersedingResult {
      let command = switch (journal.find(request.identity)) { case null return #err("not_found"); case (?value) value };
      #ok(switch (BrowserObservations.superseding(command, Array.fromIter(Map.values(mem.commands)))) { case null null; case (?replacement) ?view(replacement) });
    };
    public func /*update*/evm_wallet_observe_browser_v1(request : WalletObserveBrowserRequest) : WalletOperationResult {
      let command = switch (journal.find(request.identity)) { case null return #err("not_found"); case (?value) value };
      if (Set.contains(running, Nat.compare, command.id)) return #ok(view(command));
      switch (BrowserObservations.apply(command, request, Array.fromIter(Map.values(mem.commands)), Time.now())) { case (#err(e)) #err(e); case (#ok(_)) #ok(view(command)) };
    };
    public func /*update*/evm_wallet_prepare_browser_v1(input : WalletPrepareBrowserRequest) : async* WalletOperationResult {
      let request = input.request;
      if (not supported(request.intent.chain_id)) return #err("Unsupported network");
      if (request.intent.account_id != "main") return #err("Unknown account");
      switch (Journal.validateIdentity(request.identity)) { case (#err(e)) return #err(e); case (_) {} };
      let a = switch (await* account(request.intent.account_id)) { case (#err(e)) return #err(e); case (#ok(value)) value };
      let command = switch (journal.start(request, Time.now())) { case (#err(e)) return #err(e); case (#ok(value)) value };
      command.address := a.address;
      if (command.status != "preparing" or command.transaction != null or Set.contains(running, Nat.compare, command.id)) return #ok(view(command));
      Set.add(running, Nat.compare, command.id);
      let prepared = try { await* prepare(command, ?input.observation) } catch (e) { #err(Error.message(e)) };
      Set.remove(running, Nat.compare, command.id);
      command.updated_at := Time.now();
      switch (prepared) {
        case (#err(e)) { command.status := "failed"; command.message := ?e };
        case (#ok(_)) {
          command.review_revision += 1;
          command.status := if (command.transaction == null) "prepared" else "preparing";
        };
      };
      #ok(view(command));
    };
    public func /*update*/evm_wallet_finish_prepare_browser_v1(request : WalletFinishPrepareBrowserRequest) : WalletOperationResult {
      let command = switch (journal.find(request.identity)) { case null return #err("not_found"); case (?value) value };
      if (Set.contains(running, Nat.compare, command.id)) return #ok(view(command));
      if (request.review_revision != command.review_revision) return #err("review_changed: use the current candidate before recording its simulation");
      if (command.status != "preparing") return #ok(view(command));
      let candidate = switch (command.transaction) { case null return #err("Candidate transaction is not available"); case (?value) value };
      let review = switch (command.review) { case null return #err("Candidate observations are not available"); case (?value) value };
      let pendingNonce = switch (uint(request.pending_nonce)) { case (#err(e)) return #err(e); case (#ok(value)) value };
      let minedNonce = switch (uint(request.mined_nonce)) { case (#err(e)) return #err(e); case (#ok(value)) value };
      journal.observeNonce(command.intent.account_id, command.intent.chain_id, Nat.max(pendingNonce, minedNonce));
      switch (command.intent.operation) {
        case (#replacement(_)) if (candidate.nonce < minedNonce) return #err("Replacement nonce is already mined; reconcile the original first");
        case (_) {
          let next = journal.nextNonce(command.intent.account_id, command.intent.chain_id, candidate.nonce);
          if (candidate.nonce != next) {
            command.transaction := ?{ candidate with nonce = next };
            command.review := ?{ review with nonce = Nat.toText(next) };
            command.review_revision += 1;
            command.message := ?"The nonce changed. Estimate and simulate the updated candidate before reviewing it again.";
            command.updated_at := Time.now();
            return #ok(view(command));
          };
        };
      };
      let estimate = switch (uint(request.gas_estimate)) { case (#err(e)) return #err(e); case (#ok(value)) value };
      let gasLimit = switch (uint(request.gas_limit)) { case (#err(e)) return #err(e); case (#ok(value)) value };
      if (gasLimit < estimate or gasLimit == 0) return #err("Requested gas limit is below the estimate or zero");
      switch (command.intent.operation) {
        case (#transaction(intent)) switch (intent.gas_limit) {
          case (?expected) switch (uint(expected)) { case (#err(e)) return #err(e); case (#ok(value)) if (gasLimit != value) return #err("Gas limit differs from the original request") };
          case null if (gasLimit != estimate) return #err("Gas limit must equal the observed estimate when no explicit limit was requested");
        };
        case (#replacement(_)) if (gasLimit != estimate) return #err("Replacement gas limit must equal the observed estimate");
        case (_) return #err("Only transactions need gas simulation");
      };
      switch (Hex.decode(request.simulation)) { case (#err(e)) return #err("Invalid simulation bytes: " # e); case (_) {} };
      let tx = { candidate with gasLimit };
      switch (Transaction.validate(tx)) { case (#err(e)) return #err(e); case (_) {} };
      let balance = switch (uint(request.balance)) { case (#err(e)) return #err(e); case (#ok(value)) value };
      if (balance < tx.value + gasLimit * maxGasPrice(tx)) return #err("Insufficient native gas balance for value plus the authorized maximum fee");
      command.transaction := ?tx;
      command.review := ?{ review with balance = Nat.toText(balance); gas_limit = Nat.toText(gasLimit); simulation = request.simulation; observed_at = Time.now() };
      command.review_revision += 1; command.status := "prepared"; command.message := null; command.updated_at := Time.now();
      #ok(view(command));
    };
    public func /*update*/evm_wallet_prepare_v1(request : WalletPrepareRequest) : async* WalletOperationResult {
      switch (request.intent.operation) { case (#transaction(_) or #replacement(_)) return #err(browserRequired); case (_) {} };
      if (not supported(request.intent.chain_id)) return #err("Unsupported network");
      if (request.intent.account_id != "main") return #err("Unknown account");
      switch (Journal.validateIdentity(request.identity)) { case (#err(e)) return #err(e); case (_) {} };
      // Public-key retrieval has no value-moving effect. If unavailable, return
      // its error before creating an operation with an unknown account address.
      let a = switch (await* account(request.intent.account_id)) { case (#err(e)) return #err(e); case (#ok(a)) a };
      let command = switch (journal.start(request, Time.now())) { case (#err(e)) return #err(e); case (#ok(c)) c };
      command.address := a.address;
      if (command.status != "preparing" or Set.contains(running, Nat.compare, command.id)) return #ok(view(command));
      Set.add(running, Nat.compare, command.id);
      let prepared = try { await* prepare(command, null) } catch (e) { #err(Error.message(e)) };
      Set.remove(running, Nat.compare, command.id);
      command.updated_at := Time.now();
      switch (prepared) {
        case (#err(e)) { command.status := "failed"; command.message := ?e };
        case (#ok(_)) { command.status := "prepared"; command.review_revision += 1 };
      };
      #ok(view(command));
    };
    public func /*update*/evm_wallet_execute_v1(request : WalletExecuteRequest) : async* WalletOperationResult {
      let command = switch (journal.find(request.identity)) { case null return #err("not_found"); case (?c) c };
      if (Set.contains(running, Nat.compare, command.id)) return #ok(view(command));
      if (command.status != "prepared") {
        // An ambiguous signer must never be called again under this identity.
        if (command.status == "signing") { command.status := "unknown"; command.message := ?"Signing was interrupted. No signature is available; this request will not sign again." };
        return #ok(view(command));
      };
      if (request.review_revision != command.review_revision) return #err("review_changed: review the current operation before approving");
      switch (journal.reserve(command)) { case (#err(e)) return #err(e); case (#ok(false)) { command.status := "preparing"; command.message := ?"The nonce changed. Estimate and simulate the updated candidate before reviewing it again."; return #ok(view(command)) }; case (_) {} };
      let digest = switch (command.transaction) {
        case (?tx) switch (Transaction.signingHash(tx)) { case (#err(e)) return #err(e); case (#ok(v)) v };
        case null switch (command.digest) { case null return #err("Prepared operation has no digest"); case (?v) v };
      };
      command.digest := ?digest;
      // Frozen fields, nonce reservation and phase commit before signing await.
      command.status := "signing"; command.updated_at := Time.now(); command.message := null;
      Set.add(running, Nat.compare, command.id);
      try {
        switch (await* signing.sign_digest({ slot = "main"; digest })) {
          case (#err(e)) {
            if (signerDidNotDispatch(e)) {
              command.status := "prepared";
              command.message := ?("Signing was not dispatched: " # debug_show(e) # ". The same frozen operation can be explicitly approved again after resolving this condition.");
            } else {
              command.status := "unknown"; command.message := ?("Signing returned " # debug_show(e) # ". This request will not sign again.");
            };
          };
          case (#ok(reply)) {
            if (reply.digest != digest or reply.slot != "main" or reply.signature.size() != 64) {
              command.status := "unknown"; command.message := ?"Signing returned an invalid or mismatched signature";
            } else {
              let a = switch (Map.get(mem.accounts, Text.compare, command.intent.account_id)) { case null { Set.remove(running, Nat.compare, command.id); return #err("Account disappeared while signing") }; case (?a) a };
              switch (Secp256k1.normalizeSignature(a.public_key, digest, reply.signature)) {
                case (#err(e)) { command.status := "unknown"; command.message := ?e };
                case (#ok(signature)) {
                  let r = switch (Hex.word(signature.r)) { case (#ok(v)) v; case (_) Blob.fromArray([]) };
                  let s = switch (Hex.word(signature.s)) { case (#ok(v)) v; case (_) Blob.fromArray([]) };
                  command.signature := ?Hex.concat([r, s, Blob.fromArray([Nat8.fromNat(signature.yParity + 27)])]);
                  switch (command.transaction) {
                    case null { command.status := "signed" };
                    case (?tx) switch (Transaction.signed(tx, signature)) {
                      case (#err(e)) { command.status := "unknown"; command.message := ?e };
                      case (#ok(signed)) {
                        // Exact bytes and independently computed hash persist
                        // before the first RPC broadcast. Recovery reuses them.
                        command.signed_raw := ?signed.raw;
                        command.transaction_hash := ?Hex.encode(signed.hash);
                        command.status := "signed";
                      };
                    };
                  };
                };
              };
            };
          };
        };
      } catch (e) {
        command.status := "unknown"; command.message := ?("Signing or submission reply was lost: " # Error.message(e));
      };
      Set.remove(running, Nat.compare, command.id);
      command.updated_at := Time.now();
      #ok(view(command));
    };
    public func /*update*/evm_wallet_reject_v1(request : WalletIdentityRequest) : WalletOperationResult {
      let command = switch (journal.find(request.identity)) { case null return #err("not_found"); case (?c) c };
      if (command.status == "prepared" or (command.status == "preparing" and not Set.contains(running, Nat.compare, command.id))) {
        // Prepared after a documented pre-dispatch failure has no released
        // signature. Its reservation can be reused without creating a gap.
        if (command.signature == null and command.signed_raw == null) command.reserved_nonce := false;
        command.status := "rejected"; command.message := ?"Rejected by owner"; command.updated_at := Time.now();
      };
      #ok(view(command));
    };
    public func /*update*/evm_wallet_status_v1(request : WalletStatusRequest) : async* WalletOperationResult {
      let command = switch (journal.find(request.identity)) { case null return #err("not_found"); case (?value) value };
      if (command.status == "signing" and not Set.contains(running, Nat.compare, command.id)) {
        command.status := "unknown"; command.message := ?"Signing was interrupted. This operation will not sign again.";
      };
      #ok(view(command));
    };
    public func /*update*/evm_wallet_review_evidence_v1(request : WalletEvidenceRequest) : async* WalletEvidenceResult {
      let command = switch (journal.find(request.identity)) { case null return #err("not_found"); case (?value) value };
      #ok({ operation = view(command); token_evidence = evidence.get(command.id) });
    };
    public func /*update*/evm_wallet_observe_evidence_browser_v1(request : WalletObserveEvidenceRequest) : WalletEvidenceResult {
      let command = switch (journal.find(request.identity)) { case null return #err("not_found"); case (?value) value };
      if (Set.contains(running, Nat.compare, command.id)) return #err("Operation is running");
      if (command.status != "prepared") return #err("Only a prepared operation can refresh the facts for its approval");
      if (request.review_revision != command.review_revision) return #err("review_changed: use the current review before refreshing evidence");
      let tx = switch (command.transaction) { case null return #err("Message signatures do not have ERC20 transaction evidence"); case (?value) value };
      switch (evidence.capture(command.id, tx, command.address, request.observation)) { case (#err(e)) return #err(e); case (_) {} };
      command.review_revision += 1; command.updated_at := Time.now();
      #ok({ operation = view(command); token_evidence = evidence.get(command.id) });
    };

    func account(id : Text) : async* Types.Result<Memory.Account> {
      if (id != "main") return #err("Unknown account");
      switch (Map.get(mem.accounts, Text.compare, id)) { case (?a) return #ok(a); case null {} };
      switch (await* signing.public_key("main")) {
        case (#err(e)) #err("Public key unavailable: " # debug_show(e));
        case (#ok(key)) {
          if (key.slot != "main" or key.public_key.size() != 33) return #err("Unexpected custody public key");
          let address = switch (Secp256k1.address(key.public_key)) { case (#err(e)) return #err(e); case (#ok(v)) v };
          let a : Memory.Account = { id; slot = "main"; address; public_key = key.public_key; key_fingerprint = key.key_fingerprint; namespace_version = key.namespace_version };
          switch (Map.get(mem.accounts, Text.compare, id)) {
            case (?existing) if (existing.public_key != a.public_key) return #err("Custody key changed while retrieving account");
            case (_) {};
          };
          Map.add(mem.accounts, Text.compare, id, a); #ok(a);
        };
      };
    };
    func prepare(command : Memory.Command, observation : ?WalletPreparationObservation) : async* Types.Result<()> {
      let a = switch (await* account(command.intent.account_id)) { case (#err(e)) return #err(e); case (#ok(a)) a };
      command.address := a.address;
      switch (command.intent.operation) {
        case (#personal_message(request)) {
          let bytes = switch (Hex.decode(request.message)) { case (#err(e)) return #err(e); case (#ok(v)) v };
          command.digest := ?Personal.hash(bytes);
          command.message := ?"Personal signatures are reusable proofs; the selected network does not add chain binding to the signed message.";
          #ok(());
        };
        case (#typed_data(request)) {
          let digest = switch (Eip712.hashForChain(request.json, command.intent.chain_id)) { case (#err(e)) return #err(e); case (#ok(v)) v };
          command.digest := ?digest;
          command.message := ?"Typed signatures may authorize permits or trades without a wallet broadcast. A domain without chainId has no network binding. Review the complete domain and message.";
          #ok(());
        };
        case (#transaction(request)) prepareTransaction(command, a, request, null, observation);
        case (#replacement(request)) {
          let original = switch (journal.byId(request.operation_id)) { case null return #err("Replacement target was not found"); case (?v) v };
          if (original.intent.chain_id != command.intent.chain_id or original.intent.account_id != command.intent.account_id or not original.reserved_nonce) return #err("Replacement must refer to a nonce reserved for this account and chain");
          if (original.status == "confirmed" or original.status == "reverted") return #err("A mined transaction cannot be replaced");
          let tx = switch (original.transaction) { case null return #err("Only transactions can be replaced"); case (?v) v };
          let oldMax = maxGasPrice(tx);
          let max = switch (uint(request.max_fee_per_gas)) { case (#err(e)) return #err(e); case (#ok(v)) v };
          let priority = switch (uint(request.max_priority_fee_per_gas)) { case (#err(e)) return #err(e); case (#ok(v)) v };
          if (max <= oldMax) return #err("Replacement fee must exceed the original fee; node-specific replacement rules may require a larger increase");
          let to = if (request.cancel) a.address else switch (tx.to) { case null return #err("Contract-creation replacement is unavailable"); case (?v) v };
          let replacement : Memory.TransactionRequest = {
            to; value = if (request.cancel) "0" else Nat.toText(tx.value);
            data = if (request.cancel) "0x" else Hex.encode(tx.data);
            gas_limit = null; max_fee_per_gas = ?Nat.toText(max); max_priority_fee_per_gas = ?Nat.toText(priority); gas_price = null;
            transaction_type = ?"eip1559";
            access_list = if (request.cancel) [] else tx.accessList;
          };
          prepareTransaction(command, a, replacement, ?tx.nonce, observation);
        };
      };
    };
    func prepareTransaction(command : Memory.Command, a : Memory.Account, request : Memory.TransactionRequest, replacementNonce : ?Nat, observation : ?WalletPreparationObservation) : Types.Result<()> {
      let chain = command.intent.chain_id;
      switch (request.transaction_type) {
        case (?("legacy" or "eip1559")) {};
        case null {};
        case (_) return #err("transaction_type must be legacy or eip1559");
      };
      if (request.transaction_type == ?"eip1559" and request.gas_price != null) return #err("EIP1559 transaction cannot include gas_price");
      if (request.transaction_type == ?"legacy" and (request.max_fee_per_gas != null or request.max_priority_fee_per_gas != null)) return #err("Legacy transaction cannot include EIP1559 fee fields");
      let to = switch (validateAddress(request.to)) { case (#err(e)) return #err(e); case (#ok(v)) v };
      let value = switch (uint(request.value)) { case (#err(e)) return #err(e); case (#ok(v)) v };
      let data = switch (Hex.decode(request.data)) { case (#err(e)) return #err(e); case (#ok(v)) v };
      let observed = switch (observation) { case null return #err(browserRequired); case (?value) value };
      switch (uint(observed.block_number)) { case (#err(e)) return #err("Invalid observation block: " # e); case (_) {} };
      let balance = switch (uint(observed.balance)) { case (#err(e)) return #err(e); case (#ok(value)) value };
      let observedNonce = switch (uint(observed.pending_nonce)) { case (#err(e)) return #err(e); case (#ok(value)) value };
      journal.observeNonce(a.id, chain, observedNonce);
      let nonce = switch (replacementNonce) {
        case null journal.nextNonce(a.id, chain, observedNonce);
        case (?n) {
          let mined = switch (uint(observed.mined_nonce)) { case (#err(e)) return #err(e); case (#ok(v)) v };
          if (n < mined) return #err("Replacement nonce is already mined; reconcile the original first");
          n;
        };
      };
      let legacyPrice = switch (request.gas_price, request.transaction_type) {
        case (?p, _) ?p;
        case (null, ?"legacy") switch (uint(observed.gas_price)) { case (#err(e)) return #err(e); case (#ok(v)) ?Nat.toText(v) };
        case (_) null;
      };
      let fee : Memory.Transaction = {
        chainId = chain; nonce; gasLimit = 0; to = ?to; value; data; accessList = request.access_list;
        fee = switch (legacyPrice) {
          case (?price) {
            if (request.max_fee_per_gas != null or request.max_priority_fee_per_gas != null) return #err("Legacy and EIP1559 fee fields cannot be combined");
            let gasPrice = switch (uint(price)) { case (#err(e)) return #err(e); case (#ok(v)) v };
            #legacy({ gasPrice });
          };
          case null {
            let maxPriorityFeePerGas = switch (request.max_priority_fee_per_gas) {
              case (?p) switch (uint(p)) { case (#err(e)) return #err(e); case (#ok(v)) v };
              case null switch (uint(observed.max_priority_fee_per_gas)) { case (#err(e)) return #err(e); case (#ok(v)) v };
            };
            let maxFeePerGas = switch (request.max_fee_per_gas) {
              case (?p) switch (uint(p)) { case (#err(e)) return #err(e); case (#ok(v)) v };
              case null {
                let base = switch (uint(observed.base_fee_per_gas)) { case (#err(e)) return #err(e); case (#ok(value)) value };
                base * 2 + maxPriorityFeePerGas;
              };
            };
            #eip1559({ maxFeePerGas; maxPriorityFeePerGas });
          };
        };
      };
      switch (Transaction.validate(fee)) { case (#err(e)) return #err(e); case (_) {} };
      let gasLimit = switch (request.gas_limit) { case null 0; case (?value) switch (uint(value)) { case (#err(e)) return #err(e); case (#ok(value)) value } };
      let tx = { fee with gasLimit };
      command.transaction := ?tx;
      command.review := ?{
        nonce = Nat.toText(nonce); gas_limit = Nat.toText(gasLimit);
        max_fee_per_gas = switch (tx.fee) { case (#eip1559(f)) ?Nat.toText(f.maxFeePerGas); case (_) null };
        max_priority_fee_per_gas = switch (tx.fee) { case (#eip1559(f)) ?Nat.toText(f.maxPriorityFeePerGas); case (_) null };
        gas_price = switch (tx.fee) { case (#legacy(f)) ?Nat.toText(f.gasPrice); case (_) null };
        balance = Nat.toText(balance); simulation = "Awaiting browser gas estimate and simulation"; observed_at = Time.now();
      };
      #ok(());
    };
    func view(command : Memory.Command) : Types.Operation {
      Journal.view(command);
    };
    func supported(chain : Nat) : Bool = Map.containsKey(mem.networks, Nat.compare, chain);
    func snapshot() : Types.Snapshot {
      { accounts = Array.fromIter(Map.values(mem.accounts)); networks = Array.fromIter(Map.values(mem.networks)); assets = Array.fromIter(Map.values(mem.assets)); lifecycle = "The installation owns this custody namespace. Compatible upgrades preserve the account. Uninstall/reinstall rotates its key and cannot recover this address. There is no seed or private-key export." };
    };
  };
  let browserRequired = "This read or transaction preparation requires the updated EVM Wallet browser service. Reload or update EVM Wallet; no canister HTTP request was made.";
  func uint(value : Text) : Types.Result<Nat> {
    switch (Hex.parseNat(value)) { case (#err(e)) #err(e); case (#ok(v)) { if (v >= Hex.uint256Limit) #err("Amount exceeds uint256") else #ok(v) } };
  };
  func validateAddress(value : Text) : Types.Result<Text> {
    switch (Hex.decode(value)) { case (#err(e)) #err(e); case (#ok(bytes)) { if (bytes.size() != 20) #err("EVM address must contain 20 bytes") else #ok(Hex.encode(bytes)) } };
  };
  func maxGasPrice(tx : Memory.Transaction) : Nat {
    switch (tx.fee) { case (#legacy(f)) f.gasPrice; case (#eip1559(f)) f.maxFeePerGas };
  };
  func signerDidNotDispatch(error : Caps.ChainKeySigningErrorV1) : Bool {
    switch (error) {
      case (#invalid_request or #not_declared or #disabled or #busy or #cost_too_high or #low_cycles or #key_unavailable or #source_gone) true;
      case (#management_failure or #outcome_unknown or #revoked_after_dispatch) false;
    };
  };
/*---NEUTRON GENERATED BEGIN---*/

public type evm_wallet_snapshot_v1_Input = (());
public type evm_wallet_snapshot_v1_Output = WalletSnapshotResult;

public type evm_wallet_accounts_v1_Input = (());
public type evm_wallet_accounts_v1_Output = WalletAccountsResult;

public type evm_wallet_history_v1_Input = (request : WalletHistoryRequest);
public type evm_wallet_history_v1_Output = WalletHistoryResult;

public type evm_wallet_asset_set_v1_Input = (asset : WalletAsset);
public type evm_wallet_asset_set_v1_Output = WalletSnapshotResult;

public type evm_wallet_balances_v1_Input = (request : WalletBalanceRequest);
public type evm_wallet_balances_v1_Output = WalletBalanceResult;

public type evm_wallet_read_contract_v1_Input = (request : WalletReadRequest);
public type evm_wallet_read_contract_v1_Output = WalletReadResultResult;

public type evm_wallet_estimate_transaction_v1_Input = (request : WalletEstimateRequest);
public type evm_wallet_estimate_transaction_v1_Output = WalletEstimateResult;

public type evm_wallet_replacement_transaction_v1_Input = (request : WalletReplacementProofRequest);
public type evm_wallet_replacement_transaction_v1_Output = WalletReplacementProofResult;

public type evm_wallet_transaction_v1_Input = (request : WalletTransactionLookupRequest);
public type evm_wallet_transaction_v1_Output = WalletTransactionLookupResult;

public type evm_wallet_transaction_request_matches_v1_Input = (request : WalletTransactionMatchesRequest);
public type evm_wallet_transaction_request_matches_v1_Output = WalletBoolResult;

public type evm_wallet_operation_v1_Input = (request : WalletIdentityRequest);
public type evm_wallet_operation_v1_Output = WalletOperationResult;

public type evm_wallet_submission_v1_Input = (request : WalletIdentityRequest);
public type evm_wallet_submission_v1_Output = WalletSubmissionResult;

public type evm_wallet_superseding_v1_Input = (request : WalletIdentityRequest);
public type evm_wallet_superseding_v1_Output = WalletSupersedingResult;

public type evm_wallet_observe_browser_v1_Input = (request : WalletObserveBrowserRequest);
public type evm_wallet_observe_browser_v1_Output = WalletOperationResult;

public type evm_wallet_prepare_browser_v1_Input = (input : WalletPrepareBrowserRequest);
public type evm_wallet_prepare_browser_v1_Output = WalletOperationResult;

public type evm_wallet_finish_prepare_browser_v1_Input = (request : WalletFinishPrepareBrowserRequest);
public type evm_wallet_finish_prepare_browser_v1_Output = WalletOperationResult;

public type evm_wallet_prepare_v1_Input = (request : WalletPrepareRequest);
public type evm_wallet_prepare_v1_Output = WalletOperationResult;

public type evm_wallet_execute_v1_Input = (request : WalletExecuteRequest);
public type evm_wallet_execute_v1_Output = WalletOperationResult;

public type evm_wallet_reject_v1_Input = (request : WalletIdentityRequest);
public type evm_wallet_reject_v1_Output = WalletOperationResult;

public type evm_wallet_status_v1_Input = (request : WalletStatusRequest);
public type evm_wallet_status_v1_Output = WalletOperationResult;

public type evm_wallet_review_evidence_v1_Input = (request : WalletEvidenceRequest);
public type evm_wallet_review_evidence_v1_Output = WalletEvidenceResult;

public type evm_wallet_observe_evidence_browser_v1_Input = (request : WalletObserveEvidenceRequest);
public type evm_wallet_observe_evidence_browser_v1_Output = WalletEvidenceResult;

/*---NEUTRON GENERATED END---*/
};
