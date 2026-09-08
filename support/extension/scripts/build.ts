import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
const root = path.resolve(import.meta.dir, "..");
const output = path.join(root, "dist");
const manifest = JSON.parse(await readFile(path.join(root, "public/manifest.json"), "utf8"));
const workspace = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
if (manifest.version !== workspace.version) throw new Error("Extension manifest and workspace versions must match.");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(path.join(root, "public"), output, { recursive: true });
const result = await Bun.build({
  entrypoints: ["background", "content", "offscreen", "network-worker", "pair", "settings"].map(name => path.join(root, "src", `${name}.ts`)),
  outdir: output,
  target: "browser",
  format: "esm",
  minify: true,
});
if (!result.success) throw new AggregateError(result.logs, "Extension build failed.");
await cp(path.join(root, "LICENSE"), path.join(output, "LICENSE"));
await cp(path.join(root, "NOTICE"), path.join(output, "NOTICE"));
await writeFile(path.join(output, "SOURCE.txt"), "The downloadable ZIP includes the exact corresponding source in source/.\nSee source/BUILD.md for offline build instructions and source/SHA256SUMS.json\nfor the source inventory. No hosted source download is required.\n\nFor this repository's local dist build, source is in ../src, ../public and\n../scripts; run bun scripts/build.ts from the support/extension workspace.\n");
console.log(`Built Neutron Browser Bridge ${workspace.version}: ${output}`);
