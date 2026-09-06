/** Isolated Chromium -> real wallet actor -> local Anvil qualification. */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { idlFactoryFromCandid } from "icblast";
import { build } from "esbuild";
import { chromium, type Browser, type Frame } from "playwright";
import { encodeFunctionData, erc20Abi, keccak256, serializeTransaction, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadMotoko, disposeMotokoCompiler } from "neutron-motoko-wasm";
import { prepareMotokoProgram } from "neutron-scripts/src/motoko.ts";
import { parsePackageString } from "neutron-scripts/src/walk.ts";
import { resolvePocketIcBinary } from "neutron-provision/src/pocketic_binary.ts";
import { PocketIcRestClient, type PocketIcRawEffectivePrincipal } from "neutron-provision/src/pocketic_rest.ts";
import { materializeSelfCallArguments, normalizeSelfCallResult, encodeSelfCallResult } from "neutron-kernel/src/self_calls.ts";
import type { Operation } from "../src/data.ts";
import tokenArtifact from "./fixtures/browser-chain-token.json";

const execute = promisify(execFile), appRoot = path.resolve(import.meta.dir, ".."), root = path.resolve(appRoot, "../..");
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "neutron-browser-chain-"));
const processes: ChildProcess[] = [];
const evidence: Record<string, unknown> = { startedAt: new Date().toISOString(), scope: "Fresh unforked Anvil and isolated PocketIC; local test ETH/token only. Actual Chromium helpers, live Candid, production wallet backend with fixture custody and no backend RPC capability." };
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
let web: Server | undefined, browser: Browser | undefined, pocket: PocketIcRestClient | undefined, instanceId: number | undefined;
const kernelCalls: Array<{ kind: string; method: string }> = [];
const rpcCalls: string[] = [];
const sourcePaths = ["apps/evm_wallet/src/browser_operations.ts", "apps/evm_wallet/src/browser_reads.ts", "apps/evm_wallet/src/browser_rpc.ts", "apps/evm_wallet/backend/main.mo", "apps/evm_wallet/backend/BrowserObservations.mo", "apps/kernel/src/self_calls.ts", "apps/evm_wallet/test/browser_chain_actor.mo"];
const sourceHashes = async () => Object.fromEntries(await Promise.all(sourcePaths.map(async (file) => [file, createHash("sha256").update(await fs.readFile(path.join(root, file))).digest("hex")])));

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  return address.port;
}
async function freePort(): Promise<number> {
  const server = createServer(); const port = await listen(server);
  await new Promise<void>((resolve) => server.close(() => resolve())); return port;
}
function processOwned(binary: string, args: string[]) {
  const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.resume(); child.stderr?.resume(); processes.push(child); return child;
}
try {
  const initialSourceHashes = await sourceHashes();
  assert.equal(createHash("sha256").update(await fs.readFile(path.join(root, tokenArtifact.sourceFile))).digest("hex"), tokenArtifact.sourceSha256, "Local token fixture source changed; regenerate its artifact");
  const source = await execute("mops", ["sources"], { cwd: appRoot });
  const packages = Object.fromEntries(Object.entries(parsePackageString(source.stdout.replace(/\n/g, " ").trim())).map(([name, location]) => [name, path.resolve(appRoot, location)]));
  const compiler = await loadMotoko();
  let wasm: Uint8Array, candid: string;
  try {
    const prepared = await prepareMotokoProgram({ compiler, sourcePath: path.join(import.meta.dir, "browser_chain_actor.mo"), packages, allowDangerous: true });
    const compiled = await compiler.wasm(prepared.entryPath, "ic");
    wasm = compiled.wasm; candid = compiled.candid;
  } finally { await disposeMotokoCompiler(); }
  evidence.actorWasmSha256 = createHash("sha256").update(wasm!).digest("hex");
  const factory = await idlFactoryFromCandid(candid!);
  const service = factory({ IDL }) as IDL.ServiceClass;
  const methods = new Map<string, IDL.FuncClass>(service._fields);
  // The live Kernel delegates its structural input conversion to icblast.
  const { convert, explainer } = await import(path.join(root, "node_modules/icblast/lib/icb_node.js"));
  const explained = explainer(factory);
  const binary = await resolvePocketIcBinary({ cacheDirectory: path.join(root, ".neutron/cache/bin") });
  const portFile = path.join(temporary, "pocket.port");
  const pocketProcess = processOwned(binary.path, ["--ttl", "120", "--port-file", portFile, "--log-levels", "error"]);
  let control = "";
  for (let attempt = 0; attempt < 400 && !control; attempt++) {
    assert.equal(pocketProcess.exitCode, null, "Owned PocketIC exited before ready");
    try { const port = Number(await fs.readFile(portFile, "utf8")); if (port > 0) control = `http://127.0.0.1:${port}/`; } catch {}
    if (!control) await sleep(25);
  }
  assert(control, "PocketIC did not become ready");
  const subnet = { state_config: "New", instruction_config: "Production", subnet_admins: null, cost_schedule: "Normal" };
  const createdResponse = await fetch(new URL("instances", control), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
    subnet_config_set: { nns: null, sns: null, ii: null, fiduciary: null, bitcoin: null, test_threshold_keys: null, system: [], application: [subnet], cloud_engine: [], verified_application: [] },
    http_gateway_config: null, state_dir: path.join(temporary, "state"), icp_config: null, log_level: null, bitcoind_addr: null, dogecoind_addr: null,
    icp_features: { registry: null, cycles_minting: null, icp_token: null, cycles_token: null, nns_governance: null, sns: null, ii: null, nns_ui: null, bitcoin: null, dogecoin: null, canister_migration: null },
    incomplete_state: "Disabled", initial_time: { AutoProgress: { artificial_delay_ms: null } }, mainnet_nns_subnet_id: false, disable_ingress_validation: false,
  }) });
  const created = await createdResponse.json() as { Created?: { instance_id: number; topology: { default_effective_canister_id: { canister_id: string } } } };
  assert(created.Created, JSON.stringify(created));
  instanceId = created.Created.instance_id; pocket = new PocketIcRestClient(control);
  const anonymous = Principal.anonymous(), management = Principal.fromText("aaaaa-aa");
  const defaultEffective: PocketIcRawEffectivePrincipal = { CanisterId: created.Created.topology.default_effective_canister_id.canister_id };
  async function rawCall(canisterId: Principal, method: string, args: IDL.Type[], values: unknown[], returns: IDL.Type[], effectivePrincipal: PocketIcRawEffectivePrincipal, query = false): Promise<unknown[]> {
    const message = { sender: anonymous, canisterId, method, payload: new Uint8Array(IDL.encode(args, values)), effectivePrincipal };
    const bytes = query ? await pocket!.queryCanister(instanceId!, message) : await pocket!.awaitIngressMessage(instanceId!, await pocket!.submitIngressMessage(instanceId!, message));
    return IDL.decode(returns, bytes);
  }
  const [creation] = await rawCall(management, "provisional_create_canister_with_cycles", [IDL.Record({ amount: IDL.Opt(IDL.Nat), settings: IDL.Opt(IDL.Record({})), specified_id: IDL.Opt(IDL.Principal), sender_canister_version: IDL.Opt(IDL.Nat64) })], [{ amount: [100_000_000_000_000n], settings: [], specified_id: [], sender_canister_version: [] }], [IDL.Record({ canister_id: IDL.Principal })], defaultEffective);
  const canisterId = (creation as { canister_id: Principal }).canister_id;
  const effective: PocketIcRawEffectivePrincipal = { CanisterId: Buffer.from(canisterId.toUint8Array()).toString("base64") };
  await rawCall(management, "install_code", [IDL.Record({ mode: IDL.Variant({ install: IDL.Null }), canister_id: IDL.Principal, wasm_module: IDL.Vec(IDL.Nat8), arg: IDL.Vec(IDL.Nat8), sender_canister_version: IDL.Opt(IDL.Nat64) })], [{ mode: { install: null }, canister_id: canisterId, wasm_module: wasm!, arg: new Uint8Array(IDL.encode([], [])), sender_canister_version: [] }], [], effective);
  async function actor(method: string, values: unknown[] = [], query = false): Promise<unknown> {
    const fn = methods.get(method); assert(fn, `Missing compiled Candid ${method}`);
    return (await rawCall(canisterId, method, fn.argTypes, values, fn.retTypes, effective, query))[0];
  }

  const anvilPort = await freePort(), anvilUrl = `http://127.0.0.1:${anvilPort}`;
  const anvil = processOwned(path.join(root, "node_modules/.bin/anvil"), ["--host", "127.0.0.1", "--port", String(anvilPort), "--chain-id", "1", "--silent"]);
  let rpcId = 0;
  async function rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    rpcCalls.push(method);
    const response = await fetch(anvilUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
    const body = await response.json() as { result: T; error?: unknown };
    assert(!body.error, `${method}: ${JSON.stringify(body.error)}`); return body.result;
  }
  async function receipt<T>(hash: string): Promise<T> {
    for (let attempt = 0; attempt < 400; attempt++) {
      const value = await rpc<T | null>("eth_getTransactionReceipt", [hash]);
      if (value) return value;
      await sleep(25);
    }
    throw new Error(`Local Anvil did not mine fixture transaction ${hash}`);
  }
  let ready = false;
  for (let attempt = 0; attempt < 400 && !ready; attempt++) {
    assert.equal(anvil.exitCode, null, "Owned Anvil exited before ready");
    try { assert.match(await rpc<string>("web3_clientVersion"), /^anvil/i); ready = true; } catch { await sleep(25); }
  }
  assert(ready); assert.equal(await rpc("eth_chainId"), "0x1");
  const info = await rpc<{ forkConfig?: { forkUrl?: unknown; forkBlockNumber?: unknown } }>("anvil_nodeInfo");
  assert(info.forkConfig?.forkUrl == null && info.forkConfig?.forkBlockNumber == null, "Only fresh unforked test chain allowed");
  const key = privateKeyToAccount(`0x${"0".repeat(63)}1`);
  await rpc("anvil_setBalance", [key.address, "0x8ac7230489e80000"]); // 10 local test ETH.
  const [deployer] = await rpc<string[]>("eth_accounts"); assert(deployer);
  const deployHash = await rpc<string>("eth_sendTransaction", [{ from: deployer, data: tokenArtifact.bytecode, gas: "0x3d0900" }]);
  const deployed = await receipt<{ contractAddress: string; status: string }>(deployHash);
  assert.equal(deployed.status, "0x1"); const token = deployed.contractAddress;
  const mintData = `0x40c10f19${key.address.slice(2).toLowerCase().padStart(64, "0")}${(20n * 10n ** 18n).toString(16).padStart(64, "0")}`;
  const mintHash = await rpc<string>("eth_sendTransaction", [{ from: deployer, to: token, data: mintData, gas: "0x30d40" }]);
  assert.equal((await receipt<{ status: string }>(mintHash)).status, "0x1");
  const recipient = "0x2222222222222222222222222222222222222222";
  const recipientBefore = BigInt(await rpc<string>("eth_getBalance", [recipient, "latest"]));
  let bundle: Uint8Array = new Uint8Array();
  web = createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*"); response.setHeader("Access-Control-Allow-Headers", "content-type"); response.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }
    try {
      if (request.url === "/bridge") {
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString()) as { kind: string; method: string; args: unknown[] };
        assert(body.method.startsWith("evm_wallet_")); const fn = methods.get(body.method); assert(fn);
        kernelCalls.push({ kind: body.kind, method: body.method });
        const materialized = materializeSelfCallArguments(body.args, [], fn.argTypes).args;
        const values = await convert(materialized, explained[body.method].input, {});
        const value = await actor(body.method, values, body.kind === "query");
        const encoded = encodeSelfCallResult(normalizeSelfCallResult(value, fn.retTypes[0]!));
        response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ ...encoded, blobs: encoded.blobs.map((blob) => ({ ...blob, data: [...new Uint8Array(blob.data)] })) })); return;
      }
      if (request.url === "/fixture.js") { response.setHeader("Content-Type", "application/javascript"); response.end(bundle); return; }
      response.setHeader("Content-Type", "text/html");
      response.end(request.url === "/app" ? '<!doctype html><script type="module" src="/fixture.js"></script>' : '<!doctype html><iframe title="Fixture" sandbox="allow-scripts" src="/app"></iframe>');
    } catch (error) { response.writeHead(500, { "Content-Type": "application/json" }); response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); }
  });
  const webPort = await listen(web), origin = `http://127.0.0.1:${webPort}`;
  const built = await build({ entryPoints: [path.join(import.meta.dir, "browser/browser_chain_fixture.ts")], bundle: true, write: false, platform: "browser", format: "esm", define: { __CHAIN_RPC_URL__: JSON.stringify(anvilUrl), __CHAIN_BRIDGE_URL__: JSON.stringify(`${origin}/bridge`) } });
  bundle = built.outputFiles[0]!.contents;
  evidence.browserBundleSha256 = createHash("sha256").update(bundle).digest("hex");
  let executablePath = process.env.EVM_BROWSER_CHROMIUM;
  if (!executablePath) try { await fs.access("/run/current-system/sw/bin/google-chrome-stable"); executablePath = "/run/current-system/sw/bin/google-chrome-stable"; } catch {}
  browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage(), errors: string[] = [], outbound: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => { if (request.url().startsWith(anvilUrl)) outbound.push((request.postDataJSON() as { method: string }).method); });
  async function load(): Promise<Frame> {
    await page.goto(origin); const frame = page.frames().find((value) => value.url() === `${origin}/app`); assert(frame);
    await frame.waitForFunction("globalThis.__chain?.ready"); assert.equal(await frame.evaluate("globalThis.__chain.origin"), "null"); return frame;
  }
  let frame = await load();
  async function action<T>(name: string, ...args: unknown[]): Promise<T> { return frame.evaluate(`globalThis.__chain.${name}(...${JSON.stringify(args)})`) as Promise<T>; }
  const nativeId = "a1".repeat(16), tokenId = "b2".repeat(16);
  const intent = (to: string, value: string, data = "0x") => ({ account_id: "main", chain_id: "1", operation: { transaction: { to, value, data, transaction_type: "eip1559", access_list: [] } } });
  async function seedSignature(operation: Operation) {
    const tx = operation.preparedTransaction; assert(tx && tx.maxFeePerGas && tx.maxPriorityFeePerGas && tx.gasLimit);
    const unsigned = serializeTransaction({ type: "eip1559", chainId: 1, nonce: Number(tx.nonce), gas: BigInt(tx.gasLimit), maxFeePerGas: BigInt(tx.maxFeePerGas), maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas), to: tx.to as Hex, value: BigInt(tx.value), data: tx.data as Hex, accessList: [] });
    const digest = keccak256(unsigned), signature = await key.sign({ hash: digest });
    await actor("fixture_signature", [Uint8Array.from(Buffer.from(digest.slice(2), "hex")), Uint8Array.from(Buffer.from(signature.slice(2, 130), "hex"))]);
  }
  const start = performance.now();
  const native = await action<Operation>("prepare", nativeId, intent(recipient, "1000000000000000"));
  assert.equal(native.status, "prepared"); assert.equal(native.preparedTransaction?.nonce, "0");
  assert.equal(await actor("fixture_signature_count", [], true), 0n); assert.equal(outbound.filter((method) => method === "eth_sendRawTransaction").length, 0);
  await seedSignature(native);
  const nativeDone = await action<Operation>("execute", native);
  assert.equal(nativeDone.status, "confirmed"); assert(nativeDone.transactionHash && nativeDone.receiptJson);
  assert.equal(BigInt(await rpc<string>("eth_getBalance", [recipient, "latest"])) - recipientBefore, 1_000_000_000_000_000n);
  assert.equal(await actor("fixture_signature_count", [], true), 1n);
  await actor("fixture_reload"); frame = await load();
  const nativeRestored = await action<Operation>("read", nativeId);
  assert.equal(nativeRestored.operationId, nativeDone.operationId); assert.equal(nativeRestored.transactionHash, nativeDone.transactionHash);
  assert.equal((await action<Operation>("prepare", nativeId, intent(recipient, "1000000000000000"))).transactionHash, nativeDone.transactionHash);
  assert.equal(await actor("fixture_signature_count", [], true), 1n);
  const tokenData = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [recipient, 5n * 10n ** 18n] });
  const tokenPrepared = await action<Operation>("prepare", tokenId, intent(token, "0", tokenData));
  assert.equal(tokenPrepared.status, "prepared"); assert.equal(tokenPrepared.preparedTransaction?.nonce, "1");
  const tokenEvidence = await action<Operation>("evidence", tokenPrepared);
  assert.equal(tokenEvidence.tokenEvidence?.balance.value, (20n * 10n ** 18n).toString());
  await seedSignature(tokenEvidence);
  await frame.evaluate("Object.assign(globalThis.__chain.fixture, {dropBroadcastReply:true, interruptAfterBroadcast:true})");
  await assert.rejects(action("execute", tokenEvidence), /browser disconnected before receipt lookup/);
  const signed = await action<Operation>("read", tokenId); assert.equal(signed.status, "signed"); assert(signed.transactionHash);
  assert.equal(await actor("fixture_signature_count", [], true), 2n);
  await actor("fixture_reload"); frame = await load();
  const tokenRestored = await action<Operation>("read", tokenId);
  assert.equal(tokenRestored.transactionHash, signed.transactionHash); assert.equal(tokenRestored.preparedTransaction?.nonce, "1");
  const tokenDone = await action<Operation>("reconcile", tokenRestored);
  assert.equal(tokenDone.status, "confirmed"); assert.equal(tokenDone.transactionHash, signed.transactionHash); assert(tokenDone.receiptJson);
  const recipientTokenData = encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [recipient] });
  assert.equal(BigInt(await rpc<string>("eth_call", [{ to: token, data: recipientTokenData }, "latest"])), 5n * 10n ** 18n);
  const balances = await action<{ nativeBalanceWei: string; tokens: Array<{ balanceAtoms: string }> }>("balances", key.address, [token]);
  assert.equal(balances.tokens[0]?.balanceAtoms, (15n * 10n ** 18n).toString());
  assert.equal(await actor("fixture_signature_count", [], true), 2n);
  assert.equal(await rpc("eth_getTransactionCount", [key.address, "latest"]), "0x2");
  assert.equal(outbound.filter((method) => method === "eth_sendRawTransaction").length, 2);
  assert.equal(kernelCalls.filter((call) => call.method === "evm_wallet_execute_v1").length, 2);
  assert.equal(errors.length, 0, errors.join("\n"));
  assert.deepEqual(await sourceHashes(), initialSourceHashes, "Qualification source files changed during the run");
  evidence.sourceHashes = initialSourceHashes;
  evidence.sourceHashesVerifiedBeforeAndAfter = true;
  Object.assign(evidence, { passed: true, elapsedPipelineMs: Math.round(performance.now() - start), chainId: 1, opaqueOrigin: "null", anvilPort, isolatedCanister: canisterId.toText(), native: { operationId: nativeDone.operationId, hash: nativeDone.transactionHash, nonce: "0", receivedWei: "1000000000000000", status: nativeDone.status }, token: { contract: token, operationId: tokenDone.operationId, hash: tokenDone.transactionHash, nonce: "1", receivedAtoms: (5n * 10n ** 18n).toString(), retainedAtoms: (15n * 10n ** 18n).toString(), status: tokenDone.status, droppedBroadcastReply: true, reloadRecovery: true }, signatures: 2, browserBroadcasts: 2, browserRpcCalls: outbound, kernelCalls, browserErrors: errors });
  console.log(`Browser/actor/Anvil integration passed: native + ERC20, 2 signatures, 2 broadcasts, reload and lost-reply recovery (${evidence.elapsedPipelineMs} ms)`);
} catch (error) {
  Object.assign(evidence, { passed: false, error: error instanceof Error ? error.stack : String(error) });
  throw error;
} finally {
  await browser?.close();
  if (web) await new Promise<void>((resolve) => web!.close(() => resolve()));
  if (pocket && instanceId !== undefined) await pocket.deleteInstance(instanceId).catch(() => undefined);
  for (const child of processes.reverse()) {
    if (child.exitCode === null) { child.kill("SIGTERM"); for (let count = 0; count < 100 && child.exitCode === null; count++) await sleep(25); if (child.exitCode === null) child.kill("SIGKILL"); }
  }
  evidence.finishedAt = new Date().toISOString(); evidence.ownedRuntimeStopped = true;
  if (process.env.EVM_BROWSER_CHAIN_EVIDENCE) await fs.writeFile(process.env.EVM_BROWSER_CHAIN_EVIDENCE, JSON.stringify(evidence, null, 2) + "\n");
  await fs.rm(temporary, { recursive: true, force: true });
}
