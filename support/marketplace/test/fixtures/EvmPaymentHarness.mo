// PocketIC-only EVM payment-domain harness. External actors are controlled
// fixtures; payment logic, receipt validation and retained storage are real.
import Iter "mo:core/Iter";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
import Time "mo:core/Time";
import API "../../mo/API";
import Encoding "../../mo/Encoding";
import EvmEvidence "../../mo/EvmEvidence";
import EvmMinter "../../mo/EvmMinter";
import EvmPayments "../../mo/EvmPayments";
import EvmRpc "../../mo/EvmRpc";
import Ledger "../../mo/Ledger";
import Journal "../../mo/PaymentStore";
import Purchases "../../mo/Purchases";
import Quotes "../../mo/Quotes";
import Store "../../mo/Store";
import Types "../../mo/Types";

persistent actor class EvmPaymentHarness(config : Types.Config, ledgerId : Principal, minterId : Principal, rpcId : Principal) = self {
  let memory = Store.init(config);
  var failRevenueFinalization = false;
  var failGrant = false;
  transient let db = Store.Use(memory);
  transient let marketplace = Principal.fromActor(self);
  transient let ledger : Ledger.Client = {
    transfer = func(expected : Principal, args : Ledger.TransferArgs) : async* Ledger.Outcome {
      assert expected == EvmMinter.ckusdcLedger();
      await* Ledger.transfer(ledgerId, args);
    };
    transferFrom = func(expected : Principal, args : Ledger.TransferFromArgs) : async* Ledger.Outcome {
      assert expected == EvmMinter.ckusdcLedger();
      await* Ledger.transferFrom(ledgerId, args);
    };
  };
  transient let minter : EvmMinter.Client = {
    getInfo = func(expected : Principal) : async* EvmMinter.Result<EvmMinter.Info> {
      assert expected == EvmMinter.minterCanister();
      await* EvmMinter.getInfo(minterId);
    };
    isAddressBlocked = func(expected : Principal, payer : Text) : async* EvmMinter.Result<Bool> {
      assert expected == EvmMinter.minterCanister();
      await* EvmMinter.isAddressBlocked(minterId, payer);
    };
    balanceOf = func(expected : Principal, account : Ledger.Account) : async* EvmMinter.Result<Nat> {
      assert expected == EvmMinter.ckusdcLedger();
      await* EvmMinter.balanceOf(ledgerId, account);
    };
  };
  transient let rpc = EvmRpc.client(rpcId);
  transient let rpcOptions : EvmRpc.Options = {
    providers = [#PublicNode, #Ankr, #Llama]; receiptResponseBytes = 16_384; blockResponseBytes = 16_384;
    receiptCycles = 100; blockCycles = 100;
  };
  transient let revenueDb : Store.DB = {
    db with credits = {
      db.credits with
      insert = func(value : Types.CreateCredit) : { #ok : Nat64; #err : Types.Error } {
        if (failRevenueFinalization) Runtime.trap("Injected EVM revenue finalization write failure");
        db.credits.insert(value);
      };
      update = func(value : Types.Credit) : { #ok : Types.Credit; #err : Types.Error } {
        if (failRevenueFinalization) Runtime.trap("Injected EVM revenue finalization write failure");
        db.credits.update(value);
      };
    };
  };
  func granted(order : Types.Order, block : ?Nat, now : Int) {
    if (failGrant) Runtime.trap("Injected EVM ownership finalization failure");
    for (item in order.items.vals()) {
      ignore Journal.must(Store.insertAcquisition(db, {
        owner = order.owner; appId = item.appId; orderId = order.id;
        kind = if (item.priceUsdMicros == 0) #free else #paid;
        atNs = now; paidAtoms = item.paidAtoms; ledger = ?order.ledger; block;
      }));
    };
  };
  transient let service = EvmPayments.Service(revenueDb, marketplace, Time.now, {
    ledger; minter;
    verify = func(expected : EvmEvidence.Expected) : async* EvmRpc.Result<EvmEvidence.Proof> {
      await* EvmEvidence.verifyWith(rpc, rpcOptions, expected);
    };
  }, granted);
  transient let ic = Purchases.Engine(db, ledger, marketplace, Time.now, granted);

  public func seedApp(appId : Text, publisher : Principal, priceUsdMicros : Nat) : async () {
    let now = Time.now();
    let bytes = Text.encodeUtf8("test package " # appId);
    let artifact = Journal.must(Store.insertArtifact(db, {
      digest = Encoding.hash(bytes); size = Nat64.fromNat(bytes.size()); mediaType = "application/octet-stream";
      content = #bytes(bytes); publicLegacy = false; createdAtNs = now;
    }));
    let app = Journal.must(Store.insertApp(db, {
      appId; owner = publisher; title = appId; summary = "Payment fixture"; description = "";
      priceUsdMicros; revision = 1; approvedCandidate = null; visible = true; iconArtifact = null;
      screenshots = []; ratingCount = 0; ratingTotal = 0; createdAtNs = now; updatedAtNs = now;
    }));
    let release = Journal.must(Store.insertCandidate(db, {
      appId; version = 100; publisher; requestId = "release:" # appId; listingRevision = 1;
      artifactId = artifact.id; sourceArtifactId = null; digest = artifact.digest; sourceDigest = null;
      dependencies = []; state = #approved; published = true; createdAtNs = now; updatedAtNs = now;
    }));
    ignore Journal.must(db.apps.update({ app with approvedCandidate = ?release.id }));
    ignore Journal.must(Store.putRate(db, {
      ledger = EvmMinter.ckusdcLedger(); symbol = "USDC"; usdRate = 100_000_000; decimals = 8;
      observedAtNs = now; refreshedAtNs = now; lastError = null;
    }));
  };
  public func setRevenueFinalizationFailure(value : Bool) : async () { failRevenueFinalization := value };
  public func setGrantFailure(value : Bool) : async () { failGrant := value };
  public shared query ({ caller }) func quote(request : API.PurchaseRequest) : async API.Result<API.CheckoutQuote> {
    service.quote(caller, request);
  };
  public shared ({ caller }) func prepare(quote : API.CheckoutQuote, payer : Text) : async API.Result<EvmPayments.InvoiceResult> {
    await* service.prepare(caller, quote, payer);
  };
  public shared ({ caller }) func verify(requestId : Text, transactionHash : Text) : async API.Result<EvmPayments.InvoiceResult> {
    await* service.verify(caller, requestId, transactionHash);
  };
  public shared ({ caller }) func settle(requestId : Text) : async API.Result<EvmPayments.InvoiceResult> {
    await* service.settle(caller, requestId);
  };
  public shared ({ caller }) func cancel(requestId : Text) : async API.Result<EvmPayments.InvoiceResult> {
    service.cancel(caller, requestId);
  };
  public shared ({ caller }) func prepareIc(request : API.PurchaseRequest) : async Purchases.Result<Types.Order> {
    switch (Quotes.purchase(db, marketplace, caller, request, Time.now())) {
      case (#err(error)) #err(error.message);
      case (#ok(quote)) Purchases.prepare(db, Quotes.order(quote, Time.now()));
    };
  };
  public shared ({ caller }) func runIc(id : Nat64) : async Purchases.Result<Types.Order> {
    assert Journal.found(db.orders.get(id)).owner == caller;
    await* ic.run(id);
  };
  public query func order(owner : Principal, requestId : Text) : async ?Types.Order { Store.getOrder(db, owner, requestId) };
  public query func status(owner : Principal, requestId : Text) : async ?EvmPayments.InvoiceResult { service.status(owner, requestId) };
  public query func invoices() : async [Types.EvmInvoice] { Iter.toArray(db.evmInvoices.iter(#fwd)) };
  public query func receipts() : async [Types.EvmReceipt] { Iter.toArray(db.evmReceipts.iter(#fwd)) };
  public query func sweeps() : async [Types.EvmSweep] { Iter.toArray(db.evmSweeps.iter(#fwd)) };
  public query func credit(owner : Principal, isBurn : Bool) : async ?Types.Credit {
    Store.getCredit(db, EvmMinter.ckusdcLedger(), owner, isBurn);
  };
  public query func entitlement(owner : Principal, appId : Text) : async ?Types.Entitlement { Store.getEntitlement(db, owner, appId) };
  public query func acquisition(owner : Principal, appId : Text) : async ?Types.Acquisition { Store.getAcquisition(db, owner, appId) };
  public query func claim(owner : Principal, appId : Text) : async ?Types.Claim { Store.getClaim(db, owner, appId) };
  public query func attempt(id : Nat64) : async ?Types.Attempt { db.attempts.get(id) };
  public query func attempts() : async [Types.Attempt] { Iter.toArray(db.attempts.iter(#fwd)) };
};
