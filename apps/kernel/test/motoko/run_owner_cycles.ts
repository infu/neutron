import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { disposeMotokoCompiler, loadMotoko } from "neutron-motoko-wasm";
import { prepareMotokoProgram } from "neutron-scripts/src/motoko.js";
import { parsePackageString } from "neutron-scripts/src/walk.js";
import { resolvePocketIcBinary, pocketIcServerArguments } from "../../../../packages/neutron-provision/src/pocketic_binary.ts";
import { PocketIcRestClient, createNeutronPocketIcInstanceConfig } from "../../../../packages/neutron-provision/src/pocketic_rest.ts";
import { managementIdl } from "../../../../packages/neutron-provision/src/idl.ts";

// Only disposable PocketIC actors are touched. This tests the production
// service/root/raw-transport combination, not a full assembled Kernel upgrade;
// the release memory planner separately verifies installed schema lineage.
const T = 1_000_000_000_000n;
const Blob = IDL.Vec(IDL.Nat8);
const Error = IDL.Record({ code: IDL.Text, message: IDL.Text });
const Scope = IDL.Record({ app_id: IDL.Text, installation_uid: IDL.Nat64 });
const Call = IDL.Record({ canister: IDL.Principal, method: IDL.Text, args: Blob, cycles: IDL.Nat });
const Request = IDL.Record({ id: Blob, app_scope: Scope, call: Call, allow_partial: IDL.Bool });
const Receipt = IDL.Record({
  request: Request, sequence: IDL.Nat, created_at: IDL.Nat64, updated_at: IDL.Nat64,
  dispatched: IDL.Bool, actual_cycles: IDL.Nat,
  result: IDL.Opt(IDL.Variant({ ok: Blob, err: Error })), charged_cycles: IDL.Opt(IDL.Nat),
});
const Result = IDL.Variant({ ok: Receipt, err: Error });
const Quote = IDL.Variant({ ok: IDL.Record({
  balance: IDL.Nat, call_cost: IDL.Nat, min_remaining_cycles: IDL.Nat,
  max_cycles: IDL.Nat, actual_cycles: IDL.Nat,
  max_cycles_per_call: IDL.Nat, max_cycles_per_day: IDL.Nat,
}), err: Error });
const LedgerSnapshot = IDL.Record({ deposits: IDL.Nat, accepted: IDL.Nat, balance: IDL.Nat });
type Saved = {
  request: { call: { cycles: bigint } }; actual_cycles: bigint; dispatched: boolean;
  result: ({ ok: Uint8Array } | { err: { code: string; message: string } })[];
  charged_cycles: bigint[];
};
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "kernel-owner-cycles-"));
try {
  const sources = await promisify(execFile)("mops", ["sources"]);
  const packages = parsePackageString(sources.stdout.replace(/\n/g, " ").trim());
  const compiler = await loadMotoko();
  const wasms: Uint8Array[] = [];
  try {
    for (const name of ["OwnerCycleLedger.mo", "OwnerCycleKernel.mo"]) {
      const prepared = await prepareMotokoProgram({ compiler,
        sourcePath: path.join(import.meta.dir, "fixtures", name), packages, allowDangerous: true });
      wasms.push((await compiler.wasm(prepared.entryPath, "ic")).wasm);
    }
  } finally {
    await disposeMotokoCompiler();
  }
  const binary = await resolvePocketIcBinary({ cacheDirectory: path.resolve("../../.neutron/cache/bin") });
  const portFile = path.join(temporary, "pocketic.port");
  const server = spawn(binary.path, pocketIcServerArguments(portFile, 60), { stdio: "ignore" });
  const stopped = new Promise<void>((resolve) => server.once("close", () => resolve()));
  let startupError: globalThis.Error | undefined;
  server.on("error", (error) => { startupError = error; });
  let client: PocketIcRestClient | undefined;
  let instanceId: number | undefined;
  try {
    const deadline = Date.now() + 30_000;
    let port = "";
    while (!port) {
      if (startupError) throw startupError;
      if (server.exitCode !== null) throw new globalThis.Error("Owner cycles PocketIC exited during startup");
      if (Date.now() > deadline) throw new globalThis.Error("Owner cycles PocketIC startup timed out");
      port = await fs.readFile(portFile, "utf8").then((value) => value.trim()).catch(() => "");
      if (!port) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const controlUrl = `http://127.0.0.1:${port}/`;
    client = new PocketIcRestClient(controlUrl);
    const config = createNeutronPocketIcInstanceConfig({ profile: "minimal", stateDirectory: path.join(temporary, "state") });
    const response = await fetch(new URL("instances", controlUrl), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...config,
        subnet_config_set: { ...config.subnet_config_set, nns: null, ii: null, test_threshold_keys: null },
        http_gateway_config: null, icp_features: { ...config.icp_features, ii: null },
      }), signal: AbortSignal.timeout(30_000),
    });
    const created = await response.json() as { Created?: {
      instance_id: number; topology: { default_effective_canister_id: { canister_id: string } };
    } };
    assert(response.ok && created.Created, `PocketIC creation failed: ${JSON.stringify(created)}`);
    instanceId = created.Created.instance_id;
    const defaultEffective = { CanisterId: created.Created.topology.default_effective_canister_id.canister_id };
    const owner = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");
    const management = Principal.fromText("aaaaa-aa");
    const methods = new Map(managementIdl({ IDL })._fields);
    const effective = (canister: Principal) => ({ CanisterId: Buffer.from(canister.toUint8Array()).toString("base64") });
    const args = (types: IDL.Type[], values: unknown[]) => new Uint8Array(IDL.encode(types, values));
    const call = async (canisterId: Principal, method: string, payload: Uint8Array,
      sender = owner, effectivePrincipal = effective(canisterId)) =>
      client!.awaitIngressMessage(instanceId!, await client!.submitIngressMessage(instanceId!, {
        sender, canisterId, method, payload, effectivePrincipal,
      }));
    const query = async (canisterId: Principal, method: string, payload: Uint8Array, types: IDL.Type[]) =>
      IDL.decode(types, await client!.queryCanister(instanceId!, {
        sender: owner, canisterId, method, payload, effectivePrincipal: effective(canisterId),
      }));
    async function create(amount: bigint) {
      const method = methods.get("provisional_create_canister_with_cycles")!;
      const reply = await call(management, "provisional_create_canister_with_cycles", args(method.argTypes, [{
        amount: [amount], settings: [], specified_id: [], sender_canister_version: [],
      }]), owner, defaultEffective);
      return (IDL.decode(method.retTypes, reply)[0] as { canister_id: Principal }).canister_id;
    }
    async function install(canister: Principal, wasm: Uint8Array, init: Uint8Array, upgrade = false) {
      const method = methods.get("install_code")!;
      await call(management, "install_code", args(method.argTypes, [{
        mode: upgrade ? { upgrade: [{ skip_pre_upgrade: [], wasm_memory_persistence: [{ keep: null }] }] } : { install: null }, canister_id: canister,
        wasm_module: wasm, arg: init, sender_canister_version: [],
      }]), owner, effective(canister));
    }
    const ledger = await create(T);
    await install(ledger, wasms[0]!, args([], []));
    const kernel = await create(55n * T);
    const init = args([IDL.Principal, IDL.Principal], [ledger, owner]);
    await install(kernel, wasms[1]!, init);
    const id = (value: number) => Uint8Array.from({ length: 16 }, (_, index) => index === 15 ? value : 0);
    const input = (value: number, amount: bigint, partial = false) => args([Blob, IDL.Nat, IDL.Bool], [id(value), amount, partial]);
    const decodeResult = (reply: Uint8Array) => IDL.decode([Result], reply)[0] as { ok?: Saved; err?: { code: string } };
    const execute = async (value: number, amount: bigint, partial = false) => decodeResult(await call(kernel, "execute", input(value, amount, partial)));
    const snapshot = async () => (await query(ledger, "snapshot", args([IDL.Principal], [kernel]), [LedgerSnapshot]))[0] as {
      deposits: bigint; accepted: bigint; balance: bigint;
    };
    const status = async (value: number) => ((await query(kernel, "status", args([Blob], [id(value)]), [IDL.Opt(Receipt)]))[0] as Saved[])[0];
    const balance = async () => (await query(kernel, "balance", args([], []), [IDL.Nat]))[0] as bigint;
    const quote = async (value: number, amount: bigint, partial = false) =>
      (await query(kernel, "quote", input(value, amount, partial), [Quote]))[0] as {
        ok?: { balance: bigint; call_cost: bigint; min_remaining_cycles: bigint; max_cycles: bigint; actual_cycles: bigint;
          max_cycles_per_call: bigint; max_cycles_per_day: bigint };
      };
    const rejectedOwner = decodeResult(await call(kernel, "execute", input(1, T), Principal.anonymous()));
    assert.equal(rejectedOwner.err?.code, "unauthorized");
    assert.equal((await snapshot()).deposits, 0n);
    const reviewed = (await quote(1, T)).ok!;
    assert.equal(reviewed.max_cycles_per_call, 100_000_000n);
    assert.equal(reviewed.max_cycles_per_day, 100_000_000n);
    assert.equal(reviewed.min_remaining_cycles, 5n * T);
    assert(T > reviewed.max_cycles_per_call);
    const first = (await execute(1, T)).ok!;
    assert(first.dispatched && first.result[0] && "ok" in first.result[0]);
    assert.equal(first.actual_cycles, T);
    assert.deepEqual(first.charged_cycles, [T]);
    assert.deepEqual(await snapshot(), { deposits: 1n, accepted: T, balance: T - 100_000_000n });
    const [depositReceipt] = IDL.decode([IDL.Record({ balance: IDL.Nat, block_index: IDL.Nat })], first.result[0].ok);
    assert.deepEqual(depositReceipt, { balance: T - 100_000_000n, block_index: 0n });

    // Keep a real remote call unresolved while checking the saved pre-await
    // receipt and repeating its ID. No ledger-level dedup can hide a resend.
    await call(ledger, "set_paused", args([IDL.Bool], [true]));
    const pending = await client.submitIngressMessage(instanceId, {
      sender: owner, canisterId: kernel, method: "execute", payload: input(2, 2n * T), effectivePrincipal: effective(kernel),
    });
    for (let attempt = 0; attempt < 20 && (await snapshot()).deposits < 2n; attempt++) {
      const tick = await fetch(new URL(`instances/${instanceId}/update/tick`, controlUrl), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(30_000),
      });
      assert(tick.ok, `PocketIC tick failed: ${await tick.text()}`);
    }
    assert.equal((await snapshot()).deposits, 2n);
    assert.equal((await status(2))?.dispatched, true);
    assert.deepEqual((await status(2))?.result, []);
    const pendingAgain = (await execute(2, 2n * T)).ok!;
    assert(pendingAgain.dispatched);
    assert.deepEqual(pendingAgain.result, []);
    assert.equal((await snapshot()).deposits, 2n);
    await call(ledger, "set_paused", args([IDL.Bool], [false]));
    const second = decodeResult(await client.awaitIngressMessage(instanceId, pending)).ok!;
    assert(second.result[0] && "ok" in second.result[0]);
    assert.equal((await execute(2, 2n * T)).ok?.actual_cycles, 2n * T);
    assert.equal((await execute(2, 3n * T)).err?.code, "request_conflict");

    // An actual Wasm upgrade preserves the immutable request and its original
    // Candid response, while transient service/broker instances are rebuilt.
    await install(kernel, wasms[1]!, init, true);
    assert.deepEqual(await status(1), first);
    assert.deepEqual(await status(2), second);
    assert.deepEqual((await execute(1, T)).ok, first);
    assert.equal((await snapshot()).deposits, 2n);
    const tooMuch = (await execute(3, 100n * T)).ok!;
    assert.equal(tooMuch.dispatched, false);
    assert.equal(tooMuch.actual_cycles, 0n);
    assert(tooMuch.result[0] && "err" in tooMuch.result[0]);
    assert.equal(tooMuch.result[0].err.code, "low_cycles");
    assert.equal((await snapshot()).deposits, 2n);

    const maximum = (await quote(4, 100n * T, true)).ok!;
    assert.equal(maximum.max_cycles, maximum.balance - 5n * T - maximum.call_cost);
    assert.equal(maximum.actual_cycles, maximum.max_cycles);
    const last = (await execute(4, 100n * T, true)).ok!;
    assert(last.dispatched && last.actual_cycles > 46n * T && last.actual_cycles <= maximum.max_cycles);
    const finalLedger = await snapshot();
    assert.deepEqual(finalLedger, {
      deposits: 3n, accepted: 3n * T + last.actual_cycles,
      balance: 3n * T + last.actual_cycles - 300_000_000n,
    });
    // Admission uses the actual live balance, including IC execution reserves.
    // A Max dispatch must succeed and leave the owner's operating reserve.
    const remaining = await balance();
    assert(remaining >= 5n * T && remaining < 6n * T,
      `Unexpected post-Max balance ${remaining}; actual transfer ${last.actual_cycles}, quote ${JSON.stringify(maximum, (_key, value) => typeof value === "bigint" ? value.toString() : value)}`);
    assert.deepEqual((await execute(4, 100n * T, true)).ok, last);
    assert.deepEqual(await snapshot(), finalLedger);
    console.log(`Owner cycle calls PocketIC passed: attached ${last.actual_cycles} cycles on partial Max, remaining ${remaining}; 3 deposits, pending/terminal duplicate protection and real memory restoration upgrade verified.`);
  } finally {
    try {
      if (client && instanceId !== undefined) await client.deleteInstance(instanceId);
    } finally {
      server.kill("SIGTERM");
      await stopped;
    }
  }
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
