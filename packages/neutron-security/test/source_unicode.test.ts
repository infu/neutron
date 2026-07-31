import { expect, test } from "bun:test";
import { checkForDangerousASTCode } from "../src/lib.ts";

test("source facts retain call contexts after Unicode text and comments", () => {
  for (const source of [
    'module { let label = "😀"; func run() : async () {}; func use() : async () { let context = { cycles = 1 }; await (context with) run() } }',
    "module { /* 😀 é */ func run() : async () {}; func use() : async () { await (with cycles = 1) run() } }",
  ]) {
    expect(
      checkForDangerousASTCode({ name: "Prog", args: [] }, source),
    ).toEqual(["cyclesTransfer"]);
  }
});
