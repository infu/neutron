// All rights reserved. See ../LICENSE.
import Array "mo:core/Array";
import Int "mo:core/Int";
import List "mo:core/List";
import Map "mo:core/Map";
import Nat8 "mo:core/Nat8";
import Nat32 "mo:core/Nat32";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
import API "./API";
import Accounting "./Accounting";
import Billing "./Billing";
import Catalog "./Catalog";
import Encoding "./Encoding";
import Pricing "./Pricing";
import Purchases "./Purchases";
import Referrals "./Referrals";
import Store "./Store";
import Types "./Types";

module {
  func error<T>(code : Text, message : Text) : API.Result<T> { #err({ code; message }) };

  public func token(db : Store.DB, ledger : Principal) : ?Types.TokenConfig {
    for (value in Store.config(db).tokens.vals()) if (value.ledger == ledger) return ?value;
    null;
  };

  public func purchaseIntent(request : API.PurchaseRequest) : Blob {
    Encoding.hash(to_candid("neutron.marketplace.purchase.intent.v1", request.requestId,
      Array.sort<Text>(request.appIds, Text.compare), request.ledger, request.referralCode));
  };

  public func withdrawalIntent(request : API.WithdrawalRequest) : Blob {
    Encoding.hash(to_candid("neutron.marketplace.withdrawal.intent.v1", request));
  };

  public func withdrawalCommitment(marketplace : Principal, owner : Principal, request : API.WithdrawalRequest, fee : Nat) : Blob {
    Encoding.hash(to_candid("neutron.marketplace.withdrawal.quote.v1", marketplace, owner, request, fee));
  };

  public func order(quote : API.CheckoutQuote, now : Int) : Types.CreateOrder {
    {
      owner = quote.buyer; requestId = quote.request.requestId;
      intentHash = purchaseIntent(quote.request); quoteCommitment = quote.commitment;
      ledger = quote.request.ledger; amount = quote.amount; fee = quote.fee;
      affiliate = quote.affiliate; rateId = switch (quote.rate) { case null 0; case (?rate) rate.id };
      items = quote.items; state = #prepared; currentAttempt = null;
      createdAtNs = now; updatedAtNs = now; finalizedAtNs = null; lastError = null;
    };
  };

  // Resolve the same latest-approved dependency graph the installer consumes,
  // before any allowance or collection. Ownership removes a price line, not a
  // graph edge: an already-owned dependency can itself require an unowned app.
  func purchaseApps(db : Store.DB, buyer : Principal, roots : [Text]) : API.Result<[Types.App]> {
    let apps = List.empty<Types.App>();
    let releases = Map.empty<Text, Types.Candidate>();
    let pending = List.empty<{ appId : Text; minimum : Nat; root : Bool }>();
    var previous : ?Text = null;
    for (appId in Array.sort<Text>(roots, Text.compare).vals()) {
      if (previous == ?appId) return error("duplicate_app", "Select each app once.");
      previous := ?appId;
      if (appId == "kernel") return error("invalid_app", "Upgrade the Kernel through Settings; it is not an app purchase.");
      List.add(pending, { appId; minimum = 100; root = true });
    };
    // Iterative traversal avoids consuming the call stack on long dependency
    // chains. Mark before adding children so shared and cyclic edges terminate.
    label walk loop {
      let ?required = List.removeLast(pending) else break walk;
      if (required.appId != "kernel") {
        switch (Map.get(releases, Text.compare, required.appId)) {
          case (?release) {
            // Every edge still checks its minimum, even if another root or
            // dependency already visited this same app at a lower minimum.
            if (release.version < required.minimum) return error("dependency_version", "The latest approved " # required.appId # " release does not satisfy the dependency minimum.");
          };
          case null {
            let ?app = Store.getApp(db, required.appId) else return error(
              if (required.root) "app_missing" else "dependency_unavailable",
              "No marketplace app exists for " # required.appId # ".");
            let ?release = Catalog.approvedRelease(db, app) else return error("not_available", "No approved published release is available for " # required.appId # ".");
            if (release.version < required.minimum) return error("dependency_version", "The latest approved " # required.appId # " release does not satisfy the dependency minimum.");
            let owned = Store.getEntitlement(db, buyer, app.appId) != null;
            if (not owned and not app.visible) return error("not_available", "This required app is not available to acquire: " # app.appId # ".");
            Map.add(releases, Text.compare, app.appId, release);
            if (not owned) List.add(apps, app);
            for (dependency in release.dependencies.vals()) {
              // The existing installer validates Kernel compatibility against
              // the installed Kernel; it never installs it in an app bundle.
              if (dependency.appId != "kernel") List.add(pending, { appId = dependency.appId; minimum = dependency.minVersion; root = false });
            };
          };
        };
      };
    };
    #ok(List.toArray(apps));
  };

  public func purchase(db : Store.DB, marketplace : Principal, buyer : Principal, request : API.PurchaseRequest, now : Int) : API.Result<API.CheckoutQuote> {
    if (not Catalog.hasText(request.requestId)) return error("request_id", "A purchase request ID is required.");
    if (request.appIds.size() == 0) return error("empty_cart", "Select an app to acquire.");
    let ?paymentToken = token(db, request.ledger) else return error("payment_token", "Select ICP, ckBTC or ckUSDC from this marketplace's supported tokens.");
    let affiliate = switch (Referrals.resolve(db, buyer, request.referralCode)) {
      case (#err(message)) return error("referral", message);
      case (#ok(null)) null;
      case (#ok(?value)) ?value.owner;
    };
    let appRows = switch (purchaseApps(db, buyer, request.appIds)) { case (#ok(value)) value; case (#err(value)) return #err(value) };
    let rate = Store.getRate(db, request.ledger);
    let pricingRate : ?Pricing.Rate = switch (rate) {
      case null null;
      case (?value) ?{ rate = value.usdRate; decimals = Nat32.toNat(value.decimals); observedAt = Nat64.fromNat(Int.abs(value.observedAtNs)) };
    };
    let prices = Array.map<Types.App, Pricing.Item>(appRows, func(app) { { appId = app.appId; publisher = app.owner; usdMicros = app.priceUsdMicros } });
    let price = switch (Pricing.priceCartWithTerms(prices, buyer, affiliate, Nat8.toNat(paymentToken.decimals), pricingRate, Store.config(db).referralTerms)) {
      case (#err(message)) return error("price_unavailable", message);
      case (#ok(value)) value;
    };
    let items = Array.map<Pricing.Line, Types.PurchaseItem>(price.lines, func(line) {
      // All rows came from the same synchronous snapshot, before any await.
      let ?app = Store.getApp(db, line.appId) else Runtime.trap("Quoted app disappeared from the synchronous snapshot");
      let ?release = Catalog.approvedRelease(db, app) else Runtime.trap("Quoted release disappeared from the synchronous snapshot");
      {
        appId = line.appId; listingRevision = app.revision; publisher = line.publisher;
        priceUsdMicros = line.usdMicros; paidAtoms = line.paidAtoms;
        developerAtoms = line.developerAtoms; affiliateAtoms = line.affiliateAtoms;
        burnAtoms = line.burnAtoms; releaseDigest = release.digest;
      };
    });
    let fee = if (price.paymentAtoms == 0) 0 else paymentToken.fee;
    let priceObservation = switch (rate) { case null null; case (?value) ?(value.ledger, value.usdRate, value.decimals, value.observedAtNs) };
    let commitment = Encoding.hash(to_candid("neutron.marketplace.purchase.quote.v1", marketplace,
      buyer, purchaseIntent(request), items, price.paymentAtoms, fee, affiliate, priceObservation, Store.config(db).referralTerms));
    let preliminary : API.CheckoutQuote = {
      request; buyer; items; amount = price.paymentAtoms; fee; affiliate; rate;
      spender = { owner = marketplace; subaccount = null };
      commitment; cycles = Billing.quote(Store.config(db).fees, #purchase, 0, 0);
      quotedAtNs = now;
    };
    #ok({ preliminary with spender = { owner = marketplace; subaccount = ?Purchases.spenderSubaccount(marketplace, order(preliminary, now)) } });
  };

  public func samePurchase(left : API.CheckoutQuote, right : API.CheckoutQuote) : Bool {
    // Diagnostics and observation-display timestamps cannot change a payment.
    // The commitment binds the successful oracle snapshot and split terms;
    // the remaining fields bind the exact reviewed effect and cycle estimate.
    to_candid(left.request, left.buyer, left.items, left.amount, left.fee, left.affiliate, left.spender, left.commitment, left.cycles) ==
    to_candid(right.request, right.buyer, right.items, right.amount, right.fee, right.affiliate, right.spender, right.commitment, right.cycles);
  };

  public func withdrawal(db : Store.DB, marketplace : Principal, owner : Principal, request : API.WithdrawalRequest) : API.Result<API.WithdrawalQuote> {
    if (not Catalog.hasText(request.requestId)) return error("request_id", "A withdrawal request ID is required.");
    if (Principal.isAnonymous(request.to.owner)) return error("recipient", "Choose a non-anonymous receiving account.");
    switch (request.to.subaccount) { case (?subaccount) if (subaccount.size() != 32) return error("subaccount", "A ledger subaccount must contain 32 bytes."); case (_) {} };
    let ?paymentToken = token(db, request.ledger) else return error("payment_token", "Unsupported payment token.");
    let available = switch (Store.getCredit(db, request.ledger, owner, false)) { case null 0; case (?credit) credit.available };
    if (request.totalDebit > available) return error("earnings_balance", "Withdraw an amount within your available earnings.");
    let netAmount = switch (Accounting.netPayout(request.totalDebit, paymentToken.fee)) {
      case (#err(message)) return error("withdrawal_amount", message);
      case (#ok(value)) value;
    };
    #ok({
      request; owner; fee = paymentToken.fee; netAmount; available;
      commitment = withdrawalCommitment(marketplace, owner, request, paymentToken.fee);
      cycles = Billing.quote(Store.config(db).fees, #withdraw, 0, 0);
    });
  };

  public func withdrawalRecord(quote : API.WithdrawalQuote, now : Int) : Types.CreateWithdrawal {
    {
      owner = quote.owner; requestId = quote.request.requestId; intentHash = withdrawalIntent(quote.request);
      ledger = quote.request.ledger; to = quote.request.to; totalDebit = quote.request.totalDebit;
      fee = quote.fee; isBurn = false; state = #prepared; currentAttempt = null;
      createdAtNs = now; updatedAtNs = now; finalizedAtNs = null; lastError = null;
    };
  };
}
