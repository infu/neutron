// All rights reserved. See ../../LICENSE.
import Cycles "mo:core/Cycles";
import Error "mo:core/Error";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import StableBlob "mo:ashroot/stable_blob";
import Sha256 "mo:sha2/Sha256";
import API "../../mo/API";
import Assets "../../mo/Assets";
import Billing "../../mo/Billing";
import PublisherStore "../../mo/PublisherStore";
import Store "../../mo/Store";

// PocketIC only: makes allocation fail deterministically without growing memory.
persistent actor class UploadBilling() = self {
  transient let owner = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");
  let initial = Store.init({ admins = []; auditors = []; tokens = []; xrc = owner;
    fees = { version = 1; updateBase = 12; updateByte = 2; storageByteYear = 100_000_000_000; purchase = 4; withdraw = 5; grant = 6; xrc = 7 };
    referralTerms = { version = 1; discountBps = 1_000; affiliateBps = 3_000; developerBps = 3_000 } });
  let mem = { initial with blobs = StableBlob.initWith({ StableBlob.defaults with maxPages = 0; uploadTtl = 0 }) };
  let publisherMemory = PublisherStore.init();
  transient let db = Store.Use(mem, publisherMemory);
  var effects = 0;

  public func seed() : async () {
    switch (Store.insertApp(db, { appId = "test"; owner; title = "Test"; summary = ""; description = "";
      priceUsdMicros = 0; revision = 1; approvedCandidate = null; visible = false; iconArtifact = null;
      screenshots = []; ratingCount = 0; ratingTotal = 0; createdAtNs = 0; updatedAtNs = 0 })) {
      case (#ok(_)) {}; case (#err(e)) Runtime.trap(debug_show(e));
    };
  };
  public shared func failAfterAccept() : async API.Result<API.UploadStatus> {
    let request : API.UploadBegin = { requestId = "limited"; appId = "test"; size = 8;
      digest = Sha256.fromBlob(#sha256, "abcdefgh"); mediaType = "application/octet-stream"; purpose = #package; feeVersion = 1 };
    let charge = Billing.quote(Store.config(db).fees, #upload, 1, 8);
    switch (Billing.accept<system>(charge, 1)) { case (#ok(_)) {}; case (#err(e)) Runtime.trap(debug_show(e)) };
    effects += 1;
    Assets.begin(db, owner, request, charge, 1);
  };
  public query func cycleBalance() : async Nat { Cycles.balance() };
  public query func counts() : async { effects : Nat; uploads : Nat; charges : Nat } { { effects; uploads = db.uploads.size(); charges = db.charges.size() } };
  public func probe(target : Principal) : async { trapped : Bool; message : Text; refunded : Nat; effects : Nat; uploads : Nat; charges : Nat } {
    let destination : actor { failAfterAccept : shared () -> async API.Result<API.UploadStatus> } = actor (Principal.toText(target));
    var trapped = false; var message = ""; var refunded = 0;
    try { ignore await (with cycles = 1_000_000_000_000) destination.failAfterAccept(); refunded := Cycles.refunded() } catch (e) { trapped := true; message := Error.message(e); refunded := Cycles.refunded() };
    { trapped; message; refunded; effects; uploads = db.uploads.size(); charges = db.charges.size() };
  };
};
