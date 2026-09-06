import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Error "mo:core/Error";
import List "mo:core/List";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Nat8 "mo:core/Nat8";
import Set "mo:core/Set";
import Text "mo:core/Text";
import Time "mo:core/Time";
import JSON "mo:json";
import Caps "mo:neutron-capabilities";
import Config "./Config";
import Journal "./Journal";
import Memory "./memory/evm_wallet/v1";
import EvidenceMemory "./memory/evm_evidence/v1";
import TokenEvidence "./token/Evidence";
import Estimate "./fees/Estimate";
import ReplacementProof "./ReplacementProof";
import Types "./Types";
import Hex "./evm/Hex";
import Personal "./evm/Personal";
import Eip712 "./evm/Eip712";
import Secp256k1 "./evm/Secp256k1";
import Transaction "./evm/Transaction";
import Rpc "./rpc/Client";
import RpcJson "./rpc/Json";

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
      backend_calls : Caps.BackendCallsV1;
      wallet_custody_signing : Caps.WalletCustodySigningV1;
    };
  };
  public class Init(env : AppBackendEnvironment) {
    let mem = env.stable_memory.evm_wallet;
    let journal = Journal.Store(mem);
    let rpc = Rpc.Client(env.capabilities.backend_calls);
    let evidence = TokenEvidence.Service(env.stable_memory.evm_evidence, rpc);
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
    public func /*update*/evm_wallet_balances_v1(request : WalletBalanceRequest) : async* WalletBalanceResult {
      if (not supported(request.chain_id)) return #err("Unsupported network");
      let a = switch (await* account(request.account_id)) { case (#err(e)) return #err(e); case (#ok(a)) a };
      let block = switch (await* rpcText(request.chain_id, "eth_blockNumber", "[]")) { case (#err(e)) return #err(e); case (#ok(b)) b };
      let balance = switch (await* rpcNat(request.chain_id, "eth_getBalance", "[" # q(a.address) # "," # q(block) # "]")) { case (#err(e)) return #err(e); case (#ok(b)) b };
      let tokens = List.empty<Types.TokenBalance>();
      for (token in request.tokens.vals()) {
        let address = switch (validateAddress(token)) { case (#err(e)) return #err(e); case (#ok(a)) a };
        let encoded = Text.replace(a.address, #text("0x"), "");
        let data = "0x70a08231000000000000000000000000" # encoded;
        let result : Types.Result<Nat> = switch (await* rpcText(request.chain_id, "eth_call", "[{\"to\":" # q(address) # ",\"data\":" # q(data) # "}," # q(block) # "]")) {
          case (#err(e)) #err(e);
          case (#ok(value)) switch (Hex.decode(value)) {
            case (#ok(bytes)) { if (bytes.size() != 32) #err("ERC20 balanceOf returned an invalid uint256 word") else #ok(Hex.toNat(bytes)) };
            case (#err(e)) #err(e);
          };
        };
        let known = Map.get(mem.assets, Text.compare, Config.assetKey(request.chain_id, address));
        List.add(tokens, {
          address; balance = switch (result) { case (#ok(n)) ?Nat.toText(n); case (_) null };
          decimals = switch (known) { case (?v) ?v.decimals; case null null };
          symbol = switch (known) { case (?v) ?v.symbol; case null null };
          error = switch (result) { case (#err(e)) ?e; case (_) null };
        });
      };
      #ok({ account_id = a.id; chain_id = request.chain_id; address = a.address; native_balance = Nat.toText(balance); tokens = List.toArray(tokens); block_number = block; observed_at = Time.now(); completeness = "requested_only" });
    };
    public func /*update*/evm_wallet_read_contract_v1(request : WalletReadRequest) : async* WalletReadResultResult {
      if (not supported(request.chain_id)) return #err("Unsupported network");
      let a = switch (await* account("main")) { case (#err(e)) return #err(e); case (#ok(a)) a };
      let to = switch (validateAddress(request.to)) { case (#err(e)) return #err(e); case (#ok(a)) a };
      switch (Hex.decode(request.data)) { case (#err(e)) return #err(e); case (_) {} };
      let block = if (request.block == "latest" or request.block == "") {
        switch (await* rpcText(request.chain_id, "eth_blockNumber", "[]")) { case (#err(e)) return #err(e); case (#ok(v)) v };
      } else {
        switch (Hex.parseNat(request.block)) { case (#err(_)) return #err("Read block must be latest or an explicit block number"); case (#ok(v)) quantity(v) };
      };
      let result = switch (await* rpcText(request.chain_id, "eth_call", "[{\"from\":" # q(a.address) # ",\"to\":" # q(to) # ",\"data\":" # q(request.data) # "}," # q(block) # "]")) { case (#err(e)) return #err(e); case (#ok(v)) v };
      switch (Hex.decode(result)) { case (#err(_)) return #err("RPC returned invalid contract bytes"); case (_) {} };
      let code = switch (await* rpcText(request.chain_id, "eth_getCode", "[" # q(to) # "," # q(block) # "]")) { case (#err(e)) return #err(e); case (#ok(v)) v };
      switch (Hex.decode(code)) { case (#err(_)) return #err("RPC returned invalid contract code"); case (_) {} };
      #ok({ chain_id = request.chain_id; to; data = request.data; result; code; block_number = block; observed_at = Time.now() });
    };
    public func /*update*/evm_wallet_estimate_transaction_v1(request : WalletEstimateRequest) : async* WalletEstimateResult {
      if (not supported(request.chain_id)) return #err("Unsupported network");
      let a = switch (await* account("main")) { case (#err(error)) return #err(error); case (#ok(value)) value };
      await* Estimate.estimate({ request with from = a.address }, rpc);
    };
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
    public func /*update*/evm_wallet_transaction_v1(request : WalletTransactionLookupRequest) : async* WalletTransactionLookupResult {
      if (not supported(request.chain_id)) return #err("Unsupported network");
      let hash = switch (Hex.decode(request.transaction_hash)) { case (#err(e)) return #err(e); case (#ok(bytes)) { if (bytes.size() != 32) return #err("Transaction hash must be 32 bytes"); Hex.encode(bytes) } };
      let wallet_request_matches = switch (request.wallet_request) {
        case null null;
        case (?expected) {
          let identity : Memory.Identity = { caller = { app_id = expected.caller_app_id; installation_uid = expected.caller_installation_uid; endpoint = "" }; request_id = expected.request_id };
          switch (Journal.validateIdentity(identity)) { case (#err(e)) return #err(e); case (_) {} };
          ?(switch (journal.find(identity)) {
            case null false;
            case (?c) c.intent.chain_id == request.chain_id and c.transaction_hash == ?hash and c.signed_raw != null;
          });
        };
      };
      let transaction = switch (await* rpc.request(request.chain_id, "eth_getTransactionByHash", "[" # q(hash) # "]")) { case (#err(e)) return #err(e); case (#ok(v)) v };
      let tx = switch (parse(transaction)) { case (#err(e)) return #err(e); case (#ok(v)) v };
      switch (tx) {
        case (#null_) {};
        case (_) switch (fieldText(tx, "hash")) { case (#ok(v)) { if (Text.toLower(v) != hash) return #err("RPC returned a mismatched transaction hash") }; case (#err(e)) return #err(e) };
      };
      let rawReceipt = switch (await* rpc.request(request.chain_id, "eth_getTransactionReceipt", "[" # q(hash) # "]")) { case (#err(e)) return #err(e); case (#ok(v)) v };
      let receipt = switch (parse(rawReceipt)) { case (#err(e)) return #err(e); case (#ok(v)) v };
      var receipt_json : ?Text = null;
      var finality : ?Text = null;
      switch (receipt) {
        case (#null_) {};
        case (_) {
          switch (fieldText(receipt, "transactionHash")) { case (#ok(v)) { if (Text.toLower(v) != hash) return #err("RPC returned a mismatched receipt hash") }; case (#err(e)) return #err(e) };
          let number = switch (fieldNat(receipt, "blockNumber")) { case (#err(e)) return #err(e); case (#ok(v)) v };
          let executionStatus = switch (fieldNat(receipt, "status")) { case (#err(e)) return #err(e); case (#ok(v)) v };
          if (executionStatus > 1) return #err("Unexpected receipt execution status");
          let blockHash = switch (fieldText(receipt, "blockHash")) { case (#err(e)) return #err(e); case (#ok(v)) v };
          let block = switch (await* rpcJson(request.chain_id, "eth_getBlockByNumber", "[" # q(quantity(number)) # ",false]")) { case (#err(e)) return #err(e); case (#ok(v)) v };
          switch (fieldText(block, "hash")) { case (#ok(v)) { if (Text.toLower(v) != Text.toLower(blockHash)) return #err("Receipt block is no longer canonical") }; case (#err(e)) return #err(e) };
          receipt_json := ?rawReceipt; finality := ?"included";
          for (tag in ["safe", "finalized"].vals()) switch (await* rpcJson(request.chain_id, "eth_getBlockByNumber", "[" # q(tag) # ",false]")) {
            case (#ok(head)) switch (fieldNat(head, "number")) { case (#ok(n)) if (n >= number) finality := ?tag; case (_) {} };
            case (_) {};
          };
        };
      };
      #ok({ chain_id = request.chain_id; transaction_hash = hash; transaction_json = transaction; receipt_json; finality; wallet_request_matches; observed_at = Time.now() });
    };
    public func /*update*/evm_wallet_prepare_v1(request : WalletPrepareRequest) : async* WalletOperationResult {
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
      let prepared = try { await* prepare(command) } catch (e) { #err(Error.message(e)) };
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
      switch (journal.reserve(command)) { case (#err(e)) return #err(e); case (#ok(false)) return #ok(view(command)); case (_) {} };
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
                        await* broadcast(command);
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
      let command = switch (journal.find(request.identity)) { case null return #err("not_found"); case (?c) c };
      if (request.refresh and not Set.contains(running, Nat.compare, command.id)) {
        Set.add(running, Nat.compare, command.id);
        try { await* reconcile(command) } catch (e) { command.message := ?("Status unavailable: " # Error.message(e)) };
        Set.remove(running, Nat.compare, command.id);
      };
      #ok(view(command));
    };
    public func /*update*/evm_wallet_review_evidence_v1(request : WalletEvidenceRequest) : async* WalletEvidenceResult {
      let command = switch (journal.find(request.identity)) { case null return #err("not_found"); case (?c) c };
      if (not request.refresh or Set.contains(running, Nat.compare, command.id)) return #ok({ operation = view(command); token_evidence = evidence.get(command.id) });
      if (command.status != "prepared") return #err("Only a prepared operation can refresh the facts for its approval");
      if (request.review_revision != command.review_revision) return #err("review_changed: use the current review before refreshing evidence");
      let tx = switch (command.transaction) { case null return #err("Message signatures do not have ERC20 transaction evidence"); case (?v) v };
      // The signed fields remain identical. A new revision prevents a parallel
      // approval from confirming an older display while observations refresh.
      command.review_revision += 1;
      Set.add(running, Nat.compare, command.id);
      try { await* evidence.capture(command.id, tx, command.address, null) }
      catch (error) { evidence.fail(command.id, "Observation unavailable: " # Error.message(error)) };
      Set.remove(running, Nat.compare, command.id);
      command.updated_at := Time.now();
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
    func prepare(command : Memory.Command) : async* Types.Result<()> {
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
        case (#transaction(request)) await* prepareTransaction(command, a, request, null);
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
          await* prepareTransaction(command, a, replacement, ?tx.nonce);
        };
      };
    };
    func prepareTransaction(command : Memory.Command, a : Memory.Account, request : Memory.TransactionRequest, replacementNonce : ?Nat) : async* Types.Result<()> {
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
      let block = switch (await* rpcText(chain, "eth_blockNumber", "[]")) { case (#err(e)) return #err(e); case (#ok(v)) v };
      let balance = switch (await* rpcNat(chain, "eth_getBalance", "[" # q(a.address) # "," # q(block) # "]")) { case (#err(e)) return #err(e); case (#ok(v)) v };
      let observedNonce = switch (await* rpcNat(chain, "eth_getTransactionCount", "[" # q(a.address) # ",\"pending\"]")) { case (#err(e)) return #err(e); case (#ok(v)) v };
      journal.observeNonce(a.id, chain, observedNonce);
      let nonce = switch (replacementNonce) {
        case null journal.nextNonce(a.id, chain, observedNonce);
        case (?n) {
          let mined = switch (await* rpcNat(chain, "eth_getTransactionCount", "[" # q(a.address) # "," # q(block) # "]")) { case (#err(e)) return #err(e); case (#ok(v)) v };
          if (n < mined) return #err("Replacement nonce is already mined; reconcile the original first");
          n;
        };
      };
      let legacyPrice = switch (request.gas_price, request.transaction_type) {
        case (?p, _) ?p;
        case (null, ?"legacy") switch (await* rpcNat(chain, "eth_gasPrice", "[]")) { case (#err(e)) return #err(e); case (#ok(v)) ?Nat.toText(v) };
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
              case null switch (await* rpcNat(chain, "eth_maxPriorityFeePerGas", "[]")) { case (#err(e)) return #err(e); case (#ok(v)) v };
            };
            let maxFeePerGas = switch (request.max_fee_per_gas) {
              case (?p) switch (uint(p)) { case (#err(e)) return #err(e); case (#ok(v)) v };
              case null {
                let blockValue = switch (await* rpcJson(chain, "eth_getBlockByNumber", "[" # q(block) # ",false]")) { case (#err(e)) return #err(e); case (#ok(v)) v };
                let base = switch (fieldNat(blockValue, "baseFeePerGas")) { case (#err(e)) return #err(e); case (#ok(v)) v };
                base * 2 + maxPriorityFeePerGas;
              };
            };
            #eip1559({ maxFeePerGas; maxPriorityFeePerGas });
          };
        };
      };
      switch (Transaction.validate(fee)) { case (#err(e)) return #err(e); case (_) {} };
      let callObject = txObject(fee, a.address, false);
      let estimate = switch (await* rpcNat(chain, "eth_estimateGas", "[" # callObject # "]")) { case (#err(e)) return #err("Gas estimation failed: " # e); case (#ok(v)) v };
      let gasLimit = switch (request.gas_limit) {
        case null estimate; case (?g) switch (uint(g)) { case (#err(e)) return #err(e); case (#ok(v)) { if (v < estimate) return #err("Requested gas limit is below the live estimate"); v } };
      };
      let tx = { fee with gasLimit };
      switch (Transaction.validate(tx)) { case (#err(e)) return #err(e); case (_) {} };
      if (balance < value + gasLimit * maxGasPrice(tx)) return #err("Insufficient native gas balance for value plus the authorized maximum fee");
      let simulation = switch (await* rpcText(chain, "eth_call", "[" # txObject(tx, a.address, true) # "," # q(block) # "]")) { case (#err(e)) return #err("Simulation failed: " # e); case (#ok(v)) v };
      command.transaction := ?tx;
      command.review := ?{
        nonce = Nat.toText(nonce); gas_limit = Nat.toText(gasLimit);
        max_fee_per_gas = switch (tx.fee) { case (#eip1559(f)) ?Nat.toText(f.maxFeePerGas); case (_) null };
        max_priority_fee_per_gas = switch (tx.fee) { case (#eip1559(f)) ?Nat.toText(f.maxPriorityFeePerGas); case (_) null };
        gas_price = switch (tx.fee) { case (#legacy(f)) ?Nat.toText(f.gasPrice); case (_) null };
        balance = Nat.toText(balance); simulation; observed_at = Time.now();
      };
      try { await* evidence.capture(command.id, tx, a.address, ?block) }
      catch (error) { evidence.fail(command.id, "Observation unavailable: " # Error.message(error)) };
      #ok(());
    };
    func broadcast(command : Memory.Command) : async* () {
      let raw = switch (command.signed_raw) { case null return; case (?v) v };
      command.status := "submitted"; command.updated_at := Time.now();
      switch (await* rpc.request(command.intent.chain_id, "eth_sendRawTransaction", "[" # q(Hex.encode(raw)) # "]")) {
        case (#err(e)) { command.status := "unknown"; command.message := ?("Broadcast outcome requires reconciliation: " # e) };
        case (#ok(response)) {
          switch (parse(response)) {
            case (#ok(#null_)) { command.message := null };
            case (#ok(#string(hash))) {
              if (?Text.toLower(hash) != command.transaction_hash) { command.status := "unknown"; command.message := ?"RPC returned a different transaction hash" } else command.message := null;
            };
            case (_) { command.status := "unknown"; command.message := ?"RPC returned an unexpected broadcast response" };
          };
        };
      };
    };
    func reconcile(command : Memory.Command) : async* () {
      if (command.status == "signing") {
        command.status := "unknown"; command.message := ?"Signing was interrupted. This operation will not sign again.";
      };
      let hash = switch (command.transaction_hash) { case null return; case (?v) v };
      let chain = command.intent.chain_id;
      let response = switch (await* rpc.request(chain, "eth_getTransactionReceipt", "[" # q(hash) # "]")) { case (#err(e)) { command.message := ?("Receipt unavailable: " # e); return }; case (#ok(v)) v };
      let receipt = switch (parse(response)) { case (#err(e)) { command.message := ?e; return }; case (#ok(v)) v };
      switch (receipt) {
        case (#null_) {
          if (command.receipt_json != null) { command.receipt_json := null; command.finality := null; command.status := "unknown"; command.message := ?"Previously observed receipt disappeared; possible reorganization." };
          // Never revive a transfer after an owner-approved replacement has
          // started signing. A replacement may itself have an unknown reply.
          switch (superseding(command)) {
            case (?replacement) {
              command.status := "unknown";
              command.replacement_hash := replacement.transaction_hash;
              command.message := ?"A later same-nonce replacement supersedes this operation. The original bytes will not be rebroadcast.";
              switch (replacement.transaction_hash) {
                case null {};
                case (?replacementHash) {
                  switch (await* evm_wallet_transaction_v1({ chain_id = chain; transaction_hash = replacementHash; wallet_request = null })) {
                    case (#ok(result)) switch (result.receipt_json) {
                      case (?_) { command.status := "replaced"; command.receipt_json := null; command.finality := null; command.message := ?("Nonce consumed by the canonical replacement " # replacementHash) };
                      case null {};
                    };
                    case (#err(_)) {};
                  };
                };
              };
              command.updated_at := Time.now();
              return;
            };
            case null {};
          };
          let transaction = switch (await* rpcJson(chain, "eth_getTransactionByHash", "[" # q(hash) # "]")) { case (#err(e)) { command.message := ?e; return }; case (#ok(v)) v };
          switch (transaction) {
            case (#null_) { await* broadcast(command) };
            case (_) { command.status := "submitted"; command.message := ?"Transaction is known to providers and awaits a receipt." };
          };
        };
        case (_) {
          let receiptHash = switch (fieldText(receipt, "transactionHash")) { case (#err(e)) { command.message := ?e; return }; case (#ok(v)) Text.toLower(v) };
          if (receiptHash != hash) { command.message := ?"RPC receipt hash does not match the signed transaction"; return };
          let number = switch (fieldNat(receipt, "blockNumber")) { case (#err(e)) { command.message := ?e; return }; case (#ok(v)) v };
          let blockHash = switch (fieldText(receipt, "blockHash")) { case (#err(e)) { command.message := ?e; return }; case (#ok(v)) v };
          let block = switch (await* rpcJson(chain, "eth_getBlockByNumber", "[" # q(quantity(number)) # ",false]")) { case (#err(e)) { command.message := ?e; return }; case (#ok(v)) v };
          switch (fieldText(block, "hash")) {
            case (#ok(v)) if (Text.toLower(v) != Text.toLower(blockHash)) { command.status := "unknown"; command.receipt_json := null; command.finality := null; command.message := ?"Receipt belongs to a block no longer canonical"; return };
            case (#err(e)) { command.message := ?e; return };
            case (_) {};
          };
          let status = switch (fieldNat(receipt, "status")) { case (#err(e)) { command.message := ?e; return }; case (#ok(v)) v };
          if (status > 1) { command.message := ?"Unexpected receipt execution status"; return };
          command.receipt_json := ?response; command.status := if (status == 1) "confirmed" else "reverted";
          command.replacement_hash := null;
          command.finality := ?"included"; command.message := null;
          for (tag in ["safe", "finalized"].vals()) {
            switch (await* rpcJson(chain, "eth_getBlockByNumber", "[" # q(tag) # ",false]")) {
              case (#ok(head)) switch (fieldNat(head, "number")) { case (#ok(n)) if (n >= number) command.finality := ?tag; case (_) {} };
              case (#err(_)) {};
            };
          };
        };
      };
      command.updated_at := Time.now();
    };
    func superseding(command : Memory.Command) : ?Memory.Command {
      let tx = switch (command.transaction) { case null return null; case (?v) v };
      var selected : ?Memory.Command = null;
      for ((_, candidate) in Map.entries(mem.commands)) {
        if (candidate.id > command.id and candidate.intent.chain_id == command.intent.chain_id and candidate.intent.account_id == command.intent.account_id and candidate.reserved_nonce) {
          switch (candidate.transaction) {
            case (?other) if (other.nonce == tx.nonce and (candidate.signed_raw != null or candidate.status == "signing" or candidate.status == "unknown")) {
              switch (selected) { case null selected := ?candidate; case (?previous) if (candidate.id > previous.id) selected := ?candidate };
            };
            case (_) {};
          };
        };
      };
      selected;
    };
    func view(command : Memory.Command) : Types.Operation {
      Journal.view(command);
    };
    func supported(chain : Nat) : Bool = Map.containsKey(mem.networks, Nat.compare, chain);
    func snapshot() : Types.Snapshot {
      { accounts = Array.fromIter(Map.values(mem.accounts)); networks = Array.fromIter(Map.values(mem.networks)); assets = Array.fromIter(Map.values(mem.assets)); lifecycle = "The installation owns this custody namespace. Compatible upgrades preserve the account. Uninstall/reinstall rotates its key and cannot recover this address. There is no seed or private-key export." };
    };
    func rpcJson(chain : Nat, method : Text, params : Text) : async* Types.Result<JSON.Json> {
      switch (await* rpc.request(chain, method, params)) { case (#err(e)) #err(e); case (#ok(v)) parse(v) };
    };
    func rpcText(chain : Nat, method : Text, params : Text) : async* Types.Result<Text> {
      switch (await* rpcJson(chain, method, params)) { case (#err(e)) #err(e); case (#ok(#string(v))) #ok(v); case (_) #err("RPC returned a non-string result") };
    };
    func rpcNat(chain : Nat, method : Text, params : Text) : async* Types.Result<Nat> {
      switch (await* rpcText(chain, method, params)) { case (#err(e)) #err(e); case (#ok(v)) RpcJson.quantityText(v) };
    };
  };
  func q(text : Text) : Text = JSON.stringify(#string(text), null);
  func parse(text : Text) : Types.Result<JSON.Json> {
    RpcJson.parse(text);
  };
  func field(value : JSON.Json, name : Text) : ?JSON.Json {
    switch (value) { case (#object_(fields)) { for ((key, v) in fields.vals()) if (key == name) return ?v; null }; case (_) null };
  };
  func fieldText(value : JSON.Json, name : Text) : Types.Result<Text> {
    switch (field(value, name)) { case (?#string(v)) #ok(v); case (_) #err("RPC result lacks string field " # name) };
  };
  func fieldNat(value : JSON.Json, name : Text) : Types.Result<Nat> {
    switch (fieldText(value, name)) { case (#ok(v)) RpcJson.quantityText(v); case (#err(e)) #err(e) };
  };
  func uint(value : Text) : Types.Result<Nat> {
    switch (Hex.parseNat(value)) { case (#err(e)) #err(e); case (#ok(v)) { if (v >= Hex.uint256Limit) #err("Amount exceeds uint256") else #ok(v) } };
  };
  func validateAddress(value : Text) : Types.Result<Text> {
    switch (Hex.decode(value)) { case (#err(e)) #err(e); case (#ok(bytes)) { if (bytes.size() != 20) #err("EVM address must contain 20 bytes") else #ok(Hex.encode(bytes)) } };
  };
  func quantity(value : Nat) : Text {
    if (value == 0) return "0x0";
    let bytes = Text.toArray(Hex.encode(Hex.nat(value)));
    if (bytes[2] != '0') return Text.fromArray(bytes);
    "0x" # Text.fromArray(Array.sliceToArray(bytes, 3, bytes.size()));
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
  func txObject(tx : Memory.Transaction, from : Text, includeGas : Bool) : Text {
    let fields = List.empty<(Text, JSON.Json)>();
    for ((key, value) in [("from", from), ("value", quantity(tx.value)), ("data", Hex.encode(tx.data)), ("nonce", quantity(tx.nonce))].vals()) List.add(fields, (key, #string(value)));
    switch (tx.to) { case (?v) List.add(fields, ("to", #string(v))); case null {} };
    if (includeGas) List.add(fields, ("gas", #string(quantity(tx.gasLimit))));
    switch (tx.fee) {
      case (#legacy(f)) List.add(fields, ("gasPrice", #string(quantity(f.gasPrice))));
      case (#eip1559(f)) {
        List.add(fields, ("maxFeePerGas", #string(quantity(f.maxFeePerGas))));
        List.add(fields, ("maxPriorityFeePerGas", #string(quantity(f.maxPriorityFeePerGas))));
        List.add(fields, ("type", #string("0x2")));
        List.add(fields, ("accessList", #array(Array.map<Memory.AccessEntry, JSON.Json>(tx.accessList, func(entry) { #object_([("address", #string(entry.address)), ("storageKeys", #array(Array.map<Text, JSON.Json>(entry.storageKeys, func(v) { #string(v) })))]) }))));
      };
    };
    JSON.stringify(#object_(List.toArray(fields)), null);
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

/*---NEUTRON GENERATED END---*/
};
