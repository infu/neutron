// Proprietary marketplace protocol. All rights reserved.
import Runtime "mo:core/Runtime";
import Result "mo:core/Result";
import Iter "mo:core/Iter";
import List "mo:core/List";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";
import Set "mo:core/Set";
import StableBlob "mo:ashroot/stable_blob";
import IndexCore "mo:ashroot/index_core";
import Generated "../.ashroot/lib";
import PublisherStore "./PublisherStore";
import Types "./Types";

module {
  public type Mem = Generated.Mem;
  public type DB = Generated.DB and {
    publishers : PublisherStore.DB;
    publisherApps : (Principal, ?Nat64) -> Iter.Iter<(Nat64, Types.App)>;
  };
  public type Error = Types.Error;

  public func init(config : Types.Config) : Mem {
    let mem = Generated.MemWithBlobs(StableBlob.initWith({ StableBlob.defaults with uploadTtl = 0 }));
    mem.store.value := ?{
      config;
      rankings = {
        expiry7 = null; expiry30 = null; generation = 0; asOfNs = 0; dirty = false;
        charts = { free7 = []; free30 = []; freeAll = []; paid7 = []; paid30 = []; paidAll = [] };
      };
      nextReferralCodeId = 1;
      trustedPublishingPrincipal = null;
    };
    mem;
  };

  // Construct once as a transient actor value. Existing retained records are
  // restored directly; initialization is never used as an upgrade fallback.
  public func Use(mem : Mem, publisherMem : PublisherStore.Mem) : DB {
    let ?retained = mem.store.value else Runtime.trap("Marketplace storage is not initialized");
    {
      Generated.Use(mem, retained) with
      publishers = PublisherStore.Use(publisherMem);
      // Existing ownership index stores (owner, physical row slot). Retain that
      // slot as the cursor, including across sparse IDs or deleted row reuse.
      publisherApps = func(owner : Principal, after : ?Nat64) : Iter.Iter<(Nat64, Types.App)> {
        let start = switch (after) { case (?slot) slot; case null (0 : Nat64) };
        let values = Set.valuesFrom(mem.apps.idx_by_owner, IndexCore.cmpStoreKey<Principal>(Principal.compare), (owner, start));
        object {
          public func next() : ?(Nat64, Types.App) {
            label scan loop {
              let ?(foundOwner, slot) = values.next() else return null;
              if (foundOwner != owner) return null;
              switch (after) { case (?previous) if (slot <= previous) continue scan; case null {} };
              switch (List.get(mem.apps.rows, Nat64.toNat(slot))) {
                case (??app) return ?(slot, app);
                case (_) {};
              };
            };
            null;
          };
        };
      };
    };
  };

  public func config(db : DB) : Types.Config { db.store.get().config };
  public func setConfig(db : DB, config : Types.Config) { db.store.config.set(config) };
  public func getTrustedPublishingPrincipal(db : DB) : ?Principal { db.store.get().trustedPublishingPrincipal };
  // Only initialization configures this deployment identity; normal config
  // updates do not replace it or change ownership of existing records.
  public func setTrustedPublishingPrincipal(db : DB, value : ?Principal) { db.store.trustedPublishingPrincipal.set(value) };
  public func rankingMaintenance(db : DB) : Types.RankingMaintenance { db.store.get().rankings };
  public func setRankingMaintenance(db : DB, value : Types.RankingMaintenance) { db.store.rankings.set(value) };
  public func allocateReferralCodeId(db : DB) : Nat64 {
    let next = db.store.get().nextReferralCodeId;
    db.store.nextReferralCodeId.set(next + 1);
    next;
  };

  public func getApp(db : DB, appId : Text) : ?Types.App { db.apps.by_appId.lookup(appId) };
  public func insertApp(db : DB, value : Types.CreateApp) : Result.Result<Types.App, Error> {
    switch (db.apps.insert(value)) {
      case (#err(error)) #err(error);
      case (#ok(id)) {
        let ?stored = db.apps.get(id) else Runtime.trap("Inserted marketplace apps row is missing");
        #ok(stored);
      };
    };
  };
  public func putApp(db : DB, value : Types.CreateApp) : Result.Result<Types.App, Error> {
    switch (db.apps.by_appId.lookup(value.appId)) {
      case (?current) db.apps.update({ value with id = current.id });
      case null insertApp(db, value);
    };
  };

  public func getListing(db : DB, appId : Text, revision : Nat64) : ?Types.Listing { db.listings.by_app_revision.lookup((appId, revision)) };
  public func insertListing(db : DB, value : Types.CreateListing) : Result.Result<Types.Listing, Error> {
    switch (db.listings.insert(value)) {
      case (#err(error)) #err(error);
      case (#ok(id)) {
        let ?stored = db.listings.get(id) else Runtime.trap("Inserted marketplace listings row is missing");
        #ok(stored);
      };
    };
  };

  public func getCandidateByRequest(db : DB, publisher : Principal, requestId : Text) : ?Types.Candidate { db.candidates.by_request.lookup((publisher, requestId)) };
  public func getCandidate(db : DB, id : Nat64) : ?Types.Candidate { db.candidates.get(id) };
  public func insertCandidate(db : DB, value : Types.CreateCandidate) : Result.Result<Types.Candidate, Error> {
    switch (db.candidates.insert(value)) {
      case (#err(error)) #err(error);
      case (#ok(id)) {
        let ?stored = db.candidates.get(id) else Runtime.trap("Inserted marketplace candidates row is missing");
        #ok(stored);
      };
    };
  };
  public func putCandidate(db : DB, value : Types.CreateCandidate) : Result.Result<Types.Candidate, Error> {
    switch (db.candidates.by_request.lookup((value.publisher, value.requestId))) {
      case (?current) db.candidates.update({ value with id = current.id });
      case null insertCandidate(db, value);
    };
  };

  public func getAuditByRequest(db : DB, auditor : Principal, requestId : Text) : ?Types.Audit { db.audits.by_request.lookup((auditor, requestId)) };
  public func getAudit(db : DB, id : Nat64) : ?Types.Audit { db.audits.get(id) };
  public func insertAudit(db : DB, value : Types.CreateAudit) : Result.Result<Types.Audit, Error> {
    switch (db.audits.insert(value)) {
      case (#err(error)) #err(error);
      case (#ok(id)) {
        let ?stored = db.audits.get(id) else Runtime.trap("Inserted marketplace audits row is missing");
        #ok(stored);
      };
    };
  };

  public func getPublishBatch(db : DB, owner : Principal, requestId : Text) : ?Types.PublishBatch {
    db.publishBatches.by_request.lookup((owner, requestId));
  };
  public func insertPublishBatch(db : DB, value : Types.CreatePublishBatch) : Result.Result<Types.PublishBatch, Error> {
    switch (db.publishBatches.insert(value)) {
      case (#err(error)) #err(error);
      case (#ok(id)) {
        let ?stored = db.publishBatches.get(id) else Runtime.trap("Inserted marketplace publication batch row is missing");
        #ok(stored);
      };
    };
  };

  public func getDelegate(db : DB, browser : Principal) : ?Types.Delegate { db.delegates.by_browser.lookup(browser) };
  public func insertDelegate(db : DB, value : Types.CreateDelegate) : Result.Result<Types.Delegate, Error> {
    switch (db.delegates.insert(value)) {
      case (#err(error)) #err(error);
      case (#ok(id)) {
        let ?stored = db.delegates.get(id) else Runtime.trap("Inserted marketplace delegates row is missing");
        #ok(stored);
      };
    };
  };
  public func putDelegate(db : DB, value : Types.CreateDelegate) : Result.Result<Types.Delegate, Error> {
    switch (db.delegates.by_browser.lookup(value.browser)) {
      case (?current) db.delegates.update({ value with id = current.id });
      case null insertDelegate(db, value);
    };
  };

  public func getGrant(db : DB, owner : Principal, requestId : Text) : ?Types.Grant { db.grants.by_request.lookup((owner, requestId)) };
  public func insertGrant(db : DB, value : Types.CreateGrant) : Result.Result<Types.Grant, Error> {
    switch (db.grants.insert(value)) {
      case (#err(error)) #err(error);
      case (#ok(id)) {
        let ?stored = db.grants.get(id) else Runtime.trap("Inserted marketplace grants row is missing");
        #ok(stored);
      };
    };
  };
  public func putGrant(db : DB, value : Types.CreateGrant) : Result.Result<Types.Grant, Error> {
    switch (db.grants.by_request.lookup((value.owner, value.requestId))) {
      case (?current) db.grants.update({ value with id = current.id });
      case null insertGrant(db, value);
    };
  };

  public func getManifest(db : DB, manifestId : Text) : ?Types.Manifest { db.manifests.by_manifestId.lookup(manifestId) };
  public func getManifestById(db : DB, id : Nat64) : ?Types.Manifest { db.manifests.get(id) };
  public func insertManifest(db : DB, value : Types.CreateManifest) : Result.Result<Types.Manifest, Error> {
    switch (db.manifests.insert(value)) {
      case (#err(error)) #err(error);
      case (#ok(id)) {
        let ?stored = db.manifests.get(id) else Runtime.trap("Inserted marketplace manifests row is missing");
        #ok(stored);
      };
    };
  };

  public func getOrder(db : DB, owner : Principal, requestId : Text) : ?Types.Order { db.orders.by_request.lookup((owner, requestId)) };
  public func getOrderById(db : DB, id : Nat64) : ?Types.Order { db.orders.get(id) };
  public func insertOrder(db : DB, value : Types.CreateOrder) : Result.Result<Types.Order, Error> {
    switch (db.orders.insert(value)) {
      case (#err(error)) #err(error);
      case (#ok(id)) {
        let ?stored = db.orders.get(id) else Runtime.trap("Inserted marketplace orders row is missing");
        #ok(stored);
      };
    };
  };
  public func putOrder(db : DB, value : Types.CreateOrder) : Result.Result<Types.Order, Error> {
    switch (db.orders.by_request.lookup((value.owner, value.requestId))) {
      case (?current) db.orders.update({ value with id = current.id });
      case null insertOrder(db, value);
    };
  };

  public func getQuoteRecord(db : DB, owner : Principal, kind : { #purchase; #withdrawal }, requestId : Text, commitment : Blob) : ?Types.QuoteRecord {
    let tag : Nat8 = switch (kind) { case (#purchase) 0; case (#withdrawal) 1 };
    db.quoteRecords.by_request.lookup((owner, tag, requestId, commitment));
  };
  public func insertQuoteRecord(db : DB, value : Types.CreateQuoteRecord) : Result.Result<Types.QuoteRecord, Error> {
    switch (db.quoteRecords.insert(value)) {
      case (#err(error)) #err(error);
      case (#ok(id)) {
        let ?stored = db.quoteRecords.get(id) else Runtime.trap("Inserted immutable quote is missing");
        #ok(stored);
      };
    };
  };

  public func getWithdrawal(db : DB, owner : Principal, requestId : Text) : ?Types.Withdrawal { db.withdrawals.by_request.lookup((owner, requestId)) };
  public func getWithdrawalById(db : DB, id : Nat64) : ?Types.Withdrawal { db.withdrawals.get(id) };
  public func insertWithdrawal(db : DB, value : Types.CreateWithdrawal) : Result.Result<Types.Withdrawal, Error> {
    switch (db.withdrawals.insert(value)) {
      case (#err(error)) #err(error);
      case (#ok(id)) {
        let ?stored = db.withdrawals.get(id) else Runtime.trap("Inserted marketplace withdrawals row is missing");
        #ok(stored);
      };
    };
  };
  public func putWithdrawal(db : DB, value : Types.CreateWithdrawal) : Result.Result<Types.Withdrawal, Error> {
    switch (db.withdrawals.by_request.lookup((value.owner, value.requestId))) {
      case (?current) db.withdrawals.update({ value with id = current.id });
      case null insertWithdrawal(db, value);
    };
  };

  public func getCredit(db : DB, ledger : Principal, owner : Principal, isBurn : Bool) : ?Types.Credit { db.credits.by_beneficiary.lookup((ledger, owner, isBurn)) };
  public func insertCredit(db : DB, value : Types.CreateCredit) : Result.Result<Types.Credit, Error> {
    switch (db.credits.insert(value)) {
      case (#err(error)) #err(error);
      case (#ok(id)) {
        let ?stored = db.credits.get(id) else Runtime.trap("Inserted marketplace credits row is missing");
        #ok(stored);
      };
    };
  };
  public func putCredit(db : DB, value : Types.CreateCredit) : Result.Result<Types.Credit, Error> {
    switch (db.credits.by_beneficiary.lookup((value.ledger, value.owner, value.isBurn))) {
      case (?current) db.credits.update({ value with id = current.id });
      case null insertCredit(db, value);
    };
  };

  public func getClaim(db : DB, owner : Principal, appId : Text) : ?Types.Claim { db.claims.by_owner_app.lookup((owner, appId)) };
  public func insertClaim(db : DB, value : Types.CreateClaim) : Result.Result<Types.Claim, Error> {
    switch (db.claims.insert(value)) {
      case (#err(error)) #err(error);
      case (#ok(id)) {
        let ?stored = db.claims.get(id) else Runtime.trap("Inserted marketplace claims row is missing");
        #ok(stored);
      };
    };
  };
  public func putClaim(db : DB, value : Types.CreateClaim) : Result.Result<Types.Claim, Error> {
    switch (db.claims.by_owner_app.lookup((value.owner, value.appId))) {
      case (?current) db.claims.update({ value with id = current.id });
      case null insertClaim(db, value);
    };
  };

  public func getEntitlement(db : DB, owner : Principal, appId : Text) : ?Types.Entitlement { db.entitlements.by_owner_app.lookup((owner, appId)) };
  public func insertEntitlement(db : DB, value : Types.CreateEntitlement) : Result.Result<Types.Entitlement, Error> {
    switch (db.entitlements.insert(value)) {
      case (#err(error)) #err(error);
      case (#ok(id)) {
        let ?stored = db.entitlements.get(id) else Runtime.trap("Inserted marketplace entitlements row is missing");
        #ok(stored);
      };
    };
  };
  public func putEntitlement(db : DB, value : Types.CreateEntitlement) : Result.Result<Types.Entitlement, Error> {
    switch (db.entitlements.by_owner_app.lookup((value.owner, value.appId))) {
      case (?current) db.entitlements.update({ value with id = current.id });
      case null insertEntitlement(db, value);
    };
  };

  public func getAcquisition(db : DB, owner : Principal, appId : Text) : ?Types.Acquisition { db.acquisitions.by_owner_app.lookup((owner, appId)) };
  public func insertAcquisition(db : DB, value : Types.CreateAcquisition) : Result.Result<Types.Acquisition, Error> {
    switch (db.acquisitions.insert(value)) {
      case (#err(error)) #err(error);
      case (#ok(id)) {
        let ?stored = db.acquisitions.get(id) else Runtime.trap("Inserted marketplace acquisitions row is missing");
        #ok(stored);
      };
    };
  };

  public func getRanking(db : DB, appId : Text) : ?Types.Ranking { db.rankings.by_app.lookup(appId) };
  public func insertRanking(db : DB, value : Types.CreateRanking) : Result.Result<Types.Ranking, Error> {
    switch (db.rankings.insert(value)) {
      case (#err(error)) #err(error);
      case (#ok(id)) {
        let ?stored = db.rankings.get(id) else Runtime.trap("Inserted marketplace rankings row is missing");
        #ok(stored);
      };
    };
  };
  public func putRanking(db : DB, value : Types.CreateRanking) : Result.Result<Types.Ranking, Error> {
    switch (db.rankings.by_app.lookup(value.appId)) {
      case (?current) db.rankings.update({ value with id = current.id });
      case null insertRanking(db, value);
    };
  };

  public func getRating(db : DB, owner : Principal, appId : Text) : ?Types.Rating { db.ratings.by_owner_app.lookup((owner, appId)) };
  public func insertRating(db : DB, value : Types.CreateRating) : Result.Result<Types.Rating, Error> {
    switch (db.ratings.insert(value)) {
      case (#err(error)) #err(error);
      case (#ok(id)) {
        let ?stored = db.ratings.get(id) else Runtime.trap("Inserted marketplace ratings row is missing");
        #ok(stored);
      };
    };
  };
  public func putRating(db : DB, value : Types.CreateRating) : Result.Result<Types.Rating, Error> {
    switch (db.ratings.by_owner_app.lookup((value.owner, value.appId))) {
      case (?current) db.ratings.update({ value with id = current.id });
      case null insertRating(db, value);
    };
  };

  public func getRate(db : DB, ledger : Principal) : ?Types.Rate { db.rates.by_ledger.lookup(ledger) };
  public func insertRate(db : DB, value : Types.CreateRate) : Result.Result<Types.Rate, Error> {
    switch (db.rates.insert(value)) {
      case (#err(error)) #err(error);
      case (#ok(id)) {
        let ?stored = db.rates.get(id) else Runtime.trap("Inserted marketplace rates row is missing");
        #ok(stored);
      };
    };
  };
  public func putRate(db : DB, value : Types.CreateRate) : Result.Result<Types.Rate, Error> {
    switch (db.rates.by_ledger.lookup(value.ledger)) {
      case (?current) db.rates.update({ value with id = current.id });
      case null insertRate(db, value);
    };
  };

  public func getUploadByRequest(db : DB, owner : Principal, requestId : Text) : ?Types.Upload { db.uploads.by_request.lookup((owner, requestId)) };
  public func getUpload(db : DB, id : Nat64) : ?Types.Upload { db.uploads.get(id) };
  public func insertUpload(db : DB, value : Types.CreateUpload) : Result.Result<Types.Upload, Error> {
    switch (db.uploads.insert(value)) {
      case (#err(error)) #err(error);
      case (#ok(id)) {
        let ?stored = db.uploads.get(id) else Runtime.trap("Inserted marketplace uploads row is missing");
        #ok(stored);
      };
    };
  };
  public func putUpload(db : DB, value : Types.CreateUpload) : Result.Result<Types.Upload, Error> {
    switch (db.uploads.by_request.lookup((value.owner, value.requestId))) {
      case (?current) db.uploads.update({ value with id = current.id });
      case null insertUpload(db, value);
    };
  };

  public func getChargeByRequest(db : DB, owner : Principal, requestId : Text, method : Text) : ?Types.Charge { db.charges.by_request.lookup((owner, requestId, method)) };
  public func getCharge(db : DB, id : Nat64) : ?Types.Charge { db.charges.get(id) };
  public func insertCharge(db : DB, value : Types.CreateCharge) : Result.Result<Types.Charge, Error> {
    switch (db.charges.insert(value)) {
      case (#err(error)) #err(error);
      case (#ok(id)) {
        let ?stored = db.charges.get(id) else Runtime.trap("Inserted marketplace charges row is missing");
        #ok(stored);
      };
    };
  };

  public func getJob(db : DB, key : Text) : ?Types.Job { db.jobs.by_key.lookup(key) };
  public func insertJob(db : DB, value : Types.CreateJob) : Result.Result<Types.Job, Error> {
    switch (db.jobs.insert(value)) {
      case (#err(error)) #err(error);
      case (#ok(id)) {
        let ?stored = db.jobs.get(id) else Runtime.trap("Inserted marketplace jobs row is missing");
        #ok(stored);
      };
    };
  };
  public func putJob(db : DB, value : Types.CreateJob) : Result.Result<Types.Job, Error> {
    switch (db.jobs.by_key.lookup(value.key)) {
      case (?current) db.jobs.update({ value with id = current.id });
      case null insertJob(db, value);
    };
  };

  public func getReferralByOwner(db : DB, owner : Principal) : ?Types.Referral { db.referrals.by_owner.lookup(owner) };
  public func getReferralByCode(db : DB, code : Text) : ?Types.Referral { db.referrals.by_code.lookup(code) };
  public func insertReferral(db : DB, value : Types.CreateReferral) : Result.Result<Types.Referral, Error> {
    switch (db.referrals.insert(value)) {
      case (#err(error)) #err(error);
      case (#ok(id)) {
        let ?stored = db.referrals.get(id) else Runtime.trap("Inserted referral is missing");
        #ok(stored);
      };
    };
  };

  public func getAttempt(db : DB, id : Nat64) : ?Types.Attempt { db.attempts.get(id) };
  public func insertAttempt(db : DB, value : Types.CreateAttempt) : Result.Result<Types.Attempt, Error> {
    switch (db.attempts.insert(value)) {
      case (#err(error)) #err(error);
      case (#ok(id)) {
        let ?stored = db.attempts.get(id) else Runtime.trap("Inserted ledger attempt is missing");
        #ok(stored);
      };
    };
  };
  public func putAttempt(db : DB, value : Types.CreateAttempt) : Result.Result<Types.Attempt, Error> {
    let kind : Nat8 = switch (value.operationKind) { case (#purchase) 0; case (#withdrawal) 1; case (#evm_sweep) 2 };
    switch (db.attempts.by_operation_ordinal.lookup((value.owner, kind, value.operationId, value.ordinal))) {
      case (?current) db.attempts.update({ value with id = current.id });
      case null insertAttempt(db, value);
    };
  };

  public func getEvmInvoice(db : DB, id : Nat64) : ?Types.EvmInvoice { db.evmInvoices.get(id) };
  public func getEvmInvoiceByOrder(db : DB, orderId : Nat64) : ?Types.EvmInvoice { db.evmInvoices.by_order.lookup(orderId) };
  public func getEvmInvoiceByRequest(db : DB, owner : Principal, requestId : Text) : ?Types.EvmInvoice { db.evmInvoices.by_request.lookup((owner, requestId)) };
  public func insertEvmInvoice(db : DB, value : Types.CreateEvmInvoice) : Result.Result<Types.EvmInvoice, Error> {
    switch (db.evmInvoices.insert(value)) {
      case (#err(error)) #err(error);
      case (#ok(id)) {
        let ?stored = db.evmInvoices.get(id) else Runtime.trap("Inserted Ethereum invoice is missing");
        #ok(stored);
      };
    };
  };
  public func getEvmReceipt(db : DB, id : Nat64) : ?Types.EvmReceipt { db.evmReceipts.get(id) };
  public func getEvmReceiptByEvent(db : DB, eventKey : Text) : ?Types.EvmReceipt { db.evmReceipts.by_event.lookup(eventKey) };
  public func insertEvmReceipt(db : DB, value : Types.CreateEvmReceipt) : Result.Result<Types.EvmReceipt, Error> {
    switch (db.evmReceipts.insert(value)) {
      case (#err(error)) #err(error);
      case (#ok(id)) {
        let ?stored = db.evmReceipts.get(id) else Runtime.trap("Inserted Ethereum receipt is missing");
        #ok(stored);
      };
    };
  };
  public func getEvmSweep(db : DB, id : Nat64) : ?Types.EvmSweep { db.evmSweeps.get(id) };
  public func getEvmSweepByOrdinal(db : DB, invoiceId : Nat64, ordinal : Nat64) : ?Types.EvmSweep { db.evmSweeps.by_invoice_ordinal.lookup((invoiceId, ordinal)) };
  public func insertEvmSweep(db : DB, value : Types.CreateEvmSweep) : Result.Result<Types.EvmSweep, Error> {
    switch (db.evmSweeps.insert(value)) {
      case (#err(error)) #err(error);
      case (#ok(id)) {
        let ?stored = db.evmSweeps.get(id) else Runtime.trap("Inserted Ethereum sweep is missing");
        #ok(stored);
      };
    };
  };

  public func getArtifact(db : DB, id : Nat64) : ?Types.Artifact { db.artifacts.get(id) };
  public func getArtifactByDigest(db : DB, digest : Blob) : ?Types.Artifact { db.artifacts.by_digest.lookup(digest) };
  public func insertArtifact(db : DB, value : Types.CreateArtifact) : Result.Result<Types.Artifact, Error> {
    switch (db.artifacts.insert(value)) {
      case (#err(error)) #err(error);
      case (#ok(id)) {
        let ?stored = db.artifacts.get(id) else Runtime.trap("Inserted artifact is missing");
        #ok(stored);
      };
    };
  };
  public func getGrantByCredential(db : DB, digest : Blob) : ?Types.Grant { db.grants.by_credential.lookup(digest) };
  public func removeClaim(db : DB, owner : Principal, appId : Text) : Result.Result<(), Error> {
    switch (getClaim(db, owner, appId)) {
      case null #ok(());
      case (?claim) db.claims.delete(claim.id);
    };
  };

  // Internal-only content primitives. Public domain entrypoints authorize before
  // invoking them; no raw-reference Candid endpoint is introduced here.
  public func beginBlob(db : DB, size : Nat64) : Result.Result<StableBlob.Upload, StableBlob.Error> { db.blobs.uploads.begin(size) };
  public func appendBlob(db : DB, upload : StableBlob.Upload, offset : Nat64, bytes : Blob) : Result.Result<Nat64, StableBlob.Error> { db.blobs.uploads.append(upload, offset, bytes) };
  public func blobUploadInfo(db : DB, upload : StableBlob.Upload) : Result.Result<StableBlob.UploadInfo, StableBlob.Error> { db.blobs.uploads.info(upload) };
  public func abortBlob(db : DB, upload : StableBlob.Upload) : Result.Result<(), StableBlob.Error> { db.blobs.uploads.abort(upload) };
  public func readBlob(db : DB, ref : StableBlob.Ref, offset : Nat64, length : Nat) : Result.Result<Blob, StableBlob.Error> { db.blobs.readRange(ref, { offset; length }) };
};
