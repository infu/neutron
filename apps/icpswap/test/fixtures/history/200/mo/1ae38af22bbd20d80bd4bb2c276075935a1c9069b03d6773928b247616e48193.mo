import Types "d1ceaf3da72a662842dad6256b90f6c4214b079f5658917a72e0fa3b97e21bdc";
import Order "4b6d97683d4354a7fe185827a135298026e670b1279af4284c74059628ec0f39";
import Result "3aeed20003aa1864549527075a8298f890157a6e37366384c9e275a38dc0d8ba";
import Option "78222225a965bef98f662c85ff9e55e747c729bdd0633968a3935628fabccb98";
import Prim "mo:⛔";
import InsertionSort "00bf6dc15ec20fec4b7f1acfee48b63ede4d913bb570d189df14f7673a125c15";
module {
  let nat = Prim.nat32ToNat;
  public func empty<T>() : [var T] = [var];
  public func repeat<T>(item : T, size : Nat) : [var T] = Prim.Array_init<T>(size, item);
  public func clone<T>(self : [var T]) : [var T] = Prim.Array_tabulateVar<T>(self.size(), func i = self[i]);
  public let tabulate : <T>(size : Nat, generator : Nat -> T) -> [var T] = Prim.Array_tabulateVar;
  public func equal<T>(self : [var T], other : [var T], equal : (implicit : (T, T) -> Bool)) : Bool {
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
  public func find<T>(self : [var T], predicate : T -> Bool) : ?T {
    for (element in self.vals()) {
      if (predicate element) {
        return ?element
      }
    };
    null
  };
  public func findIndex<T>(self : [var T], predicate : T -> Bool) : ?Nat {
    for ((index, element) in enumerate(self)) {
      if (predicate element) {
        return ?index
      }
    };
    null
  };
  public func concat<T>(self : [var T], other : [var T]) : [var T] {
    let size1 = self.size();
    let size2 = other.size();
    tabulate<T>(
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
  public func sort<T>(self : [var T], compare : (implicit : (T, T) -> Order.Order)) : [var T] {
    let newArray = clone(self);
    sortInPlace(newArray, compare);
    newArray
  };
  public func sortInPlace<T>(self : [var T], compare : (implicit : (T, T) -> Order.Order)) : () {
    let size = Prim.natToNat32(self.size());
    if (size <= 1) return;
    if (size <= 8) {
      InsertionSort.insertionSortSmall(self, self, compare, 0 : Nat32, size);
      return
    };
    let buffer = repeat(self[0], nat(size / 2));
    mergeSortRec(self, buffer, compare, 0 : Nat32, size, true, 0 : Nat32)
  };
  func mergeSortRec<T>(
    array : [var T],
    buffer : [var T],
    compare : (T, T) -> Order.Order,
    from : Nat32,
    to : Nat32,
    even : Bool,
    offset : Nat32
  ) {
    debug assert from < to;
    let size = to -% from;
    debug assert size >= 4;
    if (size <= 8) {
      if (even) {
        InsertionSort.insertionSortSmall(array, array, compare, from, size);  
      } else {
        InsertionSort.insertionSortSmallMove(array, buffer, compare, from, size, offset);  
      };
      return
    };
    let len1 = size / 2;
    let mid = from +% len1;
    if (even) {
      mergeSortRec(array, buffer, compare, mid, to, true, 0 : Nat32);  
      mergeSortRec(array, buffer, compare, from, mid, false, 0 : Nat32);  
      merge1(array, buffer, compare, from, mid, to);  
    } else {
      mergeSortRec(array, buffer, compare, from, mid, true, 0 : Nat32);  
      mergeSortRec(array, buffer, compare, mid, to, false, offset +% len1);  
      merge2(array, buffer, compare, from, mid, size, offset);  
    }
  };
  func merge1<T>(array : [var T], buffer : [var T], compare : (T, T) -> Order.Order, from : Nat32, mid : Nat32, to : Nat32) {
    debug assert from < mid;
    debug assert mid < to;
    let len = mid -% from;
    var pos = from;
    var i = 0 : Nat32;
    var j = mid;
    var iElem = buffer[nat(i)];
    var jElem = array[nat(j)];
    label L loop {
      switch (compare(jElem, iElem)) {
        case (#less) {
          array[nat(pos)] := jElem;
          j +%= 1;
          pos +%= 1;
          if (j == to) {
            while (i < len) {
              array[nat(pos)] := buffer[nat(i)];
              i +%= 1;
              pos +%= 1
            };
            break L
          };
          jElem := array[nat(j)]
        };
        case (_) {
          array[nat(pos)] := iElem;
          i +%= 1;
          pos +%= 1;
          if (i == len) break L;
          iElem := buffer[nat(i)]
        }
      }
    }
  };
  func merge2<T>(array : [var T], buffer : [var T], compare : (T, T) -> Order.Order, from : Nat32, mid : Nat32, size : Nat32, offset : Nat32) {
    debug assert from < mid;
    debug assert mid < from +% size;
    let len = mid -% from;
    var pos = offset;
    var i = from;
    var j = offset +% len;
    let j_max = offset +% size;
    var iElem = array[nat(i)];
    var jElem = buffer[nat(j)];
    label L loop {
      switch (compare(jElem, iElem)) {
        case (#less) {
          buffer[nat(pos)] := jElem;
          j +%= 1;
          pos +%= 1;
          if (j == j_max) {
            while (i < mid) {
              buffer[nat(pos)] := array[nat(i)];
              i +%= 1;
              pos +%= 1
            };
            break L
          };
          jElem := buffer[nat(j)]
        };
        case (_) {
          buffer[nat(pos)] := iElem;
          i +%= 1;
          pos +%= 1;
          if (i == mid) break L;
          iElem := array[nat(i)]
        }
      }
    }
  };
  public func reverse<T>(self : [var T]) : [var T] {
    let size = self.size();
    tabulate<T>(size, func i = self[size - i - 1])
  };
  public func reverseInPlace<T>(self : [var T]) : () {
    let size = self.size();
    if (size == 0) {
      return
    };
    var i = 0;
    var j = (size - 1) : Nat;
    while (i < j) {
      let temp = self[i];
      self[i] := self[j];
      self[j] := temp;
      i += 1;
      j -= 1
    }
  };
  public func forEach<T>(self : [var T], f : T -> ()) {
    for (item in self.vals()) {
      f(item)
    }
  };
  public func map<T, R>(self : [var T], f : T -> R) : [var R] {
    tabulate<R>(
      self.size(),
      func(index) {
        f(self[index])
      }
    )
  };
  public func mapInPlace<T>(self : [var T], f : T -> T) {
    var index = 0;
    let size = self.size();
    while (index < size) {
      self[index] := f(self[index]);
      index += 1
    }
  };
  public func filter<T>(self : [var T], f : T -> Bool) : [var T] {
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
    tabulate<T>(
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
  public func filterMap<T, R>(self : [var T], f : T -> ?R) : [var R] {
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
    tabulate<R>(
      count,
      func _ {
        while (Option.isNull(options[nextSome])) {
          nextSome += 1
        };
        nextSome += 1;
        switch (options[nextSome - 1]) {
          case (?element) element;
          case null {
            Prim.trap "VarArray.filterMap(): malformed array"
          }
        }
      }
    )
  };
  public func mapResult<T, R, E>(self : [var T], f : T -> Result.Result<R, E>) : Result.Result<[var R], E> {
    let size = self.size();
    var error : ?Result.Result<[var R], E> = null;
    let results = tabulate(
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
                  Prim.trap "VarArray.mapResults(): malformed array"
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
  public func mapEntries<T, R>(self : [var T], f : (T, Nat) -> R) : [var R] {
    tabulate<R>(self.size(), func i = f(self[i], i))
  };
  public func flatMap<T, R>(self : [var T], k : T -> Types.Iter<R>) : [var R] {
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
    tabulate<R>(
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
  public func foldLeft<T, A>(self : [var T], base : A, combine : (A, T) -> A) : A {
    var acc = base;
    for (element in self.vals()) {
      acc := combine(acc, element)
    };
    acc
  };
  public func foldRight<T, A>(self : [var T], base : A, combine : (T, A) -> A) : A {
    var acc = base;
    let size = self.size();
    var i = size;
    while (i > 0) {
      i -= 1;
      acc := combine(self[i], acc)
    };
    acc
  };
  public func join<T>(self : Types.Iter<[var T]>) : [var T] {
    flatten<T>(fromIter(self))
  };
  public func flatten<T>(self : [var [var T]]) : [var T] {
    var flatSize = 0;
    for (subArray in self.vals()) {
      flatSize += subArray.size()
    };
    var outer = 0;
    var inner = 0;
    tabulate<T>(
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
  public func singleton<T>(element : T) : [var T] = [var element];
  public func size<T>(self : [var T]) : Nat = self.size();
  public func isEmpty<T>(self : [var T]) : Bool = self.size() == 0;
  public func fromArray<T>(array : [T]) : [var T] = Prim.Array_tabulateVar<T>(array.size(), func i = array[i]);
  public func fromIter<T>(iter : Types.Iter<T>) : [var T] {
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
    if (size == 0) { return [var] };
    let array = Prim.Array_init(
      size,
      switch list {
        case (?(h, _)) h;
        case null {
          Prim.trap("VarArray.fromIter(): unreachable")
        }
      }
    );
    var i = size;
    while (i > 0) {
      i -= 1;
      switch list {
        case (?(h, t)) {
          array[i] := h;
          list := t
        };
        case null {
          Prim.trap("VarArray.fromIter(): unreachable")
        }
      }
    };
    array
  };
  public func keys<T>(self : [var T]) : Types.Iter<Nat> = self.keys();
  public func values<T>(self : [var T]) : Types.Iter<T> = self.vals();
  public func enumerate<T>(self : [var T]) : Types.Iter<(Nat, T)> = object {
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
  public func all<T>(self : [var T], predicate : T -> Bool) : Bool {
    for (element in self.values()) {
      if (not predicate(element)) {
        return false
      }
    };
    true
  };
  public func any<T>(self : [var T], predicate : T -> Bool) : Bool {
    for (element in self.values()) {
      if (predicate(element)) {
        return true
      }
    };
    false
  };
  public func indexOf<T>(self : [var T], equal : (implicit : (T, T) -> Bool), element : T) : ?Nat = nextIndexOf<T>(self, equal, element, 0);
  public func nextIndexOf<T>(self : [var T], equal : (implicit : (T, T) -> Bool), element : T, fromInclusive : Nat) : ?Nat {
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
  public func lastIndexOf<T>(self : [var T], equal : (implicit : (T, T) -> Bool), element : T) : ?Nat = prevIndexOf<T>(self, equal, element, self.size());
  public func prevIndexOf<T>(self : [var T], equal : (implicit : (T, T) -> Bool), element : T, fromExclusive : Nat) : ?Nat {
    var i = fromExclusive;
    while (i > 0) {
      i -= 1;
      if (equal(self[i], element)) {
        return ?i
      }
    };
    null
  };
  public func contains<T>(self : [var T], equal : (implicit : (T, T) -> Bool), element : T) : Bool {
    for (item in self.vals()) {
      if (equal(item, element)) {
        return true
      }
    };
    false
  };
  public func range<T>(self : [var T], fromInclusive : Int, toExclusive : Int) : Types.Iter<T> {
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
  public func sliceToArray<T>(self : [var T], fromInclusive : Int, toExclusive : Int) : [T] {
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
  public func sliceToVarArray<T>(self : [var T], fromInclusive : Int, toExclusive : Int) : [var T] {
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
  public func toArray<T>(self : [var T]) : [T] = Prim.Array_tabulate<T>(self.size(), func i = self[i]);
  public let toBlob : (self : [var Nat8]) -> Blob = Prim.arrayMutToBlob;
  public func toText<T>(self : [var T], f : (implicit : (toText : T -> Text))) : Text {
    let size = self.size();
    if (size == 0) { return "[var]" };
    var text = "[var ";
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
  public func compare<T>(self : [var T], other : [var T], compare : (implicit : (T, T) -> Order.Order)) : Order.Order {
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
  public func binarySearch<T>(self : [var T], compare : (implicit : (T, T) -> Order.Order), element : T) : {
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
  public func isSorted<T>(self : [var T], compare : (implicit : (T, T) -> Order.Order)) : Bool {
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
