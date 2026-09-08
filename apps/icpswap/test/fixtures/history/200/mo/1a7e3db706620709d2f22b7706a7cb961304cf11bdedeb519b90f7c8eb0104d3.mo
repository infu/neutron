import Order "4b6d97683d4354a7fe185827a135298026e670b1279af4284c74059628ec0f39";
import Iter "394eda524ad6869af6e1f8bf5be2f6885951b4191c71c790ca325539ef65464e";
import Types "d1ceaf3da72a662842dad6256b90f6c4214b079f5658917a72e0fa3b97e21bdc";
import Runtime "ccb23e2d72bb4ab9edc842d7dc106d708734b3a441117e4a7816067209391eac";
module {
  public type Map<K, V> = Types.Pure.Map<K, V>;
  type Tree<K, V> = Types.Pure.Map.Tree<K, V>;
  public func empty<K, V>() : Map<K, V> {
    Internal.empty<K, V>()
  };
  public func isEmpty<K, V>(self : Map<K, V>) : Bool {
    self.size == 0
  };
  public func size<K, V>(self : Map<K, V>) : Nat = self.size;
  public func containsKey<K, V>(self : Map<K, V>, compare : (implicit : (K, K) -> Order.Order), key : K) : Bool = Internal.contains(self.root, compare, key);
  public func get<K, V>(self : Map<K, V>, compare : (implicit : (K, K) -> Order.Order), key : K) : ?V = Internal.get(self.root, compare, key);
  public func insert<K, V>(self : Map<K, V>, compare : (implicit : (K, K) -> Order.Order), key : K, value : V) : (Map<K, V>, Bool) {
    switch (swap(self, compare, key, value)) {
      case (map1, null) (map1, true);
      case (map1, _) (map1, false)
    }
  };
  public func add<K, V>(self : Map<K, V>, compare : (implicit : (K, K) -> Order.Order), key : K, value : V) : Map<K, V> {
    swap(self, compare, key, value).0
  };
  public func swap<K, V>(self : Map<K, V>, compare : (implicit : (K, K) -> Order.Order), key : K, value : V) : (Map<K, V>, ?V) {
    switch (Internal.swap(self.root, compare, key, value)) {
      case (t, null) { ({ root = t; size = self.size + 1 }, null) };
      case (t, v) { ({ root = t; size = self.size }, v) }
    }
  };
  public func replace<K, V>(self : Map<K, V>, compare : (implicit : (K, K) -> Order.Order), key : K, value : V) : (Map<K, V>, ?V) {
    if (containsKey(self, compare, key)) {
      swap(self, compare, key, value)
    } else { (self, null) }
  };
  public func remove<K, V>(self : Map<K, V>, compare : (implicit : (K, K) -> Order.Order), key : K) : Map<K, V> {
    switch (Internal.remove(self.root, compare, key)) {
      case (_, null) self;
      case (t, ?_) { { root = t; size = self.size - 1 } }
    }
  };
  public func delete<K, V>(self : Map<K, V>, compare : (implicit : (K, K) -> Order.Order), key : K) : (Map<K, V>, Bool) {
    switch (Internal.remove(self.root, compare, key)) {
      case (_, null) { (self, false) };
      case (t, ?_) { ({ root = t; size = self.size - 1 }, true) }
    }
  };
  public func take<K, V>(self : Map<K, V>, compare : (implicit : (K, K) -> Order.Order), key : K) : (Map<K, V>, ?V) {
    switch (Internal.remove(self.root, compare, key)) {
      case (t, null) { ({ root = t; size = self.size }, null) };
      case (t, v) { ({ root = t; size = self.size - 1 }, v) }
    }
  };
  public func maxEntry<K, V>(self : Map<K, V>) : ?(K, V) = Internal.maxEntry(self.root);
  public func minEntry<K, V>(self : Map<K, V>) : ?(K, V) = Internal.minEntry(self.root);
  public func entries<K, V>(self : Map<K, V>) : Iter.Iter<(K, V)> = Internal.iter(self.root, #fwd);
  public func reverseEntries<K, V>(self : Map<K, V>) : Iter.Iter<(K, V)> = Internal.iter(self.root, #bwd);
  public func keys<K, V>(self : Map<K, V>) : Iter.Iter<K> = Iter.map(entries(self), func(kv : (K, V)) : K { kv.0 });
  public func values<K, V>(self : Map<K, V>) : Iter.Iter<V> = Iter.map(entries(self), func(kv : (K, V)) : V { kv.1 });
  public func fromIter<K, V>(iter : Iter.Iter<(K, V)>, compare : (implicit : (K, K) -> Order.Order)) : Map<K, V> = Internal.fromIter(iter, compare);
  public func toMap<K, V>(self : Iter.Iter<(K, V)>, compare : (implicit : (K, K) -> Order.Order)) : Map<K, V> = Internal.fromIter(self, compare);
  public func map<K, V1, V2>(self : Map<K, V1>, f : (K, V1) -> V2) : Map<K, V2> = Internal.map(self, f);
  public func foldLeft<K, V, A>(
    self : Map<K, V>,
    base : A,
    combine : (A, K, V) -> A
  ) : A = Internal.foldLeft(self.root, base, combine);
  public func foldRight<K, V, A>(
    self : Map<K, V>,
    base : A,
    combine : (K, V, A) -> A
  ) : A = Internal.foldRight(self.root, base, combine);
  public func all<K, V>(self : Map<K, V>, pred : (K, V) -> Bool) : Bool = Internal.all(self.root, pred);
  public func any<K, V>(self : Map<K, V>, pred : (K, V) -> Bool) : Bool = Internal.any(self.root, pred);
  public func singleton<K, V>(key : K, value : V) : Map<K, V> {
    {
      size = 1;
      root = #red(#leaf, key, value, #leaf)
    }
  };
  public func forEach<K, V>(self : Map<K, V>, operation : (K, V) -> ()) = Internal.forEach(self, operation);
  public func filter<K, V>(self : Map<K, V>, compare : (implicit : (K, K) -> Order.Order), criterion : (K, V) -> Bool) : Map<K, V> = Internal.filter(self, compare, criterion);
  public func filterMap<K, V1, V2>(self : Map<K, V1>, compare : (implicit : (K, K) -> Order.Order), f : (K, V1) -> ?V2) : Map<K, V2> = Internal.mapFilter(self, compare : (K, K) -> Order.Order, f);
  public func assertValid<K, V>(self : Map<K, V>, compare : (implicit : (K, K) -> Order.Order)) : () = Internal.validate(self, compare);
  public func toText<K, V>(self : Map<K, V>, keyFormat : (implicit : (toText : K -> Text)), valueFormat : (implicit : (toText : V -> Text))) : Text {
    var text = "PureMap{";
    var sep = "";
    for ((k, v) in entries(self)) {
      text #= sep # "(" # keyFormat(k) # ", " # valueFormat(v) # ")";
      sep := ", "
    };
    text # "}"
  };
  public func equal<K, V>(self : Map<K, V>, other : Map<K, V>, compare : (implicit : (K, K) -> Order.Order), equal : (implicit : (V, V) -> Bool)) : Bool {
    if (self.size != other.size) {
      return false
    };
    let iterator1 = entries(self);
    let iterator2 = entries(other);
    loop {
      let next1 = iterator1.next();
      let next2 = iterator2.next();
      switch (next1, next2) {
        case (null, null) {
          return true
        };
        case (?(key1, value1), ?(key2, value2)) {
          if (not (compare(key1, key2) == #equal) or not equal(value1, value2)) {
            return false
          }
        };
        case _ { return false }
      }
    }
  };
  public func compare<K, V>(self : Map<K, V>, other : Map<K, V>, compareKey : (implicit : (compare : (K, K) -> Order.Order)), compareValue : (implicit : (compare : (V, V) -> Order.Order))) : Order.Order {
    let iterator1 = entries(self);
    let iterator2 = entries(other);
    loop {
      switch (iterator1.next(), iterator2.next()) {
        case (null, null) return #equal;
        case (null, _) return #less;
        case (_, null) return #greater;
        case (?(key1, value1), ?(key2, value2)) {
          let keyComparison = compareKey(key1, key2);
          if (keyComparison != #equal) {
            return keyComparison
          };
          let valueComparison = compareValue(value1, value2);
          if (valueComparison != #equal) {
            return valueComparison
          }
        }
      }
    }
  };
  module Internal {
    public func empty<K, V>() : Map<K, V> { { size = 0; root = #leaf } };
    public func fromIter<K, V>(i : Iter.Iter<(K, V)>, compare : (K, K) -> Order.Order) : Map<K, V> {
      var map = #leaf : Tree<K, V>;
      var size = 0;
      for (val in i) {
        map := add(map, compare, val.0, val.1);
        size += 1
      };
      { root = map; size }
    };
    type List<T> = Types.Pure.List<T>;
    type IterRep<K, V> = List<{ #tr : Tree<K, V>; #xy : (K, V) }>;
    public func iter<K, V>(map : Tree<K, V>, direction : { #fwd; #bwd }) : Iter.Iter<(K, V)> {
      let turnLeftFirst : MapTraverser<K, V> = func(l, x, y, r, ts) {
        ?(#tr(l), ?(#xy(x, y), ?(#tr(r), ts)))
      };
      let turnRightFirst : MapTraverser<K, V> = func(l, x, y, r, ts) {
        ?(#tr(r), ?(#xy(x, y), ?(#tr(l), ts)))
      };
      switch direction {
        case (#fwd) IterMap(map, turnLeftFirst);
        case (#bwd) IterMap(map, turnRightFirst)
      }
    };
    type MapTraverser<K, V> = (Tree<K, V>, K, V, Tree<K, V>, IterRep<K, V>) -> IterRep<K, V>;
    class IterMap<K, V>(tree : Tree<K, V>, mapTraverser : MapTraverser<K, V>) {
      var trees : IterRep<K, V> = ?(#tr(tree), null);
      public func next() : ?(K, V) {
        switch (trees) {
          case (null) { null };
          case (?(#tr(#leaf), ts)) {
            trees := ts;
            next()
          };
          case (?(#xy(xy), ts)) {
            trees := ts;
            ?xy
          };
          case (?(#tr(#red(l, x, y, r)), ts)) {
            trees := mapTraverser(l, x, y, r, ts);
            next()
          };
          case (?(#tr(#black(l, x, y, r)), ts)) {
            trees := mapTraverser(l, x, y, r, ts);
            next()
          }
        }
      }
    };
    public func map<K, V1, V2>(map : Map<K, V1>, f : (K, V1) -> V2) : Map<K, V2> {
      func mapRec(m : Tree<K, V1>) : Tree<K, V2> {
        switch m {
          case (#leaf) { #leaf };
          case (#red(l, x, y, r)) {
            #red(mapRec l, x, f(x, y), mapRec r)
          };
          case (#black(l, x, y, r)) {
            #black(mapRec l, x, f(x, y), mapRec r)
          }
        }
      };
      { size = map.size; root = mapRec(map.root) }
    };
    public func foldLeft<Key, Value, Accum>(
      map : Tree<Key, Value>,
      base : Accum,
      combine : (Accum, Key, Value) -> Accum
    ) : Accum {
      switch (map) {
        case (#leaf) { base };
        case (#red(l, k, v, r)) {
          let left = foldLeft(l, base, combine);
          let middle = combine(left, k, v);
          foldLeft(r, middle, combine)
        };
        case (#black(l, k, v, r)) {
          let left = foldLeft(l, base, combine);
          let middle = combine(left, k, v);
          foldLeft(r, middle, combine)
        }
      }
    };
    public func foldRight<Key, Value, Accum>(
      map : Tree<Key, Value>,
      base : Accum,
      combine : (Key, Value, Accum) -> Accum
    ) : Accum {
      switch (map) {
        case (#leaf) { base };
        case (#red(l, k, v, r)) {
          let right = foldRight(r, base, combine);
          let middle = combine(k, v, right);
          foldRight(l, middle, combine)
        };
        case (#black(l, k, v, r)) {
          let right = foldRight(r, base, combine);
          let middle = combine(k, v, right);
          foldRight(l, middle, combine)
        }
      }
    };
    public func forEach<K, V>(map : Map<K, V>, operation : (K, V) -> ()) {
      func combine(_acc : Null, key : K, value : V) : Null {
        operation(key, value);
        null
      };
      ignore foldLeft(map.root, null, combine)
    };
    public func filter<K, V>(map : Map<K, V>, compare : (K, K) -> Order.Order, criterion : (K, V) -> Bool) : Map<K, V> {
      var size = 0;
      func combine(acc : Tree<K, V>, key : K, value : V) : Tree<K, V> {
        if (criterion(key, value)) {
          size += 1;
          add(acc, compare, key, value)
        } else acc
      };
      { root = foldLeft(map.root, #leaf, combine); size }
    };
    public func mapFilter<K, V1, V2>(map : Map<K, V1>, compare : (K, K) -> Order.Order, f : (K, V1) -> ?V2) : Map<K, V2> {
      var size = 0;
      func combine(acc : Tree<K, V2>, key : K, value1 : V1) : Tree<K, V2> {
        switch (f(key, value1)) {
          case null { acc };
          case (?value2) {
            size += 1;
            add(acc, compare, key, value2)
          }
        }
      };
      { root = foldLeft(map.root, #leaf, combine); size }
    };
    public func get<K, V>(t : Tree<K, V>, compare : (K, K) -> Order.Order, x : K) : ?V {
      switch t {
        case (#red(l, x1, y1, r)) {
          switch (compare(x, x1)) {
            case (#less) { get(l, compare, x) };
            case (#equal) { ?y1 };
            case (#greater) { get(r, compare, x) }
          }
        };
        case (#black(l, x1, y1, r)) {
          switch (compare(x, x1)) {
            case (#less) { get(l, compare, x) };
            case (#equal) { ?y1 };
            case (#greater) { get(r, compare, x) }
          }
        };
        case (#leaf) { null }
      }
    };
    public func contains<K, V>(m : Tree<K, V>, compare : (K, K) -> Order.Order, key : K) : Bool {
      switch (get(m, compare, key)) {
        case (null) { false };
        case (_) { true }
      }
    };
    public func maxEntry<K, V>(m : Tree<K, V>) : ?(K, V) {
      func rightmost(m : Tree<K, V>) : (K, V) {
        switch m {
          case (#red(_, k, v, #leaf)) { (k, v) };
          case (#red(_, _, _, r)) { rightmost(r) };
          case (#black(_, k, v, #leaf)) { (k, v) };
          case (#black(_, _, _, r)) { rightmost(r) };
          case (#leaf) { Runtime.trap "pure/Map.maxEntry() impossible" }
        }
      };
      switch m {
        case (#leaf) { null };
        case (_) { ?rightmost(m) }
      }
    };
    public func minEntry<K, V>(m : Tree<K, V>) : ?(K, V) {
      func leftmost(m : Tree<K, V>) : (K, V) {
        switch m {
          case (#red(#leaf, k, v, _)) { (k, v) };
          case (#red(l, _, _, _)) { leftmost(l) };
          case (#black(#leaf, k, v, _)) { (k, v) };
          case (#black(l, _, _, _)) { leftmost(l) };
          case (#leaf) { Runtime.trap "pure/Map.minEntry() impossible" }
        }
      };
      switch m {
        case (#leaf) { null };
        case (_) { ?leftmost(m) }
      }
    };
    public func all<K, V>(m : Tree<K, V>, pred : (K, V) -> Bool) : Bool {
      switch m {
        case (#red(l, k, v, r)) {
          pred(k, v) and all(l, pred) and all(r, pred)
        };
        case (#black(l, k, v, r)) {
          pred(k, v) and all(l, pred) and all(r, pred)
        };
        case (#leaf) { true }
      }
    };
    public func any<K, V>(m : Tree<K, V>, pred : (K, V) -> Bool) : Bool {
      switch m {
        case (#red(l, k, v, r)) {
          pred(k, v) or any(l, pred) or any(r, pred)
        };
        case (#black(l, k, v, r)) {
          pred(k, v) or any(l, pred) or any(r, pred)
        };
        case (#leaf) { false }
      }
    };
    func redden<K, V>(t : Tree<K, V>) : Tree<K, V> {
      switch t {
        case (#black(l, x, y, r)) { (#red(l, x, y, r)) };
        case _ {
          Runtime.trap "pure/Map.redden() impossible"
        }
      }
    };
    func lbalance<K, V>(left : Tree<K, V>, x : K, y : V, right : Tree<K, V>) : Tree<K, V> {
      switch (left, right) {
        case (#red(#red(l1, x1, y1, r1), x2, y2, r2), r) {
          #red(
            #black(l1, x1, y1, r1),
            x2,
            y2,
            #black(r2, x, y, r)
          )
        };
        case (#red(l1, x1, y1, #red(l2, x2, y2, r2)), r) {
          #red(
            #black(l1, x1, y1, l2),
            x2,
            y2,
            #black(r2, x, y, r)
          )
        };
        case _ {
          #black(left, x, y, right)
        }
      }
    };
    func rbalance<K, V>(left : Tree<K, V>, x : K, y : V, right : Tree<K, V>) : Tree<K, V> {
      switch (left, right) {
        case (l, #red(l1, x1, y1, #red(l2, x2, y2, r2))) {
          #red(
            #black(l, x, y, l1),
            x1,
            y1,
            #black(l2, x2, y2, r2)
          )
        };
        case (l, #red(#red(l1, x1, y1, r1), x2, y2, r2)) {
          #red(
            #black(l, x, y, l1),
            x1,
            y1,
            #black(r1, x2, y2, r2)
          )
        };
        case _ {
          #black(left, x, y, right)
        }
      }
    };
    type ClashResolver<A> = { old : A; new : A } -> A;
    func insertWith<K, V>(
      m : Tree<K, V>,
      compare : (K, K) -> Order.Order,
      key : K,
      val : V,
      onClash : ClashResolver<V>
    ) : Tree<K, V> {
      func ins(tree : Tree<K, V>) : Tree<K, V> {
        switch tree {
          case (#black(left, x, y, right)) {
            switch (compare(key, x)) {
              case (#less) {
                lbalance(ins left, x, y, right)
              };
              case (#greater) {
                rbalance(left, x, y, ins right)
              };
              case (#equal) {
                let newVal = onClash({ new = val; old = y });
                #black(left, key, newVal, right)
              }
            }
          };
          case (#red(left, x, y, right)) {
            switch (compare(key, x)) {
              case (#less) {
                #red(ins left, x, y, right)
              };
              case (#greater) {
                #red(left, x, y, ins right)
              };
              case (#equal) {
                let newVal = onClash { new = val; old = y };
                #red(left, key, newVal, right)
              }
            }
          };
          case (#leaf) {
            #red(#leaf, key, val, #leaf)
          }
        }
      };
      switch (ins m) {
        case (#red(left, x, y, right)) {
          #black(left, x, y, right)
        };
        case other { other }
      }
    };
    public func swap<K, V>(
      m : Tree<K, V>,
      compare : (K, K) -> Order.Order,
      key : K,
      val : V
    ) : (Tree<K, V>, ?V) {
      var oldVal : ?V = null;
      func onClash(clash : { old : V; new : V }) : V {
        oldVal := ?clash.old;
        clash.new
      };
      let res = insertWith(m, compare, key, val, onClash);
      (res, oldVal)
    };
    public func add<K, V>(
      m : Tree<K, V>,
      compare : (K, K) -> Order.Order,
      key : K,
      val : V
    ) : Tree<K, V> = swap(m, compare, key, val).0;
    func balLeft<K, V>(left : Tree<K, V>, x : K, y : V, right : Tree<K, V>) : Tree<K, V> {
      switch (left, right) {
        case (#red(l1, x1, y1, r1), r) {
          #red(
            #black(l1, x1, y1, r1),
            x,
            y,
            r
          )
        };
        case (_, #black(l2, x2, y2, r2)) {
          rbalance(left, x, y, #red(l2, x2, y2, r2))
        };
        case (_, #red(#black(l2, x2, y2, r2), x3, y3, r3)) {
          #red(
            #black(left, x, y, l2),
            x2,
            y2,
            rbalance(r2, x3, y3, redden r3)
          )
        };
        case _ { Runtime.trap "pure/Map.balLeft() impossible" }
      }
    };
    func balRight<K, V>(left : Tree<K, V>, x : K, y : V, right : Tree<K, V>) : Tree<K, V> {
      switch (left, right) {
        case (l, #red(l1, x1, y1, r1)) {
          #red(
            l,
            x,
            y,
            #black(l1, x1, y1, r1)
          )
        };
        case (#black(l1, x1, y1, r1), r) {
          lbalance(#red(l1, x1, y1, r1), x, y, r)
        };
        case (#red(l1, x1, y1, #black(l2, x2, y2, r2)), r3) {
          #red(
            lbalance(redden l1, x1, y1, l2),
            x2,
            y2,
            #black(r2, x, y, r3)
          )
        };
        case _ { Runtime.trap "pure/Map.balRight() impossible" }
      }
    };
    func append<K, V>(left : Tree<K, V>, right : Tree<K, V>) : Tree<K, V> {
      switch (left, right) {
        case (#leaf, _) { right };
        case (_, #leaf) { left };
        case (
          #red(l1, x1, y1, r1),
          #red(l2, x2, y2, r2)
        ) {
          switch (append(r1, l2)) {
            case (#red(l3, x3, y3, r3)) {
              #red(
                #red(l1, x1, y1, l3),
                x3,
                y3,
                #red(r3, x2, y2, r2)
              )
            };
            case r1l2 {
              #red(l1, x1, y1, #red(r1l2, x2, y2, r2))
            }
          }
        };
        case (t1, #red(l2, x2, y2, r2)) {
          #red(append(t1, l2), x2, y2, r2)
        };
        case (#red(l1, x1, y1, r1), t2) {
          #red(l1, x1, y1, append(r1, t2))
        };
        case (#black(l1, x1, y1, r1), #black(l2, x2, y2, r2)) {
          switch (append(r1, l2)) {
            case (#red(l3, x3, y3, r3)) {
              #red(
                #black(l1, x1, y1, l3),
                x3,
                y3,
                #black(r3, x2, y2, r2)
              )
            };
            case r1l2 {
              balLeft(
                l1,
                x1,
                y1,
                #black(r1l2, x2, y2, r2)
              )
            }
          }
        }
      }
    };
    public func delete<K, V>(m : Tree<K, V>, compare : (K, K) -> Order.Order, key : K) : Tree<K, V> = remove(m, compare, key).0;
    public func remove<K, V>(tree : Tree<K, V>, compare : (K, K) -> Order.Order, x : K) : (Tree<K, V>, ?V) {
      var y0 : ?V = null;
      func delNode(left : Tree<K, V>, x1 : K, y1 : V, right : Tree<K, V>) : Tree<K, V> {
        switch (compare(x, x1)) {
          case (#less) {
            let newLeft = del left;
            switch left {
              case (#black(_, _, _, _)) {
                balLeft(newLeft, x1, y1, right)
              };
              case _ {
                #red(newLeft, x1, y1, right)
              }
            }
          };
          case (#greater) {
            let newRight = del right;
            switch right {
              case (#black(_, _, _, _)) {
                balRight(left, x1, y1, newRight)
              };
              case _ {
                #red(left, x1, y1, newRight)
              }
            }
          };
          case (#equal) {
            y0 := ?y1;
            append(left, right)
          }
        }
      };
      func del(tree : Tree<K, V>) : Tree<K, V> {
        switch tree {
          case (#red(left, x, y, right)) {
            delNode(left, x, y, right)
          };
          case (#black(left, x, y, right)) {
            delNode(left, x, y, right)
          };
          case (#leaf) {
            tree
          }
        }
      };
      switch (del(tree)) {
        case (#red(left, x, y, right)) { (#black(left, x, y, right), y0) };
        case other { (other, y0) }
      }
    };
    public func validate<K, V>(rbMap : Map<K, V>, comp : (K, K) -> Order.Order) {
      ignore blackDepth(rbMap.root, comp)
    };
    func blackDepth<K, V>(node : Tree<K, V>, comp : (K, K) -> Order.Order) : Nat {
      func checkNode(left : Tree<K, V>, key : K, right : Tree<K, V>) : Nat {
        checkKey(left, func(x : K) : Bool { comp(x, key) == #less });
        checkKey(right, func(x : K) : Bool { comp(x, key) == #greater });
        let leftBlacks = blackDepth(left, comp);
        let rightBlacks = blackDepth(right, comp);
        assert (leftBlacks == rightBlacks);
        leftBlacks
      };
      switch node {
        case (#leaf) 0;
        case (#red(left, key, _, right)) {
          let leftBlacks = checkNode(left, key, right);
          assert (not isRed(left));
          assert (not isRed(right));
          leftBlacks
        };
        case (#black(left, key, _, right)) {
          checkNode(left, key, right) + 1
        }
      }
    };
    func isRed<K, V>(node : Tree<K, V>) : Bool {
      switch node {
        case (#red(_, _, _, _)) true;
        case _ false
      }
    };
    func checkKey<K, V>(node : Tree<K, V>, isValid : K -> Bool) {
      switch node {
        case (#leaf) {};
        case (#red(_, key, _, _)) {
          assert (isValid(key))
        };
        case (#black(_, key, _, _)) {
          assert (isValid(key))
        }
      }
    }
  };
}
