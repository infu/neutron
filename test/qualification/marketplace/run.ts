// Installed-browser regression for Marketplace's normal-mode initialization.
// All canisters are disposable PocketIC instances. Exact release archives are
// installed unchanged, and browser requests may only reach the owned gateway.
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Actor, Cbor, requestIdOf } from "@dfinity/agent";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from "@playwright/test";
import { prepareDeployment, chunkWasm, sha256Hex, type PreparedDeployment } from "neutron-provision/src/artifact.js";
import { seedFreshKernel } from "neutron-provision/src/provision.js";
import { bindDeploymentRuntimeConfig } from "neutron-provision/src/runtime_config.js";
import { PocketIcRestClient } from "neutron-provision/src/pocketic_rest.ts";
import { trustedInstallationContextFromRootKey } from "neutron-compiler/src/installation_context.js";
import { physicalAppMethodName } from "neutron-tools/src/physical_names.js";
import { packageArchiveFilename } from "neutron-tools/src/package_archive.js";
import { disposeMotokoCompiler } from "neutron-motoko-wasm";
import { launchIsolatedQualificationPocketIc, type IsolatedQualificationPocketIc } from "../../../apps/kernel/evidence/qualification/environment.ts";
import { compileFixture, prepareAsh } from "../../../support/marketplace/scripts/test-ash-runtime.ts";
import { publishInstallFixtures, type InstallFixture } from "./fixtures.ts";
import { inspectSourcePreflight, preserveSourceCertificateVisibility, type SourceCorsRestoration } from "./source_gateway.ts";

const root = path.resolve(import.meta.dir, "../../..");
const negativeControl = process.argv.includes("--negative-control");
const customTarget = process.argv.includes("--custom-target");
const productionProtocolId = "sj2r4-haaaa-aaaay-aadgq-cai";
function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  assert.ok(value && !value.startsWith("--"), `${name} needs a value`);
  return value;
}
const expectedVersion = negativeControl ? 107 : Number(option("--version") ?? 111);
assert.ok(Number.isSafeInteger(expectedVersion) && expectedVersion >= 107);
const expectedArchiveHash = option("--sha256") ?? (!negativeControl ? ({
  109: "8bdeb24571521f33ef4a91a684dcea89e7085a569f8ef7726f03769c1a0c6db2",
  110: "67ff1d6b3cf7a40ad621e3ea2c89be2837dd55e192a5136980205ba0b8b460f6",
  111: "e2f861cc3147ed0933216730999d5f74272a988a1e63fb3470faf64d687931be",
} as Record<number, string>)[expectedVersion] : undefined);
assert.ok(negativeControl || expectedArchiveHash, "An unpinned Marketplace release needs --sha256");
if (expectedArchiveHash) assert.match(expectedArchiveHash, /^[a-f0-9]{64}$/);
const kernelVersion = Number(option("--kernel-version") ?? 359);
assert.ok(Number.isSafeInteger(kernelVersion) && kernelVersion >= 356);
const kernelHash = option("--kernel-sha256") ?? ({
  356: "0b69d73d903c0ae312e7c7efd43968924c2dd865a99d1aaa0a1f5b68ca15a373",
  357: "445b4ce4b970e527e0ee1ca7fc70f6e7a1c4abd286b5cf3e343f871fc6db20da",
  358: "0e0b801a37ca42dcce8bc5a396b035ba46ca39d0e0245d849a49f7df6b9a3eda",
  359: "6b506590ab9160a6e8e31859a791d40e60b797f06e9fde28781b8f0beb89574d",
} as Record<number, string>)[kernelVersion];
assert.ok(kernelHash, "An unpinned Kernel release needs --kernel-sha256");
assert.match(kernelHash, /^[a-f0-9]{64}$/);
const manifestReservations = !negativeControl && expectedVersion >= 110;
const expectRuntimeGrant = !manifestReservations || customTarget;
const predecessorHash = "03ef7d67e3c7314474049da7ee9ede6678b5a8e291b3ed85e55fc5feddb7f785";
const protocolHash = "2bde4755ae504b96706c48b752daa681a19a5b0aa302da764c41529c00789143";
const timeout = 90_000;
const loginSeed = 0xc7;
const blob = IDL.Vec(IDL.Nat8);
const relayType = IDL.Record({ canister: IDL.Principal, method: IDL.Text, args: blob, cycles: IDL.Nat });
const output = process.env.MARKETPLACE_QUALIFICATION_ARTIFACTS ?? `/tmp/marketplace-connect-${expectedVersion}`;

type Runtime = {
  environment: IsolatedQualificationPocketIc;
  deployment: PreparedDeployment;
  canisterId: string;
  protocolId: string;
  marketplaceHash: string;
  relayMethod: string;
  configureLocalProtocol(): Promise<void>;
  assertInstallReservations(): Promise<void>;
  installFixtures: InstallFixture[];
  installReservations: Array<{ principal: string; method: string }>;
  assertNoLedgerEffects(): Promise<void>;
  readSourceHttp: Parameters<typeof preserveSourceCertificateVisibility>[1]["readHttp"];
  state(): Promise<{ seed: [] | [Uint8Array]; canister: [] | [Principal]; owner: Principal; revision: bigint }>;
};
type Observation = {
  relays: Map<string, string>;
  ingress: Array<{ path: string; method: string; canisterType: string }>;
  privateQueries: Array<{ method: string; canisterId: string; sender: string; delegationTargets: string[][] }>;
  libraryReplies: number;
  errors: string[];
  blocked: string[];
  privatePackageReads: Array<{ path: string; status: number; authorized: boolean }>;
  sourceCorsRestorations: SourceCorsRestoration[];
  sourceGrantRequests: Array<{ ingressRequestId: string; source: string; paths: string[] }>;
};

function archive(appId: string, version: number): string {
  return path.join(root, "apps", appId, packageArchiveFilename(appId, version));
}

async function installRuntime(temporary: string): Promise<Runtime> {
  const kernelArchive = archive("kernel", kernelVersion), marketplaceArchive = archive("marketplace", expectedVersion);
  const [kernelBytes, marketplaceBytes] = await Promise.all([readFile(kernelArchive), readFile(marketplaceArchive)]);
  assert.equal(sha256Hex(kernelBytes), kernelHash, "Use the exact reviewed Kernel archive bytes");
  if (negativeControl) assert.equal(sha256Hex(marketplaceBytes), predecessorHash, "Never edit the released negative control");
  const marketplaceHash = sha256Hex(marketplaceBytes);
  if (expectedArchiveHash) assert.equal(marketplaceHash, expectedArchiveHash, "Use the exact reviewed Marketplace archive bytes");
  console.log(`Installed browser pins: kernel${kernelVersion}:${kernelHash} marketplace${expectedVersion}:${marketplaceHash}`);
  const environment = await launchIsolatedQualificationPocketIc({ repositoryRoot: root });
  try {
    const deployment = await prepareDeployment([kernelArchive, marketplaceArchive], {
      target: "local",
      freshInstallationContext: trustedInstallationContextFromRootKey(Uint8Array.from(Buffer.from(environment.rootKeyBase64, "base64"))),
    });
    const packagedManifest = deployment.packages.find(pkg => pkg.manifest.id === "marketplace")!.manifest;
    const installReservations = (packagedManifest.capabilities?.backend_calls?.install_reservations ?? []).map(grant => {
      assert.equal(grant.kind, "exact", "The production Marketplace should declare only exact target/method grants");
      assert.ok("principal" in grant && "method" in grant);
      assert.equal(grant.principal, productionProtocolId);
      return { principal: grant.principal, method: grant.method };
    });
    if (manifestReservations) assert.ok(installReservations.length > 0, "The exact packed manifest must declare its normal installation permissions");
    if (expectedVersion >= 111) {
      assert.ok(packagedManifest.capabilities?.frontend_tools?.targets.some(target => target.app === "kernel" && target.tools.includes("apps.install_prepared")), "The exact archive must declare its generic prepared-install capability");
      assert.ok(installReservations.some(grant => grant.method === "repo_access_v1"), "Preparing private downloads must be included in the install review");
    }
    async function fixture(name: string, source: string, args: unknown[] = [], targetId?: string) {
      const compiled = await compileFixture(`marketplace_browser_${name}`, source);
      const wasm = new Uint8Array(await readFile(compiled.rawWasmPath));
      if (source === "mo/main.mo") assert.equal(sha256Hex(wasm), protocolHash, "Exercise the exact deployed protocol module");
      const canisterId = targetId ? await createProtocolAtManifestPrincipal(environment, targetId) : await environment.createCanister();
      await environment.installTransportWasm(canisterId, {
        chunks: chunkWasm(wasm), transportWasm: wasm, transportWasmSha256: sha256Hex(wasm),
      }, new Uint8Array(IDL.encode(compiled.init({ IDL }), args)));
      return { canisterId: Principal.fromText(canisterId), compiled };
    }
    const ledger = await fixture("ledger", "test/fixtures/FakeLedger.mo", [{ symbol: "ckUSDC", decimals: 6, fee: 10n }]);
    const oracle = await fixture("oracle", "test/fixtures/Oracle.mo");
    const fees = { version: 1n, updateBase: 1_000_000n, updateByte: 2n, storageByteYear: 3n, purchase: 2_000_000n, withdraw: 2_000_000n, grant: 3_000_000n, xrc: 20_000_000n };
    const protocol = await fixture("protocol", "mo/main.mo", [{
      admins: [Principal.fromText(environment.controllerPrincipal)], auditors: [], trustedPublishingPrincipal: [Principal.fromText(environment.controllerPrincipal)],
      tokens: [{ ledger: ledger.canisterId, symbol: "ckUSDC", decimals: 6, fee: 10n, rateSymbol: "USDC", burnAccount: [] }],
      xrc: oracle.canisterId, fees, referralTerms: { version: 1n, discountBps: 1000n, affiliateBps: 3000n, developerBps: 3000n }, reservations: [],
    }], customTarget ? undefined : productionProtocolId);
    const canisterId = await environment.createCanister();
    await environment.ensureQualificationSelfController(canisterId);
    await environment.installTransportWasm(canisterId, deployment);
    bindDeploymentRuntimeConfig({ deployment, canisterId, target: "pocketic", updateSourceCanisterId: protocol.canisterId.toText() });
    const actor = environment.provision.kernelActor(canisterId);
    await seedFreshKernel({ actor, canisterId, deployment, concurrency: 128, logger: { log() {} } });
    await environment.authorizeQualificationController(canisterId);
    await environment.verifyQualificationController(canisterId);
    const info = await actor.kernel_runtime_info();
    assert.equal(info.deployment_id, deployment.compiled.deploymentId);
    const generatedBase = path.join(temporary, "neutron");
    await writeFile(`${generatedBase}.did`, deployment.compiled.candid);
    const bindings = await (await prepareAsh()).bind(`${generatedBase}.did`, generatedBase, temporary);
    const { idlFactory } = await import(pathToFileURL(bindings.jsPath).href);
    await environment.normalizeToWallAndStartAutoProgress();
    const installed = Actor.createActor(idlFactory, { agent: environment.provision.agent, canisterId }) as Record<string, (...args: any[]) => Promise<any>>;
    function method(name: string): string {
      return physicalAppMethodName("marketplace", name);
    }
    // This setup only selects a disposable protocol. It does not pre-create a
    // browser identity, grant backend reservations, or register a read delegate.
    async function configureLocalProtocol() {
      const configured = await installed[method("marketplace_configure")]!({ canister: protocol.canisterId, host: "http://localhost:8000" });
      assert.ok("ok" in configured);
    }
    await configureLocalProtocol();
    const state = () => installed[method("marketplace_state")]!(null);
    async function assertInstallReservations() {
      if (!manifestReservations) return;
      const rows = await installed.kernel_backend_reservations_snapshot!(null) as Array<{ app_id: string; installation_uid: bigint; scope_kind: string; principal: [] | [Principal]; method: [] | [string] }>;
      const current = (await actor.kernel_runtime_info()).apps.find(app => app.scope.app_id === "marketplace")!;
      assert.ok(current);
      const grants = rows.filter(row => row.app_id === "marketplace");
      assert.equal(grants.length, installReservations.length, "Installation must create all declared grants before first open");
      for (const grant of grants) {
        assert.equal(grant.installation_uid, current.scope.installation_uid, "Grants must belong to the current app installation");
        assert.equal(grant.scope_kind, "exact");
        assert.equal(grant.principal[0]?.toText(), productionProtocolId);
      }
      assert.deepEqual(grants.map(grant => grant.method[0]).sort(), installReservations.map(grant => grant.method).sort());
    }
    await assertInstallReservations();
    assert.deepEqual((await state()).seed, [], "A fresh runtime starts without a registered read key");
    const protocolActor = Actor.createActor(protocol.compiled.idlFactory, { agent: environment.provision.agent, canisterId: protocol.canisterId }) as Record<string, (...args: any[]) => Promise<any>>;
    const ledgerActor = Actor.createActor(ledger.compiled.idlFactory, { agent: environment.provision.agent, canisterId: ledger.canisterId }) as Record<string, (...args: any[]) => Promise<any>>;
    async function assertNoLedgerEffects() {
      const stats = await ledgerActor.stats!();
      assert.equal(stats.transferCalls, 0n);
      assert.equal(stats.transferFromCalls, 0n);
      assert.equal(stats.approveCalls, 0n);
      assert.equal(stats.appliedTransactions, 0n, "Free acquisitions and installation must not move ledger funds");
    }
    const installFixtures = expectedVersion >= 111 && !negativeControl ? await publishInstallFixtures(protocolActor, protocol.canisterId.toText()) : [];
    return { environment, deployment, canisterId, protocolId: protocol.canisterId.toText(), marketplaceHash, relayMethod: method("marketplace_call"), state, configureLocalProtocol, assertInstallReservations, installFixtures, installReservations, assertNoLedgerEffects, readSourceHttp: request => protocolActor.http_request!(request) };
  } catch (error) {
    await environment.stop();
    throw error;
  }
}

async function createProtocolAtManifestPrincipal(environment: IsolatedQualificationPocketIc, canisterId: string): Promise<string> {
  // This is a new empty canister inside this process's disposable PocketIC.
  // Keeping the manifest principal exercises its real install grants without
  // editing the released archive or silently creating test-only reservations.
  const target = Principal.fromText(canisterId);
  const request = IDL.Record({ amount: IDL.Opt(IDL.Nat), specified_id: IDL.Opt(IDL.Principal), settings: IDL.Opt(IDL.Record({ controllers: IDL.Opt(IDL.Vec(IDL.Principal)) })) });
  const control = new PocketIcRestClient(environment.controlUrl, { requestTimeoutMs: 120_000 });
  const message = await control.submitIngressMessage(environment.instanceId, {
    sender: Principal.fromText(environment.controllerPrincipal), canisterId: Principal.fromText("aaaaa-aa"), method: "provisional_create_canister_with_cycles",
    payload: new Uint8Array(IDL.encode([request], [{ amount: [100_000_000_000_000n], specified_id: [target], settings: [{ controllers: [[Principal.fromText(environment.controllerPrincipal)]] }] }])),
  });
  const result = IDL.decode([IDL.Record({ canister_id: IDL.Principal })], await control.awaitIngressMessage(environment.instanceId, message)) as Array<{ canister_id: Principal }>;
  assert.equal(result[0]?.canister_id.toText(), canisterId);
  return canisterId;
}

export function observe(context: BrowserContext, runtime: Runtime): Observation {
  const result: Observation = { relays: new Map(), ingress: [], privateQueries: [], libraryReplies: 0, errors: [], blocked: [], privatePackageReads: [], sourceCorsRestorations: [], sourceGrantRequests: [] };
  context.on("request", request => {
    const url = new URL(request.url());
    if (!/^\/api\/v[234]\/canister\/[^/]+\/(?:call|query)$/.test(url.pathname)) return;
    const body = request.postDataBuffer();
    if (!body) return;
    try {
      const envelope = Cbor.decode<{ content: Record<string, unknown>; sender_delegation?: Array<{ delegation: { targets?: Uint8Array[] } }> }>(new Uint8Array(body));
      const content = envelope.content;
      const method = content.method_name, canister = content.canister_id;
      result.ingress.push({ path: url.pathname, method: String(method), canisterType: Object.prototype.toString.call(canister) });
      if (typeof method !== "string") return;
      assert.ok(canister instanceof Uint8Array);
      const canisterId = Principal.fromUint8Array(new Uint8Array(canister)).toText();
      if (method === runtime.relayMethod) {
        assert.equal(canisterId, runtime.canisterId);
        const [request] = IDL.decode([relayType], new Uint8Array(content.arg as Uint8Array)) as Array<{ canister: Principal; method: string; args: Uint8Array; cycles: bigint }>;
        assert.equal(request!.canister.toText(), runtime.protocolId, "Marketplace updates escaped the local protocol");
        assert.ok(request!.cycles > 0n, "Initialization must attach the protocol's fixed cycle charge");
        const ingressRequestId = Buffer.from(requestIdOf(content as any)).toString("hex");
        result.relays.set(ingressRequestId, request!.method);
        if (request!.method === "repo_access_v1" && !result.sourceGrantRequests.some(item => item.ingressRequestId === ingressRequestId)) {
          // Retain exact scope, never the bearer capability itself.
          const [grant] = IDL.decode([IDL.Record({ paths: IDL.Vec(IDL.Text) })], new Uint8Array(request!.args)) as Array<{ paths: string[] }>;
          result.sourceGrantRequests.push({ ingressRequestId, source: request!.canister.toText(), paths: grant!.paths });
        }
      }
      if (["earnings_query", "library_query", "publisher_apps"].includes(method)) {
        assert.equal(canisterId, runtime.protocolId);
        assert.ok(content.sender instanceof Uint8Array);
        result.privateQueries.push({ method, canisterId, sender: Principal.fromUint8Array(content.sender).toText(),
          delegationTargets: (envelope.sender_delegation ?? []).map(entry => (entry.delegation.targets ?? []).map(value => Principal.fromUint8Array(value).toText())),
        });
      }
    } catch (error) { result.errors.push(String(error)); }
  });
  context.on("response", response => {
    const request = response.request();
    const pathname = new URL(request.url()).pathname;
    if (/^\/repo\/v1\/packages\/[a-f0-9]{64}\.neutron$/.test(pathname)) {
      result.privatePackageReads.push({ path: pathname, status: response.status(), authorized: !!request.headers().authorization });
    }
    if (!pathname.endsWith("/query")) return;
    const body = request.postDataBuffer();
    if (!body) return;
    void (async () => {
      const envelope = Cbor.decode<{ content: { method_name: string } }>(new Uint8Array(body));
      if (envelope.content.method_name !== "library_query") return;
      assert.equal(response.status(), 200);
      const reply = Cbor.decode<{ status: string; reply: { arg: Uint8Array } }>(new Uint8Array(await response.body()));
      assert.equal(reply.status, "replied", "The replica must accept the actual delegated signature");
      const outputType = IDL.Variant({ ok: IDL.Record({ apps: IDL.Vec(IDL.Reserved), nextCursor: IDL.Opt(IDL.Nat64) }), err: IDL.Record({ code: IDL.Text, message: IDL.Text }) });
      const [decoded] = IDL.decode([outputType], new Uint8Array(reply.reply.arg)) as Array<{ ok?: { apps: unknown[] } }>;
      assert.ok(decoded && "ok" in decoded, "The live protocol must authorize the private library read");
      result.libraryReplies++;
    })().catch(error => result.errors.push(String(error)));
  });
  void context.route("**/*", route => {
    const url = new URL(route.request().url());
    if (!["http:", "https:"].includes(url.protocol) || (url.protocol === "http:" && url.port === "8000" && (url.hostname === "localhost" || url.hostname.endsWith(".localhost")))) return route.continue();
    result.blocked.push(url.origin);
    return route.abort("blockedbyclient");
  });
  return result;
}

async function tileFor(page: Page): Promise<Frame> {
  const locator = page.locator('iframe[data-app-id="marketplace"][data-tile-id="main"]').last();
  await locator.waitFor({ state: "attached", timeout });
  for (let n = 0; n < 150; n++) {
    const frame = await (await locator.elementHandle())?.contentFrame();
    if (frame?.url().includes("/app/marketplace/")) return frame;
    await page.waitForTimeout(100);
  }
  throw new Error("Installed Marketplace tile did not load");
}

async function open(page: Page, runtime: Runtime): Promise<Frame> {
  await page.goto(`http://${runtime.canisterId}.localhost:8000`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof (window as any).__NEUTRON_PLAYWRIGHT_LOGIN_AS__ === "function", undefined, { timeout });
  const owner = await page.evaluate(seed => (window as any).__NEUTRON_PLAYWRIGHT_LOGIN_AS__(seed), loginSeed);
  assert.equal(owner, runtime.environment.controllerPrincipal);
  const existing = page.locator('iframe[data-app-id="marketplace"][data-tile-id="main"]');
  await page.locator('[data-tid="launcher-open"]').waitFor({ state: "visible", timeout });
  if (await existing.count() === 0) {
    await page.locator('[data-tid="launcher-open"]').click();
    await page.locator('[data-tid="launcher-tile-marketplace-main"]').click();
  }
  return tileFor(page);
}

async function library(page: Page, frame: Frame, observation: Observation): Promise<void> {
  const previousReplies = observation.libraryReplies;
  await frame.getByRole("button", { name: "My Apps", exact: true }).click();
  await frame.getByText("Make room for something useful", { exact: true }).waitFor({ state: "visible", timeout });
  const start = Date.now();
  while (observation.libraryReplies === previousReplies && Date.now() - start < timeout && observation.errors.length === 0) await page.waitForTimeout(100);
  assert.deepEqual(observation.errors, [], "The installed private-read transport must succeed");
  assert.ok(observation.libraryReplies > previousReplies, "My Apps must receive an authorized response from the actual protocol");
  assert.equal(await page.locator('[data-tid="backend-call-dialog"]').count(), 0, "Restored identity unexpectedly asked for backend permission");
  assert.ok(observation.privateQueries.some(request => request.method === "library_query"), "My Apps must execute the real direct private query");
  assert.equal(await frame.getByText("This background process did not declare this UI request", { exact: false }).count(), 0);
}

function libraryPrincipal(observation: Observation, protocolId: string): string {
  const requests = observation.privateQueries.filter(request => request.method === "library_query");
  assert.ok(requests.length > 0, "No authenticated My Apps query was captured");
  for (const request of requests) {
    assert.deepEqual(request.delegationTargets, [[protocolId]], "Private reads must use an IC delegation limited to the selected marketplace");
    assert.equal(request.sender, requests[0]!.sender, "Private read account unexpectedly changed");
  }
  return requests[0]!.sender;
}

async function waitForAppOperation(page: Page, kind: "install" | "uninstall"): Promise<void> {
  const progress = page.locator('[data-tid="install-progress"]');
  const error = page.locator('[data-tid="install-error"]');
  const first = await Promise.race([
    progress.waitFor({ state: "visible", timeout: 30_000 }).then(() => "progress"),
    error.waitFor({ state: "visible", timeout: 30_000 }).then(() => "error"),
  ]);
  if (first === "error") throw new Error(`Checked ${kind} failed: ${await error.innerText()}`);
  assert.equal(await progress.getAttribute("data-operation-kind"), kind);
  await progress.waitFor({ state: "hidden", timeout: 180_000 });
  if (await error.isVisible()) throw new Error(`Checked ${kind} failed: ${await error.innerText()}`);
}

async function reinstall(page: Page, runtime: Runtime): Promise<void> {
  const actor = runtime.environment.provision.kernelActor(runtime.canisterId);
  const before = await actor.kernel_runtime_info();
  const previous = before.apps.find(app => app.scope.app_id === "marketplace")!;
  assert.ok(previous);
  await page.locator('[data-tid="kernel-tray-toggle"]').click();
  await page.locator('[data-tid="kernel-tray-settings"]').click();
  await page.locator('[data-tid="settings-select-marketplace"]').click();
  await page.locator('[data-tid="settings-delete-selected"]').click();
  await page.locator('[data-tid="uninstall-dialog"]').waitFor({ state: "visible", timeout });
  await page.locator('[data-tid="uninstall-confirm"]').click();
  await waitForAppOperation(page, "uninstall");
  const removed = await actor.kernel_runtime_info();
  assert.ok(removed.apps.every(app => app.scope.app_id !== "marketplace"));
  assert.deepEqual(await actor.kernel_install_status(null), []);
  await page.locator('[data-tid="settings-back"]').click();
  const launcher = page.locator('[data-tid="launcher"]');
  if (!(await launcher.isVisible())) await page.locator('[data-tid="launcher-open"]').click();
  const choosing = page.waitForEvent("filechooser");
  await page.locator('[data-tid="launcher-install-package"]').click();
  await (await choosing).setFiles(archive("marketplace", expectedVersion));
  await page.locator('[data-tid="install-compiled"]').waitFor({ state: "visible", timeout: 180_000 });
  assert.match(await page.locator('[data-tid="install-dialog"]').innerText(), /Wallet custody signing|wallet_custody_signing/i,
    "Reinstall must review the declared stable signing capability");
  if (manifestReservations) {
    await page.locator('[data-tid="install-dialog"]').getByText("Technical details", { exact: true }).click();
    // The disclosure also lists "exact" as an allowed reservation mode; that
    // row has no principal and is not one of the installed target grants.
    const grants = page.locator('[data-tid="install-dialog"] [data-kind="backend_calls"] .permission-inventory li[data-scope="exact"]').filter({ hasText: productionProtocolId });
    assert.equal(await grants.count(), runtime.installReservations.length, "Install review must show every exact permission before acceptance");
    for (const { principal, method } of runtime.installReservations) assert.equal(await grants.filter({ hasText: `${principal} · ${method}` }).count(), 1);
    if (expectedVersion >= 111) assert.equal(await page.locator('[data-tid="install-dialog"] [data-kind="frontend_tools"] code').filter({ hasText: /^apps\.install_prepared$/ }).count(), 1, "Install review must disclose the generic prepared-install tool");
    await page.screenshot({ path: path.join(output, "install-permissions.png") });
  }
  await page.locator('[data-tid="install-accept"]').click();
  await waitForAppOperation(page, "install");
  const reinstalled = await actor.kernel_runtime_info();
  const current = reinstalled.apps.find(app => app.scope.app_id === "marketplace")!;
  assert.ok(current);
  assert.notEqual(current.scope.installation_uid, previous.scope.installation_uid, "Uninstall/reinstall must create a new app installation");
  assert.deepEqual(await actor.kernel_install_status(null), []);
  assert.deepEqual((await runtime.state()).seed, [], "Uninstall must actually remove the old app memory, not retain the test seed");
  await runtime.assertInstallReservations();
  await runtime.configureLocalProtocol();
}

async function installFixtureApps(page: Page, frame: Frame, runtime: Runtime, observation: Observation): Promise<void> {
  const actor = runtime.environment.provision.kernelActor(runtime.canisterId);
  const initial = await actor.kernel_runtime_info();
  assert.ok(runtime.installFixtures.length === 2);
  for (const fixture of runtime.installFixtures) {
    assert.ok(initial.apps.every(app => app.scope.app_id !== fixture.id));
    await frame.getByRole("button", { name: "Explore", exact: true }).click();
    const card = frame.locator(".mp-app-card").filter({ hasText: fixture.title });
    await card.getByRole("button", { name: "Free", exact: true }).click();
    const checkout = frame.getByRole("dialog", { name: "Add to My Apps", exact: true });
    await checkout.getByRole("button", { name: "Review costs", exact: true }).click();
    await checkout.getByRole("button", { name: "Add to My Apps", exact: true }).click();
    await checkout.waitFor({ state: "hidden", timeout });
    await frame.getByRole("checkbox", { name: `Select ${fixture.title}`, exact: true }).waitFor({ state: "visible", timeout });
  }
  await runtime.assertNoLedgerEffects();
  for (const fixture of runtime.installFixtures) await frame.getByRole("checkbox", { name: `Select ${fixture.title}`, exact: true }).check();
  const install = frame.locator(".mp-selection-bar").getByRole("button", { name: "Install selected", exact: true });
  const relayCount = (method: string) => [...observation.relays.values()].filter(value => value === method).length;
  const beforePrepare = relayCount("install_prepare"), beforeGrant = relayCount("repo_access_v1");
  async function review(reopen = false) {
    if (reopen) {
      // After preparation the app clears its selection toolbar and retains a
      // named saved operation. Reopen that exact operation without selecting
      // apps again or starting a fresh preparation.
      const saved = frame.locator(".mp-operation").filter({ hasText: "Ready to install" });
      await saved.getByText("Ready · No additional access charge", { exact: true }).waitFor({ state: "visible", timeout });
      await saved.getByRole("button", { name: "Install", exact: true }).click();
    } else await install.click();
    const dialog = page.locator('[data-tid="repository-setup-dialog"]');
    const confirm = dialog.locator('[data-tid="repository-install"]');
    await confirm.waitFor({ state: "visible", timeout: 180_000 });
    assert.equal(await confirm.isEnabled(), true);
    assert.equal(await dialog.locator('[data-tid="repository-select-all"]').count(), 0, "The prepared selection must not be selected a second time");
    assert.equal(await dialog.locator('[data-tid="repository-review"]').count(), 0, "Prepared installs must go directly to the final review");
    assert.equal(await page.locator('[data-tid="install-offer-dialog"], [data-tid="frontend-tool-dialog"], [data-tid="backend-call-dialog"]').count(), 0, "There must not be a preliminary offer/access/tool permission dialog");
    assert.equal(await dialog.locator(".repository-package").count(), 2);
    for (const fixture of runtime.installFixtures) assert.equal(await dialog.locator(`.repository-package[data-app-id="${fixture.id}"].is-selected`).count(), 1);
    assert.equal(relayCount("install_prepare"), beforePrepare + 1, "Preparing/reopening this selection must call install_prepare once");
    assert.equal(relayCount("repo_access_v1"), beforeGrant + 1, "Preparing/reopening this selection must charge for one exact download grant");
    assert.deepEqual(observation.sourceGrantRequests.at(-1)?.paths.slice().sort(), runtime.installFixtures.map(fixture => `/repo/v1/packages/${fixture.sha256}.neutron`).sort(), "The prepared grant must cover exactly the selected package paths");
    assert.ok(observation.ingress.every(call => call.method !== "kernel_repository_access_v1"), "Kernel must reuse the app's prepared grant instead of charging for another source grant");
    return { dialog, confirm };
  }
  let reviewed = await review();
  await page.screenshot({ path: path.join(output, "prepared-install-review.png") });
  await reviewed.dialog.locator('[data-tid="repository-dismiss"]').click();
  await reviewed.dialog.waitFor({ state: "hidden", timeout });
  assert.equal((await actor.kernel_runtime_info()).deployment_id, initial.deployment_id, "Canceling the final review must not install either app");
  reviewed = await review(true);
  await reviewed.confirm.click();
  await page.locator('[data-tid="repository-success"]').waitFor({ state: "visible", timeout: 240_000 });
  const installed = await actor.kernel_runtime_info();
  for (const fixture of runtime.installFixtures) {
    const app = installed.apps.find(app => app.scope.app_id === fixture.id);
    assert.ok(app, `${fixture.id} was not installed by the checked transaction`);
    assert.equal(Number(app.version), fixture.version);
    const resource = `/repo/v1/packages/${fixture.sha256}.neutron`;
    assert.ok(observation.privatePackageReads.some(read => read.path === resource && read.status === 200), "Each selected package must be downloaded successfully");
    if (kernelVersion >= 359) assert.ok(observation.privatePackageReads.filter(read => read.path === resource).every(read => !read.authorized), "Free public packages should use the certified public response without sending the prepared bearer");
  }
  assert.equal(relayCount("install_prepare"), beforePrepare + 1);
  assert.equal(relayCount("repo_access_v1"), beforeGrant + 1);
  await runtime.assertNoLedgerEffects();
  await page.screenshot({ path: path.join(output, "two-apps-installed.png") });
  await page.locator('[data-tid="repository-done"]').click();
}

async function launchBrowser(): Promise<Browser> {
  let executablePath = process.env.CHROMIUM_PATH;
  if (!executablePath) {
    for (const entry of (await readdir("/nix/store").catch(() => [])).filter(name => name.includes("-chromium-")).sort()) {
      const candidate = path.join("/nix/store", entry, "bin/chromium");
      try { await access(candidate, constants.X_OK); executablePath = candidate; break; } catch {}
    }
  }
  return chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}), args: ["--no-sandbox", "--disable-background-networking", "--host-resolver-rules=MAP localhost 127.0.0.2,MAP *.localhost 127.0.0.2"] });
}

async function run(): Promise<void> {
  await mkdir(output, { recursive: true });
  const temporary = await mkdtemp(path.join(tmpdir(), "marketplace-browser-qualification-"));
  let runtime: Runtime | undefined, browser: Browser | undefined;
  const observations: Observation[] = [];
  try {
    runtime = await installRuntime(temporary);
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1100, height: 850 } });
    const observed = observe(context, runtime); observations.push(observed);
    const sourceCors = (item: Observation) => ({ source: runtime!.protocolId, gateway: runtime!.environment.gatewayTransportOrigin, rootKey: Uint8Array.from(Buffer.from(runtime!.environment.rootKeyBase64, "base64")), readHttp: runtime!.readSourceHttp, evidence: item.sourceCorsRestorations, errors: item.errors });
    const sourcePreflight = await inspectSourcePreflight(sourceCors(observed), runtime.installFixtures[0] ? `/repo/v1/packages/${runtime.installFixtures[0].sha256}.neutron` : "/repo/v1/access.json");
    await writeFile(path.join(output, "source-preflight.json"), JSON.stringify(sourcePreflight, null, 2) + "\n");
    await preserveSourceCertificateVisibility(context, sourceCors(observed));
    const page = await context.newPage();
    page.on("console", message => { if (message.type() === "error") console.error(`[browser] ${message.text()}`); });
    page.on("pageerror", error => observed.errors.push(String(error)));
    let tile = await open(page, runtime);
    if (negativeControl) {
      await tile.getByRole("button", { name: "Connect", exact: true }).click();
      await tile.getByText("This background process did not declare this UI request", { exact: false }).waitFor({ timeout });
      assert.equal(observed.relays.size, 0, "The rejected old declaration must not dispatch a registration");
      await page.screenshot({ path: path.join(output, "negative-control.png") });
    } else {
      // Default permissions come from the unchanged package at installation.
      // A selected custom target (or old archive) genuinely lacks that grant.
      if (expectRuntimeGrant) {
        await page.locator('[data-tid="backend-call-dialog"]').waitFor({ state: "visible", timeout });
        assert.match(await page.locator('[data-tid="backend-call-dialog"]').innerText(), /Marketplace/);
        await page.locator('[data-tid="backend-call-approve"]').click();
      }
      await library(page, tile, observed);
      console.log("Initial browser observation", JSON.stringify({ ...observed, relays: [...observed.relays] }));
      assert.deepEqual([...observed.relays.values()], ["read_delegate_set"], "First initialization registers exactly once and performs no payment");
      const state = await runtime.state();
      assert.equal(state.seed.length, 1);
      assert.equal(state.seed[0]!.length, 32);
      const seedHash = sha256Hex(state.seed[0]!);
      const readPrincipal = libraryPrincipal(observed, runtime.protocolId);
      await page.screenshot({ path: path.join(output, "initialized.png") });
      tile = await open(page, runtime);
      await library(page, tile, observed);
      assert.deepEqual([...observed.relays.values()], ["read_delegate_set"], "Reload repeated protocol registration");
      assert.equal(sha256Hex((await runtime.state()).seed[0]!), seedHash);
      assert.equal(libraryPrincipal(observed, runtime.protocolId), readPrincipal);
      await context.close();
      const fresh = await browser.newContext({ viewport: { width: 1100, height: 850 } });
      const freshObserved = observe(fresh, runtime); observations.push(freshObserved);
      await preserveSourceCertificateVisibility(fresh, sourceCors(freshObserved));
      const freshPage = await fresh.newPage();
      freshPage.on("pageerror", error => freshObserved.errors.push(String(error)));
      const freshTile = await open(freshPage, runtime);
      await library(freshPage, freshTile, freshObserved);
      assert.equal(freshObserved.relays.size, 0, "A fresh browser profile must restore the same Neutron delegate without registration");
      assert.equal(sha256Hex((await runtime.state()).seed[0]!), seedHash);
      assert.equal(libraryPrincipal(freshObserved, runtime.protocolId), readPrincipal);
      await freshPage.screenshot({ path: path.join(output, "restored-profile.png") });
      await reinstall(freshPage, runtime);
      const reinstalledTile = await open(freshPage, runtime);
      await library(freshPage, reinstalledTile, freshObserved);
      assert.equal(freshObserved.relays.size, 0, "Same-Neutron reinstall must not register another protocol account");
      assert.notEqual(sha256Hex((await runtime.state()).seed[0]!), seedHash, "The new browser session key should be distinct after app-memory deletion");
      assert.equal(libraryPrincipal(freshObserved, runtime.protocolId), readPrincipal, "The marketplace identity must survive actual app uninstall/reinstall");
      await freshPage.screenshot({ path: path.join(output, "reinstalled.png") });
      // Reinstall restores manifest grants as part of its consent transaction.
      // A later nonfinancial update must use those grants without another
      // prompt. Only a separately selected custom target still needs consent.
      await reinstalledTile.getByRole("button", { name: "Earnings", exact: true }).click();
      await reinstalledTile.getByRole("button", { name: "Get my affiliate code", exact: true }).click();
      if (expectRuntimeGrant) {
        await freshPage.locator('[data-tid="backend-call-dialog"]').waitFor({ state: "visible", timeout });
        await freshPage.locator('[data-tid="backend-call-approve"]').click();
      }
      await reinstalledTile.locator(".mp-code-row code").waitFor({ state: "visible", timeout });
      assert.equal(await freshPage.locator('[data-tid="backend-call-dialog"]').count(), 0, "The first post-install update must not leave a permission prompt");
      assert.deepEqual([...freshObserved.relays.values()], ["referral_get_or_create"], "A reinstall's first update must not repeat account registration or a payment");
      if (expectedVersion >= 111) {
        // Browser permission belongs to the top-level Kernel, never the app's
        // cross-origin frame. Copy must use the shared Kernel clipboard broker.
        await fresh.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(freshPage.url()).origin });
        const referralCode = await reinstalledTile.locator(".mp-code-row code").innerText();
        await reinstalledTile.getByRole("button", { name: "Copy", exact: true }).click();
        await reinstalledTile.getByRole("button", { name: "Copied", exact: true }).waitFor({ state: "visible", timeout });
        assert.equal(await freshPage.evaluate(() => navigator.clipboard.readText()), referralCode, "The installed iframe must copy through the Kernel's clipboard capability");
        await freshPage.screenshot({ path: path.join(output, "affiliate-copied.png") });
        await installFixtureApps(freshPage, reinstalledTile, runtime, freshObserved);
      }
      await fresh.close();
    }
    for (const item of observations) {
      assert.deepEqual(item.blocked, [], "No request may escape the disposable gateway");
      assert.deepEqual(item.errors, [], "Installed browser or request inspection failed");
    }
    const report = { result: "passed", negativeControl, customTarget, manifestReservations, expectRuntimeGrant, kernelVersion, kernelHash, marketplaceVersion: expectedVersion, marketplaceHash: runtime.marketplaceHash, protocolHash,
      registrationCalls: observations.map(item => [...item.relays.values()].filter(method => method === "read_delegate_set").length),
      directPrivateQueries: observations.map(item => item.privateQueries),
      clipboardCopied: !negativeControl && expectedVersion >= 111,
      installFixtures: runtime.installFixtures,
      privatePackageReads: observations.flatMap(item => item.privatePackageReads),
      sourceCorsRestorations: observations.flatMap(item => item.sourceCorsRestorations),
      sourceGrantRequests: observations.flatMap(item => item.sourceGrantRequests),
      sourcePreflight,
      scope: "Installed normal-mode tile, initial manifest reservations, checked uninstall/reinstall, later update, direct private queries, real clipboard copying, two free acquisitions and single-review two-app installation with cancel/retry when supported; no financial effects, no direct reservation/delegate setup, no production calls" };
    await writeFile(path.join(output, "receipt.json"), JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    await writeFile(path.join(output, "failure-observations.json"), JSON.stringify(observations.map(item => ({ ...item, relays: [...item.relays] })), null, 2));
    await writeFile(path.join(output, "failure.txt"), String(error) + "\n" + (error instanceof Error ? error.stack : ""));
    for (const context of browser?.contexts() ?? []) for (const page of context.pages()) {
      await page.screenshot({ path: path.join(output, "failure.png") }).catch(() => undefined);
      await writeFile(path.join(output, "failure-page.txt"), await page.locator("body").innerText().catch(() => "Page unavailable"));
      for (const frame of page.frames()) if (frame.url().includes("/app/marketplace/")) await writeFile(path.join(output, `failure-${new URL(frame.url()).searchParams.get("role")}.txt`), await frame.locator("body").innerText().catch(() => "Frame unavailable"));
    }
    throw error;
  } finally {
    await browser?.close();
    await runtime?.environment.stop();
    await rm(temporary, { recursive: true, force: true });
    await disposeMotokoCompiler();
  }
}

if (import.meta.main) await run();
