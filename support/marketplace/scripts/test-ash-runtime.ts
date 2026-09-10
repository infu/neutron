import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { compileMotokoWithCandid } from "neutron-scripts/src/compile_motoko.js";
import { exposeCandidService } from "./public-candid.ts";

const execFile = promisify(execFileCallback);
export const projectRoot = path.resolve(import.meta.dir, "..");
export const repositoryRoot = path.resolve(projectRoot, "../..");
const pins = JSON.parse(await readFile(path.join(projectRoot, "test/toolchain.json"), "utf8"));
let preparing: Promise<AshRuntime> | undefined;
let preparingPackages: Promise<Record<string, string>> | undefined;
const fixtureBuilds = new Map<string, Promise<any>>();

export type AshRuntime = {
  directory: string;
  testCommand: (config: string, name?: string, options?: { verbose?: boolean }) => Promise<void>;
  createSession: (options?: Record<string, unknown>) => Promise<{ pic: any; shutdown: () => Promise<void> }>;
  bind: (did: string, base: string, root: string) => Promise<{ tsPath: string; jsPath: string; dtsPath: string }>;
};

async function digest(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest("hex");
}

async function verifyBinary(name: string, sha256: string, version: string): Promise<void> {
  const file = path.join(homedir(), ".local/bin", name);
  const actual = await digest(file);
  if (actual !== sha256) throw new Error(`${name} hash mismatch: expected ${sha256}, received ${actual}. Review and pin the intended test toolchain; do not silently replace it.`);
  const { stdout } = await execFile(file, ["--version"]);
  if (stdout.trim() !== version) throw new Error(`${name} version mismatch: ${stdout.trim()}`);
}

export function prepareAsh(): Promise<AshRuntime> {
  return preparing ??= prepare();
}

async function prepare(): Promise<AshRuntime> {
  const ashSource = process.env.MARKETPLACE_ASH_SOURCE ?? path.resolve(repositoryRoot, "../ash");
  const directory = await mkdtemp(path.join(tmpdir(), "neutron-marketplace-ash-"));
  // Read immutable git objects: never build or alter another workspace's dirty files.
  const archive = path.join(directory, "source.tar");
  await execFile("git", ["-C", ashSource, "archive", "--format=tar", `--output=${archive}`, pins.ashCommit]);
  await execFile("tar", ["-xf", archive, "-C", directory]);
  for (const [relative, expected] of [
    ["src/commands/test.ts", pins.ashTestRunnerSha256],
    ["src/pocketic.ts", pins.ashPocketIcAdapterSha256],
  ]) {
    if (await digest(path.join(directory, relative)) !== expected) throw new Error(`Pinned Ash source mismatch: ${relative}`);
  }
  // The pinned transport spins on a partial stdout body because waitForData
  // treats any buffered byte as progress. Its callers have already determined
  // the frame is incomplete; wait for the next event so large HTTP replies and
  // timers can progress. Patch only this disposable snapshot.
  const transportPatch = path.join(projectRoot, "test/ash-stdio-partial-response.patch");
  if (await digest(transportPatch) !== pins.ashStdioPatchSha256) throw new Error("Pinned Ash partial-response patch mismatch.");
  await execFile("git", ["-C", directory, "apply", transportPatch]);
  const picPackage = JSON.parse(await readFile(path.join(repositoryRoot, "node_modules/@dfinity/pic/package.json"), "utf8"));
  if (picPackage.version !== pins.pocketIcClient) throw new Error(`PocketIC client must be ${pins.pocketIcClient}; received ${picPackage.version}`);
  await Promise.all([
    verifyBinary("pocket-ic", pins.pocketIcSha256, pins.pocketIcVersion),
    verifyBinary("didc", pins.didcSha256, pins.didcVersion),
  ]);
  await symlink(path.join(repositoryRoot, "node_modules"), path.join(directory, "node_modules"), "dir");
  // Keep Ash's test runner, metrics and PocketIC lifecycle. Replace its compiler
  // adapter so tests and deployment use the same repository-pinned compiler.
  const adapter = `export { compileAshCanister as buildCanisterArtifacts } from ${JSON.stringify(pathToFileURL(import.meta.filename).href)};\n`;
  await writeFile(path.join(directory, "src/moc.ts"), adapter);
  const test = await import(pathToFileURL(path.join(directory, "src/commands/test.ts")).href);
  const pocket = await import(pathToFileURL(path.join(directory, "src/pocketic.ts")).href);
  const bindings = await import(pathToFileURL(path.join(directory, "src/didc.ts")).href);
  console.log(`Ash ${pins.ashCommit}; PocketIC ${pins.pocketIcVersion}; compiler adapter: repository-pinned WASM compiler`);
  return { directory, testCommand: test.testCommand, createSession: pocket.createPocketIcInstance, bind: bindings.generateDidBindings };
}

export function testPackages(): Promise<Record<string, string>> {
  return preparingPackages ??= import("./build.ts").then(({ marketplacePackages }) => marketplacePackages(projectRoot));
}

export async function compileAshCanister(canister: any, paths: any, options: { packages?: Array<{ name: string; path: string }> } = {}) {
  const packages = { ...await testPackages(), ...Object.fromEntries((options.packages ?? []).map((entry) => [entry.name, entry.path])) };
  const base = path.join(paths.artifactsDir, canister.name);
  const output = await compileMotokoWithCandid({ sourcePath: canister.srcAbs, outputPath: `${base}.wasm`, cwd: projectRoot, packages, emitStableTypes: true });
  if (path.resolve(canister.srcAbs) === path.join(projectRoot, "mo/main.mo")) {
    // Public actor tests install the same interface visibility and bytes as the
    // normal deployment build; private test fixtures need no metadata change.
    await exposeCandidService(output.wasmPath);
  }
  // IC install_code accepts gzip Wasm. The assembled public actor exceeds the
  // ingress message cap when sent raw; compression changes only its transport,
  // not the module, compiler options or state-preserving upgrade path.
  const wasmPath = `${output.wasmPath}.gz`;
  await writeFile(wasmPath, gzipSync(await readFile(output.wasmPath), { level: 9 }));
  const didPath = `${base}.did`;
  await copyFile(output.candidPath, didPath);
  // prepare() has completed before Ash invokes compilation; this does not recurse.
  const ash = await prepareAsh();
  const bindings = await ash.bind(didPath, base, projectRoot);
  return { ...output, wasmPath, rawWasmPath: output.wasmPath, didPath, tsBindingsPath: bindings.tsPath, jsBindingsPath: bindings.jsPath, dtsBindingsPath: bindings.dtsPath, wasmHash: await digest(output.wasmPath) };
}

export function compileFixture(name: string, source: string): Promise<any> {
  const key = `${name}:${source}`;
  let result = fixtureBuilds.get(key);
  if (!result) {
    result = buildFixture(name, source);
    fixtureBuilds.set(key, result);
  }
  return result;
}

async function buildFixture(name: string, source: string) {
  await prepareAsh();
  const artifactsDir = path.join(projectRoot, "build/test");
  await mkdir(artifactsDir, { recursive: true });
  const output = await compileAshCanister({ name, srcAbs: path.resolve(projectRoot, source) }, { artifactsDir });
  if (source === "mo/main.mo") console.log(`Marketplace protocol test Wasm SHA-256: ${output.wasmHash}`);
  const bindings = await import(pathToFileURL(output.jsBindingsPath).href);
  return { ...output, idlFactory: bindings.idlFactory, init: bindings.init };
}
