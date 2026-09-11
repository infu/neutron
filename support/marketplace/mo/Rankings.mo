// All rights reserved. See ../LICENSE.
import Runtime "mo:core/Runtime";
import List "mo:core/List";
import Iter "mo:core/Iter";
import Store "Store";
import Types "Types";
import Publishers "Publishers";

module {
  public type Kind = { #free; #paid };
  public type Window = { #week; #month; #all };
  public type Counters = {
    free7 : Nat; free30 : Nat; freeAll : Nat;
    paid7 : Nat; paid30 : Nat; paidAll : Nat;
  };

  public let weekNs : Int = 604_800_000_000_000;
  public let monthNs : Int = 2_592_000_000_000_000;

  public func emptyCounters() : Counters {
    { free7 = 0; free30 = 0; freeAll = 0; paid7 = 0; paid30 = 0; paidAll = 0 };
  };

  public func add(counters : Counters, kind : Kind) : Counters {
    switch (kind) {
      case (#free) { { counters with free7 = counters.free7 + 1; free30 = counters.free30 + 1; freeAll = counters.freeAll + 1 } };
      case (#paid) { { counters with paid7 = counters.paid7 + 1; paid30 = counters.paid30 + 1; paidAll = counters.paidAll + 1 } };
    };
  };

  public func expire(counters : Counters, kind : Kind, window : Window) : Counters {
    switch (kind, window) {
      case (#free, #week) {
        if (counters.free7 == 0) Runtime.trap("Ranking expiry would count an acquisition twice");
        { counters with free7 = counters.free7 - 1 };
      };
      case (#free, #month) {
        if (counters.free30 == 0) Runtime.trap("Ranking expiry would count an acquisition twice");
        { counters with free30 = counters.free30 - 1 };
      };
      case (#paid, #week) {
        if (counters.paid7 == 0) Runtime.trap("Ranking expiry would count an acquisition twice");
        { counters with paid7 = counters.paid7 - 1 };
      };
      case (#paid, #month) {
        if (counters.paid30 == 0) Runtime.trap("Ranking expiry would count an acquisition twice");
        { counters with paid30 = counters.paid30 - 1 };
      };
      case (_, #all) Runtime.trap("All-time acquisition counts do not expire");
    };
  };

  public func inWindow(acquiredAtNs : Int, asOfNs : Int, window : Window) : Bool {
    if (acquiredAtNs > asOfNs) return false;
    switch (window) {
      case (#all) true;
      case (#week) acquiredAtNs > asOfNs - weekNs;
      case (#month) acquiredAtNs > asOfNs - monthNs;
    };
  };

  public func score(counters : Counters, kind : Kind, window : Window) : Nat {
    switch (kind, window) {
      case (#free, #week) counters.free7;
      case (#free, #month) counters.free30;
      case (#free, #all) counters.freeAll;
      case (#paid, #week) counters.paid7;
      case (#paid, #month) counters.paid30;
      case (#paid, #all) counters.paidAll;
    };
  };

  public type Result<T> = { #ok : T; #err : Text };
  public type ChartCursor = { generation : Nat64; offset : Nat };
  public type ChartPage = {
    entries : [Types.ChartEntry]; next : ?ChartCursor; generation : Nat64;
    asOfNs : Int; refreshing : Bool;
  };
  public type AdvanceResult = { processed : Nat; published : Bool; generation : Nat64; asOfNs : Int };

  func must<T>(value : { #ok : T; #err : Types.Error }) : T {
    switch (value) { case (#ok(result)) result; case (#err(error)) Runtime.trap("Ranking storage invariant: " # debug_show(error)) };
  };

  func appEligible(db : Store.DB, app : Types.App) : Bool {
    if (not app.visible) return false;
    let ?candidateId = app.approvedCandidate else return false;
    let ?candidate = db.candidates.get(candidateId) else return false;
    candidate.appId == app.appId and candidate.published and candidate.state == #approved;
  };

  public func refreshEligibility(db : Store.DB, app : Types.App) {
    let eligible = appEligible(db, app);
    let isFree = app.priceUsdMicros == 0;
    switch (db.rankings.by_app.lookup(app.appId)) {
      case (?prior) {
        if (prior.eligible == eligible and prior.isFree == isFree) return;
        ignore must(db.rankings.update({ prior with eligible; isFree }));
      };
      case null {
        ignore must(db.rankings.insert({ emptyCounters() with appId = app.appId; eligible; isFree }));
      };
    };
    let maintenance = db.store.get().rankings;
    db.store.rankings.set({ maintenance with dirty = true });
  };

  // The entitlement domain invokes this in its own await-free finalization.
  // The unique owner/app acquisition is the durable exactly-once counter guard.
  public func recordAcquisition(db : Store.DB, input : Types.CreateAcquisition) : Types.Acquisition {
    switch (db.acquisitions.by_owner_app.lookup((input.owner, input.appId))) {
      case (?existing) return existing;
      case null {};
    };
    let ?app = db.apps.by_appId.lookup(input.appId) else Runtime.trap("Acquisition app missing");
    refreshEligibility(db, app);
    let ?prior = db.rankings.by_app.lookup(input.appId) else Runtime.trap("Acquisition ranking missing");
    let counters = add(prior, input.kind);
    let id = must(db.acquisitions.insert(input));
    Publishers.recordAcquisition(db, app.owner, input.owner);
    ignore must(db.rankings.update({ prior with
      free7 = counters.free7; free30 = counters.free30; freeAll = counters.freeAll;
      paid7 = counters.paid7; paid30 = counters.paid30; paidAll = counters.paidAll;
    }));
    let maintenance = db.store.get().rankings;
    db.store.rankings.set({ maintenance with dirty = true });
    switch (db.acquisitions.get(id)) { case (?event) event; case null Runtime.trap("Acquisition missing after insert") };
  };

  func expireWindow(db : Store.DB, cursor : ?Types.ExpiryCursor, cutoff : Int, window : Window, budget : Nat)
    : { cursor : ?Types.ExpiryCursor; processed : Nat; complete : Bool } {
    let after = switch (cursor) { case null null; case (?entry) ?(entry.atNs, entry.id) };
    let events = db.acquisitions.by_time.rangeIter({
      gt = after; gte = null; lt = null; lte = ?(cutoff, 18_446_744_073_709_551_615 : Nat64); dir = #fwd;
    }, null);
    var processed = 0;
    var next = cursor;
    for (event in events) {
      if (processed == budget) return { cursor = next; processed; complete = false };
      let ?prior = db.rankings.by_app.lookup(event.appId) else Runtime.trap("Expiry ranking missing");
      let counters = expire(prior, event.kind, window);
      ignore must(db.rankings.update({ prior with
        free7 = counters.free7; free30 = counters.free30; freeAll = counters.freeAll;
        paid7 = counters.paid7; paid30 = counters.paid30; paidAll = counters.paidAll;
      }));
      next := ?{ atNs = event.atNs; id = event.id };
      processed += 1;
    };
    { cursor = next; processed; complete = true };
  };

  func chartEntries(rows : Iter.Iter<Types.Ranking>, kind : Kind, window : Window) : [Types.ChartEntry] {
    let entries = List.empty<Types.ChartEntry>();
    for (row in rows) { List.add(entries, { appId = row.appId; score = score(row, kind, window) }) };
    List.toArray(entries);
  };

  public func advance(db : Store.DB, now : Int, workBudget : Nat) : AdvanceResult {
    let saved = db.store.get().rankings;
    let weekly = expireWindow(db, saved.expiry7, now - weekNs, #week, workBudget);
    let monthly = expireWindow(db, saved.expiry30, now - monthNs, #month, workBudget - weekly.processed);
    let processed = weekly.processed + monthly.processed;
    var next = { saved with expiry7 = weekly.cursor; expiry30 = monthly.cursor };
    let publish = weekly.complete and monthly.complete;
    if (publish) {
      let descending = { gt = null; gte = null; lt = null; lte = null; dir = #bwd };
      // Every candidate remains indexed. Snapshots cover all entries so hiding
      // one app can still expose the next eligible result during later backlog.
      let charts = {
        free7 = chartEntries(db.rankings.by_free7.rangeIter(descending, null), #free, #week);
        free30 = chartEntries(db.rankings.by_free30.rangeIter(descending, null), #free, #month);
        freeAll = chartEntries(db.rankings.by_freeAll.rangeIter(descending, null), #free, #all);
        paid7 = chartEntries(db.rankings.by_paid7.rangeIter(descending, null), #paid, #week);
        paid30 = chartEntries(db.rankings.by_paid30.rangeIter(descending, null), #paid, #month);
        paidAll = chartEntries(db.rankings.by_paidAll.rangeIter(descending, null), #paid, #all);
      };
      next := { next with charts; generation = saved.generation + 1; asOfNs = now; dirty = false };
    };
    db.store.rankings.set(next);
    { processed; published = publish; generation = next.generation; asOfNs = next.asOfNs };
  };

  func hasExpired(db : Store.DB, cursor : ?Types.ExpiryCursor, cutoff : Int) : Bool {
    let after = switch (cursor) { case null null; case (?entry) ?(entry.atNs, entry.id) };
    switch (db.acquisitions.by_time.rangeIter({
      gt = after; gte = null; lt = null; lte = ?(cutoff, 18_446_744_073_709_551_615 : Nat64); dir = #fwd;
    }, null).next()) { case null false; case (?_) true };
  };

  public func chart(db : Store.DB, kind : Kind, window : Window, cursor : ?ChartCursor, limit : Nat, now : Int) : Result<ChartPage> {
    if (limit == 0) return #err("Choose a positive chart page size.");
    let saved = db.store.get().rankings;
    var offset = switch (cursor) {
      case null 0;
      case (?value) {
        if (value.generation != saved.generation) return #err("The chart has refreshed. Start a new page from its current generation.");
        value.offset;
      };
    };
    let rows = switch (kind, window) {
      case (#free, #week) saved.charts.free7; case (#free, #month) saved.charts.free30; case (#free, #all) saved.charts.freeAll;
      case (#paid, #week) saved.charts.paid7; case (#paid, #month) saved.charts.paid30; case (#paid, #all) saved.charts.paidAll;
    };
    if (offset > rows.size()) return #err("The chart cursor is outside this generation.");
    let entries = List.empty<Types.ChartEntry>();
    while (offset < rows.size() and List.size(entries) < limit) {
      let row = rows[offset];
      offset += 1;
      switch (db.apps.by_appId.lookup(row.appId)) {
        case (?app) {
          if (appEligible(db, app) and ((app.priceUsdMicros == 0) == (kind == #free))) List.add(entries, row);
        };
        case null {};
      };
    };
    #ok({
      entries = List.toArray(entries);
      next = if (offset < rows.size()) ?{ generation = saved.generation; offset } else null;
      generation = saved.generation; asOfNs = saved.asOfNs;
      refreshing = saved.dirty or hasExpired(db, saved.expiry7, now - weekNs) or hasExpired(db, saved.expiry30, now - monthNs);
    });
  };
}
