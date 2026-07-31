import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import {
  disposeMotokoCompiler,
  loadMotoko,
} from "neutron-motoko-wasm";
import { prepareMotokoProgram } from "../src/motoko.ts";

test("prepares a relative Motoko dependency graph for the Wasm compiler", async () => {
  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), "neutron-motoko-program-"),
  );
  const dependencyPath = path.join(temporary, "dependency.mo");
  const entryPath = path.join(temporary, "main.mo");
  await fs.writeFile(
    dependencyPath,
    "module { public let answer : Nat = 42 }",
  );
  await fs.writeFile(
    entryPath,
    'import Dependency "dependency"; Dependency.answer',
  );

  try {
    const compiler = await loadMotoko();
    const prepared = await prepareMotokoProgram({
      compiler,
      sourcePath: entryPath,
      allowDangerous: true,
    });
    expect(prepared.sourceCount).toBe(2);
    expect((await compiler.run(prepared.entryPath)).stdout).toBe("42 : Nat\n");
  } finally {
    await disposeMotokoCompiler();
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
