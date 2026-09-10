import Store "../../mo/Store";
import Types "../../mo/Types";
import Catalog "../../mo/Catalog";
import Publishing "../../mo/Publishing";
import Audits "../../mo/Audits";
import Sha256 "mo:sha2/Sha256";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Nat64 "mo:core/Nat64";
import Runtime "mo:core/Runtime";

module {
  public func owner() : Principal { Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai") };
  public func auditor() : Principal { Principal.fromText("mxzaz-hqaaa-aaaar-qaada-cai") };
  public func other() : Principal { Principal.fromText("xevnm-gaaaa-aaaar-qafnq-cai") };
  public func memory() : Store.Mem {
    Store.init({
      admins = [owner()]; auditors = [auditor()]; tokens = [];
      xrc = Principal.fromText("aaaaa-aa");
      fees = { version = 1; updateBase = 0; updateByte = 0; storageByteYear = 0; purchase = 0; withdraw = 0; grant = 0; xrc = 0 };
      referralTerms = { version = 1; discountBps = 1_000; affiliateBps = 3_000; developerBps = 3_000 };
    });
  };
  public func ok<T>(result : { #ok : T; #err : Text }) : T {
    switch (result) { case (#ok(value)) value; case (#err(error)) Runtime.trap(error) };
  };
  public func stored<T>(result : { #ok : T; #err : Types.Error }) : T {
    switch (result) { case (#ok(value)) value; case (#err(error)) Runtime.trap(debug_show(error)) };
  };
  public func listing(appId : Text, price : Nat, revision : ?Nat64) : Catalog.ListingInput {
    { appId; title = appId; summary = "Fixture app"; description = ""; priceUsdMicros = price;
      expectedRevision = revision; visible = true; iconArtifact = null; screenshots = [] };
  };
  public func draft(db : Store.DB, appId : Text, price : Nat) : Types.App {
    ok(Catalog.save(db, owner(), listing(appId, price, null), 1));
  };
  public func upload(db : Store.DB, appId : Text, requestId : Text, purpose : { #package; #source; #image }) : Types.Artifact {
    let bytes = Text.encodeUtf8(appId # requestId);
    let size = Nat64.fromNat(bytes.size());
    let #ok(ticket) = Store.beginBlob(db, size) else Runtime.trap("Fixture begin failed");
    let #ok(_) = Store.appendBlob(db, ticket, 0, bytes) else Runtime.trap("Fixture append failed");
    let artifact = stored(Store.insertArtifact(db, {
      digest = Sha256.fromBlob(#sha256, bytes); size; mediaType = if (purpose == #image) "image/png" else "application/octet-stream";
      content = #upload(ticket); publicLegacy = false; createdAtNs = 1;
    }));
    let charge = stored(Store.insertCharge(db, {
      owner = owner(); requestId; method = "upload"; feeVersion = 1; cycles = 0;
      processingCycles = 0; storageCycles = 0; coveredBytes = size; coverageFromNs = 1; coverageUntilNs = 2; createdAtNs = 1;
    }));
    ignore stored(Store.insertUpload(db, {
      owner = owner(); requestId; appId; digest = artifact.digest; size; mediaType = artifact.mediaType;
      purpose; ticket; hashState = null; chargeId = charge.id; state = #attached; artifactId = ?artifact.id;
      createdAtNs = 1; updatedAtNs = 1;
    }));
    artifact;
  };
  public func candidate(db : Store.DB, appId : Text, version : Nat, requestId : Text) : Types.Candidate {
    let artifact = upload(db, appId, requestId # "package", #package);
    let source = upload(db, appId, requestId # "source", #source);
    ok(Publishing.submit(db, owner(), {
      requestId; appId; version; artifactId = artifact.id; sourceArtifactId = ?source.id;
      dependencies = []; feeVersion = 1;
    }, 2));
  };
  public func approve(db : Store.DB, value : Types.Candidate, requestId : Text) : Audits.StampResult {
    ok(Audits.stamp(db, auditor(), {
      requestId; candidateId = value.id; decision = #approved;
      expectedDigest = value.digest; expectedSourceDigest = value.sourceDigest;
      analysis = "Inspected these exact package and offered-source hashes"; reason = null;
    }, 3));
  };
}
