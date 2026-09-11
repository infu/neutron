import assert from "node:assert/strict";
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
import { pocketIcServerArguments, resolvePocketIcBinary } from "neutron-provision/src/pocketic_binary.ts";
import { createNeutronPocketIcInstanceConfig, PocketIcRestClient, type PocketIcIngressMessage } from "neutron-provision/src/pocketic_rest.ts";
import { managementIdl } from "neutron-provision/src/idl.ts";

const Blob = IDL.Vec(IDL.Nat8);
const StepInput = IDL.Record({ step_id: IDL.Text, args: Blob, method: IDL.Opt(IDL.Text) });
const Prepare = IDL.Record({ operation_id: IDL.Text, sns: IDL.Principal, governance: IDL.Principal,
  kind: IDL.Opt(IDL.Text), title: IDL.Opt(IDL.Text),
  input_json: IDL.Text, review_json: IDL.Text, state_json: IDL.Text, initiator: IDL.Text, steps: IDL.Vec(StepInput) });
const Step = IDL.Record({ step_id: IDL.Text, args: Blob, method: IDL.Text, status: IDL.Text, reply: IDL.Opt(Blob), error: IDL.Opt(IDL.Text),
  attempted_at_seconds: IDL.Opt(IDL.Nat64), finished_at_seconds: IDL.Opt(IDL.Nat64) });
const Detail = IDL.Record({ operation_id: IDL.Text, sns: IDL.Principal, governance: IDL.Principal,
  kind: IDL.Text, title: IDL.Text,
  input_json: IDL.Text, review_json: IDL.Text, state_json: IDL.Text, revision: IDL.Nat, initiator: IDL.Text,
  seq: IDL.Nat, created_at_seconds: IDL.Nat64, updated_at_seconds: IDL.Nat64, steps: IDL.Vec(Step) });
const Result = IDL.Variant({ ok: Detail, err: IDL.Text });
const Dispatch = IDL.Record({ operation_id: IDL.Text, step_id: IDL.Text });
const Update = IDL.Record({ operation_id: IDL.Text, expected_revision: IDL.Nat, state_json: IDL.Text });
const SnsUpsert = IDL.Record({ sns: IDL.Principal, governance: IDL.Principal, voting_enabled: IDL.Bool,
  agent_voting_enabled: IDL.Bool, label_text: IDL.Text });
const ConfigResult = IDL.Variant({ ok: IDL.Null, err: IDL.Text });
const ListQuery = IDL.Record({ before: IDL.Opt(IDL.Nat), limit: IDL.Nat });
// Summary metadata is additive; detail checks below separately verify every
// immutable input, raw byte and receipt field.
const Page = IDL.Record({ rows: IDL.Vec(IDL.Record({ operation_id: IDL.Text, seq: IDL.Nat, kind: IDL.Text, title: IDL.Text })),
  next_before: IDL.Opt(IDL.Nat), total: IDL.Nat });
const Observations = IDL.Vec(IDL.Record({ args: Blob, method: IDL.Text, reply: IDL.Opt(Blob) }));
const Legacy = IDL.Record({
  config: IDL.Record({ snses: IDL.Vec(IDL.Record({ sns: IDL.Principal, governance: IDL.Principal,
    voting_enabled: IDL.Bool, agent_voting_enabled: IDL.Bool, label_text: IDL.Text, added_at_seconds: IDL.Nat64 })),
    audit_rows: IDL.Nat, max_audit_rows: IDL.Nat, draft_count: IDL.Nat }),
  drafts: IDL.Vec(IDL.Record({ id: IDL.Nat, title: IDL.Text, payload: IDL.Opt(Blob) })),
});
type Input = { operation_id: string; kind: string[]; title: string[]; sns: Principal; governance: Principal; input_json: string; review_json: string;
  state_json: string; initiator: string; steps: { step_id: string; args: Uint8Array; method: string[] }[] };
type Saved = Omit<Input, "steps" | "kind" | "title"> & { kind: string; title: string; seq: bigint; revision: bigint; created_at_seconds: bigint; updated_at_seconds: bigint;
  steps: { step_id: string; args: Uint8Array; method: string; status: string; reply: Uint8Array[]; error: string[];
    attempted_at_seconds: bigint[]; finished_at_seconds: bigint[] }[] };
type Outcome = { ok: Saved } | { err: string };
type PageValue = { rows: { operation_id: string; seq: bigint; kind: string; title: string }[]; next_before: bigint[]; total: bigint };
const bytes = (value: string) => new TextEncoder().encode(value);
const encode = (types: IDL.Type[], values: unknown[]) => new Uint8Array(IDL.encode(types, values));
function ok(result: Outcome): Saved {
  if ("err" in result) throw new Error(result.err);
  return result.ok;
}
function conflict(result: Outcome): void { assert("err" in result, "Expected rejected conflicting operation input or revision"); }
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// The only actors installed or upgraded are owned disposable fixtures. The
// production backend and memory modules are compiled directly, with classical
// persistence as used by the release compiler. This is not a package-lineage
// qualification; that remains covered by the separate release memory tests.
const appRoot = path.resolve(import.meta.dir, "..");
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "snsgov-journal-pocketic-"));
let server: ChildProcess | undefined;
let stopped: Promise<void> | undefined;
let client: PocketIcRestClient | undefined;
let instanceId: number | undefined;
try {
  const sources = await promisify(execFile)("mops", ["sources"], { cwd: appRoot });
  const packages = Object.fromEntries(Object.entries(parsePackageString(sources.stdout.replace(/\n/g, " ").trim()))
    .map(([name, directory]) => [name, path.resolve(appRoot, directory)]));
  const compiler = await loadMotoko();
  let gateWasm: Uint8Array;
  let originalWasm: Uint8Array;
  let successorWasm: Uint8Array;
  try {
    await compiler.configurePersistence("classical");
    const gateProgram = await prepareMotokoProgram({ compiler, sourcePath: path.join(import.meta.dir, "fixtures/journal/gate.mo"), packages, allowDangerous: true });
    gateWasm = (await compiler.wasm(gateProgram.entryPath, "ic")).wasm;
    const program = await prepareMotokoProgram({ compiler, sourcePath: path.join(import.meta.dir, "fixtures/journal/app.mo"), packages, allowDangerous: true });
    originalWasm = (await compiler.wasm(program.entryPath, "ic")).wasm;
    const source = await compiler.read(program.entryPath);
    const upgradedSource = source.replace("fixture_version() : async Nat { 1 }", "fixture_version() : async Nat { 2 }");
    assert.notEqual(upgradedSource, source, "The fixture successor must contain a visible code change");
    await compiler.write(program.entryPath, upgradedSource);
    successorWasm = (await compiler.wasm(program.entryPath, "ic")).wasm;
    assert.notDeepEqual(successorWasm, originalWasm);
  } finally { await disposeMotokoCompiler(); }

  const binary = await resolvePocketIcBinary({ cacheDirectory: path.resolve(appRoot, "../../.neutron/cache/bin") });
  const portFile = path.join(temporary, "pocketic.port");
  server = spawn(binary.path, pocketIcServerArguments(portFile, 180), { stdio: ["ignore", "ignore", "pipe"] });
  stopped = new Promise<void>((resolve) => server!.once("close", () => resolve()));
  let serverError = "";
  server.stderr?.on("data", (chunk) => { serverError = (serverError + String(chunk)).slice(-8192); });
  let startupError: Error | undefined;
  server.on("error", (error) => { startupError = error; });
  const startupDeadline = Date.now() + 15_000;
  let port = "";
  while (!port) {
    if (startupError) throw startupError;
    if (server.exitCode !== null || Date.now() > startupDeadline) throw new Error(`SNS journal PocketIC startup failed: ${serverError}`);
    port = await fs.readFile(portFile, "utf8").then(value => value.trim()).catch(() => "");
    if (!port) await delay(25);
  }
  const controlUrl = `http://127.0.0.1:${port}/`;
  client = new PocketIcRestClient(controlUrl);
  const config = createNeutronPocketIcInstanceConfig({ profile: "minimal", stateDirectory: path.join(temporary, "state") });
  const response = await fetch(new URL("instances", controlUrl), { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...config, subnet_config_set: { ...config.subnet_config_set, nns: null, ii: null, test_threshold_keys: null },
      http_gateway_config: null, icp_features: { ...config.icp_features, ii: null } }), signal: AbortSignal.timeout(30_000) });
  const created = await response.json() as { Created?: { instance_id: number; topology: { default_effective_canister_id: { canister_id: string } } } };
  assert(response.ok && created.Created, `PocketIC instance creation failed: ${JSON.stringify(created)}`);
  instanceId = created.Created.instance_id;
  const defaultEffective = { CanisterId: created.Created.topology.default_effective_canister_id.canister_id };
  const sender = Principal.anonymous();
  const management = Principal.fromText("aaaaa-aa");
  const methods = new Map(managementIdl({ IDL })._fields);
  const effective = (canister: Principal) => ({ CanisterId: Buffer.from(canister.toUint8Array()).toString("base64") });
  const submit = (canisterId: Principal, method: string, types: IDL.Type[], values: unknown[], effectivePrincipal = effective(canisterId)) =>
    client!.submitIngressMessage(instanceId!, { sender, canisterId, method, payload: encode(types, values), effectivePrincipal });
  async function finish<T>(pending: PocketIcIngressMessage, returns: IDL.Type[] = [Result]): Promise<T> {
    return IDL.decode(returns, await client!.awaitIngressMessage(instanceId!, pending))[0] as T;
  }
  async function call<T>(canister: Principal, method: string, types: IDL.Type[], values: unknown[], returns: IDL.Type[] = [Result]): Promise<T> {
    return finish<T>(await submit(canister, method, types, values), returns);
  }
  async function query<T>(canisterId: Principal, method: string, types: IDL.Type[], values: unknown[], returns: IDL.Type): Promise<T> {
    return IDL.decode([returns], await client!.queryCanister(instanceId!, { sender, canisterId, method,
      payload: encode(types, values), effectivePrincipal: effective(canisterId) }))[0] as T;
  }
  async function createCanister(): Promise<Principal> {
    const method = methods.get("provisional_create_canister_with_cycles")!;
    const result = await finish<{ canister_id: Principal }>(await submit(management, "provisional_create_canister_with_cycles", method.argTypes,
      [{ amount: [100_000_000_000_000n], settings: [], specified_id: [], sender_canister_version: [] }], defaultEffective), method.retTypes);
    return result.canister_id;
  }
  async function install(canister: Principal, wasm: Uint8Array, init: Uint8Array, upgrade = false): Promise<void> {
    const method = methods.get("install_code")!;
    await finish(await submit(management, "install_code", method.argTypes, [{ mode: upgrade ? { upgrade: [] } : { install: null },
      canister_id: canister, wasm_module: wasm, arg: init, sender_canister_version: [] }], effective(canister)), method.retTypes);
  }
  const gate = await createCanister();
  await install(gate, gateWasm, encode([], []));
  const journal = await createCanister();
  const init = encode([IDL.Principal], [gate]);
  await install(journal, originalWasm, init);
  const sns = Principal.fromText("extk7-gaaaa-aaaaq-aacda-cai");
  const prepare = (request: Input) => call<Outcome>(journal, "prepare", [Prepare], [request]);
  const get = async (id: string) => (await query<Saved[]>(journal, "get", [IDL.Text], [id], IDL.Opt(Detail)))[0];
  const dispatch = (id: string, step_id: string) => submit(journal, "dispatch", [Dispatch], [{ operation_id: id, step_id }]);
  const update = (id: string, revision: bigint, state: string) => call<Outcome>(journal, "update", [Update], [{ operation_id: id, expected_revision: revision, state_json: state }]);
  const list = (before: bigint[] = [], limit = 2n) => query<PageValue>(journal, "list", [ListQuery], [{ before, limit }], Page);
  const observations = () => query<{ args: Uint8Array; method: string; reply: Uint8Array[] }[]>(gate, "observations", [], [], Observations);
  const configure = (args: Uint8Array, reply: Uint8Array, mode = "reply") => call(gate, "configure", [Blob, Blob, IDL.Text], [args, reply, mode], []);
  const release = (args: Uint8Array) => call(gate, "release", [Blob], [args], []);
  const removeSns = () => call(journal, "remove", [IDL.Principal], [sns], [ConfigResult]);
  const configureSns = (governance: Principal, enabled = true, agentVotingEnabled = true) => call(journal, "configure", [SnsUpsert], [{
    sns, governance, voting_enabled: enabled, agent_voting_enabled: agentVotingEnabled, label_text: "Retained SNS",
  }], [ConfigResult]);
  async function suspended(args: Uint8Array): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const count = await query<bigint>(gate, "entered", [Blob], [args], IDL.Nat);
      assert(count <= 1n, "The broker dispatched the same step more than once");
      if (count === 1n) return;
      // The instance already advances automatically. Explicit tick requests
      // can race that job and receive HTTP 409; queries use the REST client's
      // serialized operation handling while the replica advances normally.
      await delay(10);
    }
    assert.fail("Remote broker call did not suspend exactly once");
  }
  const input = (id: string, args: Uint8Array): Input => ({ operation_id: id, sns, governance: gate,
    kind: [], title: [],
    input_json: '{"command":"ManageNeuron"}', review_json: '{"review":"original displayed command"}',
    state_json: '{"phase":"reviewed"}', initiator: "user", steps: [{ step_id: "first", args, method: [] }] });

  assert.equal(await query(journal, "fixture_version", [], [], IDL.Nat), 1n);
  assert.equal(await get("absent"), undefined);
  assert.deepEqual(await list(), { rows: [], next_before: [], total: 0n });
  const emptyLegacy = await query<any>(journal, "legacy", [], [], Legacy);
  assert.equal(emptyLegacy.config.draft_count, 0n);
  assert.deepEqual(emptyLegacy.config.snses, []);

  // Payloads larger than the old relay's 100 KB limit must remain byte exact.
  const largeArgs = Uint8Array.from({ length: 120_001 }, (_, index) => index % 251);
  const secondArgs = bytes("second independently dispatched neuron");
  const firstReply = Uint8Array.from([68, 73, 68, 76, 0, 255, 0, 17]);
  const secondReply = bytes("original second raw SNS response");
  const original = { ...input("concurrent", largeArgs), initiator: "agent", input_json: JSON.stringify({ nested: { kind: "ignored" }, payload: "x".repeat(100_001), values: Array(20_001).fill("x"), kind: "manage_batch" }),
    kind: ["manage_batch"], title: ["Review 😄 actions"],
    review_json: '{"nested":[{"title":"ignored","value":"\\\"},]\\\""}],"title":"Review \\ud83d\\ude04 actions"}',
    steps: [{ step_id: "first", args: largeArgs, method: [] }, { step_id: "second", args: secondArgs, method: [] }] };
  const prepared = ok(await prepare(original));
  assert.equal(prepared.revision, 0n);
  assert(prepared.steps.every(step => step.status === "prepared" && step.reply.length === 0));
  const summary = (await list()).rows[0]!;
  assert.equal(summary.kind, "manage_batch");
  assert.equal(summary.title, 'Review 😄 actions');
  // Preparation does not require a signing grant. Dispatch does, and a denied
  // attempt must leave the retained operation available for later approval.
  conflict(await finish<Outcome>(await dispatch(original.operation_id, "first")));
  assert.deepEqual(await get(original.operation_id), prepared);
  assert.deepEqual(await observations(), []);
  await call(journal, "seedLegacy", [IDL.Principal], [sns], []);
  // Reviewed operation dispatch has its own frontend approval boundary. Keep
  // honest agent attribution while proving legacy automatic-agent voting is
  // not a prerequisite for this already reviewed, enabled SNS operation.
  assert.deepEqual(await configureSns(gate, true, false), { ok: null });
  assert.equal((await query<any>(journal, "legacy", [], [], Legacy)).config.snses[0].agent_voting_enabled, false);
  assert.deepEqual(ok(await prepare(original)), prepared);
  for (const changed of [
    { kind: ["changed"] }, { title: ["changed"] },
    { sns: gate }, { governance: sns }, { initiator: "user" }, { input_json: "changed input" },
    { review_json: "changed review" }, { state_json: "changed initial state" },
    { steps: [{ ...original.steps[0]!, args: bytes("changed bytes") }, original.steps[1]!] },
    { steps: [{ ...original.steps[0]!, step_id: "renamed" }, original.steps[1]!] },
    { steps: [{ ...original.steps[0]!, method: ["reset_timers"] }, original.steps[1]!] },
    { steps: [original.steps[1]!, original.steps[0]!] }, { steps: [original.steps[0]!] },
  ]) conflict(await prepare({ ...original, ...changed }));
  assert.deepEqual(await get(original.operation_id), prepared);
  const reviewed = ok(await update(original.operation_id, prepared.revision, '{"phase":"dispatch-approved","receipt":"original"}'));
  assert.equal(reviewed.revision, prepared.revision + 1n);
  conflict(await update(original.operation_id, prepared.revision, '{"phase":"stale"}'));
  await configure(largeArgs, firstReply);
  await configure(secondArgs, secondReply);
  const firstPending = await dispatch(original.operation_id, "first");
  await suspended(largeArgs);
  const firstSuspended = (await get(original.operation_id))!;
  assert.equal(firstSuspended.initiator, "agent");
  assert.equal(firstSuspended.steps[0]!.status, "dispatching");
  assert.equal(firstSuspended.revision, reviewed.revision + 1n);
  assert.equal(firstSuspended.steps[0]!.attempted_at_seconds.length, 1);
  assert.deepEqual(firstSuspended.steps[0]!.reply, []);
  assert.deepEqual(ok(await finish<Outcome>(await dispatch(original.operation_id, "first"))), firstSuspended);
  assert.deepEqual(ok(await prepare(original)), firstSuspended);
  assert.equal((await observations()).length, 1);
  const secondPending = await dispatch(original.operation_id, "second");
  await suspended(secondArgs);
  const bothPending = (await get(original.operation_id))!;
  assert(bothPending.steps.every(step => step.status === "dispatching"));
  conflict(await update(original.operation_id, reviewed.revision, '{"phase":"prepared"}'));
  await release(secondArgs);
  const secondFinished = ok(await finish<Outcome>(secondPending));
  assert.equal(secondFinished.steps[0]!.status, "dispatching");
  assert.equal(secondFinished.steps[1]!.status, "replied");
  assert.deepEqual(secondFinished.steps[1]!.reply, [secondReply]);
  const receiptState = '{"phase":"partial","second":{"reply":"retained original receipt"}}';
  const withReceipt = ok(await update(original.operation_id, secondFinished.revision, receiptState));
  await release(largeArgs);
  const completed = ok(await finish<Outcome>(firstPending));
  assert.equal(completed.revision, withReceipt.revision + 1n);
  assert.equal(completed.state_json, receiptState, "A late callback must preserve the concurrent CAS state");
  assert(completed.steps.every(step => step.status === "replied" && step.finished_at_seconds.length === 1));
  assert.deepEqual(completed.steps.map(step => step.args), [largeArgs, secondArgs]);
  assert.deepEqual(completed.steps.map(step => step.reply), [[firstReply], [secondReply]]);
  assert(completed.steps.every(step => step.method === "manage_neuron"));
  assert.deepEqual(ok(await finish<Outcome>(await dispatch(original.operation_id, "first"))), completed);
  assert.deepEqual(ok(await prepare(original)), completed);

  // The gate records success, then the caller's callback traps. The committed
  // dispatching record must prevent resending despite no local reply receipt.
  const trappedInput = input("callback-trapped", bytes("one remote side effect before callback trap"));
  const trappedArgs = trappedInput.steps[0]!.args;
  const trappedReply = bytes("remote side effect completed");
  const trappedPrepared = ok(await prepare(trappedInput));
  await configure(trappedArgs, trappedReply);
  await call(journal, "trapAfterReply", [IDL.Opt(Blob)], [[trappedArgs]], []);
  const trapPending = await dispatch(trappedInput.operation_id, "first");
  await suspended(trappedArgs);
  await release(trappedArgs);
  await assert.rejects(finish(trapPending), /journal fixture callback trap|trapped/i);
  const trapped = (await get(trappedInput.operation_id))!;
  assert.equal(trapped.steps[0]!.status, "dispatching");
  assert.deepEqual(trapped.steps[0]!.reply, []);
  assert.deepEqual(trapped.steps[0]!.finished_at_seconds, []);
  assert.deepEqual((await observations()).find(row => Buffer.from(row.args).equals(trappedArgs))!.reply, [trappedReply]);
  conflict(await update(trappedInput.operation_id, trappedPrepared.revision, '{"phase":"prepared"}'));
  assert.deepEqual(ok(await finish<Outcome>(await dispatch(trappedInput.operation_id, "first"))), trapped);

  const unknownInput = input("remote-reject", bytes("remote rejection after real await"));
  const unknownArgs = unknownInput.steps[0]!.args;
  ok(await prepare(unknownInput));
  await configure(unknownArgs, bytes("unused"), "error");
  const unknownPending = await dispatch(unknownInput.operation_id, "first");
  await suspended(unknownArgs);
  await release(unknownArgs);
  const unknown = ok(await finish<Outcome>(unknownPending));
  assert.equal(unknown.steps[0]!.status, "unknown");
  assert.equal(unknown.steps[0]!.error.length, 1);
  assert.deepEqual(unknown.steps[0]!.reply, []);
  assert.deepEqual(ok(await finish<Outcome>(await dispatch(unknownInput.operation_id, "first"))), unknown);
  const untouchedInput = input("prepared-at-upgrade", bytes("not dispatched before upgrade"));
  const untouched = ok(await prepare(untouchedInput));
  // Removing and re-admitting this SNS with a different governance canister
  // must never redirect the destination frozen into its prepared operation.
  assert.deepEqual(await removeSns(), { ok: null });
  conflict(await finish<Outcome>(await dispatch(untouched.operation_id, "first")));
  assert.deepEqual(await configureSns(sns), { ok: null });
  conflict(await finish<Outcome>(await dispatch(untouched.operation_id, "first")));
  assert.deepEqual(await get(untouched.operation_id), untouched);
  assert.deepEqual(await removeSns(), { ok: null });
  assert.deepEqual(await configureSns(gate, false), { ok: null });
  conflict(await finish<Outcome>(await dispatch(untouched.operation_id, "first")));
  assert.deepEqual(ok(await finish<Outcome>(await dispatch(completed.operation_id, "first"))), completed);
  assert.deepEqual(await get(untouched.operation_id), untouched);
  assert.equal((await observations()).length, 4);
  assert.deepEqual(await configureSns(gate), { ok: null });
  const firstPage = await list();
  assert.deepEqual(firstPage.rows.map(row => row.operation_id), [untouched.operation_id, unknown.operation_id]);
  assert.equal(firstPage.total, 4n);
  const secondPage = await list(firstPage.next_before);
  assert.deepEqual(secondPage.rows.map(row => row.operation_id), [trapped.operation_id, completed.operation_id]);
  assert.deepEqual(secondPage.next_before, []);
  const legacyBefore = await query<any>(journal, "legacy", [], [], Legacy);
  assert.equal(legacyBefore.config.audit_rows, 1n);
  assert.equal(legacyBefore.config.draft_count, 1n);
  assert.deepEqual(legacyBefore.drafts[0].payload, [bytes("original draft payload")]);
  const callsBeforeUpgrade = await observations();
  assert.equal(callsBeforeUpgrade.length, 4);

  // A changed Wasm really replaces the installed code and rebuilds the app's
  // transient service over the retained v1 roots. There is no fixture reset.
  await install(journal, successorWasm, init, true);
  assert.equal(await query(journal, "fixture_version", [], [], IDL.Nat), 2n);
  assert.deepEqual(await query(journal, "legacy", [], [], Legacy), legacyBefore);
  for (const saved of [completed, trapped, unknown, untouched]) assert.deepEqual(await get(saved.operation_id), saved);
  assert.deepEqual(await list(), firstPage);
  assert.deepEqual(await list(firstPage.next_before), secondPage);
  assert.deepEqual(ok(await prepare(original)), completed);
  conflict(await update(completed.operation_id, withReceipt.revision, '{"phase":"prepared"}'));
  conflict(await update(trapped.operation_id, trappedPrepared.revision, '{"phase":"prepared"}'));
  for (const saved of [completed, trapped, unknown]) {
    assert.deepEqual(ok(await finish<Outcome>(await dispatch(saved.operation_id, "first"))), saved);
  }
  assert.deepEqual(await observations(), callsBeforeUpgrade, "Upgrade and retry must never repeat a broker call");

  // Known SNS maintenance commands keep the reviewed method immutable and
  // dispatch exactly that method through the reconstructed broker runtime.
  const maintenanceArgs = encode([], []);
  const maintenance = { ...input("maintenance-after-upgrade", maintenanceArgs),
    steps: [{ step_id: "reset", args: maintenanceArgs, method: ["reset_timers"] }] };
  const maintenancePrepared = ok(await prepare(maintenance));
  assert.equal(maintenancePrepared.steps[0]!.method, "reset_timers");
  conflict(await prepare({ ...maintenance, steps: [{ ...maintenance.steps[0]!, method: ["manage_neuron"] }] }));
  conflict(await prepare({ ...maintenance, operation_id: "unsupported-method", steps: [{ ...maintenance.steps[0]!, method: ["arbitrary_method"] }] }));
  assert.equal(await get("unsupported-method"), undefined);
  const maintenanceReply = encode([], []);
  await configure(maintenanceArgs, maintenanceReply);
  const maintenancePending = await dispatch(maintenance.operation_id, "reset");
  await suspended(maintenanceArgs);
  await release(maintenanceArgs);
  const maintenanceFinished = ok(await finish<Outcome>(maintenancePending));
  assert.equal(maintenanceFinished.steps[0]!.status, "replied");
  assert.deepEqual(maintenanceFinished.steps[0]!.reply, [maintenanceReply]);
  assert.deepEqual(ok(await finish<Outcome>(await dispatch(maintenance.operation_id, "reset"))), maintenanceFinished);
  const callsAfterMaintenance = await observations();
  assert.deepEqual(callsAfterMaintenance.slice(0, 4), callsBeforeUpgrade);
  assert.deepEqual(callsAfterMaintenance[4], { args: maintenanceArgs, method: "reset_timers", reply: [maintenanceReply] });
  assert.equal(callsAfterMaintenance.length, 5);

  // Clean initialization uses the successor bytes and starts independent empty
  // roots, while the previously installed canister remains unchanged.
  const fresh = await createCanister();
  await install(fresh, successorWasm, init);
  assert.equal(await query(fresh, "fixture_version", [], [], IDL.Nat), 2n);
  assert.deepEqual(await query(fresh, "list", [ListQuery], [{ before: [], limit: 2n }], Page), { rows: [], next_before: [], total: 0n });
  assert.deepEqual(await query(fresh, "get", [IDL.Text], [completed.operation_id], IDL.Opt(Detail)), []);
  assert.deepEqual(await query(fresh, "legacy", [], [], Legacy), emptyLegacy);
  const cleanPrepared = ok(await call<Outcome>(fresh, "prepare", [Prepare], [original]));
  assert.equal(cleanPrepared.seq, prepared.seq);
  assert.equal(cleanPrepared.revision, 0n);
  assert(cleanPrepared.steps.every(step => step.status === "prepared"));
  assert.deepEqual(await get(completed.operation_id), completed);
  assert.deepEqual(await observations(), callsAfterMaintenance);
  console.log("SNS journal PocketIC passed: real concurrent awaits, immutable inputs, CAS receipts, callback trap, unknown reply, >100 KB payload, pagination, clean initialization and actual Wasm upgrade restore.");
} finally {
  try {
    if (client && instanceId !== undefined) await client.deleteInstance(instanceId);
  } finally {
    if (server) {
      server.kill("SIGTERM");
      if (stopped) {
        const killTimeout = setTimeout(() => { server!.kill("SIGKILL"); }, 5_000);
        try { await stopped; } finally { clearTimeout(killTimeout); }
      }
    }
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
