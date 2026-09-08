import VarArray "1ae38af22bbd20d80bd4bb2c276075935a1c9069b03d6773928b247616e48193";
import Runtime "ccb23e2d72bb4ab9edc842d7dc106d708734b3a441117e4a7816067209391eac";
module {
  public func insertAtPosition<T>(array : [var ?T], insertElement : ?T, insertIndex : Nat, currentLastElementIndex : Nat) {
    if (insertIndex == currentLastElementIndex + 1) {
      array[insertIndex] := insertElement;
      return
    };
    var j = currentLastElementIndex;
    label l loop {
      array[j + 1] := array[j];
      if (j == insertIndex) {
        array[j] := insertElement;
        break l
      };
      j -= 1
    }
  };
  public func insertOneAtIndexAndSplitArray<T>(array : [var ?T], insertElement : T, insertIndex : Nat) : ([var ?T], T, [var ?T]) {
    let splitIndex = (array.size() + 1) / 2;
    if (splitIndex > array.size()) { assert false };
    let leftSplit = if (insertIndex < splitIndex) {
      VarArray.tabulate(
        array.size(),
        func(i) {
          if (i < splitIndex) {
            if (i < insertIndex) { array[i] }
            else if (i > insertIndex) { array[i - 1] }
            else { ?insertElement }
          } else { null }
        }
      )
    }
    else {
      VarArray.tabulate(
        array.size(),
        func(i) {
          if (i < splitIndex) { array[i] } else { null }
        }
      )
    };
    let (rightSplit, middleElement) : ([var ?T], ?T) =
    if (insertIndex > splitIndex) {
      let right = VarArray.tabulate(
        array.size(),
        func(i) {
          let adjIndex = i + splitIndex + 1;  
          if (adjIndex <= array.size()) {
            if (adjIndex < insertIndex) { array[adjIndex] } else if (adjIndex > insertIndex) {
              array[adjIndex - 1]
            } else { ?insertElement }
          } else { null }
        }
      );
      (right, array[splitIndex])
    }
    else if (insertIndex < splitIndex) {
      let right = VarArray.tabulate(
        array.size(),
        func(i) {
          let adjIndex = i + splitIndex;
          if (adjIndex < array.size()) { array[adjIndex] } else { null }
        }
      );
      (right, array[splitIndex - 1])
    }
    else {
      let right = VarArray.tabulate(
        array.size(),
        func(i) {
          let adjIndex = i + splitIndex;
          if (adjIndex < array.size()) { array[adjIndex] } else { null }
        }
      );
      (right, ?insertElement)
    };
    switch (middleElement) {
      case null {
        Runtime.trap("UNREACHABLE_ERROR: file a bug report! In internal/BTreeHelper: insertOneAtIndexAndSplitArray, middle element of a BTree node should never be null")
      };
      case (?el) { (leftSplit, el, rightSplit) }
    }
  };
  public func splitArrayAndInsertTwo<T>(children : [var ?T], rebalancedChildIndex : Nat, leftChildInsert : T, rightChildInsert : T) : ([var ?T], [var ?T]) {
    let splitIndex = children.size() / 2;
    let leftRebalancedChildren = VarArray.tabulate(
      children.size(),
      func(i) {
        if (i <= splitIndex) {
          if (i < rebalancedChildIndex) { children[i] }
          else if (i == rebalancedChildIndex) {
            ?leftChildInsert
          } else if (i == rebalancedChildIndex + 1) { ?rightChildInsert } else {
            children[i - 1]
          }  
        } else { null }
      }
    );
    let rightRebalanceChildren : [var ?T] =
    if (rebalancedChildIndex + 1 <= splitIndex) {
      VarArray.tabulate<?T>(
        children.size(),
        func(i) {
          let adjIndex = i + splitIndex;
          if (adjIndex < children.size()) { children[adjIndex] } else { null }
        }
      )
    }
    else if (rebalancedChildIndex > splitIndex) {
      var rebalanceOffset = 0;
      VarArray.tabulate<?T>(
        children.size(),
        func(i) {
          let adjIndex = i + splitIndex + 1;
          if (adjIndex == rebalancedChildIndex) { ?leftChildInsert } else if (adjIndex == rebalancedChildIndex + 1) {
            rebalanceOffset := 1;  
            ?rightChildInsert
          } else if (adjIndex <= children.size()) {
            children[adjIndex - rebalanceOffset]
          } else { null }
        }
      )
    }
    else {
      VarArray.tabulate<?T>(
        children.size(),
        func(i) {
          if (i == 0) { ?rightChildInsert } else {
            let adjIndex = i + splitIndex;
            if (adjIndex < children.size()) { children[adjIndex] } else {
              null
            }
          }
        }
      )
    };
    (leftRebalancedChildren, rightRebalanceChildren)
  };
  public func deleteAndShift<T>(array : [var ?T], deleteIndex : Nat) : T {
    var deleted : T = switch (array[deleteIndex]) {
      case null {
        Runtime.trap("UNREACHABLE_ERROR: file a bug report! In internal/BTreeHelper: deleteAndShift, an invalid/incorrect delete index was passed")
      };
      case (?el) { el }
    };
    array[deleteIndex] := null;
    var i = deleteIndex + 1;
    label l loop {
      if (i >= array.size()) { break l };
      switch (array[i]) {
        case null { break l };
        case (?_) {
          array[i - 1] := array[i]
        }
      };
      i += 1
    };
    array[i - 1] := null;
    deleted
  };
  public func replaceTwoWithElementAndShift<T>(array : [var ?T], element : T, replaceIndex : Nat) {
    array[replaceIndex] := ?element;
    var i = replaceIndex + 1;
    let endShiftIndex : Nat = array.size() - 1;
    while (i < endShiftIndex) {
      switch (array[i]) {
        case (?_) { array[i] := array[i + 1] };
        case null { return }
      };
      i += 1
    };
    array[endShiftIndex] := null
  };
  public func insertAtPostionAndDeleteAtPosition<T>(array : [var ?T], insertElement : ?T, insertIndex : Nat, deleteIndex : Nat) : T {
    var deleted : T = switch (array[deleteIndex]) {
      case null {
        Runtime.trap("UNREACHABLE_ERROR: file a bug report! In internal/BTreeHelper: insertAtPositionAndDeleteAtPosition, and incorrect delete index was passed")
      };  
      case (?el) { el }
    };
    if (insertIndex < deleteIndex) {
      var i = deleteIndex;
      while (i > insertIndex) {
        array[i] := array[i - 1];
        i -= 1
      };
      array[insertIndex] := insertElement
    }
    else if (insertIndex > deleteIndex) {
      array[deleteIndex] := null;
      var i = deleteIndex + 1;
      label l loop {
        if (i >= array.size()) { assert false; break l };  
        if (i == insertIndex) {
          array[i - 1] := array[i];
          array[i] := insertElement;
          break l
        } else {
          array[i - 1] := array[i]
        };
        i += 1
      };
    }
    else { array[deleteIndex] := insertElement };
    deleted
  };
  public type DeletionSide = { #left; #right };
  public func mergeParentWithChildrenAndDelete<T>(
    parentElement : ?T,
    childCount : Nat,
    leftChild : [var ?T],
    rightChild : [var ?T],
    deleteIndex : Nat,
    deletionSide : DeletionSide
  ) : ([var ?T], T) {
    let mergedArray = VarArray.repeat<?T>(null, leftChild.size());
    var i = 0;
    switch (deletionSide) {
      case (#left) {
        let deletedElement = switch (leftChild[deleteIndex]) {
          case (?el) { el };
          case null {
            Runtime.trap("UNREACHABLE_ERROR: file a bug report! In internal/BTreeHelper: mergeParentWithChildrenAndDelete, an invalid delete index was passed")
          }
        };
        while (i < childCount) {
          if (i < deleteIndex) {
            mergedArray[i] := leftChild[i]
          } else {
            mergedArray[i] := leftChild[i + 1]
          };
          i += 1
        };
        mergedArray[childCount - 1] := parentElement;
        while (i < childCount * 2) {
          mergedArray[i] := rightChild[i - childCount];
          i += 1
        };
        (mergedArray, deletedElement)
      };
      case (#right) {
        let deletedElement = switch (rightChild[deleteIndex]) {
          case (?el) { el };
          case null {
            Runtime.trap("UNREACHABLE_ERROR: file a bug report! In internal/BTreeHelper: mergeParentWithChildrenAndDelete: element at deleted index must exist")
          }
        };
        while (i < childCount) {
          mergedArray[i] := leftChild[i];
          i += 1
        };
        mergedArray[childCount] := parentElement;
        i += 1;
        var j = 0;
        while (i < childCount * 2) {
          if (j < deleteIndex) {
            mergedArray[i] := rightChild[j]
          } else {
            mergedArray[i] := rightChild[j + 1]
          };
          i += 1;
          j += 1
        };
        (mergedArray, deletedElement)
      }
    }
  };
}
