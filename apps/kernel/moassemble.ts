import fs from "node:fs/promises";
import { assemble } from "neutron-compiler/src/assemble.js";
import type { AssemblyManifest } from "neutron-compiler/src/assemble.js";
import { compileMotokoWithCandid } from "./src/tools/moc.ts";

const conf = JSON.parse(
  await fs.readFile("neutron.json", "utf8")
) as AssemblyManifest;
if (!conf.src) throw new Error("neutron.json must include src");
conf.entry = conf.src.replace(".mo", "");
const t = assemble([conf]);

await fs.writeFile("./backend/_neutron.mo", t);

const compilerOutputPath = `dist/.neutron-motoko-wasm-${process.pid}`;
const { wasmPath, candidPath } = await compileMotokoWithCandid({
  sourcePath: "backend/_neutron.mo",
  outputPath: compilerOutputPath,
});
try {
  await fs.rename(candidPath, "dist/neutron.did");
} finally {
  await Promise.all([
    fs.rm(wasmPath, { force: true }),
    fs.rm(candidPath, { force: true }),
  ]);
}
