// All rights reserved. See ../LICENSE.
import Nat64 "mo:core/Nat64";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
import Sha256 "mo:sha2/Sha256";
import StableBlob "mo:ashroot/stable_blob";
import API "./API";
import Billing "./Billing";
import Store "./Store";
import Types "./Types";

module {
  let storageYearNs : Int = 31_536_000_000_000_000;

  func error<T>(code : Text, message : Text) : API.Result<T> { #err({ code; message }) };
  func must<T>(result : { #ok : T; #err : Types.Error }) : T {
    switch (result) {
      case (#ok(value)) value;
      case (#err(detail)) Runtime.trap("Asset storage invariant: " # debug_show(detail));
    };
  };
  func blobError<T>(detail : StableBlob.Error) : API.Result<T> {
    error("upload_storage", "The upload could not be updated: " # debug_show(detail));
  };
  func hasText(value : Text) : Bool {
    Text.trim(value, #predicate(func (char) { char == ' ' or char == '\n' or char == '\r' or char == '\t' })).size() > 0;
  };
  func authorizedApp(db : Store.DB, owner : Principal, appId : Text) : API.Result<()> {
    let ?app = Store.getApp(db, appId) else return error("app_missing", "Create the app listing before uploading its files.");
    if (app.owner != owner) return error("publisher_required", "Only this app's publisher can upload its files.");
    #ok(());
  };
  func sameIntent(saved : Types.Upload, input : API.UploadBegin) : Bool {
    saved.appId == input.appId and saved.digest == input.digest and saved.size == input.size and
    saved.mediaType == input.mediaType and saved.purpose == input.purpose;
  };
  func validateBegin(db : Store.DB, owner : Principal, input : API.UploadBegin) : API.Result<?Types.Upload> {
    switch (authorizedApp(db, owner, input.appId)) { case (#err(e)) return #err(e); case (#ok(_)) {} };
    if (not hasText(input.requestId)) return error("request_id", "An upload request ID is required for safe retry.");
    if (input.digest.size() != 32) return error("digest", "Provide the file's exact SHA-256 digest.");
    if (input.size == 0) return error("empty_file", "Choose a nonempty file to upload.");
    if (not hasText(input.mediaType) or Text.contains(input.mediaType, #char '\r') or Text.contains(input.mediaType, #char '\n')) {
      return error("media_type", "Provide a nonempty HTTP media type without line breaks.");
    };
    let saved = Store.getUploadByRequest(db, owner, input.requestId);
    switch (saved) {
      case (?upload) {
        if (not sameIntent(upload, input)) return error("request_conflict", "This upload request ID already names a different file.");
      };
      case null {};
    };
    #ok(saved);
  };
  func uploadFor(db : Store.DB, owner : Principal, requestId : Text) : API.Result<Types.Upload> {
    let ?upload = Store.getUploadByRequest(db, owner, requestId) else return error("upload_missing", "This upload request was not found for your Neutron.");
    switch (authorizedApp(db, owner, upload.appId)) { case (#err(e)) return #err(e); case (#ok(_)) {} };
    #ok(upload);
  };
  func publicStatus(db : Store.DB, upload : Types.Upload) : API.Result<API.UploadStatus> {
    let ?charge = Store.getCharge(db, upload.chargeId) else Runtime.trap("Upload storage charge is missing");
    let uploadedBytes : Nat64 = switch (upload.state) {
      case (#attached) upload.size;
      case (#aborted) 0;
      case (#uploading) {
        switch (Store.blobUploadInfo(db, upload.ticket)) { case (#ok(info)) info.written; case (#err(e)) return blobError(e) };
      };
    };
    #ok({
      id = upload.id; requestId = upload.requestId; appId = upload.appId; digest = upload.digest;
      size = upload.size; uploadedBytes; state = upload.state; artifactId = upload.artifactId; charge;
    });
  };
  func savedHash(upload : Types.Upload) : API.Result<Sha256.Digest> {
    let ?encoded = upload.hashState else return error("upload_hash_unavailable", "This upload's retained hash state is unavailable; its bytes cannot be certified.");
    let ?state = (from_candid(encoded) : ?Sha256.StaticSha256) else return error("upload_hash_unavailable", "This upload's retained hash state could not be restored.");
    let hash = Sha256.Digest(#sha256);
    hash.unshare(state);
    #ok(hash);
  };

  // New bytes incur the fixed storage coverage charge once. A digest alone does
  // not establish possession of a private package, so every new upload intent
  // stages and verifies its own bytes even when the digest already exists.
  public func estimateNewStorage(db : Store.DB, owner : Principal, input : API.UploadBegin) : API.Result<Nat> {
    switch (validateBegin(db, owner, input)) {
      case (#err(e)) #err(e);
      case (#ok(?_)) #ok(0);
      case (#ok(null)) #ok(Nat64.toNat(input.size));
    };
  };

  // The actor authenticates and accepts this exact fixed Billing quote first.
  // No await is allowed between accepting it and persisting these records.
  public func begin(db : Store.DB, owner : Principal, input : API.UploadBegin, accepted : Billing.Quote, now : Int) : API.Result<API.UploadStatus> {
    switch (validateBegin(db, owner, input)) {
      case (#err(e)) return #err(e);
      case (#ok(?saved)) return publicStatus(db, saved);
      case (#ok(null)) {};
    };
    if (accepted.feeVersion != input.feeVersion or accepted.newStorageBytes != Nat64.toNat(input.size)) {
      return error("upload_charge", "The accepted storage estimate does not match this upload.");
    };
    // Allocation follows cycle acceptance in the same message. A storage failure
    // must roll back that accepted charge, not return a paid-but-unsaved upload.
    let ticket = switch (Store.beginBlob(db, input.size)) {
      case (#ok(value)) value;
      case (#err(e)) Runtime.trap("Upload allocation failed; the storage charge was not retained: " # debug_show(e));
    };
    let charge = must(Store.insertCharge(db, {
      owner; requestId = input.requestId; method = "upload_begin"; feeVersion = accepted.feeVersion;
      cycles = accepted.totalCycles; processingCycles = accepted.processingCycles; storageCycles = accepted.storageCycles;
      coveredBytes = input.size; coverageFromNs = now; coverageUntilNs = now + storageYearNs; createdAtNs = now;
    }));
    let hash = Sha256.Digest(#sha256);
    let upload = must(Store.insertUpload(db, {
      owner; requestId = input.requestId; appId = input.appId; digest = input.digest; size = input.size;
      mediaType = input.mediaType; purpose = input.purpose; ticket; chargeId = charge.id;
      hashState = ?to_candid(hash.share()); state = #uploading; artifactId = null; createdAtNs = now; updatedAtNs = now;
    }));
    publicStatus(db, upload);
  };

  public func status(db : Store.DB, owner : Principal, requestId : Text) : API.Result<API.UploadStatus> {
    switch (uploadFor(db, owner, requestId)) { case (#err(e)) #err(e); case (#ok(upload)) publicStatus(db, upload) };
  };

  public func chunk(db : Store.DB, owner : Principal, input : API.UploadChunk, now : Int) : API.Result<API.UploadStatus> {
    let upload = switch (uploadFor(db, owner, input.requestId)) { case (#ok(value)) value; case (#err(e)) return #err(e) };
    if (upload.state == #aborted) return error("upload_aborted", "This upload was aborted.");
    if (upload.state == #attached) {
      let ?artifactId = upload.artifactId else Runtime.trap("Attached upload artifact is missing");
      let ?artifact = Store.getArtifact(db, artifactId) else Runtime.trap("Attached artifact is missing");
      if (input.offset > upload.size or input.bytes.size() > Nat64.toNat(upload.size - input.offset)) {
        return error("upload_range", "The chunk lies outside the completed file.");
      };
      switch (Store.readBlob(db, artifact.content, input.offset, input.bytes.size())) {
        case (#err(e)) return blobError(e);
        case (#ok(bytes)) { if (bytes != input.bytes) return error("upload_conflict", "The completed upload already contains different bytes at this offset.") };
      };
      return publicStatus(db, upload);
    };
    let info = switch (Store.blobUploadInfo(db, upload.ticket)) { case (#ok(value)) value; case (#err(e)) return blobError(e) };
    let hash = switch (savedHash(upload)) { case (#ok(value)) value; case (#err(e)) return #err(e) };
    switch (Store.appendBlob(db, upload.ticket, input.offset, input.bytes)) { case (#err(e)) return blobError(e); case (#ok(_)) {} };
    // The blob store byte-compares retransmissions before returning success.
    // Only bytes appended at the prior end participate in the digest again.
    if (input.offset == info.written and input.bytes.size() > 0) {
      hash.writeBlob(input.bytes);
      let updated = must(Store.putUpload(db, { upload with hashState = ?to_candid(hash.share()); updatedAtNs = now }));
      return publicStatus(db, updated);
    };
    publicStatus(db, upload);
  };

  public func finish(db : Store.DB, owner : Principal, input : API.UploadFinish, now : Int) : API.Result<API.UploadStatus> {
    let upload = switch (uploadFor(db, owner, input.requestId)) { case (#ok(value)) value; case (#err(e)) return #err(e) };
    if (upload.state == #attached) return publicStatus(db, upload);
    if (upload.state == #aborted) return error("upload_aborted", "This upload was aborted.");
    let info = switch (Store.blobUploadInfo(db, upload.ticket)) { case (#ok(value)) value; case (#err(e)) return blobError(e) };
    if (info.written != upload.size) return error("upload_incomplete", "Send the remaining file bytes before finishing this upload.");
    let hash = switch (savedHash(upload)) { case (#ok(value)) value; case (#err(e)) return #err(e) };
    if (hash.sum() != upload.digest) return error("digest_mismatch", "The uploaded bytes do not match the declared SHA-256 digest. Start a new upload with the correct file and digest.");
    let artifactId = switch (Store.getArtifactByDigest(db, upload.digest)) {
      case (?existing) {
        if (existing.size != upload.size) Runtime.trap("Artifact digest size invariant failed");
        switch (Store.abortBlob(db, upload.ticket)) { case (#ok(_)) {}; case (#err(e)) Runtime.trap("Verified duplicate upload release failed: " # debug_show(e)) };
        existing.id;
      };
      case null {
        must(Store.insertArtifact(db, {
          digest = upload.digest; size = upload.size; mediaType = upload.mediaType;
          content = #upload(upload.ticket); publicLegacy = false; createdAtNs = now;
        })).id;
      };
    };
    let attached = must(Store.putUpload(db, { upload with state = #attached; artifactId = ?artifactId; hashState = null; updatedAtNs = now }));
    publicStatus(db, attached);
  };
};
