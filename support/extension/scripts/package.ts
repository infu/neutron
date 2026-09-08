import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { zip } from "./zip";
import type { ZipEntry } from "./zip";
import "./build";

const workspaceRoot = path.resolve(import.meta.dir, "..");
const repositoryRoot = path.resolve(workspaceRoot, "../..");
const workspace = JSON.parse(await readFile(path.join(workspaceRoot, "package.json"), "utf8"));
const text = (value: string) => new TextEncoder().encode(value);
const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

// Match the repository's Complete App Source conventions without using an IC
// application manifest for a Chrome extension. The source is embedded directly.
const sourceEntries: ZipEntry[] = [];
for (const name of ["package.json", "package-lock.json", "tsconfig.base.json", "tsconfig.browser.json", "tsconfig.bun.json", "tsconfig.json", "flake.nix", "flake.lock", "LICENSE", "LICENSES.md"]) {
  sourceEntries.push({ path: name, content: await readFile(path.join(repositoryRoot, name)) });
}
async function collect(directory: string, prefix: string, output: ZipEntry[], excludeBuild: boolean) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (excludeBuild && (["dist", "node_modules", ".git", ".cache", "coverage", "test-results", "playwright-report"].includes(entry.name) || entry.name.endsWith(".zip") || entry.name.endsWith(".zip.sha256"))) continue;
    if (/^(?:\.env(?:\..+)?|credentials?(?:\..+)?|secrets?(?:\..+)?|id_ed25519(?:\.pub)?|id_rsa(?:\.pub)?)$/iu.test(entry.name) || /\.(?:key|p12|pfx|pem)$/iu.test(entry.name)) throw new Error(`Do not include credentials in extension source: ${entry.name}`);
    const filename = path.join(directory, entry.name);
    const archivePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Extension packaging requires concrete source files: ${archivePath}`);
    if (entry.isDirectory()) await collect(filename, archivePath, output, excludeBuild);
    else if (entry.isFile()) output.push({ path: archivePath, content: await readFile(filename) });
  }
}
await collect(workspaceRoot, "support/extension", sourceEntries, true);
sourceEntries.push({ path: "BUILD.md", content: text(`# Build the included Neutron Browser Bridge source\n\nThis archive includes the exact extension source, license, build scripts and\nrepository configuration used for version ${workspace.version}. The runtime has\nno third-party dependencies. No source download or dependency installation is\nneeded to build it once Bun is installed. The packaged bytes were built with\nBun ${Bun.version}.\n\nFrom this source directory:\n\n\x60\x60\x60sh\ncd support/extension\nbun scripts/build.ts\n\x60\x60\x60\n\nThe output is support/extension/dist relative to this source directory.\nTo produce another ZIP including the source, run bun scripts/package.ts instead.\nThe root package.json and package-lock.json record the original monorepo's test\nand development tools; the runtime build above does not install or use them.\nThe test scripts need the development dependencies and Chromium described in\nsupport/extension/README.md.\n\nSHA256SUMS.json lists every included source file and its exact SHA-256. The\ninventory excludes itself. INSTALL.txt at the archive root describes loading\nthe ready-to-use extension. No extension, account or pairing is installed by\nextracting or rebuilding this archive.\n`) });
sourceEntries.sort((a, b) => a.path.localeCompare(b.path, "en"));
const inventory = sourceEntries.map(entry => ({ path: entry.path, bytes: entry.content.byteLength, sha256: digest(entry.content) }));
const entries: ZipEntry[] = [];
await collect(path.join(workspaceRoot, "dist"), "", entries, false);
entries.push({ path: "INSTALL.txt", content: text(`Neutron Browser Bridge ${workspace.version}\n\n1. Extract this ZIP to a folder you will keep.\n2. Open chrome://extensions in Chrome 116 or newer.\n3. Enable Developer mode, choose Load unpacked and select the extracted folder\n   containing manifest.json.\n4. Reload your Neutron page and connect in Browser extension settings or from\n   an app feature that uses the extension.\n5. Accept your exact Neutron origin once. The connection has no expiry and can\n   be revoked in Settings. Neutron manages permanent permissions for its apps.\n\nThe source/ directory contains the exact corresponding source, build inputs and\nlicense. See source/BUILD.md to build it without downloading source or packages.\nThe extension is not automatically installed or published by extracting this ZIP.\n`) });
entries.push(...sourceEntries.map(entry => ({ path: `source/${entry.path}`, content: entry.content })));
entries.push({ path: "source/SHA256SUMS.json", content: text(`${JSON.stringify({ format: 1, extensionVersion: workspace.version, bunVersion: Bun.version, files: inventory }, null, 2)}\n`) });
const archive = zip(entries);
const basename = `neutron-extension.v${workspace.version}.zip`;
await writeFile(path.join(workspaceRoot, basename), archive);
await writeFile(path.join(workspaceRoot, `${basename}.sha256`), `${digest(archive)}  ${basename}\n`);
console.log(`Packaged ${basename}: ${archive.byteLength} bytes, SHA-256 ${digest(archive)}`);
