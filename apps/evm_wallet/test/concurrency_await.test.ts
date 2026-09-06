import { expect, test } from "bun:test";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { Transaction } from "ethers";
import { disposeMotokoCompiler, loadMotoko } from "neutron-motoko-wasm";
import { prepareMotokoProgram } from "neutron-scripts/src/motoko.js";
import { parsePackageString } from "neutron-scripts/src/walk.js";
import { resolvePocketIcBinary } from "neutron-provision/src/pocketic_binary.ts";
import { PocketIcRestClient, type PocketIcIngressMessage, type PocketIcRawEffectivePrincipal } from "neutron-provision/src/pocketic_rest.ts";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const Caller = IDL.Record({ app_id: IDL.Text, installation_uid: IDL.Nat64, endpoint: IDL.Text });
const Identity = IDL.Record({ caller: Caller, request_id: IDL.Text });
const Summary = IDL.Record({ operation_id: IDL.Nat, caller: Caller, request_id: IDL.Text, chain_id: IDL.Nat, status: IDL.Text, review_revision: IDL.Nat, nonce: IDL.Opt(IDL.Text), transaction_hash: IDL.Opt(IDL.Text) });
const Result = IDL.Variant({ ok: Summary, err: IDL.Text });
const Attempt = IDL.Record({ operation_id: IDL.Nat, caller: Caller, chain_id: IDL.Nat, nonce: IDL.Opt(IDL.Text), digest: IDL.Text });
const Observations = IDL.Record({ attempts: IDL.Vec(Attempt), broadcasts: IDL.Vec(IDL.Text), commands: IDL.Nat });
type CallerValue = { app_id: string; installation_uid: bigint; endpoint: string };
type IdentityValue = { caller: CallerValue; request_id: string };
type SummaryValue = { operation_id: bigint; caller: CallerValue; request_id: string; chain_id: bigint; status: string; review_revision: bigint; nonce: string[]; transaction_hash: string[] };
type ResultValue = { ok: SummaryValue } | { err: string };
type ObservationsValue = { attempts: Array<{ operation_id: bigint; caller: CallerValue; chain_id: bigint; nonce: string[]; digest: string }>; broadcasts: string[]; commands: bigint };
const identity = (installation_uid: bigint, request = "1", app_id = "consumer", endpoint = "original-tile"): IdentityValue => ({ caller: { app_id, installation_uid, endpoint }, request_id: request.padStart(32, "0") });
function ok(result: ResultValue): SummaryValue {
  if ("err" in result) throw new Error(result.err);
  return result.ok;
}

// Separate ingress messages exercise the real compiled backend while its
// callback is held by a separate canister. This proves async interleaving and
// scripted signer semantics; live chain-key/EVM signing has separate coverage.
test("overlapping caller installations and chains preserve nonce, review and signing ownership across real awaits", async () => {
  const appRoot = path.resolve(import.meta.dir, "..");
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "evm-wallet-concurrency-await-"));
  let server: ChildProcess | undefined;
  let client: PocketIcRestClient | undefined;
  let instanceId: number | undefined;
  try {
    const sources = await promisify(execFile)("mops", ["sources"], { cwd: appRoot });
    const packages = Object.fromEntries(Object.entries(parsePackageString(sources.stdout.replace(/\n/g, " ").trim())).map(([name, root]) => [name, path.resolve(appRoot, root)]));
    const wasm: Uint8Array[] = [];
    const compiler = await loadMotoko();
    try {
      for (const filename of ["concurrency_await_gate.mo", "concurrency_await_wallet.mo"]) {
        const program = await prepareMotokoProgram({ compiler, sourcePath: path.join(appRoot, "test", filename), packages, allowDangerous: true });
        wasm.push((await compiler.wasm(program.entryPath, "ic")).wasm);
      }
    } finally { await disposeMotokoCompiler(); }
    const binary = await resolvePocketIcBinary({ cacheDirectory: path.resolve(appRoot, "../../.neutron/cache/bin") });
    const portFile = path.join(temp, "control.port");
    server = spawn(binary.path, ["--ttl", "180", "--port-file", portFile, "--log-levels", "error"], { stdio: ["ignore", "pipe", "pipe"] });
    server.stdout?.resume();
    let serverError = "";
    server.stderr?.on("data", (chunk) => { serverError = (serverError + String(chunk)).slice(-8192); });
    let controlUrl: string | undefined;
    const startupDeadline = Date.now() + 10_000;
    while (Date.now() < startupDeadline) {
      if (server.exitCode !== null) throw new Error(`PocketIC exited: ${serverError}`);
      try {
        const port = Number((await fs.readFile(portFile, "utf8")).trim());
        if (Number.isInteger(port) && port > 0 && port <= 65535) { controlUrl = `http://127.0.0.1:${port}/`; break; }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await delay(25);
    }
    if (!controlUrl) throw new Error(`PocketIC failed to start: ${serverError}`);
    const subnet = { state_config: "New", instruction_config: "Production", subnet_admins: null, cost_schedule: "Normal" };
    const createdResponse = await fetch(new URL("instances", controlUrl), { method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(30_000), body: JSON.stringify({
      subnet_config_set: { nns: null, sns: null, ii: null, fiduciary: null, bitcoin: null, test_threshold_keys: null, system: [], application: [subnet], cloud_engine: [], verified_application: [] },
      http_gateway_config: null, state_dir: path.join(temp, "state"), icp_config: null, log_level: null, bitcoind_addr: null, dogecoind_addr: null,
      icp_features: { registry: null, cycles_minting: null, icp_token: null, cycles_token: null, nns_governance: null, sns: null, ii: null, nns_ui: null, bitcoin: null, dogecoin: null, canister_migration: null },
      incomplete_state: "Disabled", initial_time: { AutoProgress: { artificial_delay_ms: null } }, mainnet_nns_subnet_id: false, disable_ingress_validation: false,
    }) });
    const created = await createdResponse.json() as { Created?: { instance_id: number; topology: { default_effective_canister_id: { canister_id: string } } } };
    if (!createdResponse.ok || !created.Created) throw new Error(`PocketIC instance failed: ${JSON.stringify(created)}`);
    instanceId = created.Created.instance_id;
    client = new PocketIcRestClient(controlUrl);
    const sender = Principal.anonymous();
    const management = Principal.fromText("aaaaa-aa");
    const defaultEffective: PocketIcRawEffectivePrincipal = { CanisterId: created.Created.topology.default_effective_canister_id.canister_id };
    const effective = (canister: Principal): PocketIcRawEffectivePrincipal => ({ CanisterId: Buffer.from(canister.toUint8Array()).toString("base64") });
    async function submit(canisterId: Principal, method: string, types: IDL.Type[], values: unknown[], effectivePrincipal = effective(canisterId)): Promise<PocketIcIngressMessage> {
      return client!.submitIngressMessage(instanceId!, { sender, canisterId, method, payload: new Uint8Array(IDL.encode(types, values)), effectivePrincipal });
    }
    async function finish<T>(pending: PocketIcIngressMessage, returns: IDL.Type[] = [Result]): Promise<T> {
      return IDL.decode(returns, await client!.awaitIngressMessage(instanceId!, pending))[0] as T;
    }
    async function call<T>(canisterId: Principal, method: string, types: IDL.Type[], values: unknown[], returns: IDL.Type[] = [Result]): Promise<T> {
      return finish<T>(await submit(canisterId, method, types, values), returns);
    }
    async function query<T>(canisterId: Principal, method: string, types: IDL.Type[], values: unknown[], returns: IDL.Type): Promise<T> {
      const reply = await client!.queryCanister(instanceId!, { sender, canisterId, method, payload: new Uint8Array(IDL.encode(types, values)), effectivePrincipal: effective(canisterId) });
      return IDL.decode([returns], reply)[0] as T;
    }
    async function install(bytes: Uint8Array, arg: Uint8Array): Promise<Principal> {
      const created = await finish<{ canister_id: Principal }>(await submit(management, "provisional_create_canister_with_cycles", [IDL.Record({ amount: IDL.Opt(IDL.Nat), settings: IDL.Opt(IDL.Record({})), specified_id: IDL.Opt(IDL.Principal), sender_canister_version: IDL.Opt(IDL.Nat64) })], [{ amount: [100_000_000_000_000n], settings: [], specified_id: [], sender_canister_version: [] }], defaultEffective), [IDL.Record({ canister_id: IDL.Principal })]);
      await finish(await submit(management, "install_code", [IDL.Record({ mode: IDL.Variant({ install: IDL.Null }), canister_id: IDL.Principal, wasm_module: IDL.Vec(IDL.Nat8), arg: IDL.Vec(IDL.Nat8), sender_canister_version: IDL.Opt(IDL.Nat64) })], [{ mode: { install: null }, canister_id: created.canister_id, wasm_module: bytes, arg, sender_canister_version: [] }], effective(created.canister_id)), []);
      return created.canister_id;
    }
    const gate = await install(wasm[0]!, new Uint8Array(IDL.encode([], [])));
    const wallet = await install(wasm[1]!, new Uint8Array(IDL.encode([IDL.Principal], [gate])));
    const entered = (key: string) => query<bigint>(gate, "entered", [IDL.Text], [key], IDL.Nat);
    async function suspended(key: string, count = 1n): Promise<void> {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) { if (await entered(key) >= count) return; await delay(10); }
      throw new Error(`Callback did not suspend at ${key} ticket ${count}`);
    }
    const release = (key: string, through = 100n) => call(gate, "release", [IDL.Text, IDL.Nat], [key, through], []);
    const prepare = (id: IdentityValue, chain = 1n, value = "1", message = false) => submit(wallet, "prepare", [Identity, IDL.Nat, IDL.Text, IDL.Bool], [id, chain, value, message]);
    const execute = (id: IdentityValue, revision: bigint) => submit(wallet, "execute", [Identity, IDL.Nat], [id, revision]);
    const status = (id: IdentityValue, refresh = true) => call<ResultValue>(wallet, "status", [Identity, IDL.Bool], [id, refresh]);
    const observations = () => query<ObservationsValue>(wallet, "observations", [], [], Observations);
    const signerError = (id: bigint, error: string) => call(wallet, "signerError", [IDL.Nat, IDL.Text], [id, error], []);

    const a = identity(101n);
    const b = identity(102n); // Same app/request ID, different installation.
    const c = identity(101n, "2", "other-consumer");
    const aPreparing = await prepare(a);
    await suspended("nonce:1");
    const replay = ok(await finish<ResultValue>(await prepare({ ...a, caller: { ...a.caller, endpoint: "replacement-tile" } })));
    expect(replay.status).toBe("preparing");
    expect(replay.caller).toEqual(a.caller); // Original attribution survives replacement endpoints.
    expect(await finish<ResultValue>(await prepare(a, 1n, "2"))).toEqual({ err: expect.stringContaining("request_conflict") });
    expect(await status(b)).toEqual({ err: "not_found" });
    const bPreparing = await prepare(b);
    const cPreparing = await prepare(c, 42161n);
    await suspended("nonce:1", 2n);
    await suspended("nonce:42161");
    expect((await observations()).commands).toBe(3n);
    await release("nonce:42161");
    const cp = ok(await finish<ResultValue>(cPreparing));
    expect(cp.nonce).toEqual(["0"]);
    expect(cp.caller).toEqual(c.caller);
    expect(ok(await status(a, false)).status).toBe("preparing");
    await release("nonce:1");
    const ap = ok(await finish<ResultValue>(aPreparing));
    const bp = ok(await finish<ResultValue>(bPreparing));
    expect(ap.operation_id).toBe(replay.operation_id);
    expect(ap.operation_id).not.toBe(bp.operation_id);
    expect(ap.nonce).toEqual(["0"]);
    expect(bp.nonce).toEqual(["0"]);
    expect((await observations()).attempts).toHaveLength(0);

    const aSigning = await execute(a, ap.review_revision);
    await suspended(`sign:${ap.operation_id}`);
    expect(ok(await finish<ResultValue>(await execute(a, ap.review_revision))).status).toBe("signing");
    expect(ok(await status(a)).status).toBe("signing");
    const revisedB = ok(await finish<ResultValue>(await execute(b, bp.review_revision)));
    expect(revisedB.status).toBe("prepared");
    expect(revisedB.nonce).toEqual(["1"]);
    expect(revisedB.review_revision).toBe(bp.review_revision + 1n);
    expect(await finish<ResultValue>(await execute(b, bp.review_revision))).toEqual({ err: expect.stringContaining("review_changed") });
    expect((await observations()).attempts).toHaveLength(1);

    // Two documented pre-dispatch failures are retryable. Neither releases
    // signed bytes or advances the separate chain's nonce space.
    await signerError(cp.operation_id, "busy");
    const cBusy = await execute(c, cp.review_revision);
    await suspended(`sign:${cp.operation_id}`);
    const bSigning = await execute(b, revisedB.review_revision);
    await suspended(`sign:${bp.operation_id}`);
    let seen = await observations();
    expect(seen.attempts.map((v) => [v.caller.installation_uid, v.chain_id, v.nonce])).toEqual([[101n, 1n, ["0"]], [101n, 42161n, ["0"]], [102n, 1n, ["1"]]]);
    expect(seen.attempts.map((v) => v.caller)).toEqual([a.caller, c.caller, b.caller]);
    await release(`sign:${cp.operation_id}`, 1n);
    expect(ok(await finish<ResultValue>(cBusy)).status).toBe("prepared");
    await signerError(cp.operation_id, "disabled");
    const cDisabled = await execute(c, cp.review_revision);
    await suspended(`sign:${cp.operation_id}`, 2n);
    await release(`sign:${cp.operation_id}`, 2n);
    expect(ok(await finish<ResultValue>(cDisabled)).status).toBe("prepared");
    expect((await observations()).broadcasts).toHaveLength(0);

    // Complete B before A, then C before A. The older suspended callback must
    // still sign/broadcast A's original chain, nonce and installation.
    await release(`sign:${bp.operation_id}`, 1n);
    await suspended(`broadcast:${bp.operation_id}`);
    expect(ok(await status(a)).status).toBe("signing");
    expect(ok(await finish<ResultValue>(await execute(b, revisedB.review_revision))).status).toBe("submitted");
    expect((await observations()).broadcasts).toHaveLength(1);
    await release(`broadcast:${bp.operation_id}`);
    expect(ok(await finish<ResultValue>(bSigning)).status).toBe("submitted");
    await signerError(cp.operation_id, "");
    const cSigning = await execute(c, cp.review_revision);
    await suspended(`sign:${cp.operation_id}`, 3n);
    await release(`sign:${cp.operation_id}`, 3n);
    await suspended(`broadcast:${cp.operation_id}`);
    await release(`broadcast:${cp.operation_id}`);
    expect(ok(await finish<ResultValue>(cSigning)).status).toBe("submitted");
    expect(ok(await status(a)).status).toBe("signing");
    await release(`sign:${ap.operation_id}`, 1n);
    await suspended(`broadcast:${ap.operation_id}`);
    expect(ok(await finish<ResultValue>(await execute(a, ap.review_revision))).status).toBe("submitted");
    expect(ok(await status(a)).status).toBe("submitted");
    await release(`broadcast:${ap.operation_id}`);
    const sentA = ok(await finish<ResultValue>(aSigning));
    expect(sentA.caller).toEqual(a.caller);
    expect(ok(await finish<ResultValue>(await prepare(a))).transaction_hash).toEqual(sentA.transaction_hash);
    expect(await finish<ResultValue>(await prepare(a, 42161n))).toEqual({ err: expect.stringContaining("request_conflict") });
    seen = await observations();
    expect(seen.broadcasts).toHaveLength(3);
    expect(new Set(seen.broadcasts).size).toBe(3);
    const decoded = seen.broadcasts.map((raw) => Transaction.from(raw));
    expect(decoded.map((tx) => [tx.chainId, tx.nonce])).toEqual([[1n, 1], [42161n, 0], [1n, 0]]);
    for (const tx of decoded) {
      expect(tx.from?.toLowerCase()).toBe("0x7e5f4552091a69125d5dfcb7b8c2659029395bdf");
      expect(tx.to?.toLowerCase()).toBe("0x0000000000000000000000000000000000000002");
      expect(tx.value).toBe(1n);
      expect(tx.type).toBe(2);
    }
    expect(sentA.transaction_hash).toEqual([decoded[2]!.hash!]);
    expect(seen.attempts.filter((v) => v.operation_id === ap.operation_id)).toHaveLength(1);
    expect(seen.attempts.filter((v) => v.operation_id === bp.operation_id)).toHaveLength(1);

    // An ambiguous callback is different from Busy/disabled: refreshing and
    // replaying the same intent must never call the signer a second time.
    const d = identity(103n, "3");
    const dp = ok(await finish<ResultValue>(await prepare(d, 1n, "1", true)));
    await signerError(dp.operation_id, "outcome_unknown");
    const dSigning = await execute(d, dp.review_revision);
    await suspended(`sign:${dp.operation_id}`);
    expect(ok(await status(d)).status).toBe("signing");
    await release(`sign:${dp.operation_id}`, 1n);
    expect(ok(await finish<ResultValue>(dSigning)).status).toBe("unknown");
    await signerError(dp.operation_id, "");
    expect(ok(await finish<ResultValue>(await execute(d, dp.review_revision))).status).toBe("unknown");
    expect(ok(await status(d)).status).toBe("unknown");
    expect(ok(await finish<ResultValue>(await prepare(d, 1n, "1", true))).status).toBe("unknown");
    seen = await observations();
    expect(seen.attempts.filter((v) => v.operation_id === dp.operation_id)).toHaveLength(1);
    expect(seen.broadcasts).toHaveLength(3);
    console.log("Real ingress overlap passed: delayed RPC/signing/broadcast, out-of-order callbacks, nonce review revision, caller/chain isolation and definitive/ambiguous signer outcomes");
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
}, 180_000);
