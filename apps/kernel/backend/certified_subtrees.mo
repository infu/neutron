import MerkleTree "mo:ic-certification/MerkleTree";
import Dyadic "mo:ic-certification/Dyadic";
import Blob "mo:core/Blob";
import Iter "mo:core/Iter";
import Nat8 "mo:core/Nat8";
import SHA256 "mo:sha2/Sha256";

// The upstream MerkleTree exposes its persistent structural type but no
// subtree take/graft operation. Certified Assets needs those two operations
// to detach and reattach a complete mount in logarithmic work. These smart
// constructors mirror the pinned ic-certification 1.1.0 implementation exactly
// so the resulting root and witnesses remain byte-identical.
module {
  public type Tree = MerkleTree.Tree;
  public type Path = MerkleTree.Path;

  type Hash = Blob;
  type Key = Blob;
  type Value = Blob;
  type Prefix = [Nat8];
  type Leaf = { value : Value; leaf_hash : Hash };
  type LabeledTree = {
    #leaf : Leaf;
    #subtree : ?T;
  };
  type T = {
    #fork : {
      interval : Dyadic.Interval;
      hash : Hash;
      left : T;
      right : T;
    };
    #prefix : {
      key : Key;
      prefix : Prefix;
      here : LabeledTree;
      labeled_hash : Hash;
      rest : ?T;
      tree_hash : Hash;
    };
  };

  func hashBlob(value : Blob) : Hash {
    SHA256.fromBlob(#sha256, value);
  };

  func hashThree(first : Blob, second : Blob, third : Blob) : Hash {
    let digest = SHA256.Digest(#sha256);
    digest.writeBlob(first);
    digest.writeBlob(second);
    digest.writeBlob(third);
    digest.sum();
  };

  func hashEmpty() : Hash {
    hashBlob("\11ic-hashtree-empty");
  };

  func hashLabeled(labelValue : Key, subtreeHash : Hash) : Hash {
    hashThree("\13ic-hashtree-labeled", labelValue, subtreeHash);
  };

  func hashFork(left : Hash, right : Hash) : Hash {
    hashThree("\10ic-hashtree-fork", left, right);
  };

  func labeledTreeHash(tree : LabeledTree) : Hash {
    switch (tree) {
      case (#leaf(leaf)) leaf.leaf_hash;
      case (#subtree(tree)) hashOptionalTree(tree);
    };
  };

  func hashOptionalTree(tree : ?T) : Hash {
    switch (tree) {
      case null hashEmpty();
      case (?value) hashTree(value);
    };
  };

  func hashTree(tree : T) : Hash {
    switch (tree) {
      case (#fork(fork)) fork.hash;
      case (#prefix(prefix)) prefix.tree_hash;
    };
  };

  func interval(tree : T) : Dyadic.Interval {
    switch (tree) {
      case (#fork(fork)) fork.interval;
      case (#prefix(prefix)) Dyadic.singleton(prefix.prefix);
    };
  };

  func makePrefix(
    key : Key,
    prefix : Prefix,
    here : LabeledTree,
    rest : ?T,
  ) : ?T {
    switch (here) {
      case (#subtree(null)) return rest;
      case _ {};
    };
    let labeledHash = hashLabeled(key, labeledTreeHash(here));
    let treeHash = switch (rest) {
      case null labeledHash;
      case (?value) hashFork(labeledHash, hashTree(value));
    };
    ?#prefix({
      key;
      prefix;
      here;
      labeled_hash = labeledHash;
      rest;
      tree_hash = treeHash;
    });
  };

  func makeLabel(
    key : Key,
    prefix : Prefix,
    here : LabeledTree,
  ) : ?T {
    makePrefix(key, prefix, here, null);
  };

  func makeFork(
    intervalValue : Dyadic.Interval,
    left : ?T,
    right : ?T,
  ) : ?T {
    switch (left) {
      case null right;
      case (?leftValue) {
        switch (right) {
          case null left;
          case (?rightValue) {
            ?#fork({
              interval = intervalValue;
              hash = hashFork(
                hashTree(leftValue),
                hashTree(rightValue),
              );
              left = leftValue;
              right = rightValue;
            });
          };
        };
      };
    };
  };

  func modifyLabeledTree(
    tree : LabeledTree,
    key : Key,
    transform : LabeledTree -> LabeledTree,
  ) : LabeledTree {
    let optionalTree = switch (tree) {
      case (#leaf(_)) null;
      case (#subtree(value)) value;
    };
    #subtree(modifyOptionalTree(
      optionalTree,
      key,
      Blob.toArray(key),
      transform,
    ));
  };

  func modifyOptionalTree(
    tree : ?T,
    key : Key,
    prefix : Prefix,
    transform : LabeledTree -> LabeledTree,
  ) : ?T {
    switch (tree) {
      case null {
        makeLabel(key, prefix, transform(#subtree(null)));
      };
      case (?value) modifyTree(value, key, prefix, transform);
    };
  };

  func modifyTree(
    tree : T,
    key : Key,
    prefix : Prefix,
    transform : LabeledTree -> LabeledTree,
  ) : ?T {
    switch (Dyadic.find(prefix, interval(tree))) {
      case (#before(common)) {
        makeFork(
          Dyadic.mk(prefix, common),
          makeLabel(key, prefix, transform(#subtree(null))),
          ?tree,
        );
      };
      case (#after(common)) {
        makeFork(
          Dyadic.mk(prefix, common),
          ?tree,
          makeLabel(key, prefix, transform(#subtree(null))),
        );
      };
      case (#needle_is_prefix) {
        makePrefix(
          key,
          prefix,
          transform(#subtree(null)),
          ?tree,
        );
      };
      case (#equal) modifyHere(tree, key, prefix, transform);
      case (#in_left_half) {
        modifyLeft(tree, key, prefix, transform);
      };
      case (#in_right_half) {
        modifyRight(tree, key, prefix, transform);
      };
    };
  };

  func modifyHere(
    tree : T,
    key : Key,
    prefix : Prefix,
    transform : LabeledTree -> LabeledTree,
  ) : ?T {
    switch (tree) {
      case (#prefix(node)) {
        makePrefix(
          key,
          prefix,
          transform(node.here),
          node.rest,
        );
      };
      case (#fork(_)) {
        makePrefix(
          key,
          prefix,
          transform(#subtree(null)),
          ?tree,
        );
      };
    };
  };

  func modifyLeft(
    tree : T,
    key : Key,
    prefix : Prefix,
    transform : LabeledTree -> LabeledTree,
  ) : ?T {
    switch (tree) {
      case (#fork(fork)) {
        makeFork(
          fork.interval,
          modifyTree(fork.left, key, prefix, transform),
          ?fork.right,
        );
      };
      case (#prefix(node)) {
        makePrefix(
          node.key,
          node.prefix,
          node.here,
          modifyOptionalTree(node.rest, key, prefix, transform),
        );
      };
    };
  };

  func modifyRight(
    tree : T,
    key : Key,
    prefix : Prefix,
    transform : LabeledTree -> LabeledTree,
  ) : ?T {
    switch (tree) {
      case (#fork(fork)) {
        makeFork(
          fork.interval,
          ?fork.left,
          modifyTree(fork.right, key, prefix, transform),
        );
      };
      case (#prefix(node)) {
        makePrefix(
          node.key,
          node.prefix,
          node.here,
          modifyOptionalTree(node.rest, key, prefix, transform),
        );
      };
    };
  };

  func lookupLabeledTree(
    tree : LabeledTree,
    prefix : Prefix,
  ) : LabeledTree {
    switch (tree) {
      case (#leaf(_)) #subtree(null);
      case (#subtree(value)) lookupOptionalTree(value, prefix);
    };
  };

  func lookupOptionalTree(
    tree : ?T,
    prefix : Prefix,
  ) : LabeledTree {
    switch (tree) {
      case null #subtree(null);
      case (?value) lookupTree(value, prefix);
    };
  };

  func lookupTree(tree : T, prefix : Prefix) : LabeledTree {
    switch (Dyadic.find(prefix, interval(tree))) {
      case (#before(_)) #subtree(null);
      case (#after(_)) #subtree(null);
      case (#needle_is_prefix) #subtree(null);
      case (#equal) {
        switch (tree) {
          case (#fork(_)) #subtree(null);
          case (#prefix(node)) node.here;
        };
      };
      case (#in_left_half) {
        switch (tree) {
          case (#fork(fork)) lookupTree(fork.left, prefix);
          case (#prefix(node)) {
            lookupOptionalTree(node.rest, prefix);
          };
        };
      };
      case (#in_right_half) {
        switch (tree) {
          case (#fork(fork)) lookupTree(fork.right, prefix);
          case (#prefix(node)) {
            lookupOptionalTree(node.rest, prefix);
          };
        };
      };
    };
  };

  func lookupPath(
    tree : LabeledTree,
    path : Iter.Iter<Key>,
  ) : LabeledTree {
    switch (path.next()) {
      case null tree;
      case (?key) {
        lookupPath(
          lookupLabeledTree(tree, Blob.toArray(key)),
          path,
        );
      };
    };
  };

  func graftPath(
    tree : LabeledTree,
    path : Iter.Iter<Key>,
    subtree : LabeledTree,
  ) : LabeledTree {
    switch (path.next()) {
      case null subtree;
      case (?key) {
        modifyLabeledTree(
          tree,
          key,
          func(current) {
            graftPath(current, path, subtree);
          },
        );
      };
    };
  };

  public func at(tree : Tree, path : Path) : Tree {
    lookupPath(tree, path.vals());
  };

  public func graft(
    tree : Tree,
    path : Path,
    subtree : Tree,
  ) : Tree {
    graftPath(tree, path.vals(), subtree);
  };

  public func empty(tree : Tree) : Bool {
    switch (tree) {
      case (#subtree(null)) true;
      case _ false;
    };
  };
};
