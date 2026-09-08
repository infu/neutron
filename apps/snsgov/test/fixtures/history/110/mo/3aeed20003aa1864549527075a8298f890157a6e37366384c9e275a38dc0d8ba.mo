import Order "4b6d97683d4354a7fe185827a135298026e670b1279af4284c74059628ec0f39";
import Types "d1ceaf3da72a662842dad6256b90f6c4214b079f5658917a72e0fa3b97e21bdc";
module {
  public type Result<Ok, Err> = Types.Result<Ok, Err>;
  public func equal<Ok, Err>(
    self : Result<Ok, Err>,
    other : Result<Ok, Err>,
    equalOk : (implicit : (equal : Ok, Ok) -> Bool),
    equalErr : (implicit : (equal : (Err, Err) -> Bool))
  ) : Bool {
    switch (self, other) {
      case (#ok(ok1), #ok(ok2)) {
        equalOk(ok1, ok2)
      };
      case (#err(err1), #err(err2)) {
        equalErr(err1, err2)
      };
      case _ { false }
    }
  };
  public func compare<Ok, Err>(
    self : Result<Ok, Err>,
    other : Result<Ok, Err>,
    compareOk : (implicit : (compare : (Ok, Ok) -> Order.Order)),
    compareErr : (implicit : (compare : (Err, Err) -> Order.Order))
  ) : Order.Order {
    switch (self, other) {
      case (#ok(ok1), #ok(ok2)) {
        compareOk(ok1, ok2)
      };
      case (#err(err1), #err(err2)) {
        compareErr(err1, err2)
      };
      case (#ok(_), _) { #greater };
      case (#err(_), _) { #less }
    }
  };
  public func chain<Ok1, Ok2, Err>(
    self : Result<Ok1, Err>,
    f : Ok1 -> Result<Ok2, Err>
  ) : Result<Ok2, Err> {
    switch self {
      case (#err(e)) { #err(e) };
      case (#ok(r)) { f(r) }
    }
  };
  public func flatten<Ok, Err>(
    self : Result<Result<Ok, Err>, Err>
  ) : Result<Ok, Err> {
    switch self {
      case (#ok(ok)) { ok };
      case (#err(err)) { #err(err) }
    }
  };
  public func mapOk<Ok1, Ok2, Err>(
    self : Result<Ok1, Err>,
    f : Ok1 -> Ok2
  ) : Result<Ok2, Err> {
    switch self {
      case (#err(e)) { #err(e) };
      case (#ok(r)) { #ok(f(r)) }
    }
  };
  public func mapErr<Ok, Err1, Err2>(
    self : Result<Ok, Err1>,
    f : Err1 -> Err2
  ) : Result<Ok, Err2> {
    switch self {
      case (#err(e)) { #err(f(e)) };
      case (#ok(r)) { #ok(r) }
    }
  };
  public func fromOption<Ok, Err>(x : ?Ok, err : Err) : Result<Ok, Err> {
    switch x {
      case (?x) { #ok(x) };
      case null { #err(err) }
    }
  };
  public func toOption<Ok, Err>(self : Result<Ok, Err>) : ?Ok {
    switch self {
      case (#ok(x)) { ?x };
      case (#err(_)) { null }
    }
  };
  public func forOk<Ok, Err>(self : Result<Ok, Err>, f : Ok -> ()) {
    switch self {
      case (#ok(ok)) { f(ok) };
      case _ {}
    }
  };
  public func forErr<Ok, Err>(self : Result<Ok, Err>, f : Err -> ()) {
    switch self {
      case (#err(err)) { f(err) };
      case _ {}
    }
  };
  public func isOk(self : Result<Any, Any>) : Bool {
    switch self {
      case (#ok(_)) { true };
      case (#err(_)) { false }
    }
  };
  public func isErr(self : Result<Any, Any>) : Bool {
    switch self {
      case (#ok(_)) { false };
      case (#err(_)) { true }
    }
  };
  public func assertOk(self : Result<Any, Any>) {
    switch self {
      case (#err(_)) { assert false };
      case (#ok(_)) {}
    }
  };
  public func assertErr(self : Result<Any, Any>) {
    switch self {
      case (#err(_)) {};
      case (#ok(_)) assert false
    }
  };
  public func fromUpper<Ok, Err>(
    result : { #Ok : Ok; #Err : Err }
  ) : Result<Ok, Err> {
    switch result {
      case (#Ok(ok)) { #ok(ok) };
      case (#Err(err)) { #err(err) }
    }
  };
  public func toUpper<Ok, Err>(
    self : Result<Ok, Err>
  ) : { #Ok : Ok; #Err : Err } {
    switch self {
      case (#ok(ok)) { #Ok(ok) };
      case (#err(err)) { #Err(err) }
    }
  };
}
