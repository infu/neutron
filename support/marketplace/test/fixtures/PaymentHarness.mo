import Array "mo:core/Array";
import Iter "mo:core/Iter";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Time "mo:core/Time";
import Ledger "../../mo/Ledger";
import Jobs "../../mo/Jobs";
import Journal "../../mo/PaymentStore";
import Purchases "../../mo/Purchases";
import Rates "../../mo/Rates";
import Store "../../mo/Store";
import Types "../../mo/Types";
import Withdrawals "../../mo/Withdrawals";

// PocketIC-only domain harness. Production payment engines and retained storage
// run unchanged; public seed/inspection methods are test controls, not APIs.
persistent actor class PaymentHarness(config : Types.Config) = self {
  let memory = Store.init(config);
  var failFinalization = false;
  var failWithdrawalFinalization = false;
  transient let db = Store.Use(memory);
  transient let marketplace = Principal.fromActor(self);
  transient let client = Ledger.client();
  transient let purchases = Purchases.Engine(db, client, marketplace, Time.now, func(order, block, now) {
    if (failFinalization) Runtime.trap("Injected finalization failure after the ledger response");
    for (item in order.items.vals()) {
      ignore Journal.must(Store.insertAcquisition(db, {
        owner = order.owner; appId = item.appId; orderId = order.id;
        kind = if (item.priceUsdMicros == 0) #free else #paid;
        atNs = now; paidAtoms = item.paidAtoms; ledger = ?order.ledger; block;
      }));
    };
  });
  // Forward every operation to the actual Store. The only injected behavior is
  // a write trap precisely when finalization consumes a retained reservation.
  transient let withdrawalDb : Store.DB = {
    db with credits = {
      db.credits with update = func(value : Types.Credit) : { #ok : Types.Credit; #err : Types.Error } {
        let current = Journal.found(db.credits.get(value.id));
        if (failWithdrawalFinalization and value.reserved < current.reserved) {
          Runtime.trap("Injected withdrawal finalization write failure after the ledger response");
        };
        db.credits.update(value);
      };
    };
  };
  transient let withdrawals = Withdrawals.Engine(withdrawalDb, client, marketplace, Time.now);
  transient let jobs = Jobs.Engine(db, withdrawals, marketplace, Time.now, {
    rate = func(_canister : Principal, _cycles : Nat, _request : Rates.Request) : async* Rates.Result<Rates.ExchangeRate> {
      #err("No oracle is configured in the payment-domain harness");
    };
    fee = func(_ledger : Principal) : async* Rates.Result<Nat> { #ok(10) };
  });

  public func setFinalizationFailure(value : Bool) : async () { failFinalization := value };
  public func setWithdrawalFinalizationFailure(value : Bool) : async () { failWithdrawalFinalization := value };

  public shared ({ caller }) func preparePurchase(value : Types.CreateOrder) : async Purchases.Result<Types.Order> {
    assert caller == value.owner;
    Purchases.prepare(db, value);
  };
  public shared ({ caller }) func runPurchase(id : Nat64) : async Purchases.Result<Types.Order> {
    assert Journal.found(db.orders.get(id)).owner == caller;
    await* purchases.run(id);
  };
  public query func purchase(owner : Principal, requestId : Text) : async ?Types.Order {
    Store.getOrder(db, owner, requestId);
  };
  public query func spenderSubaccount(value : Types.CreateOrder) : async Blob {
    Purchases.spenderSubaccount(marketplace, value);
  };
  public shared func seedCredit(ledger : Principal, owner : Principal, amount : Nat) : async () {
    Journal.addCredit(db, ledger, owner, false, amount, Time.now());
  };
  public shared func seedBurnCredit(ledger : Principal, amount : Nat) : async () {
    Journal.addCredit(db, ledger, marketplace, true, amount, Time.now());
  };
  public shared func setBurnAccount(ledger : Principal, account : ?Types.Account) : async () {
    let current = Store.config(db);
    let tokens = Array.map<Types.TokenConfig, Types.TokenConfig>(current.tokens, func(token) {
      if (token.ledger == ledger) ({ token with burnAccount = account }) else token;
    });
    Store.setConfig(db, { current with tokens });
  };
  public shared func tickJobs() : async Jobs.Report { await* jobs.tick() };
  public query func job(key : Text) : async ?Types.Job { db.jobs.by_key.lookup(key) };
  public query func withdrawalsSnapshot() : async [Types.Withdrawal] { Iter.toArray(db.withdrawals.iter(#fwd)) };
  public shared ({ caller }) func prepareWithdrawal(value : Types.CreateWithdrawal) : async Withdrawals.Result<Types.Withdrawal> {
    assert caller == value.owner;
    Withdrawals.prepare(db, value);
  };
  public shared ({ caller }) func runWithdrawal(id : Nat64) : async Withdrawals.Result<Types.Withdrawal> {
    assert Journal.found(db.withdrawals.get(id)).owner == caller;
    await* withdrawals.run(id);
  };
  public query func withdrawal(owner : Principal, requestId : Text) : async ?Types.Withdrawal {
    Store.getWithdrawal(db, owner, requestId);
  };
  public query func attempt(id : Nat64) : async ?Types.Attempt { db.attempts.get(id) };
  public query func credit(ledger : Principal, owner : Principal, isBurn : Bool) : async ?Types.Credit {
    Store.getCredit(db, ledger, owner, isBurn);
  };
  public query func entitlement(owner : Principal, appId : Text) : async ?Types.Entitlement {
    Store.getEntitlement(db, owner, appId);
  };
  public query func acquisition(owner : Principal, appId : Text) : async ?Types.Acquisition {
    Store.getAcquisition(db, owner, appId);
  };
  public query func claim(owner : Principal, appId : Text) : async ?Types.Claim {
    Store.getClaim(db, owner, appId);
  };
};
