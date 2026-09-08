import { Array_tabulate } "mo:⛔";
import Array "fe45cc69bcad5c3283a472988075a08cb2bd3c578ee5bf802670fe0b38bfa994";
import VarArray "1ae38af22bbd20d80bd4bb2c276075935a1c9069b03d6773928b247616e48193";
import Iter "394eda524ad6869af6e1f8bf5be2f6885951b4191c71c790ca325539ef65464e";
import Order "4b6d97683d4354a7fe185827a135298026e670b1279af4284c74059628ec0f39";
import Result "3aeed20003aa1864549527075a8298f890157a6e37366384c9e275a38dc0d8ba";
import { trap } "ccb23e2d72bb4ab9edc842d7dc106d708734b3a441117e4a7816067209391eac";
import Types "d1ceaf3da72a662842dad6256b90f6c4214b079f5658917a72e0fa3b97e21bdc";
import Runtime "ccb23e2d72bb4ab9edc842d7dc106d708734b3a441117e4a7816067209391eac";
module {
  public type List<T> = Types.Pure.List<T>;
  public func empty<T>() : List<T> = null;
  public func isEmpty<T>(self : List<T>) : Bool = switch self {
    case null true;
    case _ false
  };
  public func size<T>(self : List<T>) : Nat = (
    func go(n : Nat, list : List<T>) : Nat = switch list {
      case (?(_, t)) go(n + 1, t);
      case null n
    }
  )(0, self);
  public func contains<T>(self : List<T>, equal : (implicit : (T, T) -> Bool), item : T) : Bool = switch self {
    case (?(h, t)) equal(h, item) or contains(t, equal, item);
    case _ false
  };
  public func get<T>(self : List<T>, n : Nat) : ?T = switch self {
    case (?(h, t)) if (n == 0) ?h else get(t, n - 1 : Nat);
    case null null
  };
  public func pushFront<T>(self : List<T>, item : T) : List<T> = ?(item, self);
  public func last<T>(self : List<T>) : ?T = switch self {
    case (?(h, null)) ?h;
    case null null;
    case (?(_, t)) last t
  };
  public func popFront<T>(self : List<T>) : (?T, List<T>) = switch self {
    case null (null, null);
    case (?(h, t)) (?h, t)
  };
  public func reverse<T>(self : List<T>) : List<T> = (
    func go(acc : List<T>, list : List<T>) : List<T> = switch list {
      case (?(h, t)) go(?(h, acc), t);
      case null acc
    }
  )(null, self);
  public func forEach<T>(self : List<T>, f : T -> ()) = switch self {
    case (?(h, t)) { f h; forEach(t, f) };
    case null ()
  };
  public func map<T1, T2>(self : List<T1>, f : T1 -> T2) : List<T2> = (
    func go(list : List<T1>, f : T1 -> T2, acc : List<T2>) : List<T2> = switch list {
      case (?(h, t)) go(t, f, ?(f h, acc));
      case null reverse acc
    }
  )(self, f, null);
  public func filter<T>(self : List<T>, f : T -> Bool) : List<T> = (
    func go(list : List<T>, f : T -> Bool, acc : List<T>) : List<T> = switch list {
      case (?(h, t)) if (f h) go(t, f, ?(h, acc)) else go(t, f, acc);
      case null reverse acc
    }
  )(self, f, null);
  public func filterMap<T, R>(self : List<T>, f : T -> ?R) : List<R> = (
    func go(list : List<T>, f : T -> ?R, acc : List<R>) : List<R> = switch list {
      case (?(h, t)) switch (f h) {
        case null go(t, f, acc);
        case (?r) go(t, f, ?(r, acc))
      };
      case null reverse acc
    }
  )(self, f, null);
  public func mapResult<T, R, E>(self : List<T>, f : T -> Result.Result<R, E>) : Result.Result<List<R>, E> = (
    func rev(acc : List<R>, list : List<T>, f : T -> Result.Result<R, E>) : Result.Result<List<R>, E> = switch list {
      case (?(h, t)) switch (f h) {
        case (#ok fh) rev(?(fh, acc), t, f);
        case (#err e) #err e
      };
      case null #ok(reverse acc)
    }
  )(null, self, f);
  public func partition<T>(self : List<T>, f : T -> Bool) : (List<T>, List<T>) = (
    func go(list : List<T>, f : T -> Bool, acc1 : List<T>, acc2 : List<T>) : (List<T>, List<T>) = switch list {
      case (?(h, t)) if (f h) go(t, f, ?(h, acc1), acc2) else go(t, f, acc1, ?(h, acc2));
      case null (reverse acc1, reverse acc2)
    }
  )(self, f, null, null);
  public func concat<T>(self : List<T>, other : List<T>) : List<T> = revAppend(reverse self, other);
  public func join<T>(iter : Iter.Iter<List<T>>) : List<T> {
    var acc : List<T> = null;
    for (list in iter) {
      acc := revAppend(list, acc)
    };
    reverse acc
  };
  public func flatten<T>(self : List<List<T>>) : List<T> = (
    func go(lists : List<List<T>>, acc : List<T>) : List<T> = switch lists {
      case (?(list, t)) go(t, revAppend(list, acc));
      case null reverse acc
    }
  )(self, null);
  public func take<T>(self : List<T>, n : Nat) : List<T> = (
    func go(n : Nat, list : List<T>, acc : List<T>) : List<T> = if (n == 0) reverse acc else switch list {
      case (?(h, t)) go(n - 1 : Nat, t, ?(h, acc));
      case null reverse acc
    }
  )(n, self, null);
  public func drop<T>(self : List<T>, n : Nat) : List<T> = if (n == 0) self else switch self {
    case (?(_, t)) drop(t, n - 1 : Nat);
    case null null
  };
  public func foldLeft<T, A>(self : List<T>, base : A, combine : (A, T) -> A) : A = switch self {
    case null base;
    case (?(h, t)) foldLeft(t, combine(base, h), combine)
  };
  public func foldRight<T, A>(self : List<T>, base : A, combine : (T, A) -> A) : A = (
    func go(list : List<T>, base : A, combine : (T, A) -> A) : A = switch list {
      case null base;
      case (?(h, t)) go(t, combine(h, base), combine)
    }
  )(reverse self, base, combine);
  public func find<T>(self : List<T>, f : T -> Bool) : ?T = switch self {
    case null null;
    case (?(h, t)) if (f h) ?h else find(t, f)
  };
  public func findIndex<T>(self : List<T>, f : T -> Bool) : ?Nat {
    findIndex_(self, 0, f)
  };
  private func findIndex_<T>(self : List<T>, index : Nat, f : T -> Bool) : ?Nat = switch self {
    case null null;
    case (?(h, t)) if (f h) ?index else findIndex_(t, index + 1, f)
  };
  public func all<T>(self : List<T>, f : T -> Bool) : Bool = switch self {
    case null true;
    case (?(h, t)) f h and all(t, f)
  };
  public func any<T>(self : List<T>, f : T -> Bool) : Bool = switch self {
    case null false;
    case (?(h, t)) f h or any(t, f)
  };
  public func merge<T>(self : List<T>, other : List<T>, compare : (implicit : (T, T) -> Order.Order)) : List<T> = (
    func go(list1 : List<T>, list2 : List<T>, compare : (T, T) -> Order.Order, acc : List<T>) : List<T> = switch (list1, list2) {
      case ((null, l) or (l, null)) reverse(revAppend(l, acc));
      case (?(h1, t1), ?(h2, t2)) switch (compare(h1, h2)) {
        case (#less or #equal) go(t1, list2, compare, ?(h1, acc));
        case (#greater) go(list1, t2, compare, ?(h2, acc))
      }
    }
  )(self, other, compare, null);
  public func equal<T>(self : List<T>, other : List<T>, equalItem : (implicit : (equal : (T, T) -> Bool))) : Bool = switch (self, other) {
    case (null, null) true;
    case (?(h1, t1), ?(h2, t2)) equalItem(h1, h2) and equal(t1, t2, equalItem);
    case _ false
  };
  public func compare<T>(self : List<T>, other : List<T>, compareItem : (implicit : (compare : (T, T) -> Order.Order))) : Order.Order = switch (self, other) {
    case (?(h1, t1), ?(h2, t2)) switch (compareItem(h1, h2)) {
      case (#equal) compare(t1, t2, compareItem);
      case o o
    };
    case (null, null) #equal;
    case (null, _) #less;
    case _ #greater
  };
  public func tabulate<T>(n : Nat, f : Nat -> T) : List<T> {
    var i = 0;
    var l : List<T> = null;
    while (i < n) {
      l := ?(f i, l);
      i += 1
    };
    reverse l
  };
  public func singleton<T>(item : T) : List<T> = ?(item, null);
  public func repeat<T>(item : T, n : Nat) : List<T> {
    var res : List<T> = null;
    var i : Int = n;
    while (i != 0) {
      i -= 1;
      res := ?(item, res)
    };
    res
  };
  public func zip<T, U>(self : List<T>, other : List<U>) : List<(T, U)> = zipWith<T, U, (T, U)>(self, other, func(x, y) = (x, y));
  public func zipWith<T, U, V>(self : List<T>, other : List<U>, f : (T, U) -> V) : List<V> = (
    func go(list1 : List<T>, list2 : List<U>, f : (T, U) -> V, acc : List<V>) : List<V> = switch (list1, list2) {
      case ((null, _) or (_, null)) reverse acc;
      case (?(h1, t1), ?(h2, t2)) go(t1, t2, f, ?(f(h1, h2), acc))
    }
  )(self, other, f, null);
  public func split<T>(self : List<T>, n : Nat) : (List<T>, List<T>) {
    func go(n : Nat, list : List<T>, acc : List<T>) : (List<T>, List<T>) = if (n == 0) (reverse acc, list) else switch list {
      case (?(h, t)) go(n - 1 : Nat, t, ?(h, acc));
      case null (reverse acc, null)
    };
    go(n, self, null)
  };
  public func chunks<T>(self : List<T>, n : Nat) : List<List<T>> {
    if (n == 0) trap "pure/List.chunks()";
    func go(list : List<T>, n : Nat, acc : List<List<T>>) : List<List<T>> = switch (split(list, n)) {
      case (null, _) reverse acc;
      case (pre, null) reverse(?(pre, acc));
      case (pre, post) go(post, n, ?(pre, acc))
    };
    go(self, n, null)
  };
  public func values<T>(self : List<T>) : Iter.Iter<T> = object {
    var l = self;
    public func next() : ?T = switch l {
      case null null;
      case (?(h, t)) {
        l := t;
        ?h
      }
    }
  };
  public func enumerate<T>(self : List<T>) : Iter.Iter<(Nat, T)> = object {
    var i = 0;
    var l = self;
    public func next() : ?(Nat, T) = switch l {
      case null null;
      case (?(h, t)) {
        l := t;
        let index = i;
        i += 1;
        ?(index, h)
      }
    }
  };
  public func fromArray<T>(array : [T]) : List<T> {
    func go(from : Nat) : List<T> = if (from < array.size()) ?(array.get from, go(from + 1)) else null;
    go 0
  };
  public func fromVarArray<T>(array : [var T]) : List<T> = fromArray<T>(VarArray.toArray<T>(array));
  public func toArray<T>(self : List<T>) : [T] {
    var l = self;
    Array_tabulate<T>(size self, func _ { let ?(h, t) = l else Runtime.trap("List.toArray(): unreachable"); l := t; h })
  };
  public func toVarArray<T>(self : List<T>) : [var T] = Array.toVarArray<T>(toArray<T>(self));
  public func fromIter<T>(iter : Iter.Iter<T>) : List<T> {
    var result : List<T> = null;
    for (x in iter) {
      result := ?(x, result)
    };
    reverse result
  };
  public func toList<T>(self : Iter.Iter<T>) : List<T> {
    fromIter(self)
  };
  public func toText<T>(self : List<T>, f : (implicit : T -> Text)) : Text {
    var text = "PureList[";
    var first = true;
    forEach(
      self,
      func(item : T) {
        if first {
          first := false
        } else {
          text #= ", "
        };
        text #= f item
      }
    );
    text # "]"
  };
  func revAppend<T>(l : List<T>, m : List<T>) : List<T> = switch l {
    case (?(h, t)) revAppend(t, ?(h, m));
    case null m
  }
}
