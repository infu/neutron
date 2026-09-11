// All rights reserved. See ../LICENSE.
import API "API";
import Store "Store";
import Types "Types";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
import Char "mo:core/Char";

module {
  func failure<T>(code : Text, message : Text) : API.Result<T> { #err({ code; message }) };
  func must<T>(value : { #ok : T; #err : Types.Error }) : T {
    switch (value) { case (#ok(result)) result; case (#err(error)) Runtime.trap("Publisher storage invariant: " # debug_show(error)) };
  };
  func blank(char : Char) : Bool { Char.isWhitespace(char) or char == '\u{feff}' };
  public func validId(value : Text) : Bool {
    if (value.size() < 3 or value.size() > 20) return false;
    for (char in value.chars()) if (char < 'a' or char > 'z') return false;
    true;
  };
  public func summary(db : Store.DB, owner : Principal) : ?API.PublisherSummary {
    let ?row = db.publishers.publisherProfiles.by_owner.lookup(owner) else return null;
    ?{ publisherId = row.publisherId; name = row.name };
  };
  public func requireProfile(db : Store.DB, owner : Principal) : API.Result<()> {
    if (db.publishers.publisherProfiles.by_owner.lookup(owner) == null) {
      failure("publisher_profile_required", "Set up your publisher profile before publishing an app.");
    } else #ok(());
  };
  public func profileFor(db : Store.DB, owner : Principal) : ?API.PublisherProfile {
    let ?row = db.publishers.publisherProfiles.by_owner.lookup(owner) else return null;
    let stats = db.publishers.publisherStats.by_owner.lookup(owner);
    let maintenance = db.publishers.store.get();
    ?{
      publisherId = row.publisherId; name = row.name; description = row.description; principal = owner;
      ratingCount = switch (stats) { case null 0; case (?value) value.ratingCount };
      ratingTotal = switch (stats) { case null 0; case (?value) value.ratingTotal };
      totalUsers = switch (stats) { case null 0; case (?value) value.totalUsers };
      statsComplete = maintenance.appsComplete and maintenance.acquisitionsComplete;
      createdAtNs = row.createdAtNs; updatedAtNs = row.updatedAtNs;
    };
  };
  public func profile(db : Store.DB, publisherId : Text) : API.Result<API.PublisherProfile> {
    let ?row = db.publishers.publisherProfiles.by_publisherId.lookup(publisherId) else return failure("publisher_not_found", "This publisher could not be found.");
    let ?value = profileFor(db, row.owner) else Runtime.trap("Publisher profile disappeared");
    #ok(value);
  };
  public func register(db : Store.DB, owner : Principal, input : API.PublisherRegister, now : Int) : API.Result<API.PublisherProfile> {
    if (not validId(input.publisherId)) return failure("invalid_publisher_id", "Publisher IDs must contain 3–20 lowercase letters (a–z).");
    let name = Text.trim(input.name, #predicate blank);
    if (name == "") return failure("invalid_publisher_name", "Enter your publisher name.");
    switch (db.publishers.publisherProfiles.by_owner.lookup(owner)) {
      case (?existing) {
        if (existing.publisherId != input.publisherId or existing.name != name) {
          return failure("publisher_identity_permanent", "Your publisher ID and name are permanent. You can update your description.");
        };
        // Retrying registration never overwrites a later description edit.
        let ?value = profileFor(db, owner) else Runtime.trap("Registered publisher missing");
        return #ok(value);
      };
      case null {};
    };
    if (db.publishers.publisherProfiles.by_publisherId.lookup(input.publisherId) != null) {
      return failure("publisher_id_taken", "This publisher ID is already taken. Choose another ID.");
    };
    ignore must(db.publishers.publisherProfiles.insert({ owner; publisherId = input.publisherId; name; description = input.description; createdAtNs = now; updatedAtNs = now }));
    let ?value = profileFor(db, owner) else Runtime.trap("Registered publisher missing");
    #ok(value);
  };
  public func update(db : Store.DB, owner : Principal, description : Text, now : Int) : API.Result<API.PublisherProfile> {
    let ?row = db.publishers.publisherProfiles.by_owner.lookup(owner) else return failure("publisher_profile_required", "Set up your publisher profile first.");
    if (row.description != description) ignore must(db.publishers.publisherProfiles.update({ row with description; updatedAtNs = now }));
    let ?value = profileFor(db, owner) else Runtime.trap("Updated publisher missing");
    #ok(value);
  };

  // An app contributes its retained rating total once. Replacing its baseline
  // makes rating edits safe even before historical backfill reaches this app.
  public func syncApp(db : Store.DB, app : Types.App) {
    let prior = db.publishers.publisherAppStats.by_appId.lookup(app.appId);
    switch (prior) {
      case (?value) {
        if (value.owner != app.owner) Runtime.trap("Publisher ownership changed without migration");
        if (value.ratingCount == app.ratingCount and value.ratingTotal == app.ratingTotal) return;
      };
      case null {};
    };
    let oldCount = switch (prior) { case null 0; case (?value) value.ratingCount };
    let oldTotal = switch (prior) { case null 0; case (?value) value.ratingTotal };
    switch (db.publishers.publisherStats.by_owner.lookup(app.owner)) {
      case null {
        if (oldCount != 0 or oldTotal != 0) Runtime.trap("Publisher rating total missing");
        ignore must(db.publishers.publisherStats.insert({ owner = app.owner; ratingCount = app.ratingCount; ratingTotal = app.ratingTotal; totalUsers = 0 }));
      };
      case (?stats) {
        if (stats.ratingCount < oldCount or stats.ratingTotal < oldTotal) Runtime.trap("Publisher rating baseline exceeds total");
        ignore must(db.publishers.publisherStats.update({ stats with ratingCount = stats.ratingCount - oldCount + app.ratingCount; ratingTotal = stats.ratingTotal - oldTotal + app.ratingTotal }));
      };
    };
    switch (prior) {
      case null { ignore must(db.publishers.publisherAppStats.insert({ appId = app.appId; owner = app.owner; ratingCount = app.ratingCount; ratingTotal = app.ratingTotal })) };
      case (?value) { ignore must(db.publishers.publisherAppStats.update({ value with ratingCount = app.ratingCount; ratingTotal = app.ratingTotal })) };
    };
  };

  // Purchases invoke this in the same await-free finalization as their existing
  // entitlement/acquisition journal. Reinstalls and another app by the same
  // publisher never create a second portfolio user.
  public func recordAcquisition(db : Store.DB, owner : Principal, buyer : Principal) {
    if (db.publishers.publisherUsers.by_owner_buyer.lookup((owner, buyer)) != null) return;
    ignore must(db.publishers.publisherUsers.insert({ owner; buyer }));
    switch (db.publishers.publisherStats.by_owner.lookup(owner)) {
      case null { ignore must(db.publishers.publisherStats.insert({ owner; ratingCount = 0; ratingTotal = 0; totalUsers = 1 })) };
      case (?stats) { ignore must(db.publishers.publisherStats.update({ stats with totalUsers = stats.totalUsers + 1 })) };
    };
  };

  // Persistent cursors bound upgrade work. New acquisitions use the same unique
  // membership index as historical ones, and app baselines make concurrent
  // rating edits idempotent. Public queries only read these stored summaries.
  public func advance(db : Store.DB, budget : Nat) : Nat {
    var saved = db.publishers.store.get();
    var processed = 0;
    if (not saved.appsComplete) {
      let rows = db.apps.iterPrimary(#fwd, saved.appsCursor);
      label apps loop {
        if (processed == budget) break apps;
        switch (rows.next()) {
          case null { saved := { saved with appsComplete = true }; break apps };
          case (?(id, app)) { syncApp(db, app); saved := { saved with appsCursor = ?id }; processed += 1 };
        };
      };
    };
    if (not saved.acquisitionsComplete) {
      let rows = db.acquisitions.iterPrimary(#fwd, saved.acquisitionsCursor);
      label acquisitions loop {
        if (processed == budget) break acquisitions;
        switch (rows.next()) {
          case null { saved := { saved with acquisitionsComplete = true }; break acquisitions };
          case (?(id, acquisition)) {
            let ?app = Store.getApp(db, acquisition.appId) else Runtime.trap("Acquisition publisher missing");
            recordAcquisition(db, app.owner, acquisition.owner);
            saved := { saved with acquisitionsCursor = ?id }; processed += 1;
          };
        };
      };
    };
    db.publishers.store.set(saved);
    processed;
  };
}
