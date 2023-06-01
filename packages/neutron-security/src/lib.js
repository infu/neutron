import mo from "motoko";
import * as disallowed from "./disallowed.js";

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

export function checkForDangerousASTCode(contents) {
  let danger = [];
  let ast = mo.parseMotoko(contents);
  for (let pattern in disallowed) {
    let exists = matchTraverseTree(ast, disallowed[pattern]);
    if (exists) danger.push(pattern);
  }
  return danger;
}

import { checkForDangerousTextCode } from "./text.js";
export { checkForDangerousTextCode };
