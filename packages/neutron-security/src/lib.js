export function matchTraverseTree(tree, pattern) {
  if (pattern(tree)) return true;
  if (!Array.isArray(tree.args)) return false;
  for (let node of tree.args) {
    if (typeof node !== "string") {
      if (matchTraverseTree(node, pattern)) return true;
    }
  }
  return false;
}
