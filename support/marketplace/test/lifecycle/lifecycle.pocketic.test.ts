// All rights reserved. See ../../LICENSE.
// The host integration runner launches this file in Bun's test process because
// the shared checked-install harness imports its own opt-in release tests.
// Only disposable canisters are used. No compile/deploy/registry is mocked.
import { expect, test } from "bun:test";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { verifyRequestResponsePair } from "@dfinity/response-verification";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  compileAndDeployPreparedPackages, compileFreshPackages, preparePackageInstall,
  uninstallApp, type PreparedPackageInstall,
} from "../../../../packages/neutron-compiler/src/install.ts";
import {
  DirectPocketIcCalls, advancePackageState, createApplicationInstance,
  freshDeployment, freshPackageState, launchPocketIc, loadProvisionHarness,
  normalizeAppInstances, requiredAppInstance, requiredPocketIcBinary, stopPocketIc,
  type DirectPocketIcClient,
} from "../../../../packages/neutron-compiler/test/legacy_kernel_upgrade.pocketic.test.ts";
import { physicalAppMethodName } from "neutron-tools/src/physical_names.js";
import { scopedLocalIdentityProvider } from "neutron-tools/src/runtime.js";
import { createKernelRuntimeConfig, encodeKernelRuntimeConfig, isolatedFrameOriginTemplate, runtimeUpdateSourceOrigin } from "neutron-tools/src/runtime_config.js";
import { createCertifiedAssetReader } from "neutron-tools/src/certified_asset.js";
import { parseRepositorySetupUrl, repositoryPackagePath, repositoryManifestPath, repositoryInfoPath } from "neutron-tools/repository";
import { verifyRepositorySetupBytes } from "../../../../apps/kernel/src/repository/client.ts";
import { createRepositoryAccessFetcher } from "../../../../apps/kernel/src/repository_access/client.ts";
import type { RepositoryAccessReply } from "neutron-tools/src/repository_access.js";
import { fetchUpdatePackage, fetchUpdateRelease } from "../../../../apps/kernel/src/updates/client.ts";
import { checkForAppUpdates } from "../../../../apps/kernel/src/updates/check.ts";
import { loadRuntimeDeployment } from "../../../../apps/kernel/src/runtime_deployment.ts";
import { compileFixture, prepareAsh } from "../../scripts/test-ash-runtime.ts";
import { fixtureArchive, currentArchive, sha256 } from "./archives.ts";

const blob = IDL.Vec(IDL.Nat8);
const principal = (seed: number) => Principal.selfAuthenticating(new Uint8Array(32).fill(seed));
const account = (owner: Principal) => ({ owner, subaccount: [] });
const success = <T = any>(value: any): T => {
  if (!value || !("ok" in value)) throw new Error(`Expected successful protocol result: ${JSON.stringify(value, (_key, v) => typeof v === "bigint" ? String(v) : v)}`);
  return value.ok;
};

test("real marketplace paid packages install, reinstall and upgrade together after Marketplace uninstall", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "marketplace-installed-lifecycle-"));
  const provision = await loadProvisionHarness();
  let server: ChildProcessWithoutNullStreams | undefined;
  let client: DirectPocketIcClient | undefined;
  let instanceId: number | undefined;
  try {
    const initialPackages = await Promise.all([currentArchive("kernel"), currentArchive("marketplace")]);
    console.log("marketplace lifecycle archive pins:", initialPackages.map(p => `${p.prepared.manifest.id}${p.prepared.manifest.version}:${sha256(p.archive)}`).join(" "));
    const launched = await launchPocketIc(requiredPocketIcBinary(), temporary);
    server = launched.server;
    client = new provision.PocketIcRestClient(launched.controlUrl, { requestTimeoutMs: 120_000 });
    const created = await createApplicationInstance(launched.controlUrl, path.join(temporary, "state"));
    instanceId = created.instanceId;
    const direct = new DirectPocketIcCalls(client, instanceId);
    const deployer = principal(211), owner = principal(212), auditor = principal(213), readIdentity = principal(214);
    const neutron = await direct.createCanister(deployer, created.defaultEffectiveCanisterId);
    const root = new URL(`instances/${instanceId}/`, launched.controlUrl);
    async function control(route: string, body?: unknown) {
      const deadline = Date.now() + 120_000;
      for (;;) {
        const response = await fetch(new URL(route, root), body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        // Concurrent certified reads may briefly occupy this isolated instance.
        // Only the read-side control requests here are repeated after Busy.
        if (response.status === 409 && route.startsWith("read/") && Date.now() < deadline) {
          await response.arrayBuffer();
          await new Promise(resolve => setTimeout(resolve, 20));
          continue;
        }
        if (!response.ok) throw new Error(`PocketIC ${route}: HTTP ${response.status} ${await response.text()}`);
        return response.json();
      }
    }
    const topology = await control("read/topology");
    const subnetId = Object.keys(topology.subnet_configs)[0]!;
    const rootKey = Uint8Array.from(await control("read/pub_key", { subnet_id: Buffer.from(Principal.fromText(subnetId).toUint8Array()).toString("base64") }));

    async function fixture(name: string, source: string, initArgs: unknown[] = []) {
      const compiled = await compileFixture(`installed_lifecycle_${name}`, source);
      const canisterId = await direct.createCanister(deployer, created.defaultEffectiveCanisterId);
      // Initial install of a disposable protocol/ledger fixture only. Neutron
      // changes below all go through its running checked install transaction.
      const install = IDL.Func([IDL.Record({ mode: IDL.Variant({ install: IDL.Null }), canister_id: IDL.Principal, wasm_module: blob, arg: blob, sender_canister_version: IDL.Opt(IDL.Nat64) })], [], []);
      await client!.awaitIngressMessage(instanceId!, await client!.submitIngressMessage(instanceId!, { canisterId: Principal.fromText("aaaaa-aa"), sender: deployer, method: "install_code", effectivePrincipal: { CanisterId: Buffer.from(canisterId.toUint8Array()).toString("base64") }, payload: new Uint8Array(IDL.encode(install.argTypes, [{ mode: { install: null }, canister_id: canisterId, wasm_module: new Uint8Array(await readFile(compiled.wasmPath)), arg: new Uint8Array(IDL.encode(compiled.init({ IDL }), initArgs)), sender_canister_version: [] }])) }));
      const methods = new Map<string, IDL.FuncClass>(compiled.idlFactory({ IDL })._fields);
      const call = (name: string, args: unknown[] = [], caller = deployer) => {
        const type = methods.get(name);
        if (!type) throw new Error(`No ${name} in current compiled ${source}`);
        return direct.actorCall(canisterId, caller, name, type, args) as Promise<any>;
      };
      return { ...compiled, canisterId, methods, call };
    }

    console.log("marketplace lifecycle: compile current actors and initialize an isolated Neutron");
    const publisher = await fixture("publisher", "test/fixtures/Relay.mo");
    const ledger = await fixture("ledger", "test/fixtures/FakeLedger.mo", [{ symbol: "ckUSDC", decimals: 6, fee: 10n }]);
    const oracle = await fixture("oracle", "test/fixtures/Oracle.mo");
    const fees = { version: 1n, updateBase: 1_000_000n, updateByte: 2n, storageByteYear: 3n, purchase: 2_000_000n, withdraw: 2_000_000n, grant: 3_000_000n, xrc: 20_000_000n };
    const market = await fixture("protocol", "mo/main.mo", [{ admins: [publisher.canisterId], auditors: [auditor], tokens: [{ ledger: ledger.canisterId, symbol: "ckUSDC", decimals: 6, fee: 10n, rateSymbol: "USDC", burnAccount: [] }], xrc: oracle.canisterId, fees, referralTerms: { version: 1n, discountBps: 1000n, affiliateBps: 3000n, developerBps: 3000n }, reservations: [], trustedPublishingPrincipal: [] }]);
    const initial = await compileFreshPackages({ packages: initialPackages.map(p => p.prepared), persistenceMode: "classical" });
    let state = freshPackageState(initialPackages.map(p => p.prepared), initial);
    let deploymentId = initial.deploymentId;
    let neutronMethods = new Map<string, IDL.FuncClass>();
    async function bindNeutron(candid: string, deployment: string) {
      const base = path.join(temporary, deployment);
      await writeFile(`${base}.did`, candid);
      const generated = await (await prepareAsh()).bind(`${base}.did`, base, temporary);
      const { idlFactory } = await import(pathToFileURL(generated.jsPath).href);
      neutronMethods = new Map(idlFactory({ IDL })._fields);
    }
    await bindNeutron(initial.candid, deploymentId);
    await direct.installInitial(neutron, deployer, initial);
    await direct.setControllers(neutron, deployer, [deployer, neutron]);
    const actorOptions = { controlUrl: launched.controlUrl, instanceId, canisterId: neutron.toText(), client };
    await provision.seedFreshKernel({ actor: provision.createDirectPocketIcKernelActor({ ...actorOptions, caller: deployer }), canisterId: neutron.toText(), deployment: freshDeployment(initialPackages, initial), concurrency: 32, logger: { log() {} } });
    const activation = new Uint8Array(32).fill(0xd3);
    expect(await direct.kernelActivation(neutron, deployer, { set: Uint8Array.from(Buffer.from(sha256(activation), "hex")) })).toEqual({ ready: null });
    expect(await direct.kernelActivation(neutron, owner, { use: activation })).toEqual({ authorized: null });
    const actor = provision.createDirectPocketIcKernelActor({ ...actorOptions, caller: owner });
    const runtimeConfig = createKernelRuntimeConfig({ target: "pocketic", gateway: "http://localhost:8000", identity_provider: scopedLocalIdentityProvider({ neutronCanisterId: neutron.toText(), localHost: "http://localhost:8000" }), canister_id: neutron.toText(), deployment_id: deploymentId, root_key_policy: "fetch", allow_loopback_http: true, isolated_frame_origin_template: isolatedFrameOriginTemplate("pocketic", neutron.toText()), update_source_origin: runtimeUpdateSourceOrigin("pocketic", market.canisterId.toText()) });
    await actor.kernel_static({ store: { key: "/system/runtime-config.json", val: { chunks: 1n, content: encodeKernelRuntimeConfig(runtimeConfig), content_encoding: "identity", content_type: "application/json" } } });
    const callApp = (id: string, name: string, args: unknown[]) => {
      const physicalName = physicalAppMethodName(id, name);
      const type = neutronMethods.get(physicalName);
      if (!type) throw new Error(`No ${physicalName} in current assembled Neutron Candid`);
      return direct.actorCall(neutron, owner, physicalName, type, args);
    };
    await callApp("marketplace", "marketplace_configure", [{ canister: market.canisterId, host: "http://localhost:8000" }]);
    const reserveMethods = ["read_delegate_set", "purchase", "install_prepare"];
    const reservations = IDL.Func([IDL.Record({ app_id: IDL.Text, actions: IDL.Vec(IDL.Variant({ reserve: IDL.Variant({ exact: IDL.Record({ principal: IDL.Principal, method: IDL.Text }) }) })) })], [IDL.Reserved], []);
    await direct.actorCall(neutron, owner, "kernel_backend_reservations_apply", reservations, [{ app_id: "marketplace", actions: reserveMethods.map(method => ({ reserve: { exact: { principal: market.canisterId, method } } })) }]);
    const scope = requiredAppInstance(normalizeAppInstances((await actor.kernel_runtime_info()).apps), "marketplace").scope;
    await direct.actorCall(neutron, owner, "kernel_capability_set_enabled", IDL.Func([IDL.Record({ app_id: IDL.Text, installation_uid: IDL.Nat64, kind: IDL.Variant({ backend_calls: IDL.Null }), resource_id: IDL.Text, enabled: IDL.Bool })], [IDL.Reserved], []), [{ app_id: "marketplace", installation_uid: BigInt(scope.installation_uid), kind: { backend_calls: null }, resource_id: "default", enabled: true }]);
    async function paidCall(name: string, request: unknown) {
      const method = market.methods.get(name)!;
      const response = success<Uint8Array>(await callApp("marketplace", "marketplace_call", [{ canister: market.canisterId, method: name, args: new Uint8Array(IDL.encode(method.argTypes, [request])), cycles: 100_000_000n }]));
      return success<any>(IDL.decode(method.retTypes, response)[0]);
    }
    async function publishCall(name: string, request: unknown) {
      const method = market.methods.get(name)!;
      const response = await publisher.call("rawCall", [market.canisterId, name, new Uint8Array(IDL.encode(method.argTypes, [request])), 100_000_000n]);
      return success<any>(IDL.decode(method.retTypes, Uint8Array.from(response))[0]);
    }
    await paidCall("read_delegate_set", { browser: readIdentity, active: true, feeVersion: 1n });
    await publishCall("rates_refresh", { feeVersion: 1n });
    const ids = ["paid_alpha", "paid_beta"];
    async function publish(appId: string, version: number) {
      if (version === 100) await publishCall("listing_save", { appId, title: appId, summary: "Local paid lifecycle fixture", description: "A real installed stateful package", priceUsdMicros: 1_000_000n, iconArtifact: [], screenshots: [], expectedRevision: [], feeVersion: 1n });
      const pkg = await fixtureArchive(appId, version, market.canisterId.toText());
      const requestId = `${appId}-${version}`;
      await publishCall("upload_begin", { requestId, appId, digest: Uint8Array.from(Buffer.from(sha256(pkg.archive), "hex")), size: BigInt(pkg.archive.length), mediaType: "application/octet-stream", purpose: { package: null }, feeVersion: 1n });
      for (let offset = 0; offset < pkg.archive.length; offset += 64_000) await publishCall("upload_chunk", { requestId, offset: BigInt(offset), bytes: pkg.archive.slice(offset, offset + 64_000), feeVersion: 1n });
      const uploaded = await publishCall("upload_finish", { requestId, feeVersion: 1n });
      const candidate = await publishCall("candidate_submit", { requestId, appId, version: BigInt(version), artifactId: uploaded.artifactId[0], sourceArtifactId: [], dependencies: [], feeVersion: 1n });
      success(await market.call("audit_stamp", [{ requestId: `audit-${requestId}`, candidateId: candidate.id, expectedDigest: candidate.digest, expectedSourceDigest: candidate.sourceDigest, decision: { approved: null }, analysis: "Local fixture source and archive inspected", reason: [] }], auditor));
      return pkg;
    }
    const originals = await Promise.all(ids.map(id => publish(id, 100)));
    const quote = success<any>(await market.call("purchase_quote", [{ requestId: "paid-lifecycle-acquisition", appIds: ids, ledger: ledger.canisterId, referralCode: [] }], readIdentity));
    expect(quote.amount).toBe(2_000_000n);
    // Deterministic local ledger balance/allowance setup. This test qualifies
    // marketplace/installer delivery, not the separately tested Wallet UI.
    await ledger.call("credit", [account(neutron), 10_000_000n]);
    expect(await ledger.call("icrc2_approve", [{ from_subaccount: [], spender: quote.spender, amount: quote.amount + quote.fee, expected_allowance: [], expires_at: [], fee: [10n], memo: [], created_at_time: [] }], neutron)).toHaveProperty("Ok");
    const purchased = await paidCall("purchase", { quote, feeVersion: 1n });
    expect(purchased.order.state).toEqual({ complete: null });
    const ledgerBefore = await ledger.call("stats");
    expect(ledgerBefore.transferFromCalls).toBe(1n);
    expect(success<any>(await market.call("library_query", [{ cursor: [], limit: 10n }], readIdentity)).apps.map((app: any) => app.appId).sort()).toEqual(ids);

    const sourceOrigin = `http://${market.canisterId.toText()}.localhost:8000`;
    let grantCalls = 0;
    let privateReads = 0;
    let deniedReads = 0;
    async function sourceFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin !== sourceOrigin) throw new Error(`Unexpected lifecycle HTTP source ${url.origin}`);
      const request = { method: init?.method ?? "GET", url: url.pathname, headers: [...new Headers(init?.headers).entries()], body: new Uint8Array(), certificate_version: [2] };
      const result = await market.call("http_request", [request], Principal.anonymous());
      expect(result.streaming_strategy).toEqual([]);
      const now = await control("read/get_time");
      const verifiedResponse = { status_code: result.status_code, headers: result.headers, body: Uint8Array.from(result.body) };
      let verified;
      try {
        verified = verifyRequestResponsePair(request, verifiedResponse, market.canisterId.toUint8Array(), BigInt(now.nanos_since_epoch), 300_000_000_000n, rootKey, 2);
      } catch (error) {
        if (process.env.MARKETPLACE_LIFECYCLE_HTTP_WITNESS_FILE) await writeFile(process.env.MARKETPLACE_LIFECYCLE_HTTP_WITNESS_FILE, JSON.stringify({ request, response: verifiedResponse, canisterId: [...market.canisterId.toUint8Array()], now: now.nanos_since_epoch, rootKey: [...rootKey] }, (_key, value) => value instanceof Uint8Array ? [...value] : value));
        throw error;
      }
      expect(verified.verificationVersion).toBe(2);
      if (result.status_code === 403) deniedReads++;
      if (result.status_code === 200 && request.headers.some(([name]) => name.toLowerCase() === "authorization")) privateReads++;
      const response = new Response(Uint8Array.from(result.body), { status: result.status_code, headers: result.headers });
      Object.defineProperty(response, "url", { value: url.href });
      return response;
    }
    const accessResult = IDL.Variant({ ok: IDL.Record({ request_id: IDL.Text, paths: IDL.Vec(IDL.Text), accepted_cycles: IDL.Nat }), err: IDL.Record({ code: IDL.Text, message: IDL.Text }) });
    const accessRequest = IDL.Record({ request_id: IDL.Text, token: IDL.Text, paths: IDL.Vec(IDL.Text), fee_version: IDL.Nat });
    const accessMethod = IDL.Func([IDL.Record({ source: IDL.Principal, cycles: IDL.Nat, request: accessRequest })], [IDL.Record({ result: accessResult, charged_cycles: IDL.Opt(IDL.Nat) })], []);
    const access = createRepositoryAccessFetcher({ fetch: sourceFetch, resolveSource: url => url.origin === sourceOrigin ? { canisterId: market.canisterId.toText(), origin: sourceOrigin } : null, ownerKey: () => neutron.toText(), requireApprovedAccess: true, authorize: async ({ source, cycles, request }) => {
      grantCalls++;
      return await direct.actorCall(neutron, owner, "kernel_repository_access_v1", accessMethod, [{ source: Principal.fromText(source), cycles, request }]) as RepositoryAccessReply;
    } });
    const approvedAccess = [{ source: market.canisterId.toText(), descriptor: { protocol: "neutron-repo-access-v1" as const, fee_version: "1", cycles: String(fees.grant) } }];
    const reader = (name: string, args: (index: bigint) => unknown) => createCertifiedAssetReader({ canisterId: market.canisterId.toText(), rootKey, readChunk: async ({ index }) => {
      const argument = args(BigInt(index));
      const result = await market.call(name, [argument], Principal.anonymous());
      if (name === "repo_package" && process.env.MARKETPLACE_LIFECYCLE_WITNESS_FILE) await writeFile(process.env.MARKETPLACE_LIFECYCLE_WITNESS_FILE, JSON.stringify({ canister: market.canisterId.toText(), argument, rootKey: [...rootKey], result }, (_key, value) => typeof value === "bigint" ? String(value) : value instanceof Uint8Array ? [...value] : value));
      return result;
    } });
    async function selection(requestId: string, appIds: string[]) {
      const prepared = await paidCall("install_prepare", { requestId, appIds, feeVersion: 1n });
      const reference = parseRepositorySetupUrl(prepared.setupUrl);
      const loaded = await verifyRepositorySetupBytes(reference, {
        readInfo: () => reader("repo_info", index => ({ index })).readRaw(repositoryInfoPath()),
        readManifest: id => reader("repo_manifest", index => ({ id, index })).readRaw(repositoryManifestPath(id)),
        readPackage: async (digest, resourcePaths) => {
          const packagePath = repositoryPackagePath(digest);
          expect(await reader("repo_package", index => ({ sha256: digest, index })).readRaw(packagePath)).toBeUndefined();
          const response = await access(`${sourceOrigin}${packagePath}`, {}, { approvedAccess, resourcePaths });
          expect(response.status).toBe(200);
          return new Uint8Array(await response.arrayBuffer());
        },
      });
      return loaded.packages.map(pkg => preparePackageInstall(pkg.bytes, { expectedIdentity: pkg.metadata }));
    }
    async function registry() { return await direct.readJsonAsset(neutron, "/system/apps.json") as Record<string, any>; }
    async function deploy(packages: PreparedPackageInstall[]) {
      const result = await compileAndDeployPreparedPackages({ actor, targetCanisterId: neutron.toText(), state, packages, expectedDeploymentId: deploymentId });
      state = advancePackageState(state, packages, result);
      deploymentId = result.compiled.deploymentId;
      await bindNeutron(result.compiled.candid, deploymentId);
      expect(await registry()).toEqual(result.apps);
      return result;
    }
    async function remove(appId: string) {
      const result = await uninstallApp({ actor, targetCanisterId: neutron.toText(), state, appId, expectedDeploymentId: deploymentId });
      state = advancePackageState(state, [], result, [appId]);
      deploymentId = result.compiled.deploymentId;
      await bindNeutron(result.compiled.candid, deploymentId);
      expect(await registry()).toEqual(result.apps);
      expect((await registry())[appId]).toBeUndefined();
    }
    // The generated app boundary represents Motoko unit Input as Candid null.
    const readCounter = (id: string) => callApp(id, "read_counter", [null]);
    console.log("marketplace lifecycle: paid batch install through private source and checked transaction");
    const installPackages = await selection("first-install", ids);
    expect(installPackages.map(p => p.manifest.id).sort()).toEqual(ids);
    await deploy(installPackages);
    for (const id of ids) expect((await registry())[id]).toMatchObject({ version: 100, update_source: market.canisterId.toText() });
    expect(grantCalls).toBe(1);
    expect(privateReads).toBe(2);
    for (const [index, id] of ids.entries()) await callApp(id, "set_counter", [BigInt(index + 41)]);
    const originalRuntime = normalizeAppInstances((await actor.kernel_runtime_info()).apps);
    const betaScope = requiredAppInstance(originalRuntime, "paid_beta").scope;
    const alphaScope = requiredAppInstance(originalRuntime, "paid_alpha").scope;
    console.log("marketplace lifecycle: uninstall/reinstall preserves ownership and unrelated managed state");
    await remove("paid_alpha");
    expect(await readCounter("paid_beta")).toBe(42n);
    expect(success<any>(await market.call("library_query", [{ cursor: [], limit: 10n }], readIdentity)).apps.map((app: any) => app.appId).sort()).toEqual(ids);
    await deploy(await selection("reinstall-owned", ["paid_alpha"]));
    expect(await readCounter("paid_alpha")).toBe(0n); // Uninstall intentionally retires that app's memory.
    expect(await readCounter("paid_beta")).toBe(42n);
    const installed = normalizeAppInstances((await actor.kernel_runtime_info()).apps);
    expect(requiredAppInstance(installed, "paid_alpha").scope).not.toEqual(alphaScope);
    expect(requiredAppInstance(installed, "paid_beta").scope).toEqual(betaScope);
    await callApp("paid_alpha", "set_counter", [141n]);
    const paidScopes = ids.map(id => requiredAppInstance(installed, id).scope);
    await remove("marketplace");
    expect(normalizeAppInstances((await actor.kernel_runtime_info()).apps).some(app => app.scope.app_id === "marketplace")).toBe(false);

    console.log("marketplace lifecycle: audited successors and grouped Settings transport without Marketplace app");
    const successors = await Promise.all(ids.map(id => publish(id, 101)));
    // Load the real Kernel runtime descriptor from its committed certified HTTP.
    // Only network routing is adapted to PocketIC's isolated control transport.
    const runtimeUrl = `http://${neutron.toText()}.localhost:8000`;
    await loadRuntimeDeployment(async (input) => {
      const url = new URL(String(input));
      const request = { method: "GET", url: url.pathname, headers: [["Host", `${neutron.toText()}.localhost:8000`]], body: new Uint8Array(), certificate_version: [2] };
      const type = IDL.Func([IDL.Record({ method: IDL.Text, url: IDL.Text, headers: IDL.Vec(IDL.Tuple(IDL.Text, IDL.Text)), body: blob, certificate_version: IDL.Opt(IDL.Nat16) })], [IDL.Record({ status_code: IDL.Nat16, headers: IDL.Vec(IDL.Tuple(IDL.Text, IDL.Text)), body: blob, streaming_strategy: IDL.Opt(IDL.Reserved) })], ["query"]);
      const result: any = await direct.actorCall(neutron, Principal.anonymous(), "http_request", type, [request]);
      expect(result.streaming_strategy).toEqual([]);
      const now = await control("read/get_time");
      expect(verifyRequestResponsePair(request, result, neutron.toUint8Array(), BigInt(now.nanos_since_epoch), 300_000_000_000n, rootKey, 2).verificationVersion).toBe(2);
      return new Response(result.body, { status: result.status_code, headers: result.headers });
    }, runtimeUrl);
    const beforeUpdates = await registry();
    const checks = await checkForAppUpdates(ids.map((id, index) => ({ appId: id, name: beforeUpdates[id].name, version: beforeUpdates[id].version, updateSource: beforeUpdates[id].update_source, packageDigest: sha256(originals[index]!.archive) })), { fetchRelease: (source, id, options) => fetchUpdateRelease(source, id, { ...options, fetch: sourceFetch as typeof fetch, timeoutMs: 120_000 }) });
    expect(checks.results.map(result => result.kind)).toEqual(["available", "available"]);
    const candidates = checks.results.filter((result): result is Extract<typeof result, { kind: "available" }> => result.kind === "available");
    const groupPaths = candidates.map(candidate => repositoryPackagePath(candidate.release.sha256));
    const groupFetch = ((input: RequestInfo | URL, init?: RequestInit) => access(input, init, { approvedAccess, resourcePaths: groupPaths })) as typeof fetch;
    const fetched = await Promise.all(candidates.map(async candidate => {
      const archive = await fetchUpdatePackage(candidate.source, candidate.release, { fetch: groupFetch, approvedAccess, resourcePaths: groupPaths, timeoutMs: 120_000 });
      return preparePackageInstall(archive, { expectedIdentity: candidate.release });
    }));
    const beforeFailedDownload = await registry();
    // An actual unauthenticated source response cannot mutate installed state.
    await expect(fetchUpdatePackage(market.canisterId.toText(), candidates[0]!.release, { fetch: sourceFetch as typeof fetch, timeoutMs: 120_000 })).rejects.toThrow();
    expect(await registry()).toEqual(beforeFailedDownload);
    expect(await readCounter("paid_alpha")).toBe(141n);
    expect(await readCounter("paid_beta")).toBe(42n);
    await deploy(fetched);
    for (const id of ids) {
      expect((await registry())[id]).toMatchObject({ version: 101, update_source: market.canisterId.toText() });
      expect(await callApp(id, "release_version", [null])).toBe(101n);
    }
    expect(await readCounter("paid_alpha")).toBe(141n);
    expect(await readCounter("paid_beta")).toBe(42n);
    const finalInstances = normalizeAppInstances((await actor.kernel_runtime_info()).apps);
    expect(ids.map(id => requiredAppInstance(finalInstances, id).scope)).toEqual(paidScopes);
    expect((await registry()).marketplace).toBeUndefined();
    expect((await ledger.call("stats")).transferFromCalls).toBe(1n);
    expect(grantCalls).toBe(2); // one original batch, one grouped successor batch
    expect(privateReads).toBe(5); // originals, owned reinstall, two successors
    expect(deniedReads).toBeGreaterThanOrEqual(5);
    expect(direct.externalInstallModes).toEqual(["install"]);
    console.log("marketplace lifecycle verified:", JSON.stringify({ registry: Object.fromEntries(ids.map(id => [id, { version: 101, update_source: market.canisterId.toText() }])), state: { paid_alpha: "141", paid_beta: "42" }, collections: 1, privateReads, grantCalls, successorDigests: successors.map(pkg => sha256(pkg.archive)) }));
  } finally {
    if (client && instanceId !== undefined) await client.deleteInstance(instanceId).catch(() => undefined);
    if (server) await stopPocketIc(server);
    await rm(temporary, { recursive: true, force: true });
  }
}, 1_800_000);
