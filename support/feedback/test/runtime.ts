import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { IDL } from "@dfinity/candid";
import { Ed25519KeyIdentity } from "@dfinity/identity";
import { PocketIc } from "@dfinity/pic";
import { Principal } from "@dfinity/principal";
import { compileMotokoWithCandid } from "neutron-scripts/src/compile_motoko.js";
import { assertPublicCandidService } from "../../marketplace/scripts/public-candid.ts";
import { buildFeedback, feedbackPackages, feedbackProjectRoot } from "../scripts/build.ts";

const execFile = promisify(execFileCallback);
export const projectRoot = feedbackProjectRoot;
export const qualificationPath = path.resolve(projectRoot, process.env.FEEDBACK_QUALIFICATION_PATH ?? "build/test/qualification-bounds.json");
if (qualificationPath === path.resolve(projectRoot, "build/test/qualification.json")) {
  throw new Error("Retain the initial qualification.json unchanged; write successor evidence to a different path");
}
const repositoryRoot = path.resolve(projectRoot, "../..");
export const pins = JSON.parse(await readFile(path.join(projectRoot, "test/toolchain.json"), "utf8"));
const pocketIcBinary = process.env.FEEDBACK_POCKET_IC_BIN ?? path.join(homedir(), ".local/bin/pocket-ic");
const didcBinary = process.env.FEEDBACK_DIDC_BIN ?? path.join(homedir(), ".local/bin/didc");
export const identity = (seed: number): Principal => Ed25519KeyIdentity.generate(new Uint8Array(32).fill(seed)).getPrincipal();
export const administrator = identity(201);
export const wire = (value: unknown): string => JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item);

export function success<T = any>(result: any): T {
  assert.ok(result && "ok" in result, `Expected protocol success, received ${wire(result)}`);
  return result.ok;
}

export function failure(result: any, code?: string): any {
  assert.ok(result && "err" in result, `Expected protocol error, received ${wire(result)}`);
  if (code) assert.equal(result.err.code, code);
  return result.err;
}

export async function digest(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest("hex");
}

async function verifyBinary(file: string, version: string, sha256: string): Promise<void> {
  assert.equal(await digest(file), sha256, `Pinned test binary changed: ${file}`);
  const { stdout } = await execFile(file, ["--version"]);
  assert.equal(stdout.trim(), version, `Pinned test binary version changed: ${file}`);
}

let verified: Promise<void> | undefined;
export function verifyToolchain(): Promise<void> {
  return verified ??= (async () => {
    const pkg = JSON.parse(await readFile(path.join(repositoryRoot, "node_modules/@dfinity/pic/package.json"), "utf8"));
    assert.equal(pkg.version, pins.pocketIcClient, "Use the pinned PocketIC JavaScript client");
    await Promise.all([
      verifyBinary(pocketIcBinary, pins.pocketIcVersion, pins.pocketIcSha256),
      verifyBinary(didcBinary, pins.didcVersion, pins.didcSha256),
    ]);
  })();
}

async function bind(candidPath: string, jsPath: string) {
  const { stdout } = await execFile(didcBinary, ["bind", "--target", "js", candidPath], { maxBuffer: 4 * 1024 * 1024 });
  await writeFile(jsPath, stdout);
  return await import(pathToFileURL(jsPath).href);
}

let built: Promise<any> | undefined;
let installationMetrics: Record<string, unknown> | undefined;
let upgradeBaseline: { path: string; sha256: string } | undefined;

export async function previousProtocol() {
  const baselinePath = path.resolve(projectRoot, process.env.FEEDBACK_PREVIOUS_PROTOCOL_WASM
    ?? ".private/releases/protocol-initial-4482bb2c1f07/feedback.wasm");
  const expected = "4482bb2c1f07c4d5dcd2391dc19dfd32ed3868f1ec6e054ca34d0325a1944a18";
  const wasm = await readFile(baselinePath);
  assert.equal(createHash("sha256").update(wasm).digest("hex"), expected, "Upgrade qualification requires the exact retained initial protocol Wasm");
  upgradeBaseline = { path: path.relative(projectRoot, baselinePath), sha256: expected };
  return { ...upgradeBaseline, wasm };
}
export function compiledProtocol(): Promise<any> {
  return built ??= (async () => {
    await verifyToolchain();
    const output = await buildFeedback();
    const wasm = await readFile(output.wasmPath);
    assertPublicCandidService(wasm);
    const wasmHash = await digest(output.wasmPath);
    const bindings = await bind(output.candidPath, path.join(projectRoot, "build/feedback.idl.js"));
    console.log(`Feedback protocol test Wasm SHA-256: ${wasmHash}`);
    return { ...output, ...bindings, wasm, wasmHash };
  })();
}

let relayBuild: Promise<any> | undefined;
async function compiledRelay(): Promise<any> {
  return relayBuild ??= (async () => {
    await verifyToolchain();
    const output = await compileMotokoWithCandid({
      cwd: projectRoot,
      sourcePath: "test/fixtures/Relay.mo",
      outputPath: "build/test/relay.wasm",
      packages: await feedbackPackages(),
    });
    const bindings = await bind(output.candidPath, path.join(projectRoot, "build/test/relay.idl.js"));
    return { ...output, ...bindings };
  })();
}

async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
  });
}

export async function session(options: { initialWasm?: Uint8Array } = {}) {
  const compiled = await compiledProtocol();
  const directory = await mkdtemp(path.join(tmpdir(), "neutron-feedback-pic-"));
  const portFile = path.join(directory, "server.port");
  const logs = createWriteStream(path.join(directory, "server.log"));
  const server = spawn(pocketIcBinary, ["--port-file", portFile, "--ttl", "600"], { stdio: ["ignore", "pipe", "pipe"] });
  server.stdout!.pipe(logs, { end: false });
  server.stderr!.pipe(logs, { end: false });
  let spawnError: Error | undefined;
  server.once("error", error => { spawnError = error; });
  let pic: PocketIc | undefined;
  try {
    let port: number | undefined;
    const deadline = Date.now() + 15_000;
    while (!port && Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (server.exitCode !== null) throw new Error(`PocketIC exited during startup: ${await readFile(path.join(directory, "server.log"), "utf8")}`);
      try { port = Number((await readFile(portFile, "utf8")).trim()) || undefined; } catch { /* Wait for the server to write its selected port. */ }
      if (!port) await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!port) throw new Error("PocketIC did not write its listening port");
    pic = await PocketIc.create(`http://127.0.0.1:${port}`, { processingTimeoutMs: 120_000 });
    const initialCycles = 100_000_000_000_000n;
    const canisterId = await pic.createCanister({ cycles: initialCycles });
    const arg = IDL.encode(compiled.init({ IDL }), [{ administrator }]);
    await pic.installCode({ canisterId, wasm: gzipSync(options.initialWasm ?? compiled.wasm, { level: 9 }), arg });
    const cyclesAfterInstall = BigInt(await pic.getCyclesBalance(canisterId));
    const as = (principal: Principal): any => {
      const actor = pic!.createActor(compiled.idlFactory, canisterId);
      actor.setPrincipal(principal);
      return actor;
    };
    const installedPic = pic;
    return {
      pic: installedPic, compiled, canisterId, arg, as,
      actor: as(Principal.anonymous()),
      admin: as(administrator),
      async installationMetrics() {
        const management = installedPic.createActor(({ IDL }) => IDL.Service({
          canister_status: IDL.Func([IDL.Record({ canister_id: IDL.Principal })], [IDL.Record({
            memory_size: IDL.Nat,
            idle_cycles_burned_per_day: IDL.Nat,
            cycles: IDL.Nat,
            settings: IDL.Record({ freezing_threshold: IDL.Nat }),
          })], []),
        }), Principal.managementCanister());
        const status: any = await management.canister_status({ canister_id: canisterId });
        installationMetrics = {
          initialCycles: initialCycles.toString(), cyclesAfterInstall: cyclesAfterInstall.toString(),
          installCycleDelta: (initialCycles - cyclesAfterInstall).toString(),
          memorySize: status.memory_size.toString(), idleCyclesBurnedPerDay: status.idle_cycles_burned_per_day.toString(),
          freezingThresholdSeconds: status.settings.freezing_threshold.toString(),
          environment: "PocketIC default application subnet; observed local values are not a production funding guarantee",
        };
        return installationMetrics;
      },
      async neutron() {
        const relay = await compiledRelay();
        const relayId = await installedPic.createCanister({ cycles: 100_000_000_000_000n });
        await installedPic.installCode({ canisterId: relayId, wasm: relay.wasmPath, arg: IDL.encode(relay.init({ IDL }), []) });
        const relayActor = installedPic.createActor(relay.idlFactory, relayId);
        return {
          canisterId: relayId,
          async call(method: string, args: unknown[] = []): Promise<any> {
            const service = compiled.idlFactory({ IDL });
            const entry = service._fields.find(([name]: [string, unknown]) => name === method);
            assert.ok(entry, `Method ${method} exists in the compiled Candid`);
            const types = entry[1];
            const bytes = await relayActor.rawCall(canisterId, method, IDL.encode(types.argTypes, args));
            const values = IDL.decode(types.retTypes, Uint8Array.from(bytes as number[]));
            return values.length === 1 ? values[0] : values;
          },
        };
      },
      async upgrade() {
        await installedPic.upgradeCanister({
          canisterId, wasm: gzipSync(compiled.wasm, { level: 9 }), arg,
          upgradeModeOptions: { skip_pre_upgrade: [], wasm_memory_persistence: [{ keep: null }] },
        });
      },
      async shutdown() {
        try { await installedPic.tearDown(); }
        finally { await stopServer(server); logs.end(); await rm(directory, { recursive: true, force: true }); }
      },
    };
  } catch (error) {
    try { await pic?.tearDown(); } finally { await stopServer(server); logs.end(); await rm(directory, { recursive: true, force: true }); }
    throw error;
  }
}

export type Session = Awaited<ReturnType<typeof session>>;
export type Neutron = Awaited<ReturnType<Session["neutron"]>>;
export type IntegrationCase = { name: string; run: () => Promise<void> };

export async function writeQualification(cases: string[]): Promise<void> {
  const compiled = await compiledProtocol();
  await mkdir(path.join(projectRoot, "build/test"), { recursive: true });
  const evidence = {
    format: "feedback-protocol-qualification-v1",
    qualifiedAt: new Date().toISOString(),
    wasm: { path: path.relative(projectRoot, compiled.wasmPath), sha256: compiled.wasmHash },
    candid: { path: path.relative(projectRoot, compiled.candidPath), sha256: await digest(compiled.candidPath) },
    stableTypes: { path: path.relative(projectRoot, compiled.stableTypesPath), sha256: await digest(compiled.stableTypesPath) },
    toolchain: pins,
    installationMetrics,
    upgradeBaseline,
    testSources: await Promise.all(["test/protocol.integration.ts", "test/runtime.ts", "test/fixtures/Relay.mo", "scripts/test-integration.ts"].map(async relative => ({
      path: relative, sha256: await digest(path.join(projectRoot, relative)),
    }))),
    cases,
  };
  await mkdir(path.dirname(qualificationPath), { recursive: true });
  await writeFile(qualificationPath, JSON.stringify(evidence, null, 2) + "\n");
}
