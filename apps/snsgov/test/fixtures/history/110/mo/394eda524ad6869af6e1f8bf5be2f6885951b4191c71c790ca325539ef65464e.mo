import Prim "mo:prim";
import Array "fe45cc69bcad5c3283a472988075a08cb2bd3c578ee5bf802670fe0b38bfa994";
import Order "4b6d97683d4354a7fe185827a135298026e670b1279af4284c74059628ec0f39";
import Runtime "ccb23e2d72bb4ab9edc842d7dc106d708734b3a441117e4a7816067209391eac";
import Types "d1ceaf3da72a662842dad6256b90f6c4214b079f5658917a72e0fa3b97e21bdc";
import VarArray "1ae38af22bbd20d80bd4bb2c276075935a1c9069b03d6773928b247616e48193";
module {
  public type Iter<T> = Types.Iter<T>;
  public func empty<T>() : Iter<T> {
    object {
      public func next() : ?T {
        null
      }
    }
  };
  public func singleton<T>(value : T) : Iter<T> {
    object {
      var state = ?value;
      public func next() : ?T {
        switch state {
          case null null;
          case some {
            state := null;
            some
          }
        }
      }
    }
  };
  public func forEach<T>(
    self : Iter<T>,
    f : (T) -> ()
  ) {
    label l loop {
      switch (self.next()) {
        case (?next) {
          f(next)
        };
        case (null) {
          break l
        }
      }
    }
  };
  public func enumerate<T>(self : Iter<T>) : Iter<(Nat, T)> {
    object {
      var i = 0;
      public func next() : ?(Nat, T) {
        switch (self.next()) {
          case (?x) {
            let current = (i, x);
            i += 1;
            ?current
          };
          case null { null }
        }
      }
    }
  };
  public func step<T>(self : Iter<T>, n : Nat) : Iter<T> {
    if (n == 0) {
      empty()
    } else if (n == 1) {
      self
    } else {
      object {
        public func next() : ?T {
          let item = self.next();
          var i = 1;
          while (i < n) {
            ignore self.next();
            i += 1
          };
          item
        }
      }
    }
  };
  public func size<T>(self : Iter<T>) : Nat {
    var len = 0;
    forEach<T>(self, func(x) { len += 1 });
    len
  };
  public func map<T, R>(self : Iter<T>, f : T -> R) : Iter<R> = object {
    public func next() : ?R {
      switch (self.next()) {
        case (?next) {
          ?f(next)
        };
        case (null) {
          null
        }
      }
    }
  };
  public func filter<T>(self : Iter<T>, f : T -> Bool) : Iter<T> = object {
    public func next() : ?T {
      loop {
        let ?x = self.next() else return null;
        if (f x) return ?x
      };
      null
    }
  };
  public func filterMap<T, R>(self : Iter<T>, f : T -> ?R) : Iter<R> = object {
    public func next() : ?R {
      loop {
        let ?x = self.next() else return null;
        switch (f x) {
          case (?r) return ?r;
          case null {}  
        }
      }
    }
  };
  public func flatten<T>(self : Iter<Iter<T>>) : Iter<T> = object {
    var current : Iter<T> = empty();
    public func next() : ?T {
      loop {
        switch (current.next()) {
          case (?x) return ?x;
          case null {
            let ?next = self.next() else return null;
            current := next
          }
        }
      }
    }
  };
  public func flatMap<T, R>(self : Iter<T>, f : T -> Iter<R>) : Iter<R> = object {
    var current : Iter<R> = empty();
    public func next() : ?R {
      loop {
        switch (current.next()) {
          case (?x) return ?x;
          case null {
            let ?next = self.next() else return null;
            current := f(next)
          }
        }
      }
    }
  };
  public func take<T>(self : Iter<T>, n : Nat) : Iter<T> = object {
    var remaining = n;
    public func next() : ?T {
      if (remaining == 0) return null;
      remaining -= 1;
      self.next()
    }
  };
  public func takeWhile<T>(self : Iter<T>, f : T -> Bool) : Iter<T> = object {
    var done = false;
    public func next() : ?T {
      if done return null;
      let ?x = self.next() else return null;
      if (f x) return ?x;
      done := true;
      null
    }
  };
  public func drop<T>(self : Iter<T>, n : Nat) : Iter<T> = object {
    var remaining = n;
    public func next() : ?T {
      while (remaining > 0) {
        let ?_ = self.next() else return null;
        remaining -= 1
      };
      self.next()
    }
  };
  public func dropWhile<T>(self : Iter<T>, f : T -> Bool) : Iter<T> = object {
    var dropping = true;
    public func next() : ?T {
      while dropping {
        let ?x = self.next() else return null;
        if (not f x) {
          dropping := false;
          return ?x
        }
      };
      self.next()
    }
  };
  public func zip<A, B>(self : Iter<A>, other : Iter<B>) : Iter<(A, B)> = object {
    public func next() : ?(A, B) {
      let ?x = self.next() else return null;
      let ?y = other.next() else return null;
      ?(x, y)
    }
  };
  public func zip3<A, B, C>(self : Iter<A>, other1 : Iter<B>, other2 : Iter<C>) : Iter<(A, B, C)> = object {
    public func next() : ?(A, B, C) {
      let ?x = self.next() else return null;
      let ?y = other1.next() else return null;
      let ?z = other2.next() else return null;
      ?(x, y, z)
    }
  };
  public func zipWith<A, B, R>(self : Iter<A>, other : Iter<B>, f : (A, B) -> R) : Iter<R> = object {
    public func next() : ?R {
      let ?x = self.next() else return null;
      let ?y = other.next() else return null;
      ?f(x, y)
    }
  };
  public func zipWith3<A, B, C, R>(self : Iter<A>, other1 : Iter<B>, other2 : Iter<C>, f : (A, B, C) -> R) : Iter<R> = object {
    public func next() : ?R {
      let ?x = self.next() else return null;
      let ?y = other1.next() else return null;
      let ?z = other2.next() else return null;
      ?f(x, y, z)
    }
  };
  public func all<T>(self : Iter<T>, f : T -> Bool) : Bool {
    for (x in self) {
      if (not f x) return false
    };
    true
  };
  public func any<T>(self : Iter<T>, f : T -> Bool) : Bool {
    for (x in self) {
      if (f x) return true
    };
    false
  };
  public func find<T>(self : Iter<T>, f : T -> Bool) : ?T {
    for (x in self) {
      if (f x) return ?x
    };
    null
  };
  public func findIndex<T>(self : Iter<T>, predicate : T -> Bool) : ?Nat {
    for ((index, element) in enumerate(self)) {
      if (predicate element) {
        return ?index
      }
    };
    null
  };
  public func contains<T>(self : Iter<T>, equal : (implicit : (T, T) -> Bool), value : T) : Bool {
    for (x in self) {
      if (equal(x, value)) return true
    };
    false
  };
  public func foldLeft<T, R>(self : Iter<T>, initial : R, combine : (R, T) -> R) : R {
    var acc = initial;
    for (x in self) {
      acc := combine(acc, x)
    };
    acc
  };
  public func foldRight<T, R>(self : Iter<T>, initial : R, combine : (T, R) -> R) : R {
    foldLeft<T, R>(reverse(self), initial, func(acc, x) = combine(x, acc))
  };
  public func reduce<T>(self : Iter<T>, combine : (T, T) -> T) : ?T {
    let ?first = self.next() else return null;
    ?foldLeft(self, first, combine)
  };
  public func scanLeft<T, R>(self : Iter<T>, initial : R, combine : (R, T) -> R) : Iter<R> = object {
    var acc = initial;
    var isInitial = true;
    public func next() : ?R {
      if (isInitial) {
        isInitial := false;
        return ?acc
      };
      switch (self.next()) {
        case (?x) {
          acc := combine(acc, x);
          ?acc
        };
        case null null
      }
    }
  };
  public func scanRight<T, R>(self : Iter<T>, initial : R, combine : (T, R) -> R) : Iter<R> {
    scanLeft<T, R>(reverse(self), initial, func(x, acc) = combine(acc, x))
  };
  public func unfold<T, S>(initial : S, step : S -> ?(T, S)) : Iter<T> = object {
    var state = initial;
    public func next() : ?T {
      let ?(t, next) = step(state) else return null;
      state := next;
      ?t
    }
  };
  public func max<T>(self : Iter<T>, compare : (implicit : (T, T) -> Order.Order)) : ?T {
    reduce<T>(
      self,
      func(a, b) {
        switch (compare(a, b)) {
          case (#less) b;
          case _ a
        }
      }
    )
  };
  public func min<T>(self : Iter<T>, compare : (implicit : (T, T) -> Order.Order)) : ?T {
    reduce<T>(
      self,
      func(a, b) {
        switch (compare(a, b)) {
          case (#greater) b;
          case _ a
        }
      }
    )
  };
  public func infinite<T>(item : T) : Iter<T> = object {
    public func next() : ?T {
      ?item
    }
  };
  public func concat<T>(self : Iter<T>, other : Iter<T>) : Iter<T> {
    var aEnded : Bool = false;
    object {
      public func next() : ?T {
        if (aEnded) {
          return other.next()
        };
        switch (self.next()) {
          case (?x) ?x;
          case (null) {
            aEnded := true;
            other.next()
          }
        }
      }
    }
  };
  public func fromArray<T>(array : [T]) : Iter<T> = array.vals();
  public func fromVarArray<T>(array : [var T]) : Iter<T> = array.vals();
  public func toArray<T>(self : Iter<T>) : [T] {
    type Node<T> = { value : T; var next : ?Node<T> };
    var first : ?Node<T> = null;
    var last : ?Node<T> = null;
    var count = 0;
    func add(value : T) {
      let node : Node<T> = { value; var next = null };
      switch (last) {
        case null {
          first := ?node
        };
        case (?previous) {
          previous.next := ?node
        }
      };
      last := ?node;
      count += 1
    };
    for (value in self) {
      add(value)
    };
    if (count == 0) {
      return []
    };
    var current = first;
    Prim.Array_tabulate<T>(
      count,
      func(_) {
        switch (current) {
          case null Runtime.trap("Iter.toArray(): node must not be null");
          case (?node) {
            current := node.next;
            node.value
          }
        }
      }
    )
  };
  public func toVarArray<T>(self : Iter<T>) : [var T] {
    Array.toVarArray<T>(toArray<T>(self))
  };
  public func sort<T>(self : Iter<T>, compare : (implicit : (T, T) -> Order.Order)) : Iter<T> {
    let array = toVarArray(self);
    VarArray.sortInPlace<T>(array, compare);
    fromVarArray<T>(array)
  };
  public func repeat<T>(item : T, count : Nat) : Iter<T> = object {
    var remaining = count;
    public func next() : ?T {
      if (remaining == 0) {
        null
      } else {
        remaining -= 1;
        ?item
      }
    }
  };
  public func reverse<T>(self : Iter<T>) : Iter<T> {
    var acc : Types.Pure.List<T> = null;
    for (x in self) {
      acc := ?(x, acc)
    };
    object {
      public func next() : ?T {
        switch acc {
          case null null;
          case (?(h, t)) {
            acc := t;
            ?h
          }
        }
      }
    }
  };
}
