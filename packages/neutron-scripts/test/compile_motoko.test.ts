import { expect, test } from "bun:test";
import { parseCompileMotokoArgs } from "../src/compile_motoko.ts";

test("compile-motoko CLI preserves absolute ICP output paths", () => {
  expect(
    parseCompileMotokoArgs([
      "--source",
      "mo/main.mo",
      "--output",
      "/tmp/icp/dispenser.wasm",
      "--emit-stable-types",
    ]),
  ).toEqual({
    sourcePath: "mo/main.mo",
    outputPath: "/tmp/icp/dispenser.wasm",
    emitStableTypes: true,
  });
});

test("compile-motoko CLI requires explicit source and output", () => {
  expect(() => parseCompileMotokoArgs(["--source", "mo/main.mo"])).toThrow(
    "--output is required",
  );
  expect(() => parseCompileMotokoArgs(["--wat"])).toThrow(
    "Unknown compile-motoko argument",
  );
});
