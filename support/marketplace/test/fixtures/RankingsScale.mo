// All rights reserved. See ../../LICENSE.
import IC "mo:core/InternetComputer";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
import Rankings "../../mo/Rankings";
import Store "../../mo/Store";
import Fixtures "../motoko/Fixtures";

// This fixture retains the production indexes and ranking functions. Seeding
// is split across messages so it cannot conceal the maintenance call's budget.
persistent actor {
  let mem = Fixtures.memory();
  transient let db = Store.Use(mem);
  var apps = 0;
  var acquisitions = 0;

  func appId(index : Nat) : Text {
    let raw = Nat.toText(index);
    var prefix = "app-";
    var pad = raw.size();
    while (pad < 5) { prefix #= "0"; pad += 1 };
    prefix # raw;
  };

  public func seedApps(count : Nat) : async Nat {
    var index = apps;
    while (index < apps + count) {
      let name = appId(index);
      let candidate = Fixtures.stored(db.candidates.insert({
        appId = name; version = 100; publisher = Fixtures.owner(); requestId = name;
        listingRevision = 1; artifactId = 1; sourceArtifactId = ?1; digest = "digest";
        sourceDigest = ?"source"; dependencies = []; state = #approved; published = true;
        createdAtNs = 1; updatedAtNs = 1;
      }));
      let id = Fixtures.stored(db.apps.insert({
        appId = name; owner = Fixtures.owner(); title = name; summary = "Scale fixture";
        description = ""; priceUsdMicros = if (index % 2 == 0) 0 else 1_000_000;
        revision = 1; approvedCandidate = ?candidate; visible = true; iconArtifact = null;
        screenshots = []; ratingCount = 0; ratingTotal = 0; createdAtNs = 1; updatedAtNs = 1;
      }));
      let ?app = db.apps.get(id) else Runtime.trap("Seed app missing");
      Rankings.refreshEligibility(db, app);
      index += 1;
    };
    apps += count;
    apps;
  };

  public func seedAcquisitions(count : Nat, atNs : Int, target : ?Nat) : async Nat {
    assert apps > 0;
    var index = acquisitions;
    while (index < acquisitions + count) {
      let selected = switch (target) { case (?value) value; case null (index * 17) % apps };
      assert selected < apps;
      let owner = Principal.fromBlob(Text.encodeUtf8("buyer-" # Nat.toText(index)));
      ignore Rankings.recordAcquisition(db, {
        owner; appId = appId(selected); orderId = 1; kind = if (selected % 2 == 0) #free else #paid;
        atNs; paidAtoms = if (selected % 2 == 0) 0 else 1_000_000;
        ledger = if (selected % 2 == 0) null else ?Fixtures.owner(); block = null;
      });
      index += 1;
    };
    acquisitions += count;
    acquisitions;
  };

  public func advance(now : Int, workBudget : Nat) : async {
    result : Rankings.AdvanceResult; rankingInstructions : Nat64; messageInstructions : Nat64;
  } {
    let before = IC.performanceCounter(0);
    let result = Rankings.advance(db, now, workBudget);
    let after = IC.performanceCounter(0);
    { result; rankingInstructions = after - before; messageInstructions = IC.performanceCounter(0) };
  };

  public query func chart(kind : Rankings.Kind, window : Rankings.Window, cursor : ?Rankings.ChartCursor, limit : Nat, now : Int) : async Rankings.Result<Rankings.ChartPage> {
    Rankings.chart(db, kind, window, cursor, limit, now);
  };

  public query func counts() : async { apps : Nat; acquisitions : Nat; rankings : Nat } {
    { apps = db.apps.size(); acquisitions = db.acquisitions.size(); rankings = db.rankings.size() };
  };
};
