// Explicit local-fixture integration check. Creates a new temporary probe
// canister; never deletes the caller's running fixture or reinstalls any app.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { IDL } from "@dfinity/candid";
import { Actor, HttpAgent } from "@dfinity/agent";
import { Principal } from "@dfinity/principal";
import { disposeMotokoCompiler, loadMotoko } from "neutron-motoko-wasm";
import { prepareMotokoProgram } from "neutron-scripts/src/motoko.js";
import { parsePackageString } from "neutron-scripts/src/walk.js";
import { PocketIcRestClient, type PocketIcRawEffectivePrincipal } from "neutron-provision/src/pocketic_rest.ts";

const [sessionPath, mode = "normalized", block, hash, outputPath] = process.argv.slice(2);
if (!sessionPath || !block || !hash || !outputPath || !["wire", "normalized"].includes(mode)) throw new Error("Usage: live_rpc_probe.ts <local-session.json> wire|normalized <block> <transaction-hash> <output.json>");
const session = JSON.parse(await fs.readFile(sessionPath, "utf8"));
if (session.runtime?.kind !== "pocketic") throw new Error("A local PocketIC session is required");
const controlUrl = session.runtime.controlUrl;
if (typeof controlUrl !== "string" || new URL(controlUrl).hostname !== "127.0.0.1") throw new Error("Only the local loopback PocketIC control API is allowed");
const instanceId = session.runtime.instanceId;
const effectiveId = session.runtime.topology.defaultEffectiveCanisterId;
if (!Number.isInteger(instanceId) || typeof effectiveId !== "string") throw new Error("Missing local instance routing metadata");
const effective: PocketIcRawEffectivePrincipal = { CanisterId: effectiveId };
const appRoot = path.resolve(import.meta.dir, "..");
const sourceOutput = await promisify(execFile)("mops", ["sources"], { cwd: appRoot });
const packages = Object.fromEntries(Object.entries(parsePackageString(sourceOutput.stdout.replace(/\n/g, " ").trim())).map(([name, root]) => [name, path.resolve(appRoot, root)]));
const compiler = await loadMotoko();
let wasm: Uint8Array;
try {
  const program = await prepareMotokoProgram({ compiler, sourcePath: path.join(appRoot, "test/live_rpc_probe.mo"), packages, allowDangerous: true });
  wasm = (await compiler.wasm(program.entryPath, "ic")).wasm;
} finally { await disposeMotokoCompiler(); }
const client = new PocketIcRestClient(controlUrl);
const caller = Principal.anonymous();
async function call(canisterId: Principal, method: string, args: IDL.Type[], values: unknown[], returns: IDL.Type[], effectivePrincipal: PocketIcRawEffectivePrincipal): Promise<unknown[]> {
  const pending = await client.submitIngressMessage(instanceId, { sender: caller, canisterId, method, payload: new Uint8Array(IDL.encode(args, values)), effectivePrincipal });
  return IDL.decode(returns, await client.awaitIngressMessage(instanceId, pending));
}
const management = Principal.fromText("aaaaa-aa");
const [created] = await call(management, "provisional_create_canister_with_cycles", [IDL.Record({ amount: IDL.Opt(IDL.Nat), settings: IDL.Opt(IDL.Record({})), specified_id: IDL.Opt(IDL.Principal), sender_canister_version: IDL.Opt(IDL.Nat64) })], [{ amount: [100_000_000_000_000n], settings: [], specified_id: [], sender_canister_version: [] }], [IDL.Record({ canister_id: IDL.Principal })], effective);
const canisterId = (created as { canister_id: Principal }).canister_id;
const ownEffective = { CanisterId: Buffer.from(canisterId.toUint8Array()).toString("base64") };
await call(management, "install_code", [IDL.Record({ mode: IDL.Variant({ install: IDL.Null }), canister_id: IDL.Principal, wasm_module: IDL.Vec(IDL.Nat8), arg: IDL.Vec(IDL.Nat8), sender_canister_version: IDL.Opt(IDL.Nat64) })], [{ mode: { install: null }, canister_id: canisterId, wasm_module: wasm, arg: new Uint8Array(IDL.encode([], [])), sender_canister_version: [] }], [], ownEffective);
console.log(`Installed fresh read-only probe: ${canisterId.toText()}`);
const gateway = session.runtime.gateway.url;
if (!["127.0.0.1", "localhost"].includes(new URL(gateway).hostname)) throw new Error("Only a local fixture gateway is allowed");
const agent = await HttpAgent.create({ host: gateway, verifyQuerySignatures: false });
await agent.fetchRootKey();
if (Buffer.from(agent.rootKey!).toString("base64") !== session.runtime.rootKeyBase64) throw new Error("Local fixture root key changed");
const probe = Actor.createActor(({ IDL }) => IDL.Service({ wire: IDL.Func([IDL.Text, IDL.Text], [IDL.Text], []), normalized: IDL.Func([IDL.Text, IDL.Text], [IDL.Text], []) }), { agent, canisterId });
const method = probe[mode];
if (!method) throw new Error("Probe method is unavailable");
const result = await method(block, hash);
const evidence = { at: new Date().toISOString(), probeCanister: canisterId.toText(), evmRpcCanister: "7hfb6-caaaa-aaaar-qadga-cai", mode, block, transactionHash: hash, observations: JSON.parse(String(result)) };
await fs.writeFile(outputPath, JSON.stringify(evidence, null, 2) + "\n");
console.log(`Local released EVM RPC ${mode} probe passed: ${outputPath}`);
