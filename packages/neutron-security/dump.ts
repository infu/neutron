import fs from "fs/promises";
import util from "util";
import { disposeMotokoCompiler, loadMotoko } from "neutron-motoko-wasm";

const file = process.argv[2];

if (!file) {
  throw new Error("Usage: bun dump.ts <motoko-file>");
}

try {
  const contents = await fs.readFile(file, "utf-8");
  const mo = await loadMotoko();
  const ast = await mo.parseMotoko(contents);

  console.log(util.inspect(ast, false, null, true));
} finally {
  await disposeMotokoCompiler();
}

// Help understanding these here https://github.com/dfinity/motoko/blob/cf5ac77f1fb86b215065ea8fcfef4ecac1012817/src/mo_def/syntax.ml#L153
