import PureMap "1a7e3db706620709d2f22b7706a7cb961304cf11bdedeb519b90f7c8eb0104d3";
import Types "d1ceaf3da72a662842dad6256b90f6c4214b079f5658917a72e0fa3b97e21bdc";
import Iter "394eda524ad6869af6e1f8bf5be2f6885951b4191c71c790ca325539ef65464e";
import Order "4b6d97683d4354a7fe185827a135298026e670b1279af4284c74059628ec0f39";
import VarArray "1ae38af22bbd20d80bd4bb2c276075935a1c9069b03d6773928b247616e48193";
import Runtime "ccb23e2d72bb4ab9edc842d7dc106d708734b3a441117e4a7816067209391eac";
import Stack "b28a4a7776ac8d70095f0bcf15b97da0e8a77560b5c8ba7fe143b8b741596b9d";
import Option "78222225a965bef98f662c85ff9e55e747c729bdd0633968a3935628fabccb98";
import BTreeHelper "ed6e47cb80f1da72c69a052013e766ee5da4e119e120eb125f1671fa148b1cb7";
module {
  let btreeOrder = 32;  
  public type Map<K, V> = Types.Map<K, V>;
  type Node<K, V> = Types.Map.Node<K, V>;
  type Data<K, V> = Types.Map.Data<K, V>;
  type Internal<K, V> = Types.Map.Internal<K, V>;
  type Leaf<K, V> = Types.Map.Leaf<K, V>;
  public func toPure<K, V>(self : Map<K, V>, compare : (implicit : (K, K) -> Order.Order)) : PureMap.Map<K, V> {
    PureMap.fromIter(entries(self), compare)
  };
  public func fromPure<K, V>(map : PureMap.Map<K, V>, compare : (implicit : (K, K) -> Order.Order)) : Map<K, V> {
    fromIter(PureMap.entries(map), compare)
  };
  public func clone<K, V>(self : Map<K, V>) : Map<K, V> {
    {
      var root = cloneNode(self.root);
      var size = self.size
    }
  };
  public func empty<K, V>() : Map<K, V> {
    {
      var root = #leaf({
        data = {
          kvs = VarArray.repeat<?(K, V)>(null, btreeOrder - 1);
          var count = 0
        }
      });
      var size = 0
    }
  };
  public func singleton<K, V>(key : K, value : V) : Map<K, V> {
    let kvs = VarArray.repeat<?(K, V)>(null, btreeOrder - 1);
    kvs[0] := ?(key, value);
    {
      var root = #leaf { data = { kvs; var count = 1 } };
      var size = 1
    }
  };
  public func clear<K, V>(self : Map<K, V>) {
    let emptyMap = empty<K, V>();
    self.root := emptyMap.root;
    self.size := 0
  };
  public func isEmpty<K, V>(self : Map<K, V>) : Bool {
    self.size == 0
  };
  public func size<K, V>(self : Map<K, V>) : Nat {
    self.size
  };
  public func equal<K, V>(self : Map<K, V>, other : Map<K, V>, compare : (implicit : (K, K) -> Types.Order), equal : (implicit : (V, V) -> Bool)) : Bool {
    if (size(self) != size(other)) {
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
          if (
            not (compare(key1, key2) == #equal) or
            not equal(value1, value2)
          ) {
            return false
          }
        };
        case _ { return false }
      }
    }
  };
  public func containsKey<K, V>(self : Map<K, V>, compare : (implicit : (K, K) -> Order.Order), key : K) : Bool {
    Option.isSome(get(self, compare, key))
  };
  public func get<K, V>(self : Map<K, V>, compare : (implicit : (K, K) -> Order.Order), key : K) : ?V {
    switch (self.root) {
      case (#internal(internalNode)) {
        getFromInternal(internalNode, compare, key)
      };
      case (#leaf(leafNode)) { getFromLeaf(leafNode, compare, key) }
    }
  };
  public func insert<K, V>(self : Map<K, V>, compare : (implicit : (K, K) -> Order.Order), key : K, value : V) : Bool {
    switch (swap(self, compare, key, value)) {
      case null true;
      case _ false
    }
  };
  public func add<K, V>(self : Map<K, V>, compare : (implicit : (K, K) -> Order.Order), key : K, value : V) {
    ignore swap(self, compare, key, value)
  };
  public func swap<K, V>(self : Map<K, V>, compare : (implicit : (K, K) -> Order.Order), key : K, value : V) : ?V {
    let insertResult = switch (self.root) {
      case (#leaf(leafNode)) {
        leafInsertHelper(leafNode, btreeOrder, compare, key, value)
      };
      case (#internal(internalNode)) {
        internalInsertHelper(internalNode, btreeOrder, compare, key, value)
      }
    };
    switch (insertResult) {
      case (#insert(ov)) {
        switch (ov) {
          case null { self.size += 1 };
          case _ {}
        };
        ov
      };
      case (#promote({ kv; leftChild; rightChild })) {
        let kvs = VarArray.repeat<?(K, V)>(null, btreeOrder - 1);
        kvs[0] := ?kv;
        let children = VarArray.repeat<?Node<K, V>>(null, btreeOrder);
        children[0] := ?leftChild;
        children[1] := ?rightChild;
        self.root := #internal({
          data = {
            kvs;
            var count = 1
          };
          children
        });
        self.size += 1;
        null
      }
    }
  };
  public func replace<K, V>(self : Map<K, V>, compare : (implicit : (K, K) -> Order.Order), key : K, value : V) : ?V {
    if (containsKey(self, compare, key)) {
      swap(self, compare, key, value)
    } else {
      null
    }
  };
  public func remove<K, V>(self : Map<K, V>, compare : (implicit : (K, K) -> Order.Order), key : K) {
    ignore delete(self, compare, key)
  };
  public func delete<K, V>(self : Map<K, V>, compare : (implicit : (K, K) -> Order.Order), key : K) : Bool {
    switch (take(self, compare, key)) {
      case null false;
      case _ true
    }
  };
  public func take<K, V>(self : Map<K, V>, compare : (implicit : (K, K) -> Order.Order), key : K) : ?V {
    let deletedValue = switch (self.root) {
      case (#leaf(leafNode)) {
        switch (NodeUtil.getKeyIndex(leafNode.data, compare, key)) {
          case (#keyFound(deleteIndex)) {
            leafNode.data.count -= 1;
            let (_, deletedValue) = BTreeHelper.deleteAndShift(leafNode.data.kvs, deleteIndex);
            self.size -= 1;
            ?deletedValue
          };
          case _ { null }
        }
      };
      case (#internal(internalNode)) {
        let deletedValueResult = switch (internalDeleteHelper(internalNode, btreeOrder, compare, key, false)) {
          case (#delete(value)) { value };
          case (#mergeChild({ internalChild; deletedValue })) {
            if (internalChild.data.count > 0) {
              self.root := #internal(internalChild)
            }
            else {
              self.root := switch (internalChild.children[0]) {
                case (?node) { node };
                case null {
                  Runtime.trap("UNREACHABLE_ERROR: file a bug report! In Map.delete(), element deletion failed, due to a null replacement node error")
                }
              }
            };
            deletedValue
          }
        };
        switch (deletedValueResult) {
          case (?deletedValue) { self.size -= 1 };
          case null {}
        };
        deletedValueResult
      }
    };
    deletedValue
  };
  public func toArray<K, V>(self : Map<K, V>) : [(K, V)] {
    Iter.toArray(entries(self))
  };
  public func toVarArray<K, V>(self : Map<K, V>) : [var (K, V)] {
    Iter.toVarArray(entries(self))
  };
  public func maxEntry<K, V>(self : Map<K, V>) : ?(K, V) {
    reverseEntries(self).next()
  };
  public func minEntry<K, V>(self : Map<K, V>) : ?(K, V) {
    entries(self).next()
  };
  public func entries<K, V>(self : Map<K, V>) : Types.Iter<(K, V)> {
    switch (self.root) {
      case (#leaf(leafNode)) { return leafEntries(leafNode) };
      case (#internal(internalNode)) { internalEntries(internalNode) }
    }
  };
  public func entriesFrom<K, V>(
    self : Map<K, V>,
    compare : (implicit : (K, K) -> Order.Order),
    key : K
  ) : Types.Iter<(K, V)> {
    switch (self.root) {
      case (#leaf(leafNode)) leafEntriesFrom(leafNode, compare, key);
      case (#internal(internalNode)) internalEntriesFrom(internalNode, compare, key)
    }
  };
  public func reverseEntries<K, V>(self : Map<K, V>) : Types.Iter<(K, V)> {
    switch (self.root) {
      case (#leaf(leafNode)) reverseLeafEntries(leafNode);
      case (#internal(internalNode)) reverseInternalEntries(internalNode)
    }
  };
  public func reverseEntriesFrom<K, V>(
    self : Map<K, V>,
    compare : (implicit : (K, K) -> Order.Order),
    key : K
  ) : Types.Iter<(K, V)> {
    switch (self.root) {
      case (#leaf(leafNode)) reverseLeafEntriesFrom(leafNode, compare, key);
      case (#internal(internalNode)) reverseInternalEntriesFrom(internalNode, compare, key)
    }
  };
  public func keys<K, V>(self : Map<K, V>) : Types.Iter<K> {
    object {
      let iterator = entries(self);
      public func next() : ?K {
        switch (iterator.next()) {
          case null null;
          case (?(key, _)) ?key
        }
      }
    }
  };
  public func values<K, V>(self : Map<K, V>) : Types.Iter<V> {
    object {
      let iterator = entries(self);
      public func next() : ?V {
        switch (iterator.next()) {
          case null null;
          case (?(_, value)) ?value
        }
      }
    }
  };
  public func fromIter<K, V>(iter : Types.Iter<(K, V)>, compare : (implicit : (K, K) -> Order.Order)) : Map<K, V> {
    let map = empty<K, V>();
    for ((key, value) in iter) {
      add(map, compare, key, value)
    };
    map
  };
  public func toMap<K, V>(self : Types.Iter<(K, V)>, compare : (implicit : (K, K) -> Order.Order)) : Map<K, V> {
    fromIter(self, compare)
  };
  public func fromArray<K, V>(array : [(K, V)], compare : (implicit : (K, K) -> Order.Order)) : Map<K, V> {
    fromIter(array.values(), compare)
  };
  public func fromVarArray<K, V>(array : [var (K, V)], compare : (implicit : (K, K) -> Order.Order)) : Map<K, V> {
    fromIter(array.values(), compare)
  };
  public func forEach<K, V>(self : Map<K, V>, operation : (K, V) -> ()) {
    for (entry in entries(self)) {
      operation(entry)
    }
  };
  public func filter<K, V>(self : Map<K, V>, compare : (implicit : (K, K) -> Order.Order), criterion : (K, V) -> Bool) : Map<K, V> {
    let result = empty<K, V>();
    for ((key, value) in entries(self)) {
      if (criterion(key, value)) {
        add(result, compare, key, value)
      }
    };
    result
  };
  public func map<K, V1, V2>(self : Map<K, V1>, project : (K, V1) -> V2) : Map<K, V2> {
    {
      var root = mapNode(self.root, project);
      var size = self.size
    }
  };
  public func foldLeft<K, V, A>(
    self : Map<K, V>,
    base : A,
    combine : (A, K, V) -> A
  ) : A {
    var accumulator = base;
    for ((key, value) in entries(self)) {
      accumulator := combine(accumulator, key, value)
    };
    accumulator
  };
  public func foldRight<K, V, A>(
    self : Map<K, V>,
    base : A,
    combine : (K, V, A) -> A
  ) : A {
    var accumulator = base;
    for ((key, value) in reverseEntries(self)) {
      accumulator := combine(key, value, accumulator)
    };
    accumulator
  };
  public func all<K, V>(self : Map<K, V>, predicate : (K, V) -> Bool) : Bool {
    for (entry in entries(self)) {
      if (not predicate(entry)) {
        return false
      }
    };
    true
  };
  public func any<K, V>(self : Map<K, V>, predicate : (K, V) -> Bool) : Bool {
    for (entry in entries(self)) {
      if (predicate(entry)) {
        return true
      }
    };
    false
  };
  public func filterMap<K, V1, V2>(self : Map<K, V1>, compare : (implicit : (K, K) -> Order.Order), project : (K, V1) -> ?V2) : Map<K, V2> {
    let result = empty<K, V2>();
    for ((key, value1) in entries(self)) {
      switch (project(key, value1)) {
        case null {};
        case (?value2) add(result, compare, key, value2)
      }
    };
    result
  };
  public func assertValid<K, V>(self : Map<K, V>, compare : (implicit : (K, K) -> Order.Order)) {
    func checkIteration(iterator : Types.Iter<(K, V)>, order : Order.Order) {
      switch (iterator.next()) {
        case null {};
        case (?first) {
          var previous = first;
          loop {
            switch (iterator.next()) {
              case null return;
              case (?next) {
                if (compare(previous.0, next.0) != order) {
                  Runtime.trap("Invalid order")
                };
                previous := next
              }
            }
          }
        }
      }
    };
    checkIteration(entries(self), #less);
    checkIteration(reverseEntries(self), #greater)
  };
  public func toText<K, V>(self : Map<K, V>, keyFormat : (implicit : (toText : K -> Text)), valueFormat : (implicit : (toText : V -> Text))) : Text {
    var text = "Map{";
    var sep = "";
    for ((key, value) in entries(self)) {
      text #= sep # "(" # keyFormat(key) # ", " # valueFormat(value) # ")";
      sep := ", "
    };
    text # "}"
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
  func leafEntries<K, V>({ data } : Leaf<K, V>) : Types.Iter<(K, V)> {
    var i : Nat = 0;
    object {
      public func next() : ?(K, V) {
        if (i >= data.count) {
          null
        } else {
          let res = data.kvs[i];
          i += 1;
          res
        }
      }
    }
  };
  func leafEntriesFrom<K, V>({ data } : Leaf<K, V>, compare : (K, K) -> Order.Order, key : K) : Types.Iter<(K, V)> {
    var i = switch (BinarySearch.binarySearchNode(data.kvs, compare, key, data.count)) {
      case (#keyFound(i)) i;
      case (#notFound(i)) i
    };
    object {
      public func next() : ?(K, V) {
        if (i >= data.count) {
          null
        } else {
          let res = data.kvs[i];
          i += 1;
          res
        }
      }
    }
  };
  func reverseLeafEntries<K, V>({ data } : Leaf<K, V>) : Types.Iter<(K, V)> {
    var i : Nat = data.count;
    object {
      public func next() : ?(K, V) {
        if (i == 0) {
          null
        } else {
          let res = data.kvs[i - 1];
          i -= 1;
          res
        }
      }
    }
  };
  func reverseLeafEntriesFrom<K, V>({ data } : Leaf<K, V>, compare : (K, K) -> Order.Order, key : K) : Types.Iter<(K, V)> {
    var i = switch (BinarySearch.binarySearchNode(data.kvs, compare, key, data.count)) {
      case (#keyFound(i)) i + 1;  
      case (#notFound(i)) i  
    };
    object {
      public func next() : ?(K, V) {
        if (i == 0) {
          null
        } else {
          let res = data.kvs[i - 1];
          i -= 1;
          res
        }
      }
    }
  };
  type NodeCursor<K, V> = { node : Node<K, V>; kvIndex : Nat };
  func internalEntries<K, V>(internal : Internal<K, V>) : Types.Iter<(K, V)> {
    let nodeCursorStack = initializeForwardNodeCursorStack(internal);
    internalEntriesFromStack(nodeCursorStack)
  };
  func internalEntriesFrom<K, V>(internal : Internal<K, V>, compare : (K, K) -> Order.Order, key : K) : Types.Iter<(K, V)> {
    let nodeCursorStack = initializeForwardNodeCursorStackFrom(internal, compare, key);
    internalEntriesFromStack(nodeCursorStack)
  };
  func internalEntriesFromStack<K, V>(nodeCursorStack : Stack.Stack<NodeCursor<K, V>>) : Types.Iter<(K, V)> {
    object {
      public func next() : ?(K, V) {
        var nodeCursor = Stack.pop(nodeCursorStack);
        switch (nodeCursor) {
          case null { return null };
          case (?{ node; kvIndex }) {
            switch (node) {
              case (#leaf(leafNode)) {
                let lastKV = leafNode.data.count - 1 : Nat;
                if (kvIndex > lastKV) {
                  Runtime.trap("UNREACHABLE_ERROR: file a bug report! In Map.internalEntries(), leaf kvIndex out of bounds")
                };
                let currentKV = switch (leafNode.data.kvs[kvIndex]) {
                  case (?kv) { kv };
                  case null {
                    Runtime.trap(
                      "UNREACHABLE_ERROR: file a bug report! In Map.internalEntries(), null key-value pair found in leaf node."
                      # "leafNode.data.count=" # debug_show (leafNode.data.count) # ", kvIndex=" # debug_show (kvIndex)
                    )
                  }
                };
                if (kvIndex < lastKV) {
                  Stack.push(
                    nodeCursorStack,
                    {
                      node = #leaf(leafNode);
                      kvIndex = kvIndex + 1 : Nat
                    }
                  )
                };
                ?currentKV
              };
              case (#internal(internalNode)) {
                let lastKV = internalNode.data.count - 1 : Nat;
                if (kvIndex > lastKV) {
                  Runtime.trap("UNREACHABLE_ERROR: file a bug report! In Map.internalEntries(), internal kvIndex out of bounds")
                };
                let currentKV = switch (internalNode.data.kvs[kvIndex]) {
                  case (?kv) { kv };
                  case null {
                    Runtime.trap(
                      "UNREACHABLE_ERROR: file a bug report! In Map.internalEntries(), null key-value pair found in internal node. " #
                      "internal.data.count=" # debug_show (internalNode.data.count) # ", kvIndex=" # debug_show (kvIndex)
                    )
                  }
                };
                let nextCursor = {
                  node = #internal(internalNode);
                  kvIndex = kvIndex + 1 : Nat
                };
                if (kvIndex < lastKV) {
                  Stack.push(nodeCursorStack, nextCursor)
                };
                traverseMinSubtreeIter(nodeCursorStack, nextCursor);
                ?currentKV
              }
            }
          }
        }
      }
    }
  };
  func reverseInternalEntries<K, V>(internal : Internal<K, V>) : Types.Iter<(K, V)> {
    let nodeCursorStack = initializeReverseNodeCursorStack(internal);
    reverseInternalEntriesFromStack(nodeCursorStack)
  };
  func reverseInternalEntriesFrom<K, V>(internal : Internal<K, V>, compare : (K, K) -> Order.Order, key : K) : Types.Iter<(K, V)> {
    let nodeCursorStack = initializeReverseNodeCursorStackFrom(internal, compare, key);
    reverseInternalEntriesFromStack(nodeCursorStack)
  };
  func reverseInternalEntriesFromStack<K, V>(nodeCursorStack : Stack.Stack<NodeCursor<K, V>>) : Types.Iter<(K, V)> {
    object {
      public func next() : ?(K, V) {
        var nodeCursor = Stack.pop(nodeCursorStack);
        switch (nodeCursor) {
          case null { return null };
          case (?{ node; kvIndex }) {
            let firstKV = 0 : Nat;
            assert (kvIndex > firstKV);
            switch (node) {
              case (#leaf(leafNode)) {
                let currentKV = switch (leafNode.data.kvs[kvIndex - 1]) {
                  case (?kv) { kv };
                  case null {
                    Runtime.trap(
                      "UNREACHABLE_ERROR: file a bug report! In Map.reverseInternalEntries(), null key-value pair found in leaf node."
                      # "leafNode.data.count=" # debug_show (leafNode.data.count) # ", kvIndex=" # debug_show (kvIndex)
                    )
                  }
                };
                if (kvIndex - 1 : Nat > firstKV) {
                  Stack.push(
                    nodeCursorStack,
                    {
                      node = #leaf(leafNode);
                      kvIndex = kvIndex - 1 : Nat
                    }
                  )
                };
                ?currentKV
              };
              case (#internal(internalNode)) {
                let currentKV = switch (internalNode.data.kvs[kvIndex - 1]) {
                  case (?kv) { kv };
                  case null {
                    Runtime.trap(
                      "UNREACHABLE_ERROR: file a bug report! In Map.reverseInternalEntries(), null key-value pair found in internal node. " #
                      "internal.data.count=" # debug_show (internalNode.data.count) # ", kvIndex=" # debug_show (kvIndex)
                    )
                  }
                };
                let previousCursor = {
                  node = #internal(internalNode);
                  kvIndex = kvIndex - 1 : Nat
                };
                if (kvIndex - 1 : Nat > firstKV) {
                  Stack.push(nodeCursorStack, previousCursor)
                };
                traverseMaxSubtreeIter(nodeCursorStack, previousCursor);
                ?currentKV
              }
            }
          }
        }
      }
    }
  };
  func initializeForwardNodeCursorStack<K, V>(internal : Internal<K, V>) : Stack.Stack<NodeCursor<K, V>> {
    let nodeCursorStack = Stack.empty<NodeCursor<K, V>>();
    let nodeCursor : NodeCursor<K, V> = {
      node = #internal(internal);
      kvIndex = 0
    };
    Stack.push(nodeCursorStack, nodeCursor);
    traverseMinSubtreeIter(nodeCursorStack, nodeCursor);
    nodeCursorStack
  };
  func initializeForwardNodeCursorStackFrom<K, V>(internal : Internal<K, V>, compare : (K, K) -> Order.Order, key : K) : Stack.Stack<NodeCursor<K, V>> {
    let nodeCursorStack = Stack.empty<NodeCursor<K, V>>();
    let nodeCursor : NodeCursor<K, V> = {
      node = #internal(internal);
      kvIndex = 0
    };
    traverseMinSubtreeIterFrom(nodeCursorStack, nodeCursor, compare, key);
    nodeCursorStack
  };
  func initializeReverseNodeCursorStack<K, V>(internal : Internal<K, V>) : Stack.Stack<NodeCursor<K, V>> {
    let nodeCursorStack = Stack.empty<NodeCursor<K, V>>();
    let nodeCursor : NodeCursor<K, V> = {
      node = #internal(internal);
      kvIndex = internal.data.count
    };
    Stack.push(nodeCursorStack, nodeCursor);
    traverseMaxSubtreeIter(nodeCursorStack, nodeCursor);
    nodeCursorStack
  };
  func initializeReverseNodeCursorStackFrom<K, V>(internal : Internal<K, V>, compare : (K, K) -> Order.Order, key : K) : Stack.Stack<NodeCursor<K, V>> {
    let nodeCursorStack = Stack.empty<NodeCursor<K, V>>();
    let nodeCursor : NodeCursor<K, V> = {
      node = #internal(internal);
      kvIndex = internal.data.count
    };
    traverseMaxSubtreeIterFrom(nodeCursorStack, nodeCursor, compare, key);
    nodeCursorStack
  };
  func traverseMinSubtreeIter<K, V>(nodeCursorStack : Stack.Stack<NodeCursor<K, V>>, nodeCursor : NodeCursor<K, V>) {
    var currentNode = nodeCursor.node;
    var childIndex = nodeCursor.kvIndex;
    label l loop {
      switch (currentNode) {
        case (#leaf(_)) {
          return
        };
        case (#internal(internalNode)) {
          switch (internalNode.children[childIndex]) {
            case (?childNode) {
              childIndex := 0;
              currentNode := childNode;
              Stack.push(
                nodeCursorStack,
                {
                  node = currentNode;
                  kvIndex = childIndex
                }
              )
            };
            case null {
              Runtime.trap("UNREACHABLE_ERROR: file a bug report! In Map.traverseMinSubtreeIter(), null child node error")
            }
          }
        }
      }
    }
  };
  func traverseMinSubtreeIterFrom<K, V>(nodeCursorStack : Stack.Stack<NodeCursor<K, V>>, nodeCursor : NodeCursor<K, V>, compare : (K, K) -> Order.Order, key : K) {
    var currentNode = nodeCursor.node;
    label l loop {
      let (node, childrenOption) = switch (currentNode) {
        case (#leaf(leafNode)) (leafNode, null);
        case (#internal(internalNode)) (internalNode, ?internalNode.children)
      };
      let (i, isFound) = switch (NodeUtil.getKeyIndex(node.data, compare, key)) {
        case (#keyFound(i)) (i, true);
        case (#notFound(i)) (i, false)
      };
      if (i < node.data.count) {
        Stack.push(
          nodeCursorStack,
          {
            node = currentNode;
            kvIndex = i  
          }
        )
      };
      if isFound return;
      let ?children = childrenOption else return;
      let ?childNode = children[i] else Runtime.trap("UNREACHABLE_ERROR: file a bug report! In Map.traverseMinSubtreeIterFrom(), null child node error");
      currentNode := childNode
    }
  };
  func traverseMaxSubtreeIter<K, V>(nodeCursorStack : Stack.Stack<NodeCursor<K, V>>, nodeCursor : NodeCursor<K, V>) {
    var currentNode = nodeCursor.node;
    var childIndex = nodeCursor.kvIndex;
    label l loop {
      switch (currentNode) {
        case (#leaf(_)) {
          return
        };
        case (#internal(internalNode)) {
          assert (childIndex <= internalNode.data.count);  
          switch (internalNode.children[childIndex]) {
            case (?childNode) {
              childIndex := switch (childNode) {
                case (#internal(internalNode)) internalNode.data.count;
                case (#leaf(leafNode)) leafNode.data.count
              };
              currentNode := childNode;
              Stack.push(
                nodeCursorStack,
                {
                  node = currentNode;
                  kvIndex = childIndex
                }
              )
            };
            case null {
              Runtime.trap("UNREACHABLE_ERROR: file a bug report! In Map.traverseMaxSubtreeIter(), null child node error")
            }
          }
        }
      }
    }
  };
  func traverseMaxSubtreeIterFrom<K, V>(nodeCursorStack : Stack.Stack<NodeCursor<K, V>>, nodeCursor : NodeCursor<K, V>, compare : (K, K) -> Order.Order, key : K) {
    var currentNode = nodeCursor.node;
    label l loop {
      let (node, childrenOption) = switch (currentNode) {
        case (#leaf(leafNode)) (leafNode, null);
        case (#internal(internalNode)) (internalNode, ?internalNode.children)
      };
      let (i, isFound) = switch (NodeUtil.getKeyIndex(node.data, compare, key)) {
        case (#keyFound(i)) (i + 1, true);  
        case (#notFound(i)) (i, false)  
      };
      if (i > 0) {
        Stack.push(
          nodeCursorStack,
          {
            node = currentNode;
            kvIndex = i
          }
        )
      };
      if isFound return;
      let ?children = childrenOption else return;
      let ?childNode = children[i] else Runtime.trap("UNREACHABLE_ERROR: file a bug report! In Map.traverseMaxSubtreeIterFrom(), null child node error");
      currentNode := childNode
    }
  };
  type IntermediateInternalDeleteResult<K, V> = {
    #delete : ?V;
    #mergeChild : {
      internalChild : Internal<K, V>;
      deletedValue : ?V
    }
  };
  func internalDeleteHelper<K, V>(internalNode : Internal<K, V>, order : Nat, compare : (K, K) -> Order.Order, deleteKey : K, skipNode : Bool) : IntermediateInternalDeleteResult<K, V> {
    let minKeys = NodeUtil.minKeysFromOrder(order);
    let keyIndex = NodeUtil.getKeyIndex(internalNode.data, compare, deleteKey);
    switch (keyIndex, skipNode) {
      case (#keyFound(deleteIndex), false) {
        let deletedValue = switch (internalNode.data.kvs[deleteIndex]) {
          case (?kv) { ?kv.1 };
          case null { assert false; null }
        };
        let replaceKV = NodeUtil.getMaxKeyValue(internalNode.children[deleteIndex]);
        internalNode.data.kvs[deleteIndex] := ?replaceKV;
        switch (internalDeleteHelper(internalNode, order, compare, replaceKV.0, true)) {
          case (#delete(_)) { #delete(deletedValue) };
          case (#mergeChild({ internalChild })) {
            #mergeChild({ internalChild; deletedValue })
          }
        }
      };
      case ((#keyFound(_), true) or (#notFound(_), _)) {
        let childIndex = switch (keyIndex) {
          case (#keyFound(replacedSkipKeyIndex)) { replacedSkipKeyIndex };
          case (#notFound(childIndex)) { childIndex }
        };
        let child = switch (internalNode.children[childIndex]) {
          case (?c) { c };
          case null {
            Runtime.trap("UNREACHABLE_ERROR: file a bug report! In Map.internalDeleteHelper, child index of #keyFound or #notfound is null")
          }
        };
        switch (child) {
          case (#internal(internalChild)) {
            switch (internalDeleteHelper(internalChild, order, compare, deleteKey, false), childIndex == 0) {
              case (#delete(v), _) { #delete(v) };
              case (#mergeChild({ internalChild; deletedValue }), true) {
                switch (NodeUtil.borrowFromInternalSibling(internalNode.children, childIndex + 1, #successor)) {
                  case (#borrowed({ deletedSiblingKVPair; child })) {
                    NodeUtil.rotateBorrowedKVsAndChildFromSibling(
                      internalNode,
                      childIndex,
                      deletedSiblingKVPair,
                      child,
                      internalChild,
                      #right
                    );
                    #delete(deletedValue)
                  };
                  case (#notEnoughKeys(sibling)) {
                    let kvPairToBePushedToChild = ?BTreeHelper.deleteAndShift(internalNode.data.kvs, 0);
                    internalNode.data.count -= 1;
                    let newChild = NodeUtil.mergeChildrenAndPushDownParent(internalChild, kvPairToBePushedToChild, sibling);
                    internalNode.children[0] := ?#internal(newChild);
                    ignore ?BTreeHelper.deleteAndShift(internalNode.children, 1);
                    if (internalNode.data.count < minKeys) {
                      #mergeChild({ internalChild = internalNode; deletedValue })
                    } else {
                      #delete(deletedValue)
                    }
                  }
                }
              };
              case (#mergeChild({ internalChild; deletedValue }), false) {
                switch (NodeUtil.borrowFromInternalSibling(internalNode.children, childIndex - 1 : Nat, #predecessor)) {
                  case (#borrowed({ deletedSiblingKVPair; child })) {
                    NodeUtil.rotateBorrowedKVsAndChildFromSibling(
                      internalNode,
                      childIndex - 1 : Nat,
                      deletedSiblingKVPair,
                      child,
                      internalChild,
                      #left
                    );
                    #delete(deletedValue)
                  };
                  case (#notEnoughKeys(leftSibling)) {
                    if (childIndex < internalNode.data.count) {
                      switch (NodeUtil.borrowFromInternalSibling(internalNode.children, childIndex, #successor)) {
                        case (#borrowed({ deletedSiblingKVPair; child })) {
                          NodeUtil.rotateBorrowedKVsAndChildFromSibling(
                            internalNode,
                            childIndex,
                            deletedSiblingKVPair,
                            child,
                            internalChild,
                            #right
                          );
                          return #delete(deletedValue)
                        };
                        case _ {}
                      }
                    };
                    let kvPairToBePushedToChild = ?BTreeHelper.deleteAndShift(internalNode.data.kvs, childIndex - 1 : Nat);
                    internalNode.data.count -= 1;
                    let newChild = NodeUtil.mergeChildrenAndPushDownParent(leftSibling, kvPairToBePushedToChild, internalChild);
                    internalNode.children[childIndex - 1] := ?#internal(newChild);
                    ignore ?BTreeHelper.deleteAndShift(internalNode.children, childIndex);
                    if (internalNode.data.count < minKeys) {
                      #mergeChild({ internalChild = internalNode; deletedValue })
                    } else {
                      #delete(deletedValue)
                    }
                  }
                }
              }
            }
          };
          case (#leaf(leafChild)) {
            switch (leafDeleteHelper(leafChild, order, compare, deleteKey), childIndex == 0) {
              case (#delete(value), _) { #delete(value) };
              case (#mergeLeafData({ leafDeleteIndex }), true) {
                switch (NodeUtil.borrowFromRightLeafChild(internalNode.children, childIndex)) {
                  case (?borrowedKVPair) {
                    let kvPairToBePushedToChild = internalNode.data.kvs[childIndex];
                    internalNode.data.kvs[childIndex] := ?borrowedKVPair;
                    let deletedKV = BTreeHelper.insertAtPostionAndDeleteAtPosition(leafChild.data.kvs, kvPairToBePushedToChild, leafChild.data.count - 1, leafDeleteIndex);
                    #delete(?deletedKV.1)
                  };
                  case null {
                    let rightChild = switch (internalNode.children[childIndex + 1]) {
                      case (?#leaf(rc)) { rc };
                      case _ {
                        Runtime.trap("UNREACHABLE_ERROR: file a bug report! In Map.internalDeleteHelper, if trying to borrow from right leaf child is null, rightChild index cannot be null or internal")
                      }
                    };
                    let (mergedLeaf, deletedKV) = mergeParentWithLeftRightChildLeafNodesAndDelete(
                      internalNode.data.kvs[childIndex],
                      leafChild,
                      rightChild,
                      leafDeleteIndex,
                      #left
                    );
                    ignore BTreeHelper.deleteAndShift<(K, V)>(internalNode.data.kvs, 0);
                    BTreeHelper.replaceTwoWithElementAndShift<Node<K, V>>(internalNode.children, #leaf(mergedLeaf), 0);
                    internalNode.data.count -= 1;
                    if (internalNode.data.count < minKeys) {
                      #mergeChild({
                        internalChild = internalNode;
                        deletedValue = ?deletedKV.1
                      })
                    } else {
                      #delete(?deletedKV.1)
                    }
                  }
                }
              };
              case (#mergeLeafData({ leafDeleteIndex }), false) {
                switch (NodeUtil.borrowFromLeftLeafChild(internalNode.children, childIndex)) {
                  case (?borrowedKVPair) {
                    let kvPairToBePushedToChild = internalNode.data.kvs[childIndex - 1];
                    internalNode.data.kvs[childIndex - 1] := ?borrowedKVPair;
                    let kvDelete = BTreeHelper.insertAtPostionAndDeleteAtPosition(leafChild.data.kvs, kvPairToBePushedToChild, 0, leafDeleteIndex);
                    #delete(?kvDelete.1)
                  };
                  case null {
                    if (childIndex < internalNode.data.count) {
                      switch (NodeUtil.borrowFromRightLeafChild(internalNode.children, childIndex)) {
                        case (?borrowedKVPair) {
                          let kvPairToBePushedToChild = internalNode.data.kvs[childIndex];
                          internalNode.data.kvs[childIndex] := ?borrowedKVPair;
                          let kvDelete = BTreeHelper.insertAtPostionAndDeleteAtPosition(leafChild.data.kvs, kvPairToBePushedToChild, leafChild.data.count - 1, leafDeleteIndex);
                          return #delete(?kvDelete.1)
                        };
                        case _ {}
                      }
                    };
                    let leftChild = switch (internalNode.children[childIndex - 1]) {
                      case (?#leaf(lc)) { lc };
                      case _ {
                        Runtime.trap("UNREACHABLE_ERROR: file a bug report! In Map.internalDeleteHelper, if trying to borrow from left leaf child is null, then left child index must not be null or internal")
                      }
                    };
                    let (mergedLeaf, deletedKV) = mergeParentWithLeftRightChildLeafNodesAndDelete(
                      internalNode.data.kvs[childIndex - 1],
                      leftChild,
                      leafChild,
                      leafDeleteIndex,
                      #right
                    );
                    ignore BTreeHelper.deleteAndShift<(K, V)>(internalNode.data.kvs, childIndex - 1);
                    BTreeHelper.replaceTwoWithElementAndShift<Node<K, V>>(internalNode.children, #leaf(mergedLeaf), childIndex - 1);
                    internalNode.data.count -= 1;
                    if (internalNode.data.count < minKeys) {
                      #mergeChild({
                        internalChild = internalNode;
                        deletedValue = ?deletedKV.1
                      })
                    } else {
                      #delete(?deletedKV.1)
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  };
  type IntermediateLeafDeleteResult<K, V> = {
    #delete : ?V;
    #mergeLeafData : {
      data : Data<K, V>;
      leafDeleteIndex : Nat
    }
  };
  func leafDeleteHelper<K, V>(leafNode : Leaf<K, V>, order : Nat, compare : (K, K) -> Order.Order, deleteKey : K) : IntermediateLeafDeleteResult<K, V> {
    let minKeys = NodeUtil.minKeysFromOrder(order);
    switch (NodeUtil.getKeyIndex<K, V>(leafNode.data, compare, deleteKey)) {
      case (#keyFound(deleteIndex)) {
        if (leafNode.data.count > minKeys) {
          leafNode.data.count -= 1;
          #delete(?BTreeHelper.deleteAndShift<(K, V)>(leafNode.data.kvs, deleteIndex).1)
        } else {
          #mergeLeafData({
            data = leafNode.data;
            leafDeleteIndex = deleteIndex
          })
        }
      };
      case (#notFound(_)) {
        #delete(null)
      }
    }
  };
  func getFromInternal<K, V>(internalNode : Internal<K, V>, compare : (K, K) -> Order.Order, key : K) : ?V {
    switch (NodeUtil.getKeyIndex<K, V>(internalNode.data, compare, key)) {
      case (#keyFound(index)) {
        getExistingValueFromIndex(internalNode.data, index)
      };
      case (#notFound(index)) {
        switch (internalNode.children[index]) {
          case null { Runtime.trap("Internal bug: Map.getFromInternal") };
          case (?#leaf(leafNode)) { getFromLeaf(leafNode, compare, key) };
          case (?#internal(internalNode)) {
            getFromInternal(internalNode, compare, key)
          }
        }
      }
    }
  };
  func getFromLeaf<K, V>(leafNode : Leaf<K, V>, compare : (K, K) -> Order.Order, key : K) : ?V {
    switch (NodeUtil.getKeyIndex<K, V>(leafNode.data, compare, key)) {
      case (#keyFound(index)) {
        getExistingValueFromIndex(leafNode.data, index)
      };
      case _ null
    }
  };
  func getExistingValueFromIndex<K, V>(data : Data<K, V>, index : Nat) : ?V {
    switch (data.kvs[index]) {
      case null { null };
      case (?ov) { ?ov.1 }
    }
  };
  type DeletionSide = { #left; #right };
  func mergeParentWithLeftRightChildLeafNodesAndDelete<K, V>(
    parentKV : ?(K, V),
    leftChild : Leaf<K, V>,
    rightChild : Leaf<K, V>,
    deleteIndex : Nat,
    deletionSide : DeletionSide
  ) : (Leaf<K, V>, (K, V)) {
    let count = leftChild.data.count * 2;
    let (kvs, deletedKV) = BTreeHelper.mergeParentWithChildrenAndDelete(
      parentKV,
      leftChild.data.count,
      leftChild.data.kvs,
      rightChild.data.kvs,
      deleteIndex,
      deletionSide
    );
    (
      {
        data = {
          kvs;
          var count = count
        }
      },
      deletedKV
    )
  };
  type IntermediateInsertResult<K, V> = {
    #insert : ?V;
    #promote : {
      kv : (K, V);
      leftChild : Node<K, V>;
      rightChild : Node<K, V>
    }
  };
  func leafInsertHelper<K, V>(leafNode : Leaf<K, V>, order : Nat, compare : (K, K) -> Order.Order, key : K, value : V) : (IntermediateInsertResult<K, V>) {
    switch (NodeUtil.getKeyIndex<K, V>(leafNode.data, compare, key)) {
      case (#keyFound(insertIndex)) {
        let previous = leafNode.data.kvs[insertIndex];
        leafNode.data.kvs[insertIndex] := ?(key, value);
        switch (previous) {
          case (?ov) { #insert(?ov.1) };
          case null { assert false; #insert(null) };  
        }
      };
      case (#notFound(insertIndex)) {
        let maxKeys : Nat = order - 1;
        if (leafNode.data.count >= maxKeys) {
          let (leftKVs, promotedParentElement, rightKVs) = BTreeHelper.insertOneAtIndexAndSplitArray(
            leafNode.data.kvs,
            (key, value),
            insertIndex
          );
          let leftCount = order / 2;
          let rightCount : Nat = if (order % 2 == 0) { leftCount - 1 } else {
            leftCount
          };
          (
            #promote({
              kv = promotedParentElement;
              leftChild = createLeaf<K, V>(leftKVs, leftCount);
              rightChild = createLeaf<K, V>(rightKVs, rightCount)
            })
          )
        }
        else {
          NodeUtil.insertAtIndexOfNonFullNodeData<K, V>(leafNode.data, ?(key, value), insertIndex);
          #insert(null)
        }
      }
    }
  };
  func internalInsertHelper<K, V>(internalNode : Internal<K, V>, order : Nat, compare : (K, K) -> Order.Order, key : K, value : V) : IntermediateInsertResult<K, V> {
    switch (NodeUtil.getKeyIndex<K, V>(internalNode.data, compare, key)) {
      case (#keyFound(insertIndex)) {
        let previous = internalNode.data.kvs[insertIndex];
        internalNode.data.kvs[insertIndex] := ?(key, value);
        switch (previous) {
          case (?ov) { #insert(?ov.1) };
          case null { assert false; #insert(null) };  
        }
      };
      case (#notFound(insertIndex)) {
        let insertResult = switch (internalNode.children[insertIndex]) {
          case null { assert false; #insert(null) };
          case (?#leaf(leafNode)) {
            leafInsertHelper(leafNode, order, compare, key, value)
          };
          case (?#internal(internalChildNode)) {
            internalInsertHelper(internalChildNode, order, compare, key, value)
          }
        };
        switch (insertResult) {
          case (#insert(ov)) { #insert(ov) };
          case (#promote({ kv; leftChild; rightChild })) {
            let maxKeys : Nat = order - 1;
            if (internalNode.data.count >= maxKeys) {
              let (leftKVs, promotedParentElement, rightKVs) = BTreeHelper.insertOneAtIndexAndSplitArray(
                internalNode.data.kvs,
                (kv),
                insertIndex
              );
              let leftCount = order / 2;
              let rightCount : Nat = if (order % 2 == 0) { leftCount - 1 } else {
                leftCount
              };
              let (leftChildren, rightChildren) = NodeUtil.splitChildrenInTwoWithRebalances(
                internalNode.children,
                insertIndex,
                leftChild,
                rightChild
              );
              #promote({
                kv = promotedParentElement;
                leftChild = #internal({
                  data = { kvs = leftKVs; var count = leftCount };
                  children = leftChildren
                });
                rightChild = #internal({
                  data = { kvs = rightKVs; var count = rightCount };
                  children = rightChildren
                })
              })
            } else {
              NodeUtil.insertAtIndexOfNonFullNodeData(internalNode.data, ?kv, insertIndex);
              NodeUtil.insertRebalancedChild(internalNode.children, insertIndex, leftChild, rightChild);
              #insert(null)
            }
          }
        }
      }
    }
  };
  func createLeaf<K, V>(kvs : [var ?(K, V)], count : Nat) : Node<K, V> {
    #leaf({
      data = {
        kvs;
        var count
      }
    })
  };
  func mapData<K, V1, V2>(data : Data<K, V1>, project : (K, V1) -> V2) : Data<K, V2> {
    {
      kvs = VarArray.map<?(K, V1), ?(K, V2)>(
        data.kvs,
        func entry {
          switch entry {
            case (?kv) ?(kv.0, project kv);
            case null null
          }
        }
      );
      var count = data.count
    }
  };
  func mapNode<K, V1, V2>(node : Node<K, V1>, project : (K, V1) -> V2) : Node<K, V2> {
    switch node {
      case (#leaf { data }) {
        #leaf { data = mapData(data, project) }
      };
      case (#internal { data; children }) {
        let mappedData = mapData(data, project);
        let mappedChildren = VarArray.map<?Node<K, V1>, ?Node<K, V2>>(
          children,
          func child {
            switch child {
              case null null;
              case (?childNode) ?mapNode(childNode, project)
            }
          }
        );
        # internal({
          data = mappedData;
          children = mappedChildren
        })
      }
    }
  };
  func cloneNode<K, V>(node : Node<K, V>) : Node<K, V> = mapNode<K, V, V>(node, func(k, v) = v);
  module BinarySearch {
    public type SearchResult = {
      #keyFound : Nat;
      #notFound : Nat
    };
    public func binarySearchNode<K, V>(array : [var ?(K, V)], compare : (implicit : (K, K) -> Order.Order), searchKey : K, maxIndex : Nat) : SearchResult {
      if (array.size() == 0) {
        assert false
      };
      if (maxIndex == 0) {
        return #notFound(0)
      };
      var left : Nat = 0;
      var right = maxIndex;  
      while (left < right) {
        let middle = (left + right) / 2;
        switch (array[middle]) {
          case null { assert false };
          case (?(key, _)) {
            switch (compare(searchKey, key)) {
              case (#equal) { return #keyFound(middle) };
              case (#greater) { left := middle + 1 };
              case (#less) {
                right := if (middle == 0) { 0 } else { middle - 1 }
              }
            }
          }
        }
      };
      if (left == array.size()) {
        return #notFound(left)
      };
      switch (array[left]) {
        case null { #notFound(left) };
        case (?(key, _)) {
          switch (compare(searchKey, key)) {
            case (#equal) { #keyFound(left) };
            case (#greater) { #notFound(left + 1) };
            case (#less) { #notFound(left) }
          }
        }
      }
    }
  };
  module NodeUtil {
    public func insertAtIndexOfNonFullNodeData<K, V>(data : Data<K, V>, kvPair : ?(K, V), insertIndex : Nat) {
      let currentLastElementIndex : Nat = if (data.count == 0) { 0 } else {
        data.count - 1
      };
      BTreeHelper.insertAtPosition<(K, V)>(data.kvs, kvPair, insertIndex, currentLastElementIndex);
      data.count += 1
    };
    public func insertRebalancedChild<K, V>(children : [var ?Node<K, V>], rebalancedChildIndex : Nat, leftChildInsert : Node<K, V>, rightChildInsert : Node<K, V>) {
      var j : Nat = children.size() - 2;
      if (Option.isSome(children[j + 1])) { assert false };
      while (j > rebalancedChildIndex) {
        children[j + 1] := children[j];
        j -= 1
      };
      children[j] := ?leftChildInsert;
      children[j + 1] := ?rightChildInsert
    };
    public func splitChildrenInTwoWithRebalances<K, V>(
      children : [var ?Node<K, V>],
      rebalancedChildIndex : Nat,
      leftChildInsert : Node<K, V>,
      rightChildInsert : Node<K, V>
    ) : ([var ?Node<K, V>], [var ?Node<K, V>]) {
      BTreeHelper.splitArrayAndInsertTwo<Node<K, V>>(children, rebalancedChildIndex, leftChildInsert, rightChildInsert)
    };
    public func getKeyIndex<K, V>(data : Data<K, V>, compare : (K, K) -> Order.Order, key : K) : BinarySearch.SearchResult {
      BinarySearch.binarySearchNode<K, V>(data.kvs, compare, key, data.count)
    };
    public func minKeysFromOrder(order : Nat) : Nat {
      if (order % 2 == 0) { order / 2 - 1 } else { order / 2 }
    };
    public func getMaxKeyValue<K, V>(node : ?Node<K, V>) : (K, V) {
      switch (node) {
        case (?#leaf({ data })) {
          switch (data.kvs[data.count - 1]) {
            case null {
              Runtime.trap("UNREACHABLE_ERROR: file a bug report! In Map.NodeUtil.getMaxKeyValue, data cannot have more elements than it's count")
            };
            case (?kv) { kv }
          }
        };
        case (?#internal({ data; children })) {
          getMaxKeyValue(children[data.count])
        };
        case null {
          Runtime.trap("UNREACHABLE_ERROR: file a bug report! In Map.NodeUtil.getMaxKeyValue, the node provided cannot be null")
        }
      }
    };
    type InorderBorrowType = {
      #predecessor;
      #successor
    };
    public func borrowFromLeftLeafChild<K, V>(children : [var ?Node<K, V>], ofChildIndex : Nat) : ?(K, V) {
      let predecessorIndex : Nat = ofChildIndex - 1;
      borrowFromLeafChild(children, predecessorIndex, #predecessor)
    };
    public func borrowFromRightLeafChild<K, V>(children : [var ?Node<K, V>], ofChildIndex : Nat) : ?(K, V) {
      borrowFromLeafChild(children, ofChildIndex + 1, #successor)
    };
    func borrowFromLeafChild<K, V>(children : [var ?Node<K, V>], borrowChildIndex : Nat, childSide : InorderBorrowType) : ?(K, V) {
      let minKeys = minKeysFromOrder(children.size());
      switch (children[borrowChildIndex]) {
        case (?#leaf({ data })) {
          if (data.count > minKeys) {
            data.count -= 1;  
            switch (childSide) {
              case (#predecessor) {
                let deletedKV = data.kvs[data.count];
                data.kvs[data.count] := null;
                deletedKV
              };
              case (#successor) {
                ?BTreeHelper.deleteAndShift(data.kvs, 0)
              }
            }
          } else { null }
        };
        case _ {
          Runtime.trap("UNREACHABLE_ERROR: file a bug report! In Map.NodeUtil.borrowFromLeafChild, the node at the borrow child index cannot be null or internal")
        }
      }
    };
    type InternalBorrowResult<K, V> = {
      #borrowed : InternalBorrow<K, V>;
      #notEnoughKeys : Internal<K, V>
    };
    type InternalBorrow<K, V> = {
      deletedSiblingKVPair : ?(K, V);
      child : ?Node<K, V>
    };
    public func borrowFromInternalSibling<K, V>(children : [var ?Node<K, V>], borrowChildIndex : Nat, borrowType : InorderBorrowType) : InternalBorrowResult<K, V> {
      let minKeys = minKeysFromOrder(children.size());
      switch (children[borrowChildIndex]) {
        case (?#internal({ data; children })) {
          if (data.count > minKeys) {
            data.count -= 1;
            switch (borrowType) {
              case (#predecessor) {
                let deletedSiblingKVPair = data.kvs[data.count];
                data.kvs[data.count] := null;
                let child = children[data.count + 1];
                children[data.count + 1] := null;
                #borrowed({
                  deletedSiblingKVPair;
                  child
                })
              };
              case (#successor) {
                #borrowed({
                  deletedSiblingKVPair = ?BTreeHelper.deleteAndShift(data.kvs, 0);
                  child = ?BTreeHelper.deleteAndShift(children, 0)
                })
              }
            }
          } else { #notEnoughKeys({ data; children }) }
        };
        case _ {
          Runtime.trap("UNREACHABLE_ERROR: file a bug report! In Map.NodeUtil.borrowFromInternalSibling from internal sibling, the child at the borrow index cannot be null or a leaf")
        }
      }
    };
    type SiblingSide = { #left; #right };
    public func rotateBorrowedKVsAndChildFromSibling<K, V>(
      internalNode : Internal<K, V>,
      parentRotateIndex : Nat,
      borrowedSiblingKVPair : ?(K, V),
      borrowedSiblingChild : ?Node<K, V>,
      internalChildRecipient : Internal<K, V>,
      siblingSide : SiblingSide
    ) {
      let (kvIndex, childIndex) = switch (siblingSide) {
        case (#left) { (0, 0) };
        case (#right) {
          (internalChildRecipient.data.count, internalChildRecipient.data.count + 1)
        }
      };
      let kvPairToBePushedToChild = internalNode.data.kvs[parentRotateIndex];
      internalNode.data.kvs[parentRotateIndex] := borrowedSiblingKVPair;
      insertAtIndexOfNonFullNodeData<K, V>(internalChildRecipient.data, kvPairToBePushedToChild, kvIndex);
      BTreeHelper.insertAtPosition<Node<K, V>>(internalChildRecipient.children, borrowedSiblingChild, childIndex, internalChildRecipient.data.count)
    };
    public func mergeChildrenAndPushDownParent<K, V>(leftChild : Internal<K, V>, parentKV : ?(K, V), rightChild : Internal<K, V>) : Internal<K, V> {
      {
        data = mergeData<K, V>(leftChild.data, parentKV, rightChild.data);
        children = mergeChildren(leftChild.children, rightChild.children)
      }
    };
    func mergeData<K, V>(leftData : Data<K, V>, parentKV : ?(K, V), rightData : Data<K, V>) : Data<K, V> {
      assert leftData.count <= minKeysFromOrder(leftData.kvs.size() + 1);
      assert rightData.count <= minKeysFromOrder(rightData.kvs.size() + 1);
      let mergedKVs = VarArray.repeat<?(K, V)>(null, leftData.kvs.size());
      var i = 0;
      while (i < leftData.count) {
        mergedKVs[i] := leftData.kvs[i];
        i += 1
      };
      mergedKVs[i] := parentKV;
      i += 1;
      var j = 0;
      while (j < rightData.count) {
        mergedKVs[i] := rightData.kvs[j];
        i += 1;
        j += 1
      };
      {
        kvs = mergedKVs;
        var count = leftData.count + 1 + rightData.count
      }
    };
    func mergeChildren<K, V>(leftChildren : [var ?Node<K, V>], rightChildren : [var ?Node<K, V>]) : [var ?Node<K, V>] {
      let mergedChildren = VarArray.repeat<?Node<K, V>>(null, leftChildren.size());
      var i = 0;
      while (Option.isSome(leftChildren[i])) {
        mergedChildren[i] := leftChildren[i];
        i += 1
      };
      var j = 0;
      while (Option.isSome(rightChildren[j])) {
        mergedChildren[i] := rightChildren[j];
        i += 1;
        j += 1
      };
      mergedChildren
    }
  }
}
