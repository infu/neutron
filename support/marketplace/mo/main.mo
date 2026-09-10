// All rights reserved. See ../LICENSE.
import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Cycles "mo:core/Cycles";
import Nat8 "mo:core/Nat8";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Time "mo:core/Time";
import Timer "mo:core/Timer";
import API "./API";
import Access "./Access";
import Assets "./Assets";
import Audits "./Audits";
import BatchPublishing "./BatchPublishing";
import Billing "./Billing";
import Catalog "./Catalog";
import Certification "./Certification";
import EvmAPI "./EvmAPI";
import EvmBilling "./EvmBilling";
import EvmEvidence "./EvmEvidence";
import EvmMinter "./EvmMinter";
import EvmPayments "./EvmPayments";
import EvmRpc "./EvmRpc";
import Http "./Http";
import Initialization "./Initialization";
import Jobs "./Jobs";
import Ledger "./Ledger";
import Operations "./Operations";
import Publishing "./Publishing";
import Rankings "./Rankings";
import Rates "./Rates";
import Ratings "./Ratings";
import Referrals "./Referrals";
import Repository "./Repository";
import Store "./Store";
import Types "./Types";
import Views "./Views";

persistent actor class Marketplace(initial : Types.Init) = this {
  // These two roots are retained on upgrades. Constructors never substitute
  // new data for an existing root, and no reinstall path is used for releases.
  let memory = Initialization.memory(initial, Time.now());
  let certificationMemory = Http.init();
  transient let db = Store.Use(memory);
  transient let source = Principal.fromActor(this);
  transient let operations = Operations.Service(db, source, Time.now);
  transient let repository = Repository.Service(db, certificationMemory, source);
  transient let http = Http.Store(certificationMemory, {
    artifact = func(path : Text) : ?Http.Artifact {
      switch (repository.artifact(path)) { case (?value) ?value; case null Certification.artifact(db, path) };
    };
    chunk = func(path : Text, index : Nat) : ?Blob {
      if (repository.isMetadata(path)) repository.chunk(path, index) else Certification.chunk(db, path, index);
    };
    authorize = func(path : Text, bearer : ?Text) : Bool {
      repository.isMetadata(path) or Access.authorizeHttp(db, path, bearer);
    };
  });
  transient let certificates = Certification.Service(db, http);
  transient let jobs = Jobs.Engine(db, operations.withdrawals, source, Time.now, Rates.client());
  transient var timer : ?Timer.TimerId = null;
  transient var maintenanceActive = false;
  transient var ethereumTimer : ?Timer.TimerId = null;
  transient var ethereumMaintenanceActive = false;

  func failure<T>(code : Text, message : Text) : API.Result<T> { #err({ code; message }) };
  func writer(caller : Principal) : API.Result<Principal> {
    let bytes = Principal.toBlob(caller);
    if (bytes.size() == 0 or bytes[bytes.size() - 1] != (1 : Nat8)) return failure("neutron_required", "Send this update through your Neutron with its quoted native cycles attached.");
    #ok(caller);
  };
  func publisher(caller : Principal) : API.Result<Principal> {
    if (Access.isTrustedPublisher(db, caller)) #ok(caller) else writer(caller);
  };
  func publisherCharge<system>(caller : Principal, operation : Billing.Operation, args : Blob, feeVersion : Nat) : API.Result<Nat> {
    if (Access.isTrustedPublisher(db, caller)) #ok(0) else charge<system>(operation, args, 0, feeVersion);
  };
  func viewer(caller : Principal) : ?Principal {
    switch (Access.readOwner(db, caller)) { case (#ok(owner)) ?owner; case (#err(_)) null };
  };
  func charge<system>(operation : Billing.Operation, args : Blob, newBytes : Nat, feeVersion : Nat) : API.Result<Nat> {
    Billing.accept<system>(Billing.quote(Store.config(db).fees, operation, args.size(), newBytes), feeVersion);
  };
  func fixedCharge<system>(operation : Billing.Operation, feeVersion : Nat) : API.Result<Nat> {
    Billing.accept<system>(Billing.quote(Store.config(db).fees, operation, 0, 0), feeVersion);
  };
  func changedApp(appId : Text) {
    repository.refreshApp(http, appId);
    certificates.refreshApp(appId);
  };
  transient let ethereum = EvmPayments.Service(db, source, Time.now, {
    ledger = Ledger.client();
    minter = EvmMinter.client();
    verify = func(expected : EvmEvidence.Expected) : async* EvmRpc.Result<EvmEvidence.Proof> {
      await* EvmEvidence.verifyWith(
        EvmRpc.client(Principal.fromText("7hfb6-caaaa-aaaar-qadga-cai")),
        EvmBilling.rpcOptions,
        expected,
      );
    };
  }, func(order : Types.Order, block : ?Nat, now : Int) {
    for (item in order.items.vals()) {
      ignore Rankings.recordAcquisition(db, {
        owner = order.owner; appId = item.appId; orderId = order.id;
        kind = if (item.priceUsdMicros == 0) #free else #paid;
        atNs = now; paidAtoms = item.paidAtoms;
        ledger = if (item.paidAtoms == 0) null else ?order.ledger; block;
      });
      changedApp(item.appId);
    };
  });
  func validateConfig() {
    let config = Store.config(db);
    if (config.admins.size() == 0) Runtime.trap("Configure at least one marketplace administrator.");
    for (admin in config.admins.vals()) {
      if (Principal.isAnonymous(admin) or Principal.toBlob(admin).size() == 0) Runtime.trap("An administrator must have an authenticated principal.");
    };
    for (auditor in config.auditors.vals()) if (Principal.isAnonymous(auditor)) Runtime.trap("An auditor cannot be anonymous.");
    if (not Billing.validSchedule(config.fees)) Runtime.trap("Configure explicit positive fixed cycle estimates before installation.");
    let terms = config.referralTerms;
    if (terms.version == 0 or terms.discountBps > 10_000 or terms.affiliateBps + terms.developerBps > 10_000) Runtime.trap("Marketplace referral allocations are invalid.");
    for (token in config.tokens.vals()) {
      if (Principal.isAnonymous(token.ledger)) Runtime.trap("A payment ledger must be configured.");
      switch (token.burnAccount) {
        case (?account) {
          if (Principal.isAnonymous(account.owner)) Runtime.trap("A burning destination cannot be anonymous.");
          switch (account.subaccount) { case (?sub) if (sub.size() != 32) Runtime.trap("A burning subaccount must contain 32 bytes."); case (_) {} };
        };
        case null {};
      };
    };
  };
  func armTimer<system>() {
    timer := ?Timer.setTimer<system>(#seconds 60, func() : async () {
      timer := null;
      if (not maintenanceActive) {
        maintenanceActive := true;
        try {
          await async {
            ignore await* jobs.tick();
            // This is an internal work batch, not a limit on purchases or apps.
            // A backlog retains its coherent generation until caught up.
            ignore Rankings.advance(db, Time.now(), 500);
          };
        } catch (_) {};
        maintenanceActive := false;
      };
      armTimer<system>();
    });
  };
  func armEthereumTimer<system>(seconds : Nat) {
    ethereumTimer := ?Timer.setTimer<system>(#seconds seconds, func() : async () {
      ethereumTimer := null;
      var moreDue = false;
      if (not ethereumMaintenanceActive) {
        ethereumMaintenanceActive := true;
        // Keep durable settlement separate from daily oracle/forwarding work.
        // The outer message restores driver liveness after a local trap; the
        // invoice and exact ledger attempt remain the source of recovery truth.
        try { moreDue := await async { await* ethereum.tick() } } catch (_) {};
        ethereumMaintenanceActive := false;
      };
      // Drain due work without delaying buyer-initiated updates. Idle invoices
      // retain their own persisted next-check time; this is only scheduling.
      armEthereumTimer<system>(if (moreDue) 1 else 30);
    });
  };
  validateConfig();
  http.initialize();
  repository.initialize(http);
  armTimer<system>();
  armEthereumTimer<system>(1);
  system func postupgrade() {
    // Timers and in-flight driver flags are intentionally disposable. Durable
    // jobs and immutable ledger attempts decide what can resume after upgrade.
    repository.initialize(http);
    certificates.refreshAllGrants();
  };

  public query func marketplace_info() : async API.Info {
    let config = Store.config(db);
    { version = 1; canister = source; trustedPublishingPrincipal = Store.getTrustedPublishingPrincipal(db); tokens = config.tokens; fees = config.fees; referralTerms = config.referralTerms };
  };
  public query func fee_quote(request : API.FeeRequest) : async Billing.Quote {
    Billing.quote(Store.config(db).fees, request.operation, request.processingBytes, request.newStorageBytes);
  };
  public shared query ({ caller }) func catalog_query(request : API.CatalogRequest) : async API.Result<API.CatalogPage> {
    Views.catalog(db, source, viewer(caller), request, Time.now());
  };
  public shared query ({ caller }) func app_detail(appId : Text) : async API.Result<API.AppDetail> {
    Views.detail(db, source, viewer(caller), appId);
  };
  public shared query ({ caller }) func library_query(request : API.PageRequest) : async API.Result<API.AppPage> {
    let owner = switch (Access.readOwner(db, caller)) { case (#err(value)) return #err(value); case (#ok(value)) value };
    Views.library(db, source, owner, request);
  };
  public shared query ({ caller }) func publisher_apps(request : API.PageRequest) : async API.Result<API.AppPage> {
    let owner = switch (Access.readOwner(db, caller)) { case (#err(value)) return #err(value); case (#ok(value)) value };
    Views.publisherApps(db, source, owner, request);
  };
  public shared query ({ caller }) func earnings_query() : async API.Result<API.Earnings> {
    let owner = switch (Access.readOwner(db, caller)) { case (#err(value)) return #err(value); case (#ok(value)) value };
    #ok(Views.earnings(db, owner));
  };
  public shared ({ caller }) func read_delegate_set(request : API.ReadDelegateRequest) : async API.Result<()> {
    let owner = switch (writer(caller)) { case (#err(value)) return #err(value); case (#ok(value)) value };
    switch (charge<system>(#update, to_candid(request), 0, request.feeVersion)) { case (#err(value)) return #err(value); case (_) {} };
    Access.setDelegate(db, owner, request.browser, request.active, Time.now());
  };
  public shared ({ caller }) func listing_save(request : API.ListingRequest) : async API.Result<API.App> {
    let owner = switch (publisher(caller)) { case (#err(value)) return #err(value); case (#ok(value)) value };
    switch (publisherCharge<system>(caller, #update, to_candid(request), request.feeVersion)) { case (#err(value)) return #err(value); case (_) {} };
    let visible = switch (Store.getApp(db, request.appId)) { case null true; case (?value) value.visible };
    switch (Catalog.save(db, owner, { request with visible }, Time.now())) {
      case (#err(message)) failure("listing", message);
      case (#ok(app)) { changedApp(app.appId); #ok(Views.app(db, source, ?owner, app)) };
    };
  };
  public shared ({ caller }) func rating_set(request : API.RatingRequest) : async API.Result<Types.Rating> {
    let owner = switch (writer(caller)) { case (#err(value)) return #err(value); case (#ok(value)) value };
    switch (charge<system>(#update, to_candid(request), 0, request.feeVersion)) { case (#err(value)) return #err(value); case (_) {} };
    switch (Ratings.set(db, owner, request.appId, request.stars, request.review, Time.now())) {
      case (#ok(value)) #ok(value); case (#err(message)) failure("rating", message);
    };
  };
  public shared ({ caller }) func referral_get_or_create(request : API.FeeVersion) : async API.Result<Types.Referral> {
    let owner = switch (writer(caller)) { case (#err(value)) return #err(value); case (#ok(value)) value };
    switch (charge<system>(#update, to_candid(request), 0, request.feeVersion)) { case (#err(value)) return #err(value); case (_) {} };
    #ok(Referrals.getOrCreate(db, owner, Time.now()));
  };

  public shared query ({ caller }) func purchase_quote(request : API.PurchaseRequest) : async API.Result<API.CheckoutQuote> {
    let owner = switch (Access.readOwner(db, caller)) { case (#err(value)) return #err(value); case (#ok(value)) value };
    operations.purchaseQuote(owner, request);
  };
  public shared ({ caller }) func purchase(request : API.PurchaseExecute) : async API.Result<API.PurchaseResult> {
    let owner = switch (writer(caller)) { case (#err(value)) return #err(value); case (#ok(value)) value };
    switch (fixedCharge<system>(#purchase, request.feeVersion)) { case (#err(value)) return #err(value); case (_) {} };
    await* operations.purchase(owner, request.quote);
  };
  public shared query ({ caller }) func purchase_status(request : API.OperationRequest) : async API.Result<?API.PurchaseResult> {
    let owner = switch (Access.readOwner(db, caller)) { case (#err(value)) return #err(value); case (#ok(value)) value };
    if (Store.getEvmInvoiceByRequest(db, owner, request.requestId) != null) {
      return failure("payment_rail", "Use ethereum_status for this invoice's app access, conversion and saved payment evidence.");
    };
    #ok(operations.purchaseStatus(owner, request.requestId));
  };
  public query func ethereum_fees() : async EvmBilling.Fees {
    EvmBilling.quote(Store.config(db).fees);
  };
  public shared query ({ caller }) func ethereum_quote(request : API.PurchaseRequest) : async API.Result<API.CheckoutQuote> {
    let owner = switch (Access.readOwner(db, caller)) { case (#err(value)) return #err(value); case (#ok(value)) value };
    ethereum.quote(owner, request);
  };
  public shared ({ caller }) func ethereum_prepare(request : EvmAPI.PrepareRequest) : async API.Result<EvmAPI.InvoiceResult> {
    let owner = switch (writer(caller)) { case (#err(value)) return #err(value); case (#ok(value)) value };
    switch (Billing.accept<system>(EvmBilling.quote(Store.config(db).fees).prepare, request.feeVersion)) { case (#err(value)) return #err(value); case (_) {} };
    await* ethereum.prepare(owner, request.quote, request.payer);
  };
  public shared ({ caller }) func ethereum_verify(request : EvmAPI.VerifyRequest) : async API.Result<EvmAPI.InvoiceResult> {
    let owner = switch (writer(caller)) { case (#err(value)) return #err(value); case (#ok(value)) value };
    switch (Billing.accept<system>(EvmBilling.quote(Store.config(db).fees).verify, request.feeVersion)) { case (#err(value)) return #err(value); case (_) {} };
    await* ethereum.verify(owner, request.requestId, request.transactionHash);
  };
  public shared ({ caller }) func ethereum_settle(request : EvmAPI.OperationRequest) : async API.Result<EvmAPI.InvoiceResult> {
    let owner = switch (writer(caller)) { case (#err(value)) return #err(value); case (#ok(value)) value };
    switch (Billing.accept<system>(EvmBilling.quote(Store.config(db).fees).settle, request.feeVersion)) { case (#err(value)) return #err(value); case (_) {} };
    await* ethereum.settle(owner, request.requestId);
  };
  public shared ({ caller }) func ethereum_cancel(request : EvmAPI.OperationRequest) : async API.Result<EvmAPI.InvoiceResult> {
    let owner = switch (writer(caller)) { case (#err(value)) return #err(value); case (#ok(value)) value };
    switch (Billing.accept<system>(EvmBilling.quote(Store.config(db).fees).cancel, request.feeVersion)) { case (#err(value)) return #err(value); case (_) {} };
    ethereum.cancel(owner, request.requestId);
  };
  public shared query ({ caller }) func ethereum_status(request : API.OperationRequest) : async API.Result<?EvmAPI.InvoiceResult> {
    let owner = switch (Access.readOwner(db, caller)) { case (#err(value)) return #err(value); case (#ok(value)) value };
    #ok(ethereum.status(owner, request.requestId));
  };
  public shared query ({ caller }) func ethereum_history(request : EvmAPI.HistoryRequest) : async API.Result<EvmAPI.InvoicePage> {
    let owner = switch (Access.readOwner(db, caller)) { case (#err(value)) return #err(value); case (#ok(value)) value };
    if (request.limit == 0) return failure("invalid_page", "Choose a positive invoice history page size.");
    #ok(ethereum.history(owner, request.cursor, request.limit));
  };
  public shared query ({ caller }) func withdraw_quote(request : API.WithdrawalRequest) : async API.Result<API.WithdrawalQuote> {
    let owner = switch (Access.readOwner(db, caller)) { case (#err(value)) return #err(value); case (#ok(value)) value };
    operations.withdrawalQuote(owner, request);
  };
  public shared ({ caller }) func withdraw(request : API.WithdrawalExecute) : async API.Result<API.WithdrawalResult> {
    let owner = switch (publisher(caller)) { case (#err(value)) return #err(value); case (#ok(value)) value };
    if (not Access.isTrustedPublisher(db, caller)) {
      switch (fixedCharge<system>(#withdraw, request.feeVersion)) { case (#err(value)) return #err(value); case (_) {} };
    };
    await* operations.withdraw(owner, request.quote);
  };
  public shared query ({ caller }) func withdraw_status(request : API.OperationRequest) : async API.Result<?API.WithdrawalResult> {
    let owner = switch (Access.readOwner(db, caller)) { case (#err(value)) return #err(value); case (#ok(value)) value };
    #ok(operations.withdrawalStatus(owner, request.requestId));
  };
  public shared query ({ caller }) func operation_history(request : API.OperationHistoryRequest) : async API.Result<API.OperationHistory> {
    let owner = switch (Access.readOwner(db, caller)) { case (#err(value)) return #err(value); case (#ok(value)) value };
    let page = switch (Views.operationRows(db, owner, request)) { case (#err(value)) return #err(value); case (#ok(value)) value };
    // Ethereum invoices have independent access and settlement states. Do not
    // expose them as unfinished IC collections with misleading retry guidance.
    // Keep the underlying page cursor; ethereum_history exposes those invoices.
    let icPurchases = Array.filter<Types.Order>(page.purchases, func(row) { Store.getEvmInvoiceByOrder(db, row.id) == null });
    let purchases = Array.map<Types.Order, API.PurchaseResult>(icPurchases, func(row) {
      let ?result = operations.purchaseStatus(owner, row.requestId) else Runtime.trap("Retained purchase is unavailable");
      result;
    });
    let withdrawals = Array.map<Types.Withdrawal, API.WithdrawalResult>(page.withdrawals, func(row) {
      let ?result = operations.withdrawalStatus(owner, row.requestId) else Runtime.trap("Retained withdrawal is unavailable");
      result;
    });
    #ok({ purchases; withdrawals; nextPurchaseCursor = page.nextPurchaseCursor; nextWithdrawalCursor = page.nextWithdrawalCursor });
  };

  public shared ({ caller }) func upload_begin(request : API.UploadBegin) : async API.Result<API.UploadStatus> {
    let owner = switch (publisher(caller)) { case (#err(value)) return #err(value); case (#ok(value)) value };
    let bytes = switch (Assets.estimateNewStorage(db, owner, request)) { case (#err(value)) return #err(value); case (#ok(value)) value };
    let estimate = Billing.quote(Store.config(db).fees, #upload, Blob.size(to_candid(request)), bytes);
    if (Access.isTrustedPublisher(db, caller)) {
      // This explicit first-party subsidy accepts no incoming cycles and keeps
      // the normal digest, byte count, ownership and retry checks unchanged.
      return Assets.begin(db, owner, { request with feeVersion = estimate.feeVersion }, { estimate with processingCycles = 0; storageCycles = 0; totalCycles = 0 }, Time.now());
    };
    switch (Billing.accept<system>(estimate, request.feeVersion)) { case (#err(value)) return #err(value); case (_) {} };
    Assets.begin(db, owner, request, estimate, Time.now());
  };
  public shared ({ caller }) func upload_chunk(request : API.UploadChunk) : async API.Result<API.UploadStatus> {
    let owner = switch (publisher(caller)) { case (#err(value)) return #err(value); case (#ok(value)) value };
    switch (publisherCharge<system>(caller, #update, to_candid(request), request.feeVersion)) { case (#err(value)) return #err(value); case (_) {} };
    Assets.chunk(db, owner, request, Time.now());
  };
  public shared ({ caller }) func upload_finish(request : API.UploadFinish) : async API.Result<API.UploadStatus> {
    let owner = switch (publisher(caller)) { case (#err(value)) return #err(value); case (#ok(value)) value };
    switch (publisherCharge<system>(caller, #update, to_candid(request), request.feeVersion)) { case (#err(value)) return #err(value); case (_) {} };
    switch (Assets.finish(db, owner, request, Time.now())) {
      case (#err(value)) #err(value);
      case (#ok(value)) {
        switch (value.artifactId) { case (?id) certificates.refreshArtifact(id); case null {} };
        #ok(value);
      };
    };
  };
  public shared query ({ caller }) func upload_status(request : API.OperationRequest) : async API.Result<API.UploadStatus> {
    let owner = switch (Access.readOwner(db, caller)) { case (#err(value)) return #err(value); case (#ok(value)) value };
    Assets.status(db, owner, request.requestId);
  };
  public shared ({ caller }) func candidate_submit(request : API.CandidateRequest) : async API.Result<Types.Candidate> {
    let owner = switch (publisher(caller)) { case (#err(value)) return #err(value); case (#ok(value)) value };
    switch (publisherCharge<system>(caller, #update, to_candid(request), request.feeVersion)) { case (#err(value)) return #err(value); case (_) {} };
    switch (Publishing.submit(db, owner, request, Time.now())) {
      case (#err(message)) failure("candidate", message);
      case (#ok(value)) { changedApp(value.appId); #ok(value) };
    };
  };
  public shared ({ caller }) func trusted_publish_batch(request : API.TrustedPublishRequest) : async API.Result<Types.PublishBatch> {
    switch (BatchPublishing.publish(db, caller, request, Time.now())) {
      case (#err(value)) #err(value);
      case (#ok(value)) {
        certificates.removeArtifacts(value.retiredArtifacts);
        for (appId in value.appIds.vals()) changedApp(appId);
        #ok(value.batch);
      };
    };
  };
  public shared query ({ caller }) func trusted_publish_status(request : API.OperationRequest) : async API.Result<?Types.PublishBatch> {
    if (not Access.isTrustedPublisher(db, caller)) return failure("trusted_publisher_required", "Only the configured first-party publisher can inspect its publication batches.");
    #ok(Store.getPublishBatch(db, caller, request.requestId));
  };
  public shared query ({ caller }) func audit_queue(request : API.PageRequest) : async API.Result<API.CandidatePage> {
    switch (Audits.queue(db, caller, request.cursor, request.limit)) {
      case (#err(message)) failure("auditor_required", message); case (#ok(value)) #ok(value);
    };
  };
  public shared query ({ caller }) func audit_candidate(id : Nat64) : async API.Result<Types.Candidate> {
    if (not Access.isAuditor(db, caller)) return failure("auditor_required", "Only assigned auditors can inspect the review queue.");
    switch (Store.getCandidate(db, id)) { case null failure("candidate_missing", "Candidate not found."); case (?value) #ok(value) };
  };
  public shared ({ caller }) func audit_stamp(request : API.AuditRequest) : async API.Result<Types.Audit> {
    // Only assigned auditors on this audit endpoint receive the update subsidy.
    switch (Audits.stamp(db, caller, request, Time.now())) {
      case (#err(message)) failure("audit", message);
      case (#ok(value)) { certificates.removeArtifacts(value.retiredArtifacts); changedApp(value.app.appId); #ok(value.audit) };
    };
  };
  public shared ({ caller }) func admin_auditor_set(request : API.AuditorRequest) : async API.Result<()> {
    // Assigned administrators call these administrative endpoints directly
    // from their CLI. This exemption never applies to ordinary user writes.
    // Retain feeVersion in the wire record for existing callers; no cycles are
    // accepted or required on these explicitly exempt endpoints.
    if (not Access.isAdmin(db, caller)) return failure("admin_required", "Only an assigned administrator can change auditors.");
    if (Principal.isAnonymous(request.principal)) return failure("invalid_auditor", "An auditor must have an authenticated principal.");
    let config = Store.config(db);
    let without = Array.filter<Principal>(config.auditors, func(value) { value != request.principal });
    Store.setConfig(db, { config with auditors = if (request.active) Array.concat(without, [request.principal]) else without });
    certificates.refreshOwnerGrants(request.principal);
    #ok(());
  };
  public shared ({ caller }) func admin_reserve_app(request : API.ReservationRequest) : async API.Result<API.App> {
    if (not Access.isAdmin(db, caller)) return failure("admin_required", "Only an administrator can register the publisher of an existing application.");
    ignore switch (publisher(request.publisher)) { case (#err(value)) return #err(value); case (#ok(value)) value };
    switch (Store.getApp(db, request.appId)) {
      case (?app) {
        if (app.owner != request.publisher) return failure("publisher_conflict", "This app ID already belongs to a different publisher. Existing ownership was preserved.");
        return #ok(Views.app(db, source, ?request.publisher, app));
      };
      case null {};
    };
    // Imported IDs are durable owner registrations, not an admission allowlist.
    // No app appears publicly until its publisher submits an approved package.
    switch (Catalog.save(db, request.publisher, {
      appId = request.appId; title = request.title; summary = "Publisher registration awaiting an approved package."; description = "";
      priceUsdMicros = 0; iconArtifact = null; screenshots = [];
      expectedRevision = null; visible = true;
    }, Time.now())) {
      case (#err(message)) failure("reservation", message);
      case (#ok(app)) #ok(Views.app(db, source, ?request.publisher, app));
    };
  };
  public shared ({ caller }) func admin_set_burn_account(request : API.BurnAccountRequest) : async API.Result<()> {
    if (not Access.isAdmin(db, caller)) return failure("admin_required", "Only an administrator can configure the burning service accounts.");
    switch (request.account) {
      case (?account) {
        if (Principal.isAnonymous(account.owner)) return failure("recipient", "A burning destination cannot be anonymous.");
        switch (account.subaccount) { case (?value) if (value.size() != 32) return failure("subaccount", "A subaccount must contain 32 bytes."); case (_) {} };
      };
      case null {};
    };
    let config = Store.config(db);
    if (Array.find<Types.TokenConfig>(config.tokens, func(token) { token.ledger == request.ledger }) == null) return failure("payment_token", "Unsupported payment token.");
    Store.setConfig(db, { config with tokens = Array.map<Types.TokenConfig, Types.TokenConfig>(config.tokens, func(token) {
      if (token.ledger == request.ledger) ({ token with burnAccount = request.account }) else token;
    }) });
    // Already dispatched forwarding attempts retain their original destination.
    #ok(());
  };

  public shared ({ caller }) func repo_access_v1(request : API.RepoAccessRequest) : async API.RepoAccessResult {
    let owner = switch (publisher(caller)) { case (#err(value)) return #err(value); case (#ok(value)) value };
    let saved = Store.getGrant(db, owner, request.request_id);
    let schedule = Store.config(db).fees;
    var accepted = 0;
    if (Access.isTrustedPublisher(db, caller)) {
      for (path in request.paths.vals()) {
        if (not Access.ownsPublishingPath(db, owner, path)) return failure("publisher_required", "First-party source access is limited to this publisher's own files.");
      };
    } else {
      if (request.fee_version != schedule.version) return failure("cycle_fee_version", "Review the current source access estimate before continuing.");
      if (Cycles.available() < schedule.grant) return failure("cycles_required", "Attach the source's fixed access estimate through your Neutron, including when reconciling an interrupted request.");
      if (saved == null) {
        accepted := switch (fixedCharge<system>(#grant, request.fee_version)) { case (#err(value)) return #err(value); case (#ok(value)) value };
      };
    };
    switch (Access.grant(db, owner, request, #publisher, Time.now())) {
      case (#err(value)) #err(value);
      case (#ok(value)) {
        // An exact retry is a receipt lookup. Its existing leaves were already
        // committed; eligibility changes update them in their own transaction.
        if (value.new) certificates.refreshGrant(value.grant);
        #ok({ request_id = value.grant.requestId; paths = value.grant.paths; accepted_cycles = accepted });
      };
    };
  };
  public shared ({ caller }) func audit_access(request : API.RepoAccessRequest) : async API.RepoAccessResult {
    if (not Access.isAuditor(db, caller)) return failure("auditor_required", "Only an assigned auditor can request subsidized review access.");
    switch (Access.grant(db, caller, request, #auditor, Time.now())) {
      case (#err(value)) #err(value);
      case (#ok(value)) {
        certificates.refreshGrant(value.grant);
        #ok({ request_id = value.grant.requestId; paths = value.grant.paths; accepted_cycles = 0 });
      };
    };
  };
  public shared ({ caller }) func install_prepare(request : API.InstallRequest) : async API.Result<API.InstallResult> {
    let owner = switch (writer(caller)) { case (#err(value)) return #err(value); case (#ok(value)) value };
    switch (charge<system>(#update, to_candid(request), 0, request.feeVersion)) { case (#err(value)) return #err(value); case (_) {} };
    repository.prepare(http, owner, request, Time.now());
  };
  public shared ({ caller }) func rates_refresh(_request : API.FeeVersion) : async API.Result<[Rates.RefreshResult]> {
    if (not Access.isAdmin(db, caller)) return failure("admin_required", "Only an administrator can request an extra oracle refresh.");
    // Rates.refresh still attaches the configured XRC budget to each outgoing
    // oracle request. Administrative refreshes are funded by the protocol.
    #ok(await* Rates.refresh(db, Time.now));
  };
  public query func http_request(request : Http.Request) : async Http.Response { http.httpRequest(request, http_streaming_callback) };
  public query func http_streaming_callback(token : Http.Token) : async Http.StreamingResponse { http.stream(token) };
  public query func repo_info(request : { index : Nat }) : async Repository.CertifiedRead { repository.read("/repo/v1/info.json", request.index) };
  public query func repo_manifests(request : { index : Nat }) : async Repository.CertifiedRead { repository.read("/repo/v1/manifests.json", request.index) };
  public query func repo_manifest(request : { id : Text; index : Nat }) : async Repository.CertifiedRead { repository.read("/repo/v1/manifests/" # request.id # ".json", request.index) };
  public query func repo_package(request : { sha256 : Text; index : Nat }) : async Repository.CertifiedRead { repository.absent("/repo/v1/packages/" # request.sha256 # ".neutron") };
}
