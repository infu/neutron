import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { disposeMotokoCompiler, loadMotoko } from "neutron-motoko-wasm";
import { prepareMotokoProgram } from "neutron-scripts/src/motoko.js";
import { parsePackageString } from "neutron-scripts/src/walk.js";
import { resolvePocketIcBinary } from "neutron-provision/src/pocketic_binary.ts";
import { PocketIcRestClient, type PocketIcRawEffectivePrincipal } from "neutron-provision/src/pocketic_rest.ts";

const execute = promisify(execFile);
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Compile real async Candid paths to an IC canister. The browser interpreter
// lacks to_candid/from_candid; WASI cannot run asynchronous actor tests.
// Each run owns an ephemeral local instance and no production canister IDs.
export async function runActors(files: string[], appRoot = path.resolve(import.meta.dir, "..")): Promise<void> {
  if (files.length === 0) throw new Error("Provide one or more test actors exposing run() : async Text");
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "nuance-actor-test-"));
  let server: ChildProcess | undefined;
  let client: PocketIcRestClient | undefined;
  let instanceId: number | undefined;
  try {
    const output = await execute("mops", ["sources"], { cwd: appRoot });
    const packages = Object.fromEntries(
      Object.entries(parsePackageString(output.stdout.replace(/\n/g, " ").trim()))
        .map(([name, root]) => [name, path.resolve(appRoot, root)]),
    );
    const compiled: Array<{ file: string; wasm: Uint8Array }> = [];
    const compiler = await loadMotoko();
    try {
      for (const file of files) {
        const sourcePath = path.resolve(appRoot, file);
        if (path.relative(appRoot, sourcePath).startsWith("..")) throw new Error("Test actors must stay inside the app");
        const program = await prepareMotokoProgram({ compiler, sourcePath, packages, allowDangerous: true });
        compiled.push({ file, wasm: (await compiler.wasm(program.entryPath, "ic")).wasm });
      }
    } finally {
      await disposeMotokoCompiler();
    }

    const binary = await resolvePocketIcBinary({ cacheDirectory: path.resolve(appRoot, "../../.neutron/cache/bin") });
    const portFile = path.join(temp, "control.port");
    server = spawn(binary.path, ["--ttl", "120", "--port-file", portFile, "--log-levels", "error"], { stdio: ["ignore", "pipe", "pipe"] });
    let serverError = "";
    server.stdout?.resume();
    server.stderr?.on("data", (chunk) => { serverError = (serverError + String(chunk)).slice(-8192); });
    let controlUrl: string | undefined;
    const readyDeadline = Date.now() + 10_000;
    while (Date.now() < readyDeadline) {
      if (server.exitCode !== null) throw new Error(`PocketIC startup failed: ${serverError}`);
      try {
        const port = Number((await fs.readFile(portFile, "utf8")).trim());
        if (Number.isInteger(port) && port > 0 && port <= 65535) { controlUrl = `http://127.0.0.1:${port}/`; break; }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await delay(25);
    }
    if (!controlUrl) throw new Error(`PocketIC did not publish its port: ${serverError}`);

    // Same minimal application-only topology as the repository's compiler
    // qualification tests. No fixed HTTP gateway/port, IC fixtures or keys.
    const subnet = { state_config: "New", instruction_config: "Production", subnet_admins: null, cost_schedule: "Normal" };
    const config = {
      subnet_config_set: { nns: null, sns: null, ii: null, fiduciary: null, bitcoin: null, test_threshold_keys: null, system: [], application: [subnet], cloud_engine: [], verified_application: [] },
      http_gateway_config: null,
      state_dir: path.join(temp, "state"),
      icp_config: null,
      log_level: null,
      bitcoind_addr: null,
      dogecoind_addr: null,
      icp_features: { registry: null, cycles_minting: null, icp_token: null, cycles_token: null, nns_governance: null, sns: null, ii: null, nns_ui: null, bitcoin: null, dogecoin: null, canister_migration: null },
      incomplete_state: "Disabled",
      initial_time: { AutoProgress: { artificial_delay_ms: null } },
      mainnet_nns_subnet_id: false,
      disable_ingress_validation: false,
    };
    const response = await fetch(new URL("instances", controlUrl), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(config), signal: AbortSignal.timeout(30_000),
    });
    const body = await response.json() as { Created?: { instance_id: number; topology: { default_effective_canister_id: { canister_id: string } } } };
    if (!response.ok || !body.Created) throw new Error(`PocketIC instance creation failed: ${JSON.stringify(body)}`);
    instanceId = body.Created.instance_id;
    client = new PocketIcRestClient(controlUrl);
    const caller = Principal.anonymous();
    const management = Principal.fromText("aaaaa-aa");
    const defaultEffective: PocketIcRawEffectivePrincipal = { CanisterId: body.Created.topology.default_effective_canister_id.canister_id };
    async function call(canisterId: Principal, method: string, args: IDL.Type[], values: unknown[], returns: IDL.Type[], effectivePrincipal: PocketIcRawEffectivePrincipal): Promise<unknown[]> {
      const pending = await client!.submitIngressMessage(instanceId!, { sender: caller, canisterId, method, payload: new Uint8Array(IDL.encode(args, values)), effectivePrincipal });
      const reply = await client!.awaitIngressMessage(instanceId!, pending);
      return IDL.decode(returns, reply);
    }
    for (const { file, wasm } of compiled) {
      const [created] = await call(management, "provisional_create_canister_with_cycles", [IDL.Record({ amount: IDL.Opt(IDL.Nat), settings: IDL.Opt(IDL.Record({})), specified_id: IDL.Opt(IDL.Principal), sender_canister_version: IDL.Opt(IDL.Nat64) })], [{ amount: [100_000_000_000_000n], settings: [], specified_id: [], sender_canister_version: [] }], [IDL.Record({ canister_id: IDL.Principal })], defaultEffective);
      const canisterId = (created as { canister_id: Principal }).canister_id;
      const effective: PocketIcRawEffectivePrincipal = { CanisterId: Buffer.from(canisterId.toUint8Array()).toString("base64") };
      await call(management, "install_code", [IDL.Record({ mode: IDL.Variant({ install: IDL.Null }), canister_id: IDL.Principal, wasm_module: IDL.Vec(IDL.Nat8), arg: IDL.Vec(IDL.Nat8), sender_canister_version: IDL.Opt(IDL.Nat64) })], [{ mode: { install: null }, canister_id: canisterId, wasm_module: wasm, arg: new Uint8Array(IDL.encode([], [])), sender_canister_version: [] }], [], effective);
      const [result] = await call(canisterId, "run", [], [], [IDL.Text], effective);
      console.log(`Motoko actor passed: ${file}: ${result}`);
    }
  } finally {
    if (client && instanceId !== undefined) await client.deleteInstance(instanceId).catch(() => undefined);
    if (server && server.exitCode === null) {
      server.kill("SIGTERM");
      const deadline = Date.now() + 5000;
      while (server.exitCode === null && Date.now() < deadline) await delay(25);
      if (server.exitCode === null) server.kill("SIGKILL");
    }
    await fs.rm(temp, { recursive: true, force: true });
  }
}

if (import.meta.main) await runActors(process.argv.slice(2));
