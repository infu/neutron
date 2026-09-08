import Order "4b6d97683d4354a7fe185827a135298026e670b1279af4284c74059628ec0f39";
import VarArray "1ae38af22bbd20d80bd4bb2c276075935a1c9069b03d6773928b247616e48193";
import Option "78222225a965bef98f662c85ff9e55e747c729bdd0633968a3935628fabccb98";
import Types "d1ceaf3da72a662842dad6256b90f6c4214b079f5658917a72e0fa3b97e21bdc";
import Prim "mo:⛔";
module {
  public func empty<T>() : [T] = [];
  public func repeat<T>(item : T, size : Nat) : [T] = Prim.Array_tabulate<T>(size, func _ = item);
  public let tabulate : <T>(size : Nat, generator : Nat -> T) -> [T] = Prim.Array_tabulate;
  public func fromVarArray<T>(varArray : [var T]) : [T] = Prim.Array_tabulate<T>(varArray.size(), func i = varArray[i]);
  public func toVarArray<T>(self : [T]) : [var T] {
    let size = self.size();
    if (size == 0) {
      return [var]
    };
    let newArray = Prim.Array_init(size, self[0]);
    var i = 0;
    while (i < size) {
      newArray[i] := self[i];
      i += 1
    };
    newArray
  };
  public let toBlob : (self : [Nat8]) -> Blob = Prim.arrayToBlob;
  public func equal<T>(self : [T], other : [T], equal : (implicit : (T, T) -> Bool)) : Bool {
    let size1 = self.size();
    let size2 = other.size();
    if (size1 != size2) {
      return false
    };
    var i = 0;
    while (i < size1) {
      if (not equal(self[i], other[i])) {
        return false
      };
      i += 1
    };
    true
  };
  public func find<T>(self : [T], predicate : T -> Bool) : ?T {
    for (element in self.vals()) {
      if (predicate(element)) {
        return ?element
      }
    };
    null
  };
  public func findIndex<T>(self : [T], predicate : T -> Bool) : ?Nat {
    for ((index, element) in enumerate(self)) {
      if (predicate(element)) {
        return ?index
      }
    };
    null
  };
  public func concat<T>(self : [T], other : [T]) : [T] {
    let size1 = self.size();
    let size2 = other.size();
    Prim.Array_tabulate<T>(
      size1 + size2,
      func i {
        if (i < size1) {
          self[i]
        } else {
          other[i - size1]
        }
      }
    )
  };
  public func sort<T>(self : [T], compare : (implicit : (T, T) -> Order.Order)) : [T] {
    let varArray : [var T] = toVarArray(self);
    VarArray.sortInPlace(varArray, compare);
    fromVarArray(varArray)
  };
  public func reverse<T>(self : [T]) : [T] {
    let size = self.size();
    Prim.Array_tabulate<T>(size, func i = self[size - i - 1])
  };
  public func forEach<T>(self : [T], f : T -> ()) {
    for (item in self.vals()) {
      f(item)
    }
  };
  public func map<T, R>(self : [T], f : T -> R) : [R] = Prim.Array_tabulate<R>(self.size(), func i = f(self[i]));
  public func filter<T>(self : [T], f : T -> Bool) : [T] {
    var count = 0;
    let keep = Prim.Array_tabulate(
      self.size(),
      func i {
        if (f(self[i])) {
          count += 1;
          true
        } else {
          false
        }
      }
    );
    var nextKeep = 0;
    Prim.Array_tabulate<T>(
      count,
      func _ {
        while (not keep[nextKeep]) {
          nextKeep += 1
        };
        nextKeep += 1;
        self[nextKeep - 1]
      }
    )
  };
  public func filterMap<T, R>(self : [T], f : T -> ?R) : [R] {
    var count = 0;
    let options = Prim.Array_tabulate(
      self.size(),
      func i {
        let result = f(self[i]);
        switch (result) {
          case (?element) {
            count += 1;
            result
          };
          case null {
            null
          }
        }
      }
    );
    var nextSome = 0;
    Prim.Array_tabulate<R>(
      count,
      func _ {
        while (Option.isNull(options[nextSome])) {
          nextSome += 1
        };
        nextSome += 1;
        switch (options[nextSome - 1]) {
          case (?element) element;
          case null {
            Prim.trap "Array.filterMap(): malformed array"
          }
        }
      }
    )
  };
  public func mapResult<T, R, E>(self : [T], f : T -> Types.Result<R, E>) : Types.Result<[R], E> {
    let size = self.size();
    var error : ?Types.Result<[R], E> = null;
    let results = Prim.Array_tabulate(
      size,
      func i {
        switch (f(self[i])) {
          case (#ok element) {
            ?element
          };
          case (#err e) {
            switch (error) {
              case null {
                error := ?(#err e)
              };
              case _ {}
            };
            null
          }
        }
      }
    );
    switch error {
      case null {
        #ok(
          map<?R, R>(
            results,
            func element {
              switch element {
                case (?element) {
                  element
                };
                case null {
                  Prim.trap "Array.mapResult(): malformed array"
                }
              }
            }
          )
        )
      };
      case (?error) {
        error
      }
    }
  };
  public func mapEntries<T, R>(self : [T], f : (T, Nat) -> R) : [R] = Prim.Array_tabulate<R>(self.size(), func i = f(self[i], i));
  public func flatMap<T, R>(self : [T], k : T -> Types.Iter<R>) : [R] {
    var flatSize = 0;
    let arrays = Prim.Array_tabulate(
      self.size(),
      func i {
        let subArray = fromIter(k(self[i]));
        flatSize += subArray.size();
        subArray
      }
    );
    var outer = 0;
    var inner = 0;
    Prim.Array_tabulate<R>(
      flatSize,
      func _ {
        while (inner == arrays[outer].size()) {
          inner := 0;
          outer += 1
        };
        let element = arrays[outer][inner];
        inner += 1;
        element
      }
    )
  };
  public func foldLeft<T, A>(self : [T], base : A, combine : (A, T) -> A) : A {
    var acc = base;
    for (element in self.values()) {
      acc := combine(acc, element)
    };
    acc
  };
  public func foldRight<T, A>(self : [T], base : A, combine : (T, A) -> A) : A {
    var acc = base;
    let size = self.size();
    var i = size;
    while (i > 0) {
      i -= 1;
      acc := combine(self[i], acc)
    };
    acc
  };
  public func join<T>(self : Types.Iter<[T]>) : [T] {
    flatten(fromIter(self))
  };
  public func flatten<T>(self : [[T]]) : [T] {
    var flatSize = 0;
    for (subArray in self.vals()) {
      flatSize += subArray.size()
    };
    var outer = 0;
    var inner = 0;
    Prim.Array_tabulate<T>(
      flatSize,
      func _ {
        while (inner == self[outer].size()) {
          inner := 0;
          outer += 1
        };
        let element = self[outer][inner];
        inner += 1;
        element
      }
    )
  };
  public func singleton<T>(element : T) : [T] = [element];
  public func size<T>(self : [T]) : Nat = self.size();
  public func isEmpty<T>(self : [T]) : Bool = self.size() == 0;
  public func fromIter<T>(iter : Types.Iter<T>) : [T] {
    var list : Types.Pure.List<T> = null;
    var size = 0;
    label l loop {
      switch (iter.next()) {
        case (?element) {
          list := ?(element, list);
          size += 1
        };
        case null { break l }
      }
    };
    if (size == 0) { return [] };
    let array = Prim.Array_init(
      size,
      switch list {
        case (?(h, _)) h;
        case null {
          Prim.trap("Array.fromIter(): unreachable")
        }
      }
    );
    var i = size : Nat;
    while (i > 0) {
      i -= 1;
      switch list {
        case (?(h, t)) {
          array[i] := h;
          list := t
        };
        case null {
          Prim.trap("Array.fromIter(): unreachable")
        }
      }
    };
    Prim.Array_tabulate<T>(size, func i = array[i])
  };
  public func keys<T>(self : [T]) : Types.Iter<Nat> = self.keys();
  public func values<T>(self : [T]) : Types.Iter<T> = self.values();
  public func enumerate<T>(self : [T]) : Types.Iter<(Nat, T)> = object {
    let size = self.size();
    var index = 0;
    public func next() : ?(Nat, T) {
      if (index >= size) {
        return null
      };
      let i = index;
      index += 1;
      ?(i, self[i])
    }
  };
  public func all<T>(self : [T], predicate : T -> Bool) : Bool {
    for (element in self.values()) {
      if (not predicate(element)) {
        return false
      }
    };
    true
  };
  public func any<T>(self : [T], predicate : T -> Bool) : Bool {
    for (element in self.values()) {
      if (predicate(element)) {
        return true
      }
    };
    false
  };
  public func indexOf<T>(self : [T], equal : (implicit : (T, T) -> Bool), element : T) : ?Nat = nextIndexOf<T>(self, equal, element, 0);
  public func nextIndexOf<T>(self : [T], equal : (implicit : (T, T) -> Bool), element : T, fromInclusive : Nat) : ?Nat {
    var index = fromInclusive;
    let size = self.size();
    while (index < size) {
      if (equal(self[index], element)) {
        return ?index
      } else {
        index += 1
      }
    };
    null
  };
  public func lastIndexOf<T>(self : [T], equal : (implicit : (T, T) -> Bool), element : T) : ?Nat = prevIndexOf<T>(self, equal, element, self.size());
  public func prevIndexOf<T>(self : [T], equal : (implicit : (T, T) -> Bool), element : T, fromExclusive : Nat) : ?Nat {
    var i = fromExclusive;
    while (i > 0) {
      i -= 1;
      if (equal(self[i], element)) {
        return ?i
      }
    };
    null
  };
  public func contains<T>(self : [T], equal : (implicit : (T, T) -> Bool), element : T) : Bool {
    for (item in self.vals()) {
      if (equal(item, element)) {
        return true
      }
    };
    false
  };
  public func range<T>(self : [T], fromInclusive : Int, toExclusive : Int) : Types.Iter<T> {
    let size = self.size();
    let startInt = if (fromInclusive < 0) {
      let s = size + fromInclusive;
      if (s < 0) { 0 } else { s }
    } else {
      if (fromInclusive > size) { size } else { fromInclusive }
    };
    let endInt = if (toExclusive < 0) {
      let e = size + toExclusive;
      if (e < 0) { 0 } else { e }
    } else {
      if (toExclusive > size) { size } else { toExclusive }
    };
    let start = Prim.abs(startInt);
    let end = Prim.abs(endInt);
    object {
      var pos = start;
      public func next() : ?T {
        if (pos >= end) {
          null
        } else {
          let elem = self[pos];
          pos += 1;
          ?elem
        }
      }
    }
  };
  public func sliceToArray<T>(self : [T], fromInclusive : Int, toExclusive : Int) : [T] {
    let size = self.size();
    let startInt = if (fromInclusive < 0) {
      let s = size + fromInclusive;
      if (s < 0) { 0 } else { s }
    } else {
      if (fromInclusive > size) { size } else { fromInclusive }
    };
    let endInt = if (toExclusive < 0) {
      let e = size + toExclusive;
      if (e < 0) { 0 } else { e }
    } else {
      if (toExclusive > size) { size } else { toExclusive }
    };
    let start = Prim.abs(startInt);
    let end = Prim.abs(endInt);
    if (start >= end) {
      return []
    };
    Prim.Array_tabulate<T>(end - start, func i = self[start + i])
  };
  public func sliceToVarArray<T>(self : [T], fromInclusive : Int, toExclusive : Int) : [var T] {
    let size = self.size();
    let startInt = if (fromInclusive < 0) {
      let s = size + fromInclusive;
      if (s < 0) { 0 } else { s }
    } else {
      if (fromInclusive > size) { size } else { fromInclusive }
    };
    let endInt = if (toExclusive < 0) {
      let e = size + toExclusive;
      if (e < 0) { 0 } else { e }
    } else {
      if (toExclusive > size) { size } else { toExclusive }
    };
    let start = Prim.abs(startInt);
    let end = Prim.abs(endInt);
    if (start >= end) {
      return [var]
    };
    Prim.Array_tabulateVar<T>(end - start, func i = self[start + i])
  };
  public func toText<T>(self : [T], f : (implicit : (toText : T -> Text))) : Text {
    let size = self.size();
    if (size == 0) { return "[]" };
    var text = "[";
    var i = 0;
    while (i < size) {
      if (i != 0) {
        text #= ", "
      };
      text #= f(self[i]);
      i += 1
    };
    text #= "]";
    text
  };
  public func compare<T>(self : [T], other : [T], compare : (implicit : (T, T) -> Order.Order)) : Order.Order {
    let size1 = self.size();
    let size2 = other.size();
    var i = 0;
    let minSize = if (size1 < size2) { size1 } else { size2 };
    while (i < minSize) {
      switch (compare(self[i], other[i])) {
        case (#less) { return #less };
        case (#greater) { return #greater };
        case (#equal) { i += 1 }
      }
    };
    if (size1 < size2) { #less } else if (size1 > size2) { #greater } else {
      #equal
    }
  };
  public func binarySearch<T>(self : [T], compare : (implicit : (T, T) -> Order.Order), element : T) : {
    #found : Nat;
    #insertionIndex : Nat
  } {
    var left = 0;
    var right = self.size();
    while (left < right) {
      let mid = (left + right) / 2;
      switch (compare(self[mid], element)) {
        case (#less) left := mid + 1;
        case (#greater) right := mid;
        case (#equal) return #found mid
      }
    };
    #insertionIndex left
  };
  public func isSorted<T>(self : [T], compare : (implicit : (T, T) -> Order.Order)) : Bool {
    let size = self.size();
    if (size <= 1) return true;
    var i = 1;
    while (i < size) {
      switch (compare(self[i - 1], self[i])) {
        case (#greater) return false;
        case _ { i += 1 }
      }
    };
    true
  }
}
