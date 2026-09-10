// Proprietary marketplace protocol. All rights reserved.
import Generated "../.ashroot/lib";
import StableBlob "mo:ashroot/stable_blob";

module {
  public type Account = { owner : Principal; subaccount : ?Blob };
  public type FeeSchedule = { version : Nat; updateBase : Nat; updateByte : Nat; storageByteYear : Nat; purchase : Nat; withdraw : Nat; grant : Nat; xrc : Nat };
  public type ReferralTerms = { version : Nat; discountBps : Nat; affiliateBps : Nat; developerBps : Nat };
  public type TokenConfig = { ledger : Principal; symbol : Text; decimals : Nat8; fee : Nat; rateSymbol : Text; burnAccount : ?{ owner : Principal; subaccount : ?Blob } };
  public type Config = { admins : [Principal]; auditors : [Principal]; tokens : [{ ledger : Principal; symbol : Text; decimals : Nat8; fee : Nat; rateSymbol : Text; burnAccount : ?{ owner : Principal; subaccount : ?Blob } }]; xrc : Principal; fees : { version : Nat; updateBase : Nat; updateByte : Nat; storageByteYear : Nat; purchase : Nat; withdraw : Nat; grant : Nat; xrc : Nat }; referralTerms : { version : Nat; discountBps : Nat; affiliateBps : Nat; developerBps : Nat } };
  public type AcquisitionKind = { #free; #paid };
  public type OperationState = { #prepared; #funding_required; #dispatched; #outcome_unknown; #failed; #complete };
  public type PurchaseItem = { appId : Text; listingRevision : Nat64; publisher : Principal; priceUsdMicros : Nat; paidAtoms : Nat; developerAtoms : Nat; affiliateAtoms : Nat; burnAtoms : Nat; releaseDigest : Blob };
  public type LedgerRequest = { kind : { #transfer; #transfer_from }; ledger : Principal; spenderSubaccount : ?Blob; to : { owner : Principal; subaccount : ?Blob }; amount : Nat; fee : Nat; memo : Blob; createdAtTimeNs : Nat64; fromAccount : { owner : Principal; subaccount : ?Blob } };
  public type ExpiryCursor = { atNs : Int; id : Nat64 };
  public type ChartEntry = { appId : Text; score : Nat };
  public type Charts = { free7 : [{ appId : Text; score : Nat }]; free30 : [{ appId : Text; score : Nat }]; freeAll : [{ appId : Text; score : Nat }]; paid7 : [{ appId : Text; score : Nat }]; paid30 : [{ appId : Text; score : Nat }]; paidAll : [{ appId : Text; score : Nat }] };
  public type RankingMaintenance = { expiry7 : ?{ atNs : Int; id : Nat64 }; expiry30 : ?{ atNs : Int; id : Nat64 }; generation : Nat64; asOfNs : Int; charts : { free7 : [{ appId : Text; score : Nat }]; free30 : [{ appId : Text; score : Nat }]; freeAll : [{ appId : Text; score : Nat }]; paid7 : [{ appId : Text; score : Nat }]; paid30 : [{ appId : Text; score : Nat }]; paidAll : [{ appId : Text; score : Nat }] }; dirty : Bool };
  public type Reservation = { appId : Text; publisher : Principal; title : Text };
  public type Init = Config and { reservations : ?[Reservation] };
  public type Error = Generated.Errors.Error;
  public type BlobRef = StableBlob.Ref;
  public type BlobInput = StableBlob.Input;
  public type BlobUpload = StableBlob.Upload;

  public type App = { id : Nat64; appId : Text; owner : Principal; title : Text; summary : Text; description : Text; priceUsdMicros : Nat; revision : Nat64; approvedCandidate : ?Nat64; visible : Bool; iconArtifact : ?Nat64; screenshots : [Nat64]; ratingCount : Nat; ratingTotal : Nat; createdAtNs : Int; updatedAtNs : Int };
  public type CreateApp = Generated.Types.CreateApp;

  public type Listing = { id : Nat64; appId : Text; revision : Nat64; owner : Principal; title : Text; summary : Text; description : Text; priceUsdMicros : Nat; iconArtifact : ?Nat64; screenshots : [Nat64]; createdAtNs : Int };
  public type CreateListing = Generated.Types.CreateListing;

  public type Candidate = { id : Nat64; appId : Text; version : Nat; publisher : Principal; requestId : Text; listingRevision : Nat64; artifactId : Nat64; sourceArtifactId : ?Nat64; digest : Blob; sourceDigest : ?Blob; dependencies : [{ appId : Text; minVersion : Nat }]; state : { #pending; #approved; #rejected; #revoked }; published : Bool; createdAtNs : Int; updatedAtNs : Int };
  public type CreateCandidate = Generated.Types.CreateCandidate;

  public type Artifact = { id : Nat64; digest : Blob; size : Nat64; mediaType : Text; content : StableBlob.Ref; publicLegacy : Bool; createdAtNs : Int };
  public type CreateArtifact = Generated.Types.CreateArtifact;

  public type Audit = { id : Nat64; auditor : Principal; requestId : Text; candidateId : Nat64; decision : { #approved; #rejected; #revoked }; analysis : Text; reason : ?Text; createdAtNs : Int };
  public type CreateAudit = Generated.Types.CreateAudit;

  public type Delegate = { id : Nat64; browser : Principal; owner : Principal; active : Bool; createdAtNs : Int; updatedAtNs : Int };
  public type CreateDelegate = Generated.Types.CreateDelegate;

  public type Grant = { id : Nat64; owner : Principal; requestId : Text; credentialHash : Blob; authorizationHash : Blob; paths : [Text]; delegate : ?Principal; artifactIds : [Nat64]; purpose : { #buyer; #publisher; #auditor }; revoked : Bool; createdAtNs : Int; updatedAtNs : Int };
  public type CreateGrant = Generated.Types.CreateGrant;

  public type Manifest = { id : Nat64; owner : Principal; requestId : Text; manifestId : Text; content : Blob; digest : Blob; candidateIds : [Nat64]; createdAtNs : Int };
  public type CreateManifest = Generated.Types.CreateManifest;

  public type Order = { id : Nat64; owner : Principal; requestId : Text; intentHash : Blob; quoteCommitment : Blob; ledger : Principal; amount : Nat; fee : Nat; affiliate : ?Principal; rateId : Nat64; items : [{ appId : Text; listingRevision : Nat64; publisher : Principal; priceUsdMicros : Nat; paidAtoms : Nat; developerAtoms : Nat; affiliateAtoms : Nat; burnAtoms : Nat; releaseDigest : Blob }]; state : { #prepared; #funding_required; #dispatched; #outcome_unknown; #failed; #complete }; currentAttempt : ?Nat64; createdAtNs : Int; updatedAtNs : Int; finalizedAtNs : ?Int; lastError : ?Text };
  public type CreateOrder = Generated.Types.CreateOrder;

  public type QuoteRecord = { id : Nat64; owner : Principal; requestId : Text; kind : { #purchase; #withdrawal }; commitment : Blob; content : Blob; createdAtNs : Int };
  public type CreateQuoteRecord = Generated.Types.CreateQuoteRecord;

  public type Withdrawal = { id : Nat64; owner : Principal; requestId : Text; intentHash : Blob; ledger : Principal; to : { owner : Principal; subaccount : ?Blob }; totalDebit : Nat; fee : Nat; isBurn : Bool; state : { #prepared; #funding_required; #dispatched; #outcome_unknown; #failed; #complete }; currentAttempt : ?Nat64; createdAtNs : Int; updatedAtNs : Int; finalizedAtNs : ?Int; lastError : ?Text };
  public type CreateWithdrawal = Generated.Types.CreateWithdrawal;

  public type Attempt = { id : Nat64; owner : Principal; operationKind : { #purchase; #withdrawal; #evm_sweep }; operationId : Nat64; ordinal : Nat64; request : { kind : { #transfer; #transfer_from }; ledger : Principal; spenderSubaccount : ?Blob; to : { owner : Principal; subaccount : ?Blob }; amount : Nat; fee : Nat; memo : Blob; createdAtTimeNs : Nat64; fromAccount : { owner : Principal; subaccount : ?Blob } }; state : { #prepared; #dispatched; #outcome_unknown; #no_effect; #succeeded }; hadUnknown : Bool; block : ?Nat; duplicate : Bool; lastLedgerError : ?Blob; lastError : ?Text; createdAtNs : Int; updatedAtNs : Int };
  public type CreateAttempt = Generated.Types.CreateAttempt;

  public type EvmRoute = { chainId : Nat; minter : Principal; helper : Text; minterAddress : Text; token : Text; ledger : Principal; decimals : Nat8 };
  public type EvmInvoice = {
    id : Nat64; owner : Principal; requestId : Text; orderId : Nat64; subaccount : Blob; route : EvmRoute;
    payer : Text; quoteContent : Blob; saleAtoms : Nat; grossAtoms : Nat; sweepFee : Nat;
    canceledAtNs : ?Int; acceptedReceiptId : ?Nat64; entitlementGrantedAtNs : ?Int;
    revenueFinalizedAtNs : ?Int; currentSweepId : ?Nat64; nextSweepOrdinal : Nat64;
    creditedBuyerAtoms : Nat; lastBalance : ?Nat; lastBalanceAtNs : ?Int; workClass : Nat8; nextCheckAtNs : Int;
    createdAtNs : Int; updatedAtNs : Int; lastError : ?Text;
  };
  public type CreateEvmInvoice = Generated.Types.CreateEvmInvoice;

  public type EvmReceipt = {
    id : Nat64; invoiceId : Nat64; eventKey : Text; transactionHash : Text; logIndex : Nat;
    blockNumber : Nat; blockHash : Text; payer : Text; amount : Nat; observedAtNs : Int;
  };
  public type CreateEvmReceipt = Generated.Types.CreateEvmReceipt;

  public type EvmSweep = {
    id : Nat64; invoiceId : Nat64; ordinal : Nat64; purpose : { #sale; #buyer_credit };
    amount : Nat; fee : Nat; attemptId : Nat64; finalizedAtNs : ?Int; createdAtNs : Int; updatedAtNs : Int;
  };
  public type CreateEvmSweep = Generated.Types.CreateEvmSweep;

  public type Credit = { id : Nat64; ledger : Principal; owner : Principal; isBurn : Bool; available : Nat; reserved : Nat; updatedAtNs : Int };
  public type CreateCredit = Generated.Types.CreateCredit;

  public type Claim = { id : Nat64; owner : Principal; appId : Text; orderId : Nat64; createdAtNs : Int };
  public type CreateClaim = Generated.Types.CreateClaim;

  public type Entitlement = { id : Nat64; owner : Principal; appId : Text; orderId : Nat64; kind : { #free; #paid }; acquiredAtNs : Int };
  public type CreateEntitlement = Generated.Types.CreateEntitlement;

  public type Acquisition = { id : Nat64; owner : Principal; appId : Text; orderId : Nat64; kind : { #free; #paid }; atNs : Int; paidAtoms : Nat; ledger : ?Principal; block : ?Nat };
  public type CreateAcquisition = Generated.Types.CreateAcquisition;

  public type Ranking = { id : Nat64; appId : Text; free7 : Nat; free30 : Nat; freeAll : Nat; paid7 : Nat; paid30 : Nat; paidAll : Nat; eligible : Bool; isFree : Bool };
  public type CreateRanking = Generated.Types.CreateRanking;

  public type Referral = { id : Nat64; owner : Principal; code : Text; createdAtNs : Int };
  public type CreateReferral = Generated.Types.CreateReferral;

  public type Rating = { id : Nat64; owner : Principal; appId : Text; stars : Nat; review : Text; createdAtNs : Int; updatedAtNs : Int };
  public type CreateRating = Generated.Types.CreateRating;

  public type Rate = { id : Nat64; ledger : Principal; symbol : Text; usdRate : Nat; decimals : Nat32; observedAtNs : Int; refreshedAtNs : Int; lastError : ?Text };
  public type CreateRate = Generated.Types.CreateRate;

  public type Upload = { id : Nat64; owner : Principal; requestId : Text; appId : Text; digest : Blob; size : Nat64; mediaType : Text; purpose : { #package; #source; #image }; ticket : { upload : { pool : Nat; slot : Nat64; generation : Nat64 } }; hashState : ?Blob; chargeId : Nat64; state : { #uploading; #attached; #aborted }; artifactId : ?Nat64; createdAtNs : Int; updatedAtNs : Int };
  public type CreateUpload = Generated.Types.CreateUpload;

  public type Charge = { id : Nat64; owner : Principal; requestId : Text; method : Text; feeVersion : Nat; cycles : Nat; processingCycles : Nat; storageCycles : Nat; coveredBytes : Nat64; coverageFromNs : Int; coverageUntilNs : Int; createdAtNs : Int };
  public type CreateCharge = Generated.Types.CreateCharge;

  public type Job = { id : Nat64; key : Text; kind : { #xrc; #forward; #rankings; #uploads }; ledger : ?Principal; scheduledAtNs : Int; state : { #scheduled; #running; #waiting; #complete; #failed }; operationId : ?Nat64; attempts : Nat; lastError : ?Text; updatedAtNs : Int };
  public type CreateJob = Generated.Types.CreateJob;

};
