import Order "4b6d97683d4354a7fe185827a135298026e670b1279af4284c74059628ec0f39";
import Iter "394eda524ad6869af6e1f8bf5be2f6885951b4191c71c790ca325539ef65464e";
import Types "d1ceaf3da72a662842dad6256b90f6c4214b079f5658917a72e0fa3b97e21bdc";
import PureList "ec64e40330b2bd235aaff46d7c1c5878ddd9e7011d37b71c32b2f52bc6af8cc4";
module {
  type List<T> = Types.Pure.List<T>;
  public type Stack<T> = Types.Stack<T>;
  public func toPure<T>(self : Stack<T>) : PureList.List<T> {
    self.top
  };
  public func toArray<T>(self : Stack<T>) : [T] {
    Iter.toArray(values(self))
  };
  public func toVarArray<T>(self : Stack<T>) : [var T] {
    Iter.toVarArray(values(self))
  };
  public func fromPure<T>(list : PureList.List<T>) : Stack<T> {
    var size = 0;
    var cur = list;
    loop {
      switch cur {
        case (?(_, next)) {
          size += 1;
          cur := next
        };
        case null {
          return { var top = list; var size }
        }
      }
    }
  };
  public func fromVarArray<T>(array : [var T]) : Stack<T> {
    fromIter(array.values())
  };
  public func fromArray<T>(array : [T]) : Stack<T> {
    fromIter(array.values())
  };
  public func empty<T>() : Stack<T> {
    {
      var top = null;
      var size = 0
    }
  };
  public func tabulate<T>(size : Nat, generator : Nat -> T) : Stack<T> {
    let stack = empty<T>();
    var index = 0;
    while (index < size) {
      let element = generator(index);
      push(stack, element);
      index += 1
    };
    stack
  };
  public func singleton<T>(element : T) : Stack<T> {
    let stack = empty<T>();
    push(stack, element);
    stack
  };
  public func clear<T>(self : Stack<T>) {
    self.top := null;
    self.size := 0
  };
  public func clone<T>(self : Stack<T>) : Stack<T> {
    let copy = empty<T>();
    for (element in values(self)) {
      push(copy, element)
    };
    reverse(copy);
    copy
  };
  public func isEmpty<T>(self : Stack<T>) : Bool {
    self.size == 0
  };
  public func size<T>(self : Stack<T>) : Nat {
    self.size
  };
  public func contains<T>(self : Stack<T>, equal : (implicit : (T, T) -> Bool), element : T) : Bool {
    for (existing in values(self)) {
      if (equal(existing, element)) {
        return true
      }
    };
    false
  };
  public func reverseValues<T>(self : Stack<T>) : Iter.Iter<T> {
    Iter.reverse(values(self))
  };
  public func push<T>(self : Stack<T>, value : T) {
    self.top := ?(value, self.top);
    self.size += 1
  };
  public func peek<T>(self : Stack<T>) : ?T {
    switch (self.top) {
      case null null;
      case (?(value, _)) ?value
    }
  };
  public func pop<T>(self : Stack<T>) : ?T {
    switch (self.top) {
      case null null;
      case (?(value, next)) {
        self.top := next;
        self.size -= 1;
        ?value
      }
    }
  };
  public func get<T>(self : Stack<T>, position : Nat) : ?T {
    var index = 0;
    var current = self.top;
    while (index < position) {
      switch (current) {
        case null return null;
        case (?(_, next)) {
          current := next
        }
      };
      index += 1
    };
    switch (current) {
      case null null;
      case (?(value, _)) ?value
    }
  };
  public func reverse<T>(self : Stack<T>) {
    var last : List<T> = null;
    for (element in values(self)) {
      last := ?(element, last)
    };
    self.top := last
  };
  public func values<T>(self : Stack<T>) : Types.Iter<T> {
    object {
      var current = self.top;
      public func next() : ?T {
        switch (current) {
          case null null;
          case (?(value, next)) {
            current := next;
            ?value
          }
        }
      }
    }
  };
  public func all<T>(self : Stack<T>, predicate : T -> Bool) : Bool {
    for (element in values(self)) {
      if (not predicate(element)) {
        return false
      }
    };
    true
  };
  public func any<T>(self : Stack<T>, predicate : T -> Bool) : Bool {
    for (element in values(self)) {
      if (predicate(element)) {
        return true
      }
    };
    false
  };
  public func forEach<T>(self : Stack<T>, operation : T -> ()) {
    for (element in values(self)) {
      operation(element)
    }
  };
  public func map<T, U>(self : Stack<T>, project : T -> U) : Stack<U> {
    let result = empty<U>();
    for (element in values(self)) {
      push(result, project(element))
    };
    reverse(result);
    result
  };
  public func filter<T>(self : Stack<T>, predicate : T -> Bool) : Stack<T> {
    let result = empty<T>();
    for (element in values(self)) {
      if (predicate(element)) {
        push(result, element)
      }
    };
    reverse(result);
    result
  };
  public func filterMap<T, U>(self : Stack<T>, project : T -> ?U) : Stack<U> {
    let result = empty<U>();
    for (element in values(self)) {
      switch (project(element)) {
        case null {};
        case (?newElement) {
          push(result, newElement)
        }
      }
    };
    reverse(result);
    result
  };
  public func find<T>(self : Stack<T>, predicate : T -> Bool) : ?T = PureList.find(self.top, predicate);
  public func findIndex<T>(self : Stack<T>, predicate : T -> Bool) : ?Nat = PureList.findIndex(self.top, predicate);
  public func equal<T>(self : Stack<T>, other : Stack<T>, equal : (implicit : (T, T) -> Bool)) : Bool {
    if (size(self) != size(other)) {
      return false
    };
    let iterator1 = values(self);
    let iterator2 = values(other);
    loop {
      let element1 = iterator1.next();
      let element2 = iterator2.next();
      switch (element1, element2) {
        case (null, null) {
          return true
        };
        case (?element1, ?element2) {
          if (not equal(element1, element2)) {
            return false
          }
        };
        case _ { return false }
      }
    }
  };
  public func fromIter<T>(iter : Types.Iter<T>) : Stack<T> {
    let stack = empty<T>();
    for (element in iter) {
      push(stack, element)
    };
    stack
  };
  public func toStack<T>(self : Types.Iter<T>) : Stack<T> {
    fromIter(self)
  };
  public func toText<T>(self : Stack<T>, format : (implicit : (toText : T -> Text))) : Text {
    var text = "Stack[";
    var sep = "";
    for (element in values(self)) {
      text #= sep # format(element);
      sep := ", "
    };
    text #= "]";
    text
  };
  public func compare<T>(self : Stack<T>, other : Stack<T>, compare : (implicit : (T, T) -> Order.Order)) : Order.Order {
    let iterator1 = values(self);
    let iterator2 = values(other);
    loop {
      switch (iterator1.next(), iterator2.next()) {
        case (null, null) return #equal;
        case (null, _) return #less;
        case (_, null) return #greater;
        case (?element1, ?element2) {
          let comparison = compare(element1, element2);
          if (comparison != #equal) {
            return comparison
          }
        }
      }
    }
  }
}
