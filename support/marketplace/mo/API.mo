// All rights reserved. See ../LICENSE.
import Billing "./Billing";
import PaymentState "./PaymentState";
import Types "./Types";

module {
  public type Error = { code : Text; message : Text };
  public type Result<T> = { #ok : T; #err : Error };
  public type Window = { #week; #month; #all };
  public type Tier = { #free; #paid };
  public type Cursor = { generation : Nat64; offset : Nat };
  public type PageRequest = { cursor : ?Nat64; limit : Nat };
  public type CatalogRequest = {
    search : Text;
    tier : Tier;
    window : Window;
    cursor : ?Cursor;
    limit : Nat;
  };
  public type App = {
    appId : Text;
    publisher : Principal;
    title : Text;
    summary : Text;
    description : Text;
    priceUsdMicros : Nat;
    revision : Nat64;
    version : ?Nat;
    iconUrl : ?Text;
    iconArtifact : ?Nat64;
    screenshots : [Text];
    screenshotArtifacts : [Nat64];
    ratingCount : Nat;
    ratingTotal : Nat;
    // Lifetime distinct Neutron acquisitions, separated by the price paid then.
    // Optional for clients that also read older protocol releases.
    acquisitionCounts : ?{ free : Nat; paid : Nat };
    owned : Bool;
    visible : Bool;
  };
  public type CatalogPage = {
    apps : [App];
    nextCursor : ?Cursor;
    asOfNs : Int;
    generation : Nat64;
    refreshing : Bool;
  };
  public type AppPage = { apps : [App]; nextCursor : ?Nat64 };
  public type AppDetail = {
    app : App;
    candidate : ?Types.Candidate;
    audit : ?Types.Audit;
    rating : ?Types.Rating;
  };
  public type Info = {
    version : Nat;
    canister : Principal;
    trustedPublishingPrincipal : ?Principal;
    tokens : [Types.TokenConfig];
    fees : Types.FeeSchedule;
    referralTerms : Types.ReferralTerms;
  };
  public type FeeRequest = { operation : Billing.Operation; processingBytes : Nat; newStorageBytes : Nat };
  public type ReadDelegateRequest = { browser : Principal; active : Bool; feeVersion : Nat };
  public type ListingRequest = {
    appId : Text;
    title : Text;
    summary : Text;
    description : Text;
    priceUsdMicros : Nat;
    iconArtifact : ?Nat64;
    screenshots : [Nat64];
    expectedRevision : ?Nat64;
    feeVersion : Nat;
  };
  public type RatingRequest = { appId : Text; stars : Nat; review : Text; feeVersion : Nat };
  public type FeeVersion = { feeVersion : Nat };
  public type PurchaseRequest = {
    requestId : Text;
    appIds : [Text];
    ledger : Principal;
    referralCode : ?Text;
  };
  public type CheckoutQuote = {
    request : PurchaseRequest;
    buyer : Principal;
    items : [Types.PurchaseItem];
    amount : Nat;
    fee : Nat;
    affiliate : ?Principal;
    rate : ?Types.Rate;
    spender : Types.Account;
    commitment : Blob;
    cycles : Billing.Quote;
    quotedAtNs : Int;
  };
  public type PurchaseExecute = { quote : CheckoutQuote; feeVersion : Nat };
  public type OperationRequest = { requestId : Text };
  public type PurchaseResult = { order : Types.Order; attempt : ?Types.Attempt; quote : ?CheckoutQuote; active : Bool; nextAction : PaymentState.NextAction };
  public type WithdrawalRequest = {
    requestId : Text;
    ledger : Principal;
    to : Types.Account;
    totalDebit : Nat;
  };
  public type WithdrawalQuote = {
    request : WithdrawalRequest;
    owner : Principal;
    fee : Nat;
    netAmount : Nat;
    available : Nat;
    commitment : Blob;
    cycles : Billing.Quote;
  };
  public type WithdrawalExecute = { quote : WithdrawalQuote; feeVersion : Nat };
  public type WithdrawalResult = { withdrawal : Types.Withdrawal; attempt : ?Types.Attempt; quote : ?WithdrawalQuote; active : Bool; nextAction : PaymentState.NextAction };
  public type Earnings = { credits : [Types.Credit]; referral : ?Types.Referral };
  public type ReferralQuote = { code : Text; affiliate : Principal; discountBps : Nat; termsVersion : Nat };
  public type HistoryCursor = { #start; #after : Nat64; #done };
  public type OperationHistoryRequest = { purchaseCursor : HistoryCursor; withdrawalCursor : HistoryCursor; limit : Nat };
  public type OperationHistory = {
    purchases : [PurchaseResult]; withdrawals : [WithdrawalResult];
    nextPurchaseCursor : HistoryCursor; nextWithdrawalCursor : HistoryCursor;
  };

  public type UploadBegin = {
    requestId : Text;
    appId : Text;
    digest : Blob;
    size : Nat64;
    mediaType : Text;
    purpose : { #package; #source; #image };
    feeVersion : Nat;
  };
  public type UploadStatus = {
    id : Nat64;
    requestId : Text;
    appId : Text;
    digest : Blob;
    size : Nat64;
    uploadedBytes : Nat64;
    state : { #uploading; #attached; #aborted };
    artifactId : ?Nat64;
    charge : Types.Charge;
  };
  public type UploadChunk = { requestId : Text; offset : Nat64; bytes : Blob; feeVersion : Nat };
  public type UploadFinish = { requestId : Text; feeVersion : Nat };
  public type CandidateRequest = {
    requestId : Text;
    appId : Text;
    version : Nat;
    artifactId : Nat64;
    sourceArtifactId : ?Nat64;
    dependencies : [{ appId : Text; minVersion : Nat }];
    feeVersion : Nat;
  };
  public type TrustedPublishRequest = {
    requestId : Text;
    candidates : [{ candidateId : Nat64; expectedDigest : Blob; expectedSourceDigest : ?Blob }];
    analysis : Text;
  };
  public type AuditRequest = {
    requestId : Text;
    candidateId : Nat64;
    expectedDigest : Blob;
    expectedSourceDigest : ?Blob;
    decision : { #approved; #rejected; #revoked };
    analysis : Text;
    reason : ?Text;
  };
  public type AuditorRequest = { principal : Principal; active : Bool; feeVersion : Nat };
  public type ReservationRequest = { appId : Text; publisher : Principal; title : Text; feeVersion : Nat };
  public type BurnAccountRequest = { ledger : Principal; account : ?Types.Account; feeVersion : Nat };
  public type CandidatePage = { candidates : [Types.Candidate]; nextCursor : ?Nat64 };

  // Fixed generic source wire format, shared with the Kernel acquisition client.
  public type RepoAccessRequest = { request_id : Text; token : Text; paths : [Text]; fee_version : Nat };
  public type RepoAccessResult = Result<{ request_id : Text; paths : [Text]; accepted_cycles : Nat }>;
  public type InstallRequest = { requestId : Text; appIds : [Text]; feeVersion : Nat };
  public type InstallResult = { canister : Principal; manifestId : Text; digest : Text; setupUrl : Text; appIds : [Text] };
}
