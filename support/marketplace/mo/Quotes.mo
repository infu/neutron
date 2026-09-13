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

  public func channelPurchaseIntent(request : API.PurchaseRequest, mode : API.ChannelMode) : Blob {
    Encoding.hash(to_candid("neutron.marketplace.purchase.intent.v2", purchaseIntent(request), mode));
  };

  public type PurchaseSnapshot = { #legacy : API.CheckoutQuote; #channel : API.ChannelCheckoutQuote };

  // Released payment rows retain opaque Candid snapshots. Decode the new
  // envelope explicitly; old snapshots and their commitments remain unchanged.
  public func decodePurchaseSnapshot(content : Blob) : ?PurchaseSnapshot {
    let channel : ?API.ChannelCheckoutQuote = from_candid(content);
    switch (channel) { case (?value) return ?#channel(value); case null {} };
    let legacy : ?API.CheckoutQuote = from_candid(content);
    switch (legacy) { case (?value) ?#legacy(value); case null null };
  };

  public func snapshotQuote(snapshot : PurchaseSnapshot) : API.CheckoutQuote {
    switch (snapshot) { case (#legacy(value)) value; case (#channel(value)) value.quote };
  };

  public func samePurchaseSnapshot(left : PurchaseSnapshot, right : PurchaseSnapshot) : Bool {
    switch (left, right) {
      case (#legacy(a), #legacy(b)) samePurchase(a, b);
      case (#channel(a), #channel(b)) sameChannelPurchase(a, b);
      case (_) false;
    };
  };

  public func snapshotContent(snapshot : PurchaseSnapshot) : Blob {
    switch (snapshot) { case (#legacy(value)) to_candid(value); case (#channel(value)) to_candid(value) };
  };

  public func snapshotOrder(snapshot : PurchaseSnapshot, now : Int) : Types.CreateOrder {
    switch (snapshot) { case (#legacy(value)) order(value, now); case (#channel(value)) channelOrder(value, now) };
  };

  public func channelOrder(quote : API.ChannelCheckoutQuote, now : Int) : Types.CreateOrder {
    { order(quote.quote, now) with intentHash = channelPurchaseIntent(quote.quote.request, quote.mode) };
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

  type PurchaseGraph = { apps : [Types.App]; releases : Map.Map<Text, Types.Candidate>; selection : [API.ReleaseSelection] };

  // Resolve one synchronous snapshot before any allowance or collection.
  // Ownership removes a price line, not a dependency or release commitment.
  // Legacy requests preserve their installed-Kernel compatibility behavior;
  // channel requests additionally select the Kernel for dependency evidence.
  func purchaseApps(db : Store.DB, buyer : Principal, roots : [Text], mode : ?API.ChannelMode) : API.Result<PurchaseGraph> {
    let apps = List.empty<Types.App>();
    let releases = Map.empty<Text, Types.Candidate>();
    let selection = List.empty<API.ReleaseSelection>();
    let pending = List.empty<{ appId : Text; minimum : Nat; root : Bool }>();
    var previous : ?Text = null;
    for (appId in Array.sort<Text>(roots, Text.compare).vals()) {
      if (previous == ?appId) return error("duplicate_app", "Select each app once.");
      previous := ?appId;
      if (appId == "kernel") return error("invalid_app", "Upgrade the Kernel through Settings; it is not an app purchase.");
      List.add(pending, { appId; minimum = 100; root = true });
    };
    label walk loop {
      let ?required = List.removeLast(pending) else break walk;
      if (required.appId != "kernel" or mode != null) {
        switch (Map.get(releases, Text.compare, required.appId)) {
          case (?release) {
            if (release.version < required.minimum) return error("dependency_version", "The selected " # required.appId # " release does not satisfy the dependency minimum.");
          };
          case null {
            let ?app = Store.getApp(db, required.appId) else return error(
              if (required.root) "app_missing" else "dependency_unavailable",
              "No marketplace app exists for " # required.appId # ".");
            let selected = switch (mode) {
              case null Catalog.approvedRelease(db, app);
              case (?value) Catalog.release(db, app, value);
            };
            let ?release = selected else return error("not_available", "No approved published release is available for " # required.appId # ".");
            if (release.version < required.minimum) return error("dependency_version", "The selected " # required.appId # " release does not satisfy the dependency minimum.");
            let owned = Store.getEntitlement(db, buyer, app.appId) != null;
            if (app.appId != "kernel" and not owned and not app.visible) return error("not_available", "This required app is not available to acquire: " # app.appId # ".");
            Map.add(releases, Text.compare, app.appId, release);
            if (app.appId != "kernel" and not owned) List.add(apps, app);
            switch (mode) {
              case null {};
              case (?value) {
                let ?identity = Catalog.selection(db, app, value) else Runtime.trap("Selected release disappeared from synchronous snapshot");
                List.add(selection, identity);
              };
            };
            for (dependency in release.dependencies.vals()) {
              if (dependency.appId != "kernel" or mode != null) List.add(pending, { appId = dependency.appId; minimum = dependency.minVersion; root = false });
            };
          };
        };
      };
    };
    #ok({ apps = List.toArray(apps); releases; selection = Array.sort<API.ReleaseSelection>(List.toArray(selection), func(a, b) { Text.compare(a.appId, b.appId) }) });
  };

  func purchaseSnapshot(db : Store.DB, marketplace : Principal, buyer : Principal, request : API.PurchaseRequest, mode : ?API.ChannelMode, now : Int) : API.Result<{ quote : API.CheckoutQuote; selection : [API.ReleaseSelection] }> {
    if (not Catalog.hasText(request.requestId)) return error("request_id", "A purchase request ID is required.");
    if (request.appIds.size() == 0) return error("empty_cart", "Select an app to acquire.");
    let ?paymentToken = token(db, request.ledger) else return error("payment_token", "Select ICP, ckBTC or ckUSDC from this marketplace's supported tokens.");
    let affiliate = switch (Referrals.resolve(db, buyer, request.referralCode)) {
      case (#err(message)) return error("referral", message);
      case (#ok(null)) null;
      case (#ok(?value)) ?value.owner;
    };
    let graph = switch (purchaseApps(db, buyer, request.appIds, mode)) { case (#ok(value)) value; case (#err(value)) return #err(value) };
    let rate = Store.getRate(db, request.ledger);
    let pricingRate : ?Pricing.Rate = switch (rate) {
      case null null;
      case (?value) ?{ rate = value.usdRate; decimals = Nat32.toNat(value.decimals); observedAt = Nat64.fromNat(Int.abs(value.observedAtNs)) };
    };
    let prices = Array.map<Types.App, Pricing.Item>(graph.apps, func(app) { { appId = app.appId; publisher = app.owner; usdMicros = app.priceUsdMicros } });
    let price = switch (Pricing.priceCartWithTerms(prices, buyer, affiliate, Nat8.toNat(paymentToken.decimals), pricingRate, Store.config(db).referralTerms)) {
      case (#err(message)) return error("price_unavailable", message);
      case (#ok(value)) value;
    };
    let items = Array.map<Pricing.Line, Types.PurchaseItem>(price.lines, func(line) {
      let ?app = Store.getApp(db, line.appId) else Runtime.trap("Quoted app disappeared from the synchronous snapshot");
      let ?release = Map.get(graph.releases, Text.compare, line.appId) else Runtime.trap("Quoted release disappeared from the synchronous snapshot");
      {
        appId = line.appId; listingRevision = app.revision; publisher = line.publisher;
        priceUsdMicros = line.usdMicros; paidAtoms = line.paidAtoms;
        developerAtoms = line.developerAtoms; affiliateAtoms = line.affiliateAtoms;
        burnAtoms = line.burnAtoms; releaseDigest = release.digest;
      };
    });
    let fee = if (price.paymentAtoms == 0) 0 else paymentToken.fee;
    let priceObservation = switch (rate) { case null null; case (?value) ?(value.ledger, value.usdRate, value.decimals, value.observedAtNs) };
    let commitment = switch (mode) {
      case null Encoding.hash(to_candid("neutron.marketplace.purchase.quote.v1", marketplace,
        buyer, purchaseIntent(request), items, price.paymentAtoms, fee, affiliate, priceObservation, Store.config(db).referralTerms));
      case (?value) Encoding.hash(to_candid("neutron.marketplace.purchase.quote.v2", marketplace,
        buyer, channelPurchaseIntent(request, value), graph.selection, items, price.paymentAtoms, fee, affiliate, priceObservation, Store.config(db).referralTerms));
    };
    let preliminary : API.CheckoutQuote = {
      request; buyer; items; amount = price.paymentAtoms; fee; affiliate; rate;
      spender = { owner = marketplace; subaccount = null };
      commitment; cycles = Billing.quote(Store.config(db).fees, #purchase, 0, 0);
      quotedAtNs = now;
    };
    let proposed = switch (mode) {
      case null order(preliminary, now);
      case (?value) channelOrder({ quote = preliminary; mode = value; selection = graph.selection }, now);
    };
    #ok({ quote = { preliminary with spender = { owner = marketplace; subaccount = ?Purchases.spenderSubaccount(marketplace, proposed) } }; selection = graph.selection });
  };

  public func purchase(db : Store.DB, marketplace : Principal, buyer : Principal, request : API.PurchaseRequest, now : Int) : API.Result<API.CheckoutQuote> {
    switch (purchaseSnapshot(db, marketplace, buyer, request, null, now)) {
      case (#err(value)) #err(value);
      case (#ok(value)) #ok(value.quote);
    };
  };

  // Listing and cart queries may bind reviewed roots without needing to know
  // their entire dependency closure. The returned quote always binds all nodes.
  public func checkExpectedSelection(selection : [API.ReleaseSelection], expected : ?[API.ReleaseSelection]) : API.Result<()> {
    switch (expected) {
      case null {};
      case (?values) {
        let seen = Map.empty<Text, Bool>();
        for (value in values.vals()) {
          if (Map.get(seen, Text.compare, value.appId) != null) return error("duplicate_app", "Select each expected release once.");
          Map.add(seen, Text.compare, value.appId, true);
          let ?current = Array.find<API.ReleaseSelection>(selection, func(item) { item.appId == value.appId }) else return error("selection_changed", "The reviewed release is no longer in this selection.");
          if (current != value) return error("selection_changed", "The reviewed release changed. Review the current selection before continuing.");
        };
      };
    };
    #ok(());
  };

  public func purchaseV2(db : Store.DB, marketplace : Principal, buyer : Principal, request : API.ChannelPurchaseRequest, now : Int) : API.Result<API.ChannelCheckoutQuote> {
    let snapshot = switch (purchaseSnapshot(db, marketplace, buyer, request.request, ?request.mode, now)) { case (#ok(value)) value; case (#err(value)) return #err(value) };
    switch (checkExpectedSelection(snapshot.selection, request.expectedSelection)) { case (#err(value)) return #err(value); case (_) {} };
    #ok({ quote = snapshot.quote; mode = request.mode; selection = snapshot.selection });
  };

  public func sameChannelPurchase(left : API.ChannelCheckoutQuote, right : API.ChannelCheckoutQuote) : Bool {
    left.mode == right.mode and left.selection == right.selection and samePurchase(left.quote, right.quote);
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
