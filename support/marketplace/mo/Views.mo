// All rights reserved. See ../LICENSE.
import API "API";
import Access "Access";
import Catalog "Catalog";
import Rankings "Rankings";
import Store "Store";
import Types "Types";
import List "mo:core/List";
import Iter "mo:core/Iter";
import Principal "mo:core/Principal";
import Text "mo:core/Text";

module {
  func failure<T>(code : Text, message : Text) : API.Result<T> { #err({ code; message }) };
  func imageUrl(db : Store.DB, source : Principal, artifactId : Nat64) : ?Text {
    let ?artifact = Store.getArtifact(db, artifactId) else return null;
    if (not Text.startsWith(artifact.mediaType, #text "image/")) return null;
    ?("https://" # Principal.toText(source) # ".icp0.io" # Access.artifactPath(artifact, #image));
  };

  public func app(db : Store.DB, source : Principal, owner : ?Principal, record : Types.App) : API.App {
    let version = switch (Catalog.approvedRelease(db, record)) { case null null; case (?candidate) ?candidate.version };
    let owned = switch (owner) { case null false; case (?principal) Store.getEntitlement(db, principal, record.appId) != null };
    let screenshots = List.empty<Text>();
    for (artifactId in record.screenshots.vals()) {
      switch (imageUrl(db, source, artifactId)) { case null {}; case (?url) List.add(screenshots, url) };
    };
    {
      appId = record.appId; publisher = record.owner; title = record.title;
      summary = record.summary; description = record.description; priceUsdMicros = record.priceUsdMicros;
      revision = record.revision; version; iconArtifact = record.iconArtifact;
      iconUrl = switch (record.iconArtifact) { case null null; case (?id) imageUrl(db, source, id) };
      screenshots = List.toArray(screenshots); screenshotArtifacts = record.screenshots;
      ratingCount = record.ratingCount; ratingTotal = record.ratingTotal; owned;
      visible = Catalog.eligible(db, record);
    };
  };

  func matches(record : Types.App, needle : Text) : Bool {
    needle == "" or Text.contains(Text.toLower(record.appId), #text needle) or
      Text.contains(Text.toLower(record.title), #text needle) or Text.contains(Text.toLower(record.summary), #text needle);
  };

  public func catalog(db : Store.DB, source : Principal, owner : ?Principal, request : API.CatalogRequest, now : Int) : API.Result<API.CatalogPage> {
    if (request.limit == 0) return failure("invalid_page", "Choose a positive catalog page size.");
    let needle = Text.toLower(Text.trim(request.search, #predicate(func(c : Char) : Bool { c == ' ' or c == '\t' or c == '\n' or c == '\r' })));
    let results = List.empty<API.App>();
    var cursor = request.cursor;
    var generation : Nat64 = 0;
    var asOfNs : Int = 0;
    var refreshing = false;
    label pages loop {
      let page = switch (Rankings.chart(db, request.tier, request.window, cursor, request.limit - List.size(results), now)) {
        case (#err(message)) return failure("catalog_page", message);
        case (#ok(page)) page;
      };
      generation := page.generation;
      asOfNs := page.asOfNs;
      refreshing := page.refreshing;
      for (entry in page.entries.vals()) {
        switch (Store.getApp(db, entry.appId)) {
          case (?record) { if (matches(record, needle)) List.add(results, app(db, source, owner, record)) };
          case null {};
        };
      };
      cursor := page.next;
      if (List.size(results) == request.limit or cursor == null) break pages;
    };
    #ok({ apps = List.toArray(results); nextCursor = cursor; asOfNs; generation; refreshing });
  };

  func latestCandidate(db : Store.DB, appId : Text) : ?Types.Candidate {
    var latest : ?Types.Candidate = null;
    for (candidate in db.candidates.by_app.rangeIter({ gt = null; gte = ?appId; lt = null; lte = ?appId; dir = #bwd }, null)) {
      switch (latest) { case null latest := ?candidate; case (?prior) { if (candidate.id > prior.id) latest := ?candidate } };
    };
    latest;
  };

  public func detail(db : Store.DB, source : Principal, owner : ?Principal, appId : Text) : API.Result<API.AppDetail> {
    let ?record = Store.getApp(db, appId) else return failure("app_not_found", "This app could not be found.");
    let isPublisher = owner == ?record.owner;
    let isAuditor = switch (owner) { case null false; case (?principal) Access.isAuditor(db, principal) };
    let entitled = switch (owner) { case null false; case (?principal) Store.getEntitlement(db, principal, appId) != null };
    if (not Catalog.eligible(db, record) and not isPublisher and not isAuditor and not entitled) {
      return failure("app_unavailable", "This app has no available approved release.");
    };
    let candidate = if (isPublisher or isAuditor) latestCandidate(db, appId) else {
      switch (record.approvedCandidate) { case null null; case (?id) Store.getCandidate(db, id) };
    };
    let audit = switch (candidate) {
      case null null;
      case (?value) db.audits.by_candidate.rangeIter({ gt = null; gte = ?value.id; lt = null; lte = ?value.id; dir = #bwd }, null).next();
    };
    let rating = switch (owner) { case null null; case (?principal) Store.getRating(db, principal, appId) };
    #ok({ app = app(db, source, owner, record); candidate; audit; rating });
  };

  public func library(db : Store.DB, source : Principal, owner : Principal, request : API.PageRequest) : API.Result<API.AppPage> {
    if (request.limit == 0) return failure("invalid_page", "Choose a positive library page size.");
    let apps = List.empty<API.App>();
    var last = request.cursor;
    for (entitlement in db.entitlements.by_owner.rangeIter({ gt = null; gte = ?owner; lt = null; lte = ?owner; dir = #fwd }, null)) {
      let after = switch (request.cursor) { case null true; case (?id) entitlement.id > id };
      if (after) {
        switch (Store.getApp(db, entitlement.appId)) {
          case (?record) {
            if (List.size(apps) == request.limit) return #ok({ apps = List.toArray(apps); nextCursor = last });
            List.add(apps, app(db, source, ?owner, record));
          };
          case null {};
        };
        last := ?entitlement.id;
      };
    };
    #ok({ apps = List.toArray(apps); nextCursor = null });
  };

  public func publisherApps(db : Store.DB, source : Principal, owner : Principal, request : API.PageRequest) : API.Result<API.AppPage> {
    if (request.limit == 0) return failure("invalid_page", "Choose a positive publisher page size.");
    let apps = List.empty<API.App>();
    var last = request.cursor;
    for (record in db.apps.by_owner.rangeIter({ gt = null; gte = ?owner; lt = null; lte = ?owner; dir = #fwd }, null)) {
      let after = switch (request.cursor) { case null true; case (?id) record.id > id };
      if (after) {
        if (List.size(apps) == request.limit) return #ok({ apps = List.toArray(apps); nextCursor = last });
        List.add(apps, app(db, source, ?owner, record));
        last := ?record.id;
      };
    };
    #ok({ apps = List.toArray(apps); nextCursor = null });
  };

  public func earnings(db : Store.DB, owner : Principal) : API.Earnings {
    let credits = List.empty<Types.Credit>();
    for (credit in db.credits.by_owner.rangeIter({ gt = null; gte = ?owner; lt = null; lte = ?owner; dir = #fwd }, null)) {
      if (not credit.isBurn) List.add(credits, credit);
    };
    { credits = List.toArray(credits); referral = Store.getReferralByOwner(db, owner) };
  };

  public type OperationRows = {
    purchases : [Types.Order]; withdrawals : [Types.Withdrawal];
    nextPurchaseCursor : API.HistoryCursor; nextWithdrawalCursor : API.HistoryCursor;
  };

  func historyPage<T>(rows : Iter.Iter<T>, cursor : API.HistoryCursor, limit : Nat, id : T -> Nat64, visible : T -> Bool)
    : { values : [T]; next : API.HistoryCursor } {
    let after = switch (cursor) {
      case (#done) return { values = []; next = #done };
      case (#start) null;
      case (#after(value)) ?value;
    };
    let values = List.empty<T>();
    var last : Nat64 = 0;
    for (row in rows) {
      let before = switch (after) { case null true; case (?value) id(row) < value };
      if (before and visible(row)) {
        if (List.size(values) == limit) return { values = List.toArray(values); next = #after(last) };
        List.add(values, row);
        last := id(row);
      };
    };
    { values = List.toArray(values); next = #done };
  };

  public func operationRows(db : Store.DB, owner : Principal, request : API.OperationHistoryRequest) : API.Result<OperationRows> {
    if (request.limit == 0) return failure("invalid_page", "Choose a positive operation history page size.");
    let range = { gt = null; gte = ?owner; lt = null; lte = ?owner; dir = #bwd };
    let purchases = historyPage<Types.Order>(db.orders.by_owner.rangeIter(range, null), request.purchaseCursor, request.limit,
      func(row) { row.id }, func(_) { true });
    let withdrawals = historyPage<Types.Withdrawal>(db.withdrawals.by_owner.rangeIter(range, null), request.withdrawalCursor, request.limit,
      func(row) { row.id }, func(row) { not row.isBurn });
    #ok({
      purchases = purchases.values; withdrawals = withdrawals.values;
      nextPurchaseCursor = purchases.next; nextWithdrawalCursor = withdrawals.next;
    });
  };
}
