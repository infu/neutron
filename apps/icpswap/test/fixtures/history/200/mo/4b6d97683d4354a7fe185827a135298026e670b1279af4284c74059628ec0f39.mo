import Types "d1ceaf3da72a662842dad6256b90f6c4214b079f5658917a72e0fa3b97e21bdc";
module {
  public type Order = Types.Order;
  public func isLess(self : Order) : Bool {
    switch self {
      case (#less) { true };
      case _ { false }
    }
  };
  public func isEqual(self : Order) : Bool {
    switch self {
      case (#equal) { true };
      case _ { false }
    }
  };
  public func isGreater(self : Order) : Bool {
    switch self {
      case (#greater) { true };
      case _ { false }
    }
  };
  public func equal(self : Order, other : Order) : Bool {
    switch (self, other) {
      case (#less, #less) { true };
      case (#equal, #equal) { true };
      case (#greater, #greater) { true };
      case _ { false }
    }
  };
  public func allValues() : Types.Iter<Order> {
    var nextState : ?Order = ?#less;
    {
      next = func() : ?Order {
        let state = nextState;
        switch state {
          case (?#less) { nextState := ?#equal };
          case (?#equal) { nextState := ?#greater };
          case (?#greater) { nextState := null };
          case (null) {}
        };
        state
      }
    }
  }
}
