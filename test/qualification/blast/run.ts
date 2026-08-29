import { chromium, type Browser, type BrowserContext, type Frame, type Page } from "@playwright/test";
import { constants } from "node:fs";
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertPreparedDeploymentTarget,
  chunkWasm,
  prepareDeployment,
  sha256Hex,
  type PreparedDeployment,
} from "neutron-provision/src/artifact.js";
import { seedFreshKernel } from "neutron-provision/src/provision.js";
import { bindDeploymentRuntimeConfig } from "neutron-provision/src/runtime_config.js";
import { compileMotokoWithCandid } from "neutron-scripts/src/compile_motoko.js";
import { trustedInstallationContextFromRootKey } from "neutron-compiler/src/installation_context.js";
import {
  unpackNeutronPackage,
  type AppInstance,
  type KernelRuntimeInfo,
} from "neutron-compiler/src/install.js";
import { packageArchiveFilename } from "neutron-tools/src/package_archive.js";
import {
  localCanisterOrigin,
  persistentAppFramePrefix,
} from "neutron-tools/src/runtime.js";
import {
  launchIsolatedQualificationPocketIc,
  type IsolatedQualificationPocketIc,
} from "../../../apps/kernel/evidence/qualification/environment.ts";
import {
  BLAST_QUALIFICATION_AGENT_ID,
  buildBlastQualificationAgentArchive,
} from "./fixture_package.ts";

const REPOSITORY_ROOT = path.resolve(import.meta.dir, "../../..");
const LOGIN_SEED = 0xc7;
const BLAST_APP_ID = "blast";
const BLAST_TARGET = "app:blast:background";
const QUALIFICATION_TIMEOUT_MS = 180_000;

type JsonObject = Record<string, unknown>;

type BlastAuthority = Readonly<{
  installationUid: string;
  browserOriginNonce: string;
  browserOriginAuthorityEpoch: string;
}>;

type BlastPackageVersions = Readonly<{
  kernel: number;
  agent: number;
  blast: number;
}>;

type InstalledRuntime = Readonly<{
  environment: IsolatedQualificationPocketIc;
  deployment: PreparedDeployment;
  versions: BlastPackageVersions;
  currentBlastArchive: string;
  neutronCanisterId: string;
  targetCanisterId: string;
  blastAuthority: BlastAuthority;
}>;

type Driver = {
  context: BrowserContext;
  page: Page;
  tile: Frame;
  agent: Frame;
  blast: Frame;
  network: NetworkGuard;
  blastToolNames: string[];
  workerRequests: Set<string>;
  callFromAgent(
    target: string,
    tool: string,
    arguments_: JsonObject,
  ): Promise<unknown>;
  callBlast(tool: string, arguments_: JsonObject): Promise<unknown>;
  turn(input: JsonObject): Promise<JsonObject>;
  cancelTurn(input: JsonObject, delayMs: number): Promise<TurnInspection>;
  assertNetworkIsolation(): Promise<void>;
  close(): Promise<void>;
};

type BlastToolCaller = Readonly<{
  callBlast(tool: string, arguments_: JsonObject): Promise<unknown>;
}>;

type BrowserBlastToolCaller = BlastToolCaller & Readonly<{ page: Page }>;

type SameProfileTab = BlastToolCaller & Readonly<{
  page: Page;
  close(): Promise<void>;
}>;

type TurnInspection = Readonly<{
  pending: boolean;
  result: unknown;
  error: string | null;
}>;

type NetworkGuard = {
  checks: Promise<void>[];
  failures: unknown[];
  socketAddresses: Set<string>;
};

type InstalledSourceTargetSummary = Readonly<{
  version: number;
  installationUid: string;
  revision: string;
}>;

type InstalledSourceQualification = Readonly<{
  kernel: InstalledSourceTargetSummary;
  blast: InstalledSourceTargetSummary;
}>;

type QualificationReport = Readonly<{
  isolated: true;
  versions: Readonly<{ kernel: number; agent: number; blast: number }>;
  neutronCanisterId: string;
  targetCanisterId: string;
  blastResidentOrigin: string;
  localIdentityPrincipal: string;
  sameProfileIdentityPrincipal: string;
  secondProfileIdentityPrincipal: string;
  workerBundles: string[];
  installedSource: InstalledSourceQualification;
  cancellation: Readonly<{
    error: string;
    runningRunsAfterCancellation: number;
  }>;
  storage: Readonly<{
    collections: number;
    pages: number;
    items: number;
    usage: number;
    quota: number;
    persisted: boolean;
  }>;
  nestedConsent: Readonly<{
    deniedDispatchStatus: string;
    counterBefore: string;
    counterAfterDenial: string;
    counterAfterApproval: string;
  }>;
  ownerConsent: Readonly<{
    deniedDispatchStatus: string;
    counterBefore: string;
    counterAfterDenial: string;
    counterAfterApproval: string;
  }>;
  uninstallReinstall: Readonly<{
    previousInstallationUid: string;
    replacementInstallationUid: string;
    replacementResidentOrigin: string;
    replacementIdentityPrincipal: string;
    freshScriptId: string;
    freshScriptRevision: string;
    savedScriptsAfterReinstall: number;
    collectionsAfterReinstall: number;
  }>;
}>;

export async function runInstalledBlastQualification(): Promise<QualificationReport> {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "neutron-blast-qualification-"),
  );
  let runtime: InstalledRuntime | undefined;
  let browser: Browser | undefined;
  try {
    runtime = await installFreshRuntime(temporaryRoot);
    await runtime.environment.normalizeToWallAndStartAutoProgress();
    browser = await launchQualificationChromium();

    const first = await openDriver(browser, runtime);
    try {
      await qualifyV100Upgrade(first, runtime);
      const report = await qualifyFirstProfile(first, runtime);
      const second = await openDriver(browser, runtime);
      let secondPrincipal: string;
      try {
        const secondIdentity = await successfulToolCall(
          second,
          "blast.identity",
          {},
        );
        secondPrincipal = requiredString(
          secondIdentity.principal,
          "second-profile Blast principal",
        );
        assert(
          secondPrincipal !== report.localIdentityPrincipal,
          "A fresh browser profile reused Blast's local identity",
        );
        const secondCollections = await successfulToolCall(
          second,
          "collection.list",
          { limit: 20 },
        );
        assertArray(secondCollections.collections, "second-profile collections");
        assert(
          secondCollections.collections.length === 0,
          "A fresh browser profile observed another profile's collections",
        );
        const sharedScripts = await successfulToolCall(second, "script.list", {
          limit: 10,
        });
        assertArray(sharedScripts.scripts, "second-profile saved scripts");
        assert(
          sharedScripts.scripts.some(
            (entry) =>
              isObject(entry) && entry.id === report.scriptId,
          ),
          "The backend script library was not shared across browser profiles",
        );

        await Promise.all([
          first.assertNetworkIsolation(),
          second.assertNetworkIsolation(),
        ]);
      } finally {
        await second.close();
      }
      const uninstallReinstall = await qualifyUninstallReinstall(
        first,
        runtime,
        {
          residentOrigin: report.blastResidentOrigin,
          identityPrincipal: report.localIdentityPrincipal,
          scriptId: report.scriptId,
          scriptRevision: report.scriptRevision,
          collectionIds: [
            report.rawCollectionId,
            report.derivedCollectionId,
          ],
        },
      );
      await first.assertNetworkIsolation();

      return Object.freeze({
        isolated: true,
        versions: runtime.versions,
        neutronCanisterId: runtime.neutronCanisterId,
        targetCanisterId: runtime.targetCanisterId,
        blastResidentOrigin: report.blastResidentOrigin,
        localIdentityPrincipal: report.localIdentityPrincipal,
        sameProfileIdentityPrincipal: report.sameProfileIdentityPrincipal,
        secondProfileIdentityPrincipal: secondPrincipal,
        workerBundles: [...first.workerRequests]
          .filter((url) => /\/(?:script|query)_worker\.js(?:\?|$)/u.test(url))
          .sort(),
        installedSource: report.installedSource,
        nestedConsent: report.nestedConsent,
        ownerConsent: report.ownerConsent,
        cancellation: report.cancellation,
        storage: report.storage,
        uninstallReinstall,
      });
    } finally {
      await first.close();
    }
  } finally {
    const failures: unknown[] = [];
    if (browser !== undefined) {
      try {
        await browser.close();
      } catch (error) {
        failures.push(error);
      }
    }
    if (runtime !== undefined) {
      try {
        await runtime.environment.stop();
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await rm(temporaryRoot, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "Blast qualification cleanup did not complete",
      );
    }
  }
}

async function installFreshRuntime(temporaryRoot: string): Promise<InstalledRuntime> {
  const blastV100Archive = path.join(
    REPOSITORY_ROOT,
    "apps",
    BLAST_APP_ID,
    packageArchiveFilename(BLAST_APP_ID, 100),
  );
  const [kernelArchive, agentArchive, currentBlastArchive, fixtureArchive] =
    await Promise.all([
      currentArchive("kernel"),
      currentArchive("agent"),
      currentArchive("blast"),
      buildBlastQualificationAgentArchive({
        repositoryRoot: REPOSITORY_ROOT,
        temporaryRoot,
      }),
    ]);
  await access(blastV100Archive, constants.R_OK);
  const blastV100Bytes = new Uint8Array(await readFile(blastV100Archive));
  assert(
    sha256Hex(blastV100Bytes) ===
      "b4e125cc7ce06146cea044bad89a609bbf2fbb12dfc772d3d80e40fdca1ea9fb",
    "Tracked Blast v0.1.0 archive bytes changed",
  );
  await assertStrictCanisterCallKernelArchive(kernelArchive);
  const environment = await launchIsolatedQualificationPocketIc({
    repositoryRoot: REPOSITORY_ROOT,
  });
  try {
    const deployment = await prepareDeployment(
      [kernelArchive, agentArchive, blastV100Archive, fixtureArchive],
      {
        target: "local",
        freshInstallationContext: trustedInstallationContextFromRootKey(
          Uint8Array.from(Buffer.from(environment.rootKeyBase64, "base64")),
        ),
      },
    );
    const initialVersions = packageVersions(deployment);
    const sourceVersions = await Promise.all([
      sourceManifestVersion("kernel"),
      sourceManifestVersion("agent"),
      sourceManifestVersion("blast"),
    ]);
    assert(
      initialVersions.kernel === sourceVersions[0] &&
        initialVersions.agent === sourceVersions[1] &&
        initialVersions.blast === 100 &&
        sourceVersions[2] > initialVersions.blast,
      "Qualification baseline must use current Kernel and Agent with exact predecessor Blast v0.1.0",
    );

    const targetCanisterId = await installTargetCanister(
      environment,
      temporaryRoot,
    );
    const neutronCanisterId = await environment.createCanister();
    await environment.ensureQualificationSelfController(neutronCanisterId);
    assertPreparedDeploymentTarget(deployment, neutronCanisterId);
    await environment.installTransportWasm(neutronCanisterId, deployment);
    bindDeploymentRuntimeConfig({
      deployment,
      canisterId: neutronCanisterId,
      target: "pocketic",
      updateSourceCanisterId: targetCanisterId,
    });
    const actor = environment.provision.kernelActor(neutronCanisterId);
    await seedFreshKernel({
      actor,
      canisterId: neutronCanisterId,
      deployment,
      concurrency: 128,
      logger: { log: () => undefined },
    });
    await environment.authorizeQualificationController(neutronCanisterId);
    await environment.verifyQualificationController(neutronCanisterId);
    const info = await actor.kernel_runtime_info();
    assert(
      info.deployment_id === deployment.compiled.deploymentId,
      "Installed runtime does not match the fresh compiled deployment",
    );
    const blast = requireBlastInstance(info);
    assert(
      Object.hasOwn(blast.resident_frame_security, "persistent_dedicated_v1"),
      "Blast did not install with persistent dedicated resident security",
    );
    return Object.freeze({
      environment,
      deployment,
      versions: Object.freeze({
        kernel: sourceVersions[0],
        agent: sourceVersions[1],
        blast: sourceVersions[2],
      }),
      currentBlastArchive,
      neutronCanisterId,
      targetCanisterId,
      blastAuthority: blastAuthority(blast),
    });
  } catch (error) {
    await environment.stop();
    throw error;
  }
}

async function installTargetCanister(
  environment: IsolatedQualificationPocketIc,
  temporaryRoot: string,
): Promise<string> {
  const sourcePath = path.join(temporaryRoot, "target.mo");
  const wasmPath = path.join(temporaryRoot, "target.wasm");
  await writeFile(sourcePath, targetCanisterSource(), { mode: 0o600 });
  const compiled = await compileMotokoWithCandid({
    cwd: temporaryRoot,
    sourcePath,
    outputPath: wasmPath,
    packages: {},
  });
  const wasm = new Uint8Array(await readFile(compiled.wasmPath));
  const targetCanisterId = await environment.createCanister();
  await environment.installTransportWasm(targetCanisterId, {
    chunks: chunkWasm(wasm),
    transportWasm: wasm,
    transportWasmSha256: sha256Hex(wasm),
  });
  return targetCanisterId;
}

function targetCanisterSource(): string {
  const candid = `service : {
  __get_candid_interface_tmp_hack: () -> (text) query;
  increment: () -> (nat);
  nested_page: (opt nat) -> (record {
    items: vec record {
      id: nat;
      title: text;
      votes: nat;
      metadata: record { topic: text; tags: vec text };
    };
    next: opt nat;
  }) query;
  read_counter: () -> (nat) query;
}`;
  return `persistent actor {
  stable var counter : Nat = 0;

  public query func __get_candid_interface_tmp_hack() : async Text {
    ${JSON.stringify(candid)}
  };

  public query func read_counter() : async Nat { counter };

  public shared func increment() : async Nat {
    counter += 1;
    counter
  };

  public query func nested_page(cursor : ?Nat) : async {
    items : [{ id : Nat; title : Text; votes : Nat; metadata : { topic : Text; tags : [Text] } }];
    next : ?Nat;
  } {
    switch (cursor) {
      case null {
        {
          items = [
            { id = 1; title = "Alpha"; votes = 2; metadata = { topic = "governance"; tags = ["nested", "page"] } },
            { id = 2; title = "Beta"; votes = 3; metadata = { topic = "governance"; tags = ["nested"] } },
          ];
          next = ?2;
        }
      };
      case (?value) {
        if (value == 2) {
          {
            items = [
              { id = 3; title = "Gamma"; votes = 4; metadata = { topic = "governance"; tags = ["page-two"] } },
              { id = 4; title = "Delta"; votes = 5; metadata = { topic = "governance"; tags = ["page-two", "nested"] } },
            ];
            next = null;
          }
        } else {
          { items = []; next = null }
        }
      };
    }
  };
};
`;
}

async function openDriver(
  browser: Browser,
  runtime: InstalledRuntime,
): Promise<Driver> {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const kernelOrigin = localCanisterOrigin(
    runtime.neutronCanisterId,
    "http://localhost:8000",
  );
  await installAgentPortCapture(context, kernelOrigin);
  const network = await installNetworkGuard(context);
  const workerRequests = new Set<string>();
  const page = await context.newPage();
  observeQualificationPage(page, network, workerRequests);
  await page.goto(kernelOrigin, { waitUntil: "domcontentloaded" });
  await loginQualificationPage(page, runtime);
  const blast = await waitForFrame(page, BLAST_APP_ID, "background");
  await assertBlastResidentAuthority(page, blast, runtime);
  const agent = await waitForFrame(page, "agent", "background");
  const blastToolNames = await authorizeAgentBlastSession(page, agent);

  await page.locator('[data-tid="launcher-open"]').click();
  await page.locator('[data-tid="launcher"]').waitFor({ state: "visible" });
  await page
    .locator(
      `[data-tid="launcher-tile-${BLAST_QUALIFICATION_AGENT_ID}-driver"]`,
    )
    .click();
  const tile = await waitForFrame(page, BLAST_QUALIFICATION_AGENT_ID, "tile");
  await enableQualificationAgentMode(page, tile);

  const driver: Driver = {
    context,
    page,
    tile,
    agent,
    blast,
    network,
    blastToolNames,
    workerRequests,
    async callFromAgent(target, tool, arguments_) {
      return await callFromAgentFrame(
        driver.agent,
        target,
        tool,
        arguments_,
      );
    },
    async callBlast(tool: string, arguments_: JsonObject) {
      return await driver.callFromAgent(BLAST_TARGET, tool, arguments_);
    },
    async turn(input) {
      await driver.tile.evaluate((value) => {
        const api = window.__BLAST_QUALIFICATION_AGENT__;
        if (!api) throw new Error("Blast qualification tile API is unavailable");
        api.prepare(value);
      }, input);
      await driver.tile.locator("[data-action=run]").click();
      await driver.tile.waitForFunction(
        () => window.__BLAST_QUALIFICATION_AGENT__?.inspect().pending === false,
        undefined,
        { timeout: QUALIFICATION_TIMEOUT_MS },
      );
      const outcome = await driver.tile.evaluate(() =>
        window.__BLAST_QUALIFICATION_AGENT__?.inspect(),
      );
      assert(isObject(outcome), "Qualification tile returned no outcome");
      if (typeof outcome.error === "string" && outcome.error.length > 0) {
        throw new Error(`Qualification turn failed: ${outcome.error}`);
      }
      return requiredObject(outcome.result, "qualification turn result");
    },
    async cancelTurn(input, delayMs) {
      await driver.tile.evaluate((value) => {
        const api = window.__BLAST_QUALIFICATION_AGENT__;
        if (!api) throw new Error("Blast qualification tile API is unavailable");
        api.prepare(value);
      }, input);
      await driver.tile.locator("[data-action=run]").click();
      await driver.tile.waitForFunction(
        () => window.__BLAST_QUALIFICATION_AGENT__?.inspect().pending === true,
      );
      await driver.tile.waitForTimeout(delayMs);
      const cancelled = await driver.tile.evaluate(() =>
        window.__BLAST_QUALIFICATION_AGENT__?.cancel(),
      );
      assert(cancelled === true, "Qualification turn had no active request to cancel");
      await driver.tile.waitForFunction(
        () => window.__BLAST_QUALIFICATION_AGENT__?.inspect().pending === false,
        undefined,
        { timeout: 10_000 },
      );
      return await inspectQualificationTurn(driver.tile);
    },
    async assertNetworkIsolation() {
      await page.waitForTimeout(50);
      await Promise.all(network.checks);
      if (network.failures.length > 0) {
        throw new AggregateError(
          [...network.failures],
          "Blast qualification browser escaped its private gateway",
        );
      }
      assert(
        network.socketAddresses.size === 1 &&
          network.socketAddresses.has("127.0.0.2:8000"),
        "Blast qualification did not remain on the owned 127.0.0.2:8000 gateway",
      );
    },
    async close() {
      await context.close();
    },
  };
  return driver;
}

async function openSameProfileTab(
  owner: Driver,
  runtime: InstalledRuntime,
): Promise<SameProfileTab> {
  const page = await owner.context.newPage();
  observeQualificationPage(page, owner.network, owner.workerRequests);
  const kernelOrigin = localCanisterOrigin(
    runtime.neutronCanisterId,
    "http://localhost:8000",
  );
  await page.goto(kernelOrigin, { waitUntil: "domcontentloaded" });
  await loginQualificationPage(page, runtime);
  const blast = await waitForFrame(page, BLAST_APP_ID, "background");
  await assertBlastResidentAuthority(page, blast, runtime);
  const agent = await waitForFrame(page, "agent", "background");
  await authorizeAgentBlastSession(page, agent);
  return Object.freeze({
    page,
    async callBlast(tool: string, arguments_: JsonObject) {
      return await callFromAgentFrame(agent, BLAST_TARGET, tool, arguments_);
    },
    async close() {
      await page.close();
    },
  });
}

async function loginQualificationPage(
  page: Page,
  runtime: InstalledRuntime,
): Promise<void> {
  await page.waitForFunction(
    () => typeof window.__NEUTRON_PLAYWRIGHT_LOGIN_AS__ === "function",
    undefined,
    { timeout: 30_000 },
  );
  const principal = await page.evaluate(async (seed) => {
    const login = window.__NEUTRON_PLAYWRIGHT_LOGIN_AS__;
    if (!login) throw new Error("Local Playwright login hook is unavailable");
    return await login(seed);
  }, LOGIN_SEED);
  assert(
    principal === runtime.environment.controllerPrincipal,
    "Browser login selected the wrong qualification principal",
  );
  await page.locator('[data-tid="launcher-open"]').waitFor({
    state: "visible",
    timeout: 30_000,
  });
}

async function callFromAgentFrame(
  agent: Frame,
  target: string,
  tool: string,
  arguments_: JsonObject,
): Promise<unknown> {
  return await agent.evaluate(
    async ({ target, tool, arguments: callArguments }) => {
      const api = window.__BLAST_QUALIFICATION_PORT__;
      if (!api) throw new Error("Installed Agent port capture is unavailable");
      return await api.exec("tools.call", {
        target,
        name: tool,
        arguments: callArguments,
      });
    },
    { target, tool, arguments: arguments_ },
  );
}

async function inspectQualificationTurn(tile: Frame): Promise<TurnInspection> {
  const value = await tile.evaluate(() =>
    window.__BLAST_QUALIFICATION_AGENT__?.inspect(),
  );
  const outcome = requiredObject(value, "qualification turn outcome");
  assert(
    typeof outcome.pending === "boolean" &&
      (outcome.error === null || typeof outcome.error === "string"),
    "Qualification turn outcome is malformed",
  );
  return Object.freeze({
    pending: outcome.pending,
    result: outcome.result,
    error: outcome.error,
  });
}

function observeQualificationPage(
  page: Page,
  network: NetworkGuard,
  workerRequests: Set<string>,
): void {
  page.on("console", (message) => {
    if (message.type() === "error") {
      console.error(`[qualification browser] ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => {
    console.error(`[qualification browser] ${error.message}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      console.error(
        `[qualification browser] HTTP ${response.status()} ${response.url()}`,
      );
    }
  });
  observeNetworkResponses(page, network);
  page.on("request", (request) => {
    if (/\/(?:script|query)_worker\.js(?:\?|$)/u.test(request.url())) {
      workerRequests.add(request.url());
    }
  });
}

async function installNetworkGuard(
  context: BrowserContext,
): Promise<NetworkGuard> {
  const guard: NetworkGuard = {
    checks: [],
    failures: [],
    socketAddresses: new Set<string>(),
  };
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      await route.continue();
      return;
    }
    if (isQualificationGatewayUrl(url)) {
      await route.continue();
      return;
    }
    guard.failures.push(
      new Error(`Blocked non-qualification browser request to ${url.origin}`),
    );
    await route.abort("blockedbyclient");
  });
  return guard;
}

function observeNetworkResponses(page: Page, guard: NetworkGuard): void {
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (!isQualificationGatewayUrl(url)) return;
    const check = response
      .serverAddr()
      .then((address) => {
        if (address === null) return;
        const observed = `${address.ipAddress}:${address.port}`;
        guard.socketAddresses.add(observed);
        assert(
          observed === "127.0.0.2:8000",
          `Qualification response used unexpected socket ${observed}`,
        );
      })
      .catch((error) => {
        guard.failures.push(error);
      });
    guard.checks.push(check);
  });
}

function isQualificationGatewayUrl(url: URL): boolean {
  return (
    url.protocol === "http:" &&
    url.port === "8000" &&
    (url.hostname === "localhost" || url.hostname.endsWith(".localhost"))
  );
}

async function installAgentPortCapture(
  context: BrowserContext,
  expectedKernelOrigin: string,
): Promise<void> {
  await context.addInitScript((kernelOrigin) => {
    const search = new URLSearchParams(location.search);
    if (
      location.pathname !== "/app/agent/service.html" ||
      search.get("app") !== "agent" ||
      search.get("role") !== "background"
    ) {
      return;
    }
    let port: MessagePort | null = null;
    let nextId = 7_000_000_000_000;
    const pending = new Map<
      number,
      { resolve(value: unknown): void; reject(error: Error): void }
    >();
    const readyWaiters: Array<() => void> = [];
    const api = Object.freeze({
      async ready(): Promise<void> {
        if (port !== null) return;
        await new Promise<void>((resolve) => readyWaiters.push(resolve));
      },
      async exec(action: string, payload: unknown): Promise<unknown> {
        if (port === null) throw new Error("Installed Agent port is not connected");
        const id = nextId;
        nextId += 1;
        if (!Number.isSafeInteger(nextId)) {
          throw new Error("Qualification Agent port request ids are exhausted");
        }
        return await new Promise<unknown>((resolve, reject) => {
          pending.set(id, { resolve, reject });
          port!.postMessage({ type: "exec", id, payload: { action, payload } });
        });
      },
    });
    Object.defineProperty(window, "__BLAST_QUALIFICATION_PORT__", {
      configurable: false,
      enumerable: false,
      writable: false,
      value: api,
    });
    window.addEventListener("message", (event) => {
      const message = event.data;
      if (
        event.source !== parent ||
        event.origin !== kernelOrigin ||
        !message ||
        typeof message !== "object" ||
        message.type !== "neutron:msgbus:connect" ||
        message.version !== 1 ||
        typeof message.sessionId !== "string" ||
        event.ports.length !== 1
      ) {
        return;
      }
      if (port !== null && port !== event.ports[0]) {
        for (const request of pending.values()) {
          request.reject(new Error("Installed Agent port was replaced"));
        }
        pending.clear();
        port.close();
      }
      port = event.ports[0]!;
      port.addEventListener("message", (portEvent) => {
        const response = portEvent.data;
        if (
          !response ||
          typeof response !== "object" ||
          response.type !== "response" ||
          !Number.isSafeInteger(response.id)
        ) {
          return;
        }
        const request = pending.get(response.id);
        if (!request) return;
        pending.delete(response.id);
        if (Object.hasOwn(response, "error")) {
          request.reject(
            new Error(
              typeof response.error?.message === "string"
                ? response.error.message
                : JSON.stringify(response.error),
            ),
          );
        } else {
          request.resolve(response.ok);
        }
      });
      port.start();
      for (const resolve of readyWaiters.splice(0)) resolve();
    });
  }, expectedKernelOrigin);
}

async function authorizeAgentBlastSession(
  page: Page,
  agent: Frame,
): Promise<string[]> {
  await agent.waitForFunction(
    () => window.__BLAST_QUALIFICATION_PORT__ !== undefined,
  );
  await agent.evaluate(async () => {
    await window.__BLAST_QUALIFICATION_PORT__?.ready();
  });
  const listing = agent.evaluate(async (target) => {
    const api = window.__BLAST_QUALIFICATION_PORT__;
    if (!api) throw new Error("Installed Agent port capture is unavailable");
    return await api.exec("tools.list", { target });
  }, BLAST_TARGET);
  const dialog = page.locator('[data-tid="frontend-tool-dialog"]');
  await dialog.waitFor({ state: "visible" });
  const text = (await dialog.textContent()) ?? "";
  assert(
    text.includes("agent/background") &&
      text.includes(BLAST_TARGET) &&
      text.includes("*") ,
    "Kernel tool consent did not bind Agent/background to Blast's resident",
  );
  await page.locator('[data-tid="frontend-tool-approve-session"]').click();
  let descriptors: unknown;
  try {
    descriptors = await listing;
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("Timeout")) {
      throw error;
    }
    descriptors = await retryAgentBlastToolList(agent);
  }
  assertArray(descriptors, "installed Agent Blast descriptors");
  return descriptors.map((descriptor) =>
    requiredString(
      requiredObject(descriptor, "Blast tool descriptor").name,
      "Blast tool descriptor name",
    )
  );
}

async function retryAgentBlastToolList(agent: Frame): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await agent.waitForTimeout(250);
    try {
      return await agent.evaluate(async (target) => {
        const api = window.__BLAST_QUALIFICATION_PORT__;
        if (!api) throw new Error("Installed Agent port capture is unavailable");
        return await api.exec("tools.list", { target });
      }, BLAST_TARGET);
    } catch (error) {
      lastError = error;
      if (!(error instanceof Error) || !error.message.includes("Timeout")) {
        throw error;
      }
    }
  }
  throw lastError;
}

async function enableQualificationAgentMode(
  page: Page,
  tile: Frame,
): Promise<void> {
  await tile.locator("[data-action=enable]").click();
  await page.locator('[data-tid="agent-grant-dialog"]').waitFor({
    state: "visible",
  });
  await page.locator('[data-tid="agent-grant-approve"]').click();
  await page.locator('[data-tid="agent-mode-indicator"]').waitFor({
    state: "visible",
  });
}

async function qualifyV100Upgrade(
  driver: Driver,
  runtime: InstalledRuntime,
): Promise<void> {
  const identity = await successfulToolCall(driver, "blast.identity", {});
  const principal = requiredString(
    identity.principal,
    "v0.1.0 Blast local identity principal",
  );
  const residentOrigin = new URL(driver.blast.url()).origin;
  const source = predecessorStateScriptSource();
  const saved = await successfulToolCall(driver, "script.save", {
    name: "v0.1.0 upgrade qualification",
    description: "Temporary predecessor state for checked upgrade qualification",
    source,
  });
  const script = requiredObject(saved.script, "v0.1.0 saved script");
  const scriptId = requiredString(script.id, "v0.1.0 script id");
  const scriptRevision = requiredString(
    script.revision,
    "v0.1.0 script revision",
  );
  const execution = await successfulToolCall(driver, "script.run", {
    id: scriptId,
    revision: scriptRevision,
    digest: requiredString(script.sourceDigest, "v0.1.0 script digest"),
    args: predecessorStateScriptArgs(),
    identityMode: "local",
    inputCollectionIds: [],
    timeoutMs: 30_000,
  });
  assert(
    execution.state === "complete",
    "Installed Blast v0.1.0 qualification script did not complete",
  );
  const result = requiredObject(execution.result, "v0.1.0 script result");
  const collectionId = requiredString(
    result.collectionId,
    "v0.1.0 collection id",
  );
  const runId = requiredString(execution.runId, "v0.1.0 run id");
  assertCompletedCrawlCheckpoint(
    await successfulToolCall(driver, "run.get", { id: runId }),
    runId,
  );

  await updateBlastFromBrowser(driver, runtime);
  await driver.page.reload({ waitUntil: "domcontentloaded" });
  await reloginAndRestoreDriver(driver, runtime);
  assert(
    new URL(driver.blast.url()).origin === residentOrigin,
    "Blast persistent browser origin changed across v0.1.0 upgrade",
  );
  assert(
    (await successfulToolCall(driver, "blast.identity", {})).principal ===
      principal,
    "Blast local identity did not survive the v0.1.0 upgrade",
  );
  const restoredScript = await successfulToolCall(driver, "script.get", {
    id: scriptId,
  });
  assert(
    restoredScript.revision === scriptRevision &&
      restoredScript.source === source,
    "Blast backend script state did not survive the v0.1.0 upgrade",
  );
  const restoredCollection = await successfulToolCall(
    driver,
    "collection.describe",
    { id: collectionId, pageLimit: 1 },
  );
  assert(
    requiredObject(
      restoredCollection.collection,
      "restored v0.1.0 collection",
    ).id === collectionId,
    "Blast browser collection did not survive the v0.1.0 upgrade",
  );
  assertCompletedCrawlCheckpoint(
    await successfulToolCall(driver, "run.get", { id: runId }),
    runId,
  );
  await cleanupFirstProfile(
    driver,
    [collectionId],
    scriptId,
    scriptRevision,
  );
}

async function qualifyFirstProfile(driver: Driver, runtime: InstalledRuntime) {
  for (const name of [
    "blast.identity",
    "blast.scan",
    "blast.schema",
    "blast.validate_input",
    "blast.query",
    "blast.update",
    "script.evaluate",
    "script.save",
    "script.run",
    "run.get",
    "run.delete",
    "collection.list",
    "collection.describe",
    "collection.query",
    "collection.delete",
    "storage.status",
  ]) {
    assert(
      driver.blastToolNames.includes(name),
      `Installed Agent discovery omitted ${name}`,
    );
  }

  requiredObject(
    await driver.callFromAgent("kernel", "canister.schema_v2", {
      canister: runtime.targetCanisterId,
      method: "increment",
    }),
    "Kernel strict target schema",
  );

  const discoveryTurn = await driver.turn({ action: "discover" });
  const discovery = requiredObject(
    discoveryTurn.discovery,
    "installed Agent discovery",
  );
  assertArray(discovery.appIds, "installed Agent app ids");
  assertArray(discovery.blastEndpoints, "installed Agent Blast endpoints");
  assertArray(discovery.toolNames, "installed Agent Blast tool names");
  const installedSource = assertInstalledSourceQualification(
    discovery.installedSource,
    runtime.versions,
  );
  assert(
    discovery.appIds.includes(BLAST_APP_ID) &&
      discovery.blastEndpoints.length === 1 &&
      discovery.toolNames.includes("script.run") &&
      discovery.toolNames.includes("collection.list"),
    "Installed Agent did not discover Blast's headless resident tools",
  );
  assert(
    (await driver.page.locator('iframe[data-app-id="blast"][data-tile-id]').count()) === 0,
    "Blast unexpectedly required an open tile for Agent discovery",
  );

  const sameProfile = await openSameProfileTab(driver, runtime);

  const [identity, sameProfileIdentity] = await Promise.all([
    successfulToolCall(driver, "blast.identity", {}),
    successfulToolCall(sameProfile, "blast.identity", {}),
  ]);
  const localIdentityPrincipal = requiredString(
    identity.principal,
    "Blast local identity principal",
  );
  const sameProfileIdentityPrincipal = requiredString(
    sameProfileIdentity.principal,
    "same-profile Blast principal",
  );
  assert(
    sameProfileIdentityPrincipal === localIdentityPrincipal,
    "Two tabs in one browser profile did not share Blast's local identity",
  );
  const keyring = await inspectBlastBrowserStorage(driver.blast);
  assert(
    keyring.principal === localIdentityPrincipal,
    "Stored CryptoKey principal does not match blast.identity",
  );
  assert(
    keyring.privateKeyExtractable === false &&
      keyring.privateKeyType === "private" &&
      keyring.privateKeyAlgorithm === "ECDSA" &&
      keyring.privateKeyCurve === "P-256" &&
      keyring.privateKeyUsages.join(",") === "sign",
    "Blast did not retain a non-extractable P-256 signing key",
  );
  const ownerConsent = await exerciseOwnerConsent(
    driver,
    runtime.targetCanisterId,
  );

  const cancelled = await driver.cancelTurn(
    {
      action: "call",
      tool: "script.evaluate",
      arguments: {
        source: "for (;;) {}",
        args: null,
        inputCollectionIds: [],
        identityMode: "local",
        timeoutMs: 30_000,
      },
      consentDecision: "allow",
    },
    250,
  );
  const cancellationError = requiredString(
    cancelled.error,
    "cancelled Agent turn error",
  );
  assert(
    /abort|cancel/u.test(cancellationError.toLowerCase()),
    `Cancelled Agent turn returned an unexpected error: ${cancellationError}`,
  );
  const afterCancellation = await waitForNoRunningRuns(driver);

  const scan = await successfulToolCall(driver, "blast.scan", {
    canister: runtime.targetCanisterId,
  });
  assertArray(scan.methods, "ICBlast scan methods");
  assertMethod(scan.methods, "read_counter", "query");
  assertMethod(scan.methods, "increment", "update");
  assertMethod(scan.methods, "nested_page", "query");
  const schema = await successfulToolCall(driver, "blast.schema", {
    canister: runtime.targetCanisterId,
    method: "nested_page",
  });
  assert(schema.kind === "query", "ICBlast returned the wrong nested_page kind");
  assert(isObject(schema.schema), "ICBlast returned no nested_page schema");
  const validation = await successfulToolCall(driver, "blast.validate_input", {
    canister: runtime.targetCanisterId,
    method: "nested_page",
    args: [null],
  });
  assert(validation.valid === true, "ICBlast rejected the initial page cursor");
  const nested = await successfulToolCall(driver, "blast.query", {
    canister: runtime.targetCanisterId,
    method: "nested_page",
    args: [null],
    identityMode: "local",
  });
  const nestedResult = requiredObject(nested.result, "nested_page result");
  assertArray(nestedResult.items, "nested_page items");
  assert(
    nestedResult.items.length === 2 &&
      isObject(nestedResult.items[0]) &&
      isObject(nestedResult.items[0].metadata) &&
      nestedResult.next === "2",
    "ICBlast did not preserve the first nested page and continuation cursor",
  );

  const source = qualificationScriptSource();
  const saved = await successfulToolCall(driver, "script.save", {
    name: "Installed qualification",
    description: "Temporary saved script used only by isolated qualification",
    source,
  });
  const script = requiredObject(saved.script, "saved script summary");
  const scriptId = requiredString(script.id, "saved script id");
  const scriptRevision = requiredString(script.revision, "saved script revision");
  const scriptDigest = requiredString(script.sourceDigest, "saved script digest");
  const fetchedScript = await successfulToolCall(driver, "script.get", {
    id: scriptId,
  });
  assert(
    fetchedScript.id === scriptId && fetchedScript.source === source,
    "Saved-script backend did not return exact source",
  );

  const counterBefore = await readCounter(driver, runtime.targetCanisterId);
  const executionTurn = await toolCall(driver, "script.run", {
    id: scriptId,
    revision: scriptRevision,
    digest: scriptDigest,
    args: { canister: runtime.targetCanisterId },
    identityMode: "local",
    inputCollectionIds: [],
    timeoutMs: 30_000,
  }, "allow");
  assert(executionTurn.error === null, "Installed QuickJS script failed in Agent Mode");
  const execution = requiredObject(executionTurn.result, "QuickJS execution");
  assert(execution.state === "complete", "Installed QuickJS script did not complete");
  assertCompactAgentResult(executionTurn, ["Alpha", "Beta", "Gamma", "Delta"]);
  const scriptResult = requiredObject(execution.result, "QuickJS script result");
  const rawCollectionId = requiredString(
    scriptResult.collectionId,
    "raw collection id",
  );
  assert(
    scriptResult.pages === 2 && scriptResult.items === 4,
    "Saved script did not fetch both target canister pages",
  );
  const runId = requiredString(execution.runId, "script run id");
  const counterAfterScript = await readCounter(driver, runtime.targetCanisterId);
  assert(
    BigInt(counterAfterScript) === BigInt(counterBefore) + 1n,
    "The saved script update did not dispatch exactly once",
  );
  assertCompletedCrawlCheckpoint(
    await successfulToolCall(driver, "run.get", { id: runId }),
    runId,
  );

  const described = await successfulToolCall(driver, "collection.describe", {
    id: rawCollectionId,
    pageLimit: 1,
  });
  assertArray(described.pages, "raw collection sample pages");
  assert(
    described.pages.length === 1 && typeof described.cursor === "string",
    "Raw collection description did not expose a bounded page cursor",
  );
  const describedPage = requiredObject(
    requiredObject(described.pages[0], "raw collection page").value,
    "raw collection page value",
  );
  assertArray(describedPage.items, "raw collection nested items");
  assert(
    describedPage.items.length === 2 && describedPage.next === "2",
    "Raw collection did not retain the canister response unchanged",
  );

  const derivedTurn = await toolCall(driver, "script.evaluate", {
    source: derivedCollectionScriptSource(),
    args: { rawCollectionId },
    inputCollectionIds: [rawCollectionId],
    identityMode: "local",
    timeoutMs: 30_000,
  }, "allow");
  assert(derivedTurn.error === null, "Derived collection script failed");
  const derivedExecution = requiredObject(
    derivedTurn.result,
    "derived script execution",
  );
  assert(derivedExecution.state === "complete", "Derived script did not complete");
  assertCompactAgentResult(derivedTurn, ["metadata", "tags"]);
  const derivedResult = requiredObject(
    derivedExecution.result,
    "derived script result",
  );
  const derivedCollectionId = requiredString(
    derivedResult.collectionId,
    "derived collection id",
  );
  assert(derivedResult.items === 4, "Derived script did not transform four items");

  const listed = await successfulToolCall(driver, "collection.list", {
    limit: 20,
  });
  assertCollectionListContains(
    listed.collections,
    [rawCollectionId, derivedCollectionId],
    "first tab collection catalogue",
  );
  const sameProfileListed = await successfulToolCall(
    sameProfile,
    "collection.list",
    { limit: 20 },
  );
  assertCollectionListContains(
    sameProfileListed.collections,
    [rawCollectionId, derivedCollectionId],
    "same-profile tab collection catalogue",
  );

  const firstQuery = await successfulToolCall(driver, "collection.query", {
    id: derivedCollectionId,
    expression: "$sum(votes.$number())",
    pageLimit: 2,
  });
  assert(
    firstQuery.pageLocal === true &&
      firstQuery.value === 5 &&
      typeof firstQuery.cursor === "string",
    "First derived JSONata page did not return its page-local sum and cursor",
  );
  const secondQuery = await successfulToolCall(
    sameProfile,
    "collection.query",
    {
      id: derivedCollectionId,
      expression: "$sum(votes.$number())",
      cursor: firstQuery.cursor,
      pageLimit: 2,
    },
  );
  assert(
    secondQuery.pageLocal === true &&
      secondQuery.value === 9 &&
      secondQuery.cursor === null,
    "Same-profile tab did not finish the derived JSONata pagination",
  );
  assertWorkerRequests(driver.workerRequests);

  const storageStatus = await successfulToolCall(
    sameProfile,
    "storage.status",
    {},
  );
  const storage = assertInstalledStorageStatus(storageStatus);
  const counterBeforeNestedConsent = await readCounter(
    driver,
    runtime.targetCanisterId,
  );

  const denied = await toolCall(driver, "blast.update", {
    canister: runtime.targetCanisterId,
    method: "increment",
    args: [],
    identityMode: "kernel",
  }, "deny");
  assert(denied.error === null, "Denied nested update failed outside Blast");
  const deniedResult = requiredObject(denied.result, "denied update result");
  assert(
    deniedResult.dispatchStatus === "unknown" &&
      deniedResult.retrySafe === false,
    "Blast did not conservatively preserve denied boundary evidence",
  );
  assertOneSignedCallChallenge(denied.challenges, "deny");
  const counterAfterDenial = await readCounter(driver, runtime.targetCanisterId);
  assert(
    counterAfterDenial === counterBeforeNestedConsent,
    "Denied nested consent dispatched the target update",
  );

  const approved = await toolCall(driver, "blast.update", {
    canister: runtime.targetCanisterId,
    method: "increment",
    args: [],
    identityMode: "kernel",
  }, "allow");
  assert(approved.error === null, "Approved nested update did not return normally");
  const approvedResult = requiredObject(approved.result, "approved update result");
  assert(
    approvedResult.identityMode === "kernel" &&
      approvedResult.result === (BigInt(counterAfterDenial) + 1n).toString(),
    "Approved nested update returned the wrong authoritative result",
  );
  assertOneSignedCallChallenge(approved.challenges, "allow");
  const counterAfterApproval = await readCounter(driver, runtime.targetCanisterId);
  assert(
    BigInt(counterAfterApproval) === BigInt(counterAfterDenial) + 1n,
    "Approved nested consent did not dispatch exactly once",
  );

  const residentOrigin = new URL(driver.blast.url()).origin;
  await driver.page.reload({ waitUntil: "domcontentloaded" });
  await reloginAndRestoreDriver(driver, runtime);
  assert(
    new URL(driver.blast.url()).origin === residentOrigin,
    "Blast resident origin changed across an ordinary reload",
  );
  const restoredIdentity = await successfulToolCall(driver, "blast.identity", {});
  assert(
    restoredIdentity.principal === localIdentityPrincipal,
    "Blast local identity did not survive reload",
  );
  const restoredCollections = await successfulToolCall(driver, "collection.list", {
    limit: 20,
  });
  assertCollectionListContains(
    restoredCollections.collections,
    [rawCollectionId, derivedCollectionId],
    "restored collection catalogue",
  );
  const restoredScripts = await successfulToolCall(driver, "script.list", {
    limit: 10,
  });
  assertArray(restoredScripts.scripts, "restored saved scripts");
  assert(
    restoredScripts.scripts.some(
      (entry) => isObject(entry) && entry.id === scriptId,
    ),
    "Backend saved script did not survive reload",
  );
  assertCompletedCrawlCheckpoint(
    await successfulToolCall(driver, "run.get", { id: runId }),
    runId,
  );
  await sameProfile.close();
  return {
    blastResidentOrigin: residentOrigin,
    localIdentityPrincipal,
    sameProfileIdentityPrincipal,
    rawCollectionId,
    derivedCollectionId,
    scriptId,
    scriptRevision,
    installedSource,
    cancellation: {
      error: cancellationError,
      runningRunsAfterCancellation: requiredNonNegativeInteger(
        requiredObject(afterCancellation.logical, "post-cancellation logical storage")
          .runningRuns,
        "post-cancellation running runs",
      ),
    },
    storage,
    ownerConsent,
    nestedConsent: {
      deniedDispatchStatus: requiredString(
        deniedResult.dispatchStatus,
        "denied dispatch status",
      ),
      counterBefore: counterBeforeNestedConsent,
      counterAfterDenial,
      counterAfterApproval,
    },
  };
}

function assertInstalledSourceQualification(
  value: unknown,
  versions: BlastPackageVersions,
): InstalledSourceQualification {
  const inspection = requiredObject(value, "installed source qualification");
  const kernel = installedSourceTarget(
    inspection.kernel,
    "kernel",
    versions.kernel,
  );
  const blast = installedSourceTarget(
    inspection.blast,
    "blast",
    versions.blast,
  );
  return Object.freeze({ kernel, blast });
}

function installedSourceTarget(
  value: unknown,
  appId: "kernel" | "blast",
  expectedVersion: number,
): InstalledSourceTargetSummary {
  const target = requiredObject(value, `${appId} installed source`);
  const installationUid = requiredString(
    target.installationUid,
    `${appId} source installation uid`,
  );
  const revision = requiredString(target.revision, `${appId} source revision`);
  assert(
    target.version === expectedVersion &&
      /^[1-9][0-9]*$/u.test(installationUid) &&
      /^[a-f0-9]{64}$/u.test(revision),
    `${appId} source summary has the wrong installed identity`,
  );
  return Object.freeze({
    version: expectedVersion,
    installationUid,
    revision,
  });
}

async function waitForNoRunningRuns(
  driver: BlastToolCaller,
): Promise<JsonObject> {
  let latest: JsonObject | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    latest = await successfulToolCall(driver, "storage.status", {});
    const logical = requiredObject(latest.logical, "Blast logical storage status");
    if (logical.runningRuns === 0) return latest;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Blast retained a running script after cancellation: ${JSON.stringify(latest)}`,
  );
}

function assertCompletedCrawlCheckpoint(
  value: JsonObject,
  runId: string,
): void {
  const run = requiredObject(value.run, "retained crawl run");
  const checkpoint = requiredObject(value.checkpoint, "retained crawl checkpoint");
  const checkpointValue = requiredObject(
    checkpoint.value,
    "retained crawl checkpoint value",
  );
  assertArray(run.pendingUpdates, "retained crawl pending updates");
  assert(
    run.id === runId &&
      run.state === "complete" &&
      run.checkpointRevision === 2 &&
      run.pendingUpdates.length === 0 &&
      checkpoint.runId === runId &&
      checkpoint.revision === 2 &&
      checkpointValue.cursor === null &&
      checkpointValue.pages === 2 &&
      checkpointValue.items === 4,
    "Reloadable run/checkpoint evidence does not cover the completed crawl",
  );
}

function assertCompactAgentResult(
  value: unknown,
  forbiddenFragments: readonly string[],
): void {
  const encoded = JSON.stringify(value);
  assert(
    new TextEncoder().encode(encoded).byteLength <= 8_192,
    "Agent result exceeded the compact qualification budget",
  );
  for (const fragment of forbiddenFragments) {
    assert(
      !encoded.includes(fragment),
      `Agent result leaked stored collection content: ${fragment}`,
    );
  }
}

function assertCollectionListContains(
  value: unknown,
  collectionIds: readonly string[],
  label: string,
): void {
  assertArray(value, label);
  for (const collectionId of collectionIds) {
    assert(
      value.some(
        (collection) => isObject(collection) && collection.id === collectionId,
      ),
      `${label} omitted ${collectionId}`,
    );
  }
}

function assertInstalledStorageStatus(value: JsonObject): {
  collections: number;
  pages: number;
  items: number;
  usage: number;
  quota: number;
  persisted: boolean;
} {
  const logical = requiredObject(value.logical, "installed logical storage status");
  const origin = requiredObject(value.origin, "installed origin storage status");
  const collections = requiredNonNegativeInteger(
    logical.collections,
    "installed collection count",
  );
  const pages = requiredNonNegativeInteger(logical.pages, "installed page count");
  const items = requiredNonNegativeInteger(logical.items, "installed item count");
  const serializedBytes = requiredNonNegativeInteger(
    logical.serializedBytes,
    "installed serialized byte count",
  );
  const deletingCollections = requiredNonNegativeInteger(
    logical.deletingCollections,
    "installed deleting collection count",
  );
  const runningRuns = requiredNonNegativeInteger(
    logical.runningRuns,
    "installed running run count",
  );
  const usage = requiredNonNegativeInteger(origin.usage, "browser origin usage");
  const quota = requiredNonNegativeInteger(origin.quota, "browser origin quota");
  assert(typeof origin.persisted === "boolean", "Browser persistence status is unavailable");
  assert(
    collections === 2 &&
      pages === 6 &&
      items === 6 &&
      serializedBytes > 0 &&
      deletingCollections === 0 &&
      runningRuns === 0,
    "storage.status did not report the two complete installed collections",
  );
  assert(quota >= usage, "Browser origin usage exceeds its reported quota");
  return {
    collections,
    pages,
    items,
    usage,
    quota,
    persisted: origin.persisted,
  };
}

async function exerciseOwnerConsent(
  driver: BrowserBlastToolCaller,
  canister: string,
): Promise<{
  deniedDispatchStatus: string;
  counterBefore: string;
  counterAfterDenial: string;
  counterAfterApproval: string;
}> {
  const counterBefore = await readCounter(driver, canister);
  const approvedCall = driver.callBlast("blast.update", {
    canister,
    method: "increment",
    args: [],
    identityMode: "kernel",
  });
  await assertOwnerCallDialog(driver.page, approvedCall);
  await driver.page.locator('[data-tid="call-approve"]').click();
  const approvedResult = requiredObject(
    await approvedCall,
    "owner-approved update result",
  );
  assert(
    approvedResult.identityMode === "kernel" &&
      approvedResult.result === (BigInt(counterBefore) + 1n).toString(),
    "Owner-approved update returned the wrong result",
  );
  const counterAfterApproval = await readCounter(driver, canister);
  assert(
    BigInt(counterAfterApproval) === BigInt(counterBefore) + 1n,
    "Owner approval did not dispatch exactly one update",
  );

  const deniedCall = driver.callBlast("blast.update", {
    canister,
    method: "increment",
    args: [],
    identityMode: "kernel",
  });
  await assertOwnerCallDialog(driver.page, deniedCall);
  await driver.page.locator('[data-tid="call-reject"]').click();
  const deniedResult = requiredObject(await deniedCall, "owner-denied update result");
  assert(
    deniedResult.dispatchStatus === "unknown" && deniedResult.retrySafe === false,
    "Owner denial did not retain conservative unknown-outcome evidence",
  );
  const counterAfterDenial = await readCounter(driver, canister);
  assert(
    counterAfterDenial === counterAfterApproval,
    "Owner-denied update reached the target canister",
  );
  return {
    deniedDispatchStatus: requiredString(
      deniedResult.dispatchStatus,
      "owner-denied dispatch status",
    ),
    counterBefore,
    counterAfterDenial,
    counterAfterApproval,
  };
}

async function assertOwnerCallDialog(
  page: Page,
  pendingCall: Promise<unknown>,
): Promise<void> {
  const dialog = page.locator('[data-tid="call-dialog"]');
  await Promise.race([
    dialog.waitFor({ state: "visible", timeout: QUALIFICATION_TIMEOUT_MS }),
    pendingCall.then(
      async (value) => {
        const summary = JSON.stringify(value).slice(0, 1_024);
        throw new Error(
          `Kernel-identity update completed without owner consent: ${summary}`,
        );
      },
      (cause) => {
        throw new Error("Kernel-identity update failed before owner consent", {
          cause,
        });
      },
    ),
  ]);
  const text = (await dialog.textContent()) ?? "";
  assert(
    text.includes("Blast") && text.includes("increment"),
    "Owner call dialog did not identify Blast and the exact method",
  );
}

async function qualifyUninstallReinstall(
  driver: Driver,
  runtime: InstalledRuntime,
  live: Readonly<{
    residentOrigin: string;
    identityPrincipal: string;
    scriptId: string;
    scriptRevision: string;
    collectionIds: readonly string[];
  }>,
): Promise<QualificationReport["uninstallReinstall"]> {
  const actor = runtime.environment.provision.kernelActor(
    runtime.neutronCanisterId,
  );
  const before = await actor.kernel_runtime_info();
  const previousInstance = requireBlastInstance(before);
  const previousAuthority = blastAuthority(previousInstance);
  const previousResidentUrl = driver.blast.url();
  const beforeMemories = memoryInventory(before);
  const liveBlastMemories = beforeMemories.filter(
    ([owner]) => owner === BLAST_APP_ID,
  );
  assert(
    liveBlastMemories.length === 1 &&
      liveBlastMemories[0]?.[1] === BLAST_APP_ID &&
      liveBlastMemories[0]?.[2] === 1,
    "Blast uninstall qualification requires its one live managed-memory v1 root",
  );
  assert(
    JSON.stringify(previousAuthority) === JSON.stringify(runtime.blastAuthority),
    "Blast authority changed before uninstall qualification",
  );
  assert(
    new URL(previousResidentUrl).origin === live.residentOrigin,
    "Blast resident origin changed before uninstall qualification",
  );
  const savedBeforeUninstall = await successfulToolCall(
    driver,
    "script.get",
    { id: live.scriptId },
  );
  assert(
    savedBeforeUninstall.id === live.scriptId &&
      savedBeforeUninstall.revision === live.scriptRevision,
    "Blast saved script was not live immediately before uninstall",
  );
  const collectionsBeforeUninstall = await successfulToolCall(
    driver,
    "collection.list",
    { limit: 20 },
  );
  assertCollectionListContains(
    collectionsBeforeUninstall.collections,
    live.collectionIds,
    "pre-uninstall collection catalogue",
  );

  await uninstallBlastFromBrowser(driver.page);
  const removed = await actor.kernel_runtime_info();
  assert(
    removed.deployment_id !== before.deployment_id,
    "Blast uninstall did not activate a successor deployment",
  );
  assert(
    removed.apps.every(({ scope }) => scope.app_id !== BLAST_APP_ID),
    "Blast remained installed after the checked uninstall",
  );
  assert(
    JSON.stringify(memoryInventory(removed)) ===
      JSON.stringify(
        beforeMemories.filter(([owner]) => owner !== BLAST_APP_ID),
      ),
    "Blast checked uninstall changed memory outside its removed managed root",
  );
  assert(
    (await actor.kernel_install_status(null)).length === 0,
    "Blast uninstall left a checked install journal pending",
  );
  await driver.page
    .locator('[data-tid="app-background-frame"][data-app-id="blast"]')
    .waitFor({ state: "detached", timeout: 30_000 });

  await installBlastFromBrowser(driver.page, runtime.currentBlastArchive);
  const reinstalled = await actor.kernel_runtime_info();
  const replacementInstance = requireBlastInstance(reinstalled);
  const replacementAuthority = blastAuthority(replacementInstance);
  assert(
    reinstalled.deployment_id !== removed.deployment_id,
    "Blast same-id reinstall did not activate a successor deployment",
  );
  assert(
    Number(replacementInstance.version) === runtime.versions.blast,
    "Blast same-id reinstall did not activate the current packaged release",
  );
  assert(
    replacementAuthority.installationUid !== previousAuthority.installationUid &&
      replacementAuthority.browserOriginNonce !==
        previousAuthority.browserOriginNonce,
    "Blast same-id reinstall reused its prior installation or browser origin authority",
  );
  assert(
    JSON.stringify(memoryInventory(reinstalled)) ===
      JSON.stringify(beforeMemories),
    "Blast same-id reinstall did not recreate the declared managed-memory inventory",
  );
  assert(
    (await actor.kernel_install_status(null)).length === 0,
    "Blast same-id reinstall left a checked install journal pending",
  );
  await assertRevokedBlastResidentUrl(driver.page, previousResidentUrl);

  await driver.page.reload({ waitUntil: "domcontentloaded" });
  await reloginAndRestoreDriver(
    driver,
    runtime,
    replacementAuthority,
  );
  const replacementResidentOrigin = new URL(driver.blast.url()).origin;
  assert(
    replacementResidentOrigin !== live.residentOrigin,
    "Blast same-id reinstall reused the prior resident origin",
  );
  const replacementIdentity = await successfulToolCall(
    driver,
    "blast.identity",
    {},
  );
  const replacementIdentityPrincipal = requiredString(
    replacementIdentity.principal,
    "replacement Blast local identity principal",
  );
  assert(
    replacementIdentityPrincipal !== live.identityPrincipal,
    "Blast same-id reinstall recovered the prior origin-local identity",
  );
  const replacementKeyring = await inspectBlastBrowserStorage(driver.blast);
  assert(
    replacementKeyring.principal === replacementIdentityPrincipal,
    "Replacement Blast keyring does not match its fresh local identity",
  );

  const scriptsAfterReinstall = await successfulToolCall(
    driver,
    "script.list",
    { limit: 10 },
  );
  assertArray(scriptsAfterReinstall.scripts, "reinstalled saved scripts");
  assert(
    scriptsAfterReinstall.scripts.length === 0 &&
      scriptsAfterReinstall.libraryRevision === "0" &&
      scriptsAfterReinstall.total === 0 &&
      scriptsAfterReinstall.totalSourceBytes === 0 &&
      scriptsAfterReinstall.nextCursor === null &&
      (await driver.callBlast("script.get", { id: live.scriptId })) === null,
    "Blast same-id reinstall recovered backend scripts from the removed installation",
  );
  const collectionsAfterReinstall = await successfulToolCall(
    driver,
    "collection.list",
    { limit: 20 },
  );
  assertArray(
    collectionsAfterReinstall.collections,
    "reinstalled browser collections",
  );
  assert(
    collectionsAfterReinstall.collections.length === 0,
    "Blast same-id reinstall exposed collections from the prior browser origin",
  );
  const storageAfterReinstall = await successfulToolCall(
    driver,
    "storage.status",
    {},
  );
  const freshLogicalStorage = requiredObject(
    storageAfterReinstall.logical,
    "reinstalled logical storage status",
  );
  for (const field of [
    "collections",
    "pages",
    "items",
    "serializedBytes",
    "deletingCollections",
    "runningRuns",
  ]) {
    assert(
      requiredNonNegativeInteger(
        freshLogicalStorage[field],
        `reinstalled ${field}`,
      ) === 0,
      `Blast same-id reinstall retained non-empty ${field}`,
    );
  }

  const freshSaved = await successfulToolCall(driver, "script.save", {
    name: "Fresh reinstall qualification",
    description: "Temporary proof of a freshly initialized script library",
    source: "return { fresh: true };",
  });
  const freshScript = requiredObject(
    freshSaved.script,
    "fresh reinstall saved script",
  );
  const freshScriptId = requiredString(
    freshScript.id,
    "fresh reinstall script id",
  );
  const freshScriptRevision = requiredString(
    freshScript.revision,
    "fresh reinstall script revision",
  );
  assert(
    freshScriptId === "1" && freshScriptRevision === "1",
    "Blast same-id reinstall did not initialize a fresh backend script library",
  );
  await successfulToolCall(driver, "script.delete", {
    id: freshScriptId,
    expectedRevision: freshScriptRevision,
  });

  return Object.freeze({
    previousInstallationUid: previousAuthority.installationUid,
    replacementInstallationUid: replacementAuthority.installationUid,
    replacementResidentOrigin,
    replacementIdentityPrincipal,
    freshScriptId,
    freshScriptRevision,
    savedScriptsAfterReinstall: scriptsAfterReinstall.scripts.length,
    collectionsAfterReinstall: collectionsAfterReinstall.collections.length,
  });
}

async function updateBlastFromBrowser(
  driver: Driver,
  runtime: InstalledRuntime,
): Promise<void> {
  const actor = runtime.environment.provision.kernelActor(
    runtime.neutronCanisterId,
  );
  const before = await actor.kernel_runtime_info();
  const beforeBlast = requireBlastInstance(before);
  assert(
    Number(beforeBlast.version) === 100,
    "Blast upgrade qualification did not start from installed v0.1.0",
  );
  assert(
    JSON.stringify(blastAuthority(beforeBlast)) ===
      JSON.stringify(runtime.blastAuthority),
    "Installed v0.1.0 Blast authority changed before its update",
  );
  const beforeMemories = memoryInventory(before);

  await submitBlastArchiveFromBrowser(driver.page, {
    archive: runtime.currentBlastArchive,
    dialogTitle: "Update application",
    actionLabel: "Update",
    operationKind: "update",
    failureLabel: "Blast checked upgrade",
  });

  const after = await actor.kernel_runtime_info();
  const afterBlast = requireBlastInstance(after);
  assert(
    after.deployment_id !== before.deployment_id,
    "Blast update did not activate a successor deployment",
  );
  assert(
    Number(afterBlast.version) === runtime.versions.blast,
    "Blast update did not activate the current packaged release",
  );
  assert(
    JSON.stringify(blastAuthority(afterBlast)) ===
      JSON.stringify(runtime.blastAuthority),
    "Blast update changed its installation or persistent browser origin authority",
  );
  assert(
    JSON.stringify(memoryInventory(after)) === JSON.stringify(beforeMemories),
    "Blast update changed the installed managed-memory inventory",
  );
  assert(
    (await actor.kernel_install_status(null)).length === 0,
    "Blast update left a checked install journal pending",
  );
}

async function uninstallBlastFromBrowser(page: Page): Promise<void> {
  await openKernelSettings(page);
  const uninstall = page.locator('[data-tid="settings-uninstall-blast"]');
  await uninstall.waitFor({ state: "visible", timeout: 30_000 });
  await uninstall.click({ timeout: 30_000 });
  const dialog = page.locator('[data-tid="uninstall-dialog"]');
  await dialog.waitFor({ state: "visible", timeout: QUALIFICATION_TIMEOUT_MS });
  const memoryIds = (await dialog
    .locator(".uninstall-memory-list code")
    .allTextContents())
    .map((value) => value.trim());
  assert(
    memoryIds.length === 1 && memoryIds[0] === BLAST_APP_ID,
    "Blast uninstall review did not identify its live managed-memory root",
  );
  const reviewText = (await dialog.textContent()) ?? "";
  assert(
    reviewText.includes("Blast") && reviewText.includes("blast"),
    "Blast uninstall review did not identify the exact installed app",
  );
  await page.locator('[data-tid="uninstall-confirm"]').click();
  await waitForAppOperation(page, "uninstall", "Blast checked uninstall");
  await page.locator('[data-tid="settings-app-blast"]').waitFor({
    state: "detached",
    timeout: 30_000,
  });
}

async function installBlastFromBrowser(
  page: Page,
  archive: string,
): Promise<void> {
  const settings = page.locator('[data-tid="kernel-settings"]');
  if (await settings.isVisible()) {
    await page.locator('[data-tid="settings-back"]').click();
    await settings.waitFor({ state: "detached" });
  }
  await submitBlastArchiveFromBrowser(page, {
    archive,
    dialogTitle: "Install application",
    actionLabel: "Install",
    operationKind: "install",
    failureLabel: "Blast same-id reinstall",
  });
}

async function submitBlastArchiveFromBrowser(
  page: Page,
  expected: Readonly<{
    archive: string;
    dialogTitle: "Install application" | "Update application";
    actionLabel: "Install" | "Update";
    operationKind: "install" | "update";
    failureLabel: string;
  }>,
): Promise<void> {
  const launcher = page.locator('[data-tid="launcher"]');
  if (!(await launcher.isVisible())) {
    await page.locator('[data-tid="launcher-open"]').click();
    await launcher.waitFor({ state: "visible" });
  }
  const fileChooserPromise = page.waitForEvent("filechooser");
  await page.locator('[data-tid="launcher-install-package"]').click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles(expected.archive);

  const dialog = page.locator('[data-tid="install-dialog"]');
  await dialog.waitFor({ state: "visible", timeout: 30_000 });
  assert(
    (await dialog.locator("h2").textContent())?.trim() ===
      expected.dialogTitle,
    `${expected.failureLabel} exposed the wrong review`,
  );
  await page.locator('[data-tid="install-compiled"]').waitFor({
    state: "visible",
    timeout: QUALIFICATION_TIMEOUT_MS,
  });
  const accept = page.locator('[data-tid="install-accept"]');
  assert(
    (await accept.textContent())?.trim() === expected.actionLabel,
    `${expected.failureLabel} exposed the wrong action`,
  );
  await accept.click();
  await waitForAppOperation(
    page,
    expected.operationKind,
    expected.failureLabel,
  );
}

async function openKernelSettings(page: Page): Promise<void> {
  const settings = page.locator('[data-tid="kernel-settings"]');
  if (await settings.isVisible()) return;
  await page.locator('[data-tid="kernel-tray-toggle"]').click();
  await page.locator('[data-tid="kernel-tray-popover"]').waitFor({
    state: "visible",
  });
  await page.locator('[data-tid="kernel-tray-settings"]').click();
  await settings.waitFor({ state: "visible", timeout: 30_000 });
}

async function waitForAppOperation(
  page: Page,
  expectedKind: "install" | "update" | "uninstall",
  failureLabel: string,
): Promise<void> {
  const progress = page.locator('[data-tid="install-progress"]');
  const installError = page.locator('[data-tid="install-error"]');
  const firstVisible = await Promise.race([
    progress
      .waitFor({ state: "visible", timeout: 30_000 })
      .then(() => "progress" as const),
    installError
      .waitFor({ state: "visible", timeout: 30_000 })
      .then(() => "error" as const),
  ]);
  if (firstVisible === "error") {
    throw new Error(
      `${failureLabel} failed: ${(await installError.textContent()) ?? "unknown error"}`,
    );
  }
  assert(
    (await progress.getAttribute("data-operation-kind")) === expectedKind,
    `${failureLabel} started the wrong app operation`,
  );
  await progress.waitFor({
    state: "hidden",
    timeout: QUALIFICATION_TIMEOUT_MS,
  });
  if (await installError.isVisible()) {
    throw new Error(
      `${failureLabel} failed: ${(await installError.textContent()) ?? "unknown error"}`,
    );
  }
}

async function assertRevokedBlastResidentUrl(
  page: Page,
  previousResidentUrl: string,
): Promise<void> {
  const marker = "blast-revoked-origin-qualification";
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url() === previousResidentUrl &&
      response.request().resourceType() === "document",
    { timeout: 30_000 },
  );
  await page.evaluate(
    ({ marker, url }) => {
      document.querySelector(`[data-qualification="${marker}"]`)?.remove();
      const frame = document.createElement("iframe");
      frame.dataset.qualification = marker;
      frame.hidden = true;
      frame.src = url;
      document.body.append(frame);
    },
    { marker, url: previousResidentUrl },
  );
  try {
    const response = await responsePromise;
    const body = await response.text();
    const certifiedDenial =
      response.status() === 404 ||
      (response.status() === 503 &&
        body.includes("Response Verification Error - 503"));
    assert(
      certifiedDenial &&
        !body.includes("service.js") &&
        !body.includes("neutron:msgbus:connect"),
      `Blast's previous nonce-bound resident URL was not denied ` +
        `(status ${response.status()}, body ${JSON.stringify(body.slice(0, 512))})`,
    );
  } finally {
    await page.evaluate((value) => {
      document
        .querySelector(`[data-qualification="${value}"]`)
        ?.remove();
    }, marker);
  }
}

function requireBlastInstance(runtime: KernelRuntimeInfo): AppInstance {
  const blast = runtime.apps.find(
    ({ scope }) => scope.app_id === BLAST_APP_ID,
  );
  assert(blast !== undefined, "Installed runtime omitted Blast");
  return blast;
}

function blastAuthority(instance: AppInstance): BlastAuthority {
  return Object.freeze({
    installationUid: instance.scope.installation_uid.toString(),
    browserOriginNonce: instance.browser_origin_nonce,
    browserOriginAuthorityEpoch:
      instance.browser_origin_authority_epoch.toString(),
  });
}

function memoryInventory(
  runtime: KernelRuntimeInfo,
): Array<[string, string, number, string]> {
  return runtime.memories
    .map(({ owner, id, version, schema }) => [
      owner,
      id,
      Number(version),
      schema,
    ] as [string, string, number, string])
    .sort(([leftOwner, leftId], [rightOwner, rightId]) =>
      leftOwner.localeCompare(rightOwner) || leftId.localeCompare(rightId)
    );
}

async function reloginAndRestoreDriver(
  driver: Driver,
  runtime: InstalledRuntime,
  authority: BlastAuthority = runtime.blastAuthority,
) {
  const page = driver.page;
  await loginQualificationPage(page, runtime);
  const blast = await waitForFrame(page, BLAST_APP_ID, "background");
  await assertBlastResidentAuthority(page, blast, runtime, authority);
  driver.blast = blast;
  const agent = await waitForFrame(page, "agent", "background");
  driver.agent = agent;
  driver.blastToolNames = await authorizeAgentBlastSession(page, agent);
  const existingTile = page.locator(
    `iframe[data-app-id="${BLAST_QUALIFICATION_AGENT_ID}"][data-tile-id="driver"]`,
  );
  if ((await existingTile.count()) === 0) {
    await page.locator('[data-tid="launcher-open"]').click();
    await page.locator('[data-tid="launcher"]').waitFor({ state: "visible" });
    await page
      .locator(
        `[data-tid="launcher-tile-${BLAST_QUALIFICATION_AGENT_ID}-driver"]`,
      )
      .click();
  }
  const tile = await waitForFrame(page, BLAST_QUALIFICATION_AGENT_ID, "tile");
  driver.tile = tile;
  await enableQualificationAgentMode(page, tile);
}

async function cleanupFirstProfile(
  driver: BlastToolCaller,
  collectionIds: string[],
  scriptId: string,
  scriptRevision: string,
): Promise<void> {
  const deleted = await successfulToolCall(driver, "collection.delete", {
    ids: collectionIds,
  });
  assert(deleted.incompleteCleanup === false, "Collection deletion remained incomplete");
  const remaining = await successfulToolCall(driver, "collection.list", {
    limit: 20,
  });
  const remainingCollections = remaining.collections;
  assertArray(remainingCollections, "remaining collections");
  assert(
    collectionIds.every((collectionId) =>
      !remainingCollections.some(
        (collection) => isObject(collection) && collection.id === collectionId,
      )
    ),
    "An exactly deleted collection remained listed",
  );
  await successfulToolCall(driver, "script.delete", {
    id: scriptId,
    expectedRevision: scriptRevision,
  });
  assert(
    (await driver.callBlast("script.get", { id: scriptId })) === null,
    "Deleted saved script remained readable",
  );
}

async function successfulToolCall(
  driver: BlastToolCaller,
  tool: string,
  arguments_: JsonObject,
): Promise<JsonObject> {
  return requiredObject(
    await driver.callBlast(tool, arguments_),
    `${tool} result`,
  );
}

async function toolCall(
  driver: Driver,
  tool: string,
  arguments_: JsonObject,
  consentDecision: "allow" | "deny",
): Promise<Readonly<{
  result: unknown;
  error: unknown;
  challenges: unknown;
}>> {
  const turn = await driver.turn({
    action: "call",
    tool,
    arguments: arguments_,
    consentDecision,
  });
  return {
    result: turn.result,
    error: turn.error,
    challenges: turn.challenges,
  };
}

async function readCounter(
  driver: BlastToolCaller,
  canister: string,
): Promise<string> {
  const call = await successfulToolCall(driver, "blast.query", {
    canister,
    method: "read_counter",
    args: [],
    identityMode: "local",
  });
  return requiredNatText(call.result, "target counter");
}

function qualificationScriptSource(): string {
  return `const update = await blast.update({
  canister: input.canister,
  method: "increment",
  args: [],
  identityMode: "local",
});
const collection = await collections.create({
  name: "Nested proposal pages",
  description: "Temporary installed qualification data",
  kind: "raw",
});
let cursor = null;
let pages = 0;
let items = 0;
do {
  const response = await blast.query({
    canister: input.canister,
    method: "nested_page",
    args: [cursor],
    identityMode: "local",
  });
  const page = response.result;
  await collections.putPage(collection.id, "page-" + pages, page);
  pages += 1;
  items += page.items.length;
  cursor = page.next ?? null;
  await run.checkpoint({ cursor, pages, items, counter: update.result });
} while (cursor !== null);
await collections.complete(collection.id, { pages, items });
return { collectionId: collection.id, pages, items };
`;
}

function predecessorStateScriptSource(): string {
  return `const collection = await collections.create({
  name: "Nested proposal pages",
  description: "Temporary predecessor data for checked upgrade qualification",
  kind: "raw",
});
let items = 0;
for (let index = 0; index < input.pages.length; index += 1) {
  const page = input.pages[index];
  await collections.putPage(collection.id, "page-" + index, page);
  items += page.items.length;
  const cursor = page.next ?? null;
  await run.checkpoint({ cursor, pages: index + 1, items });
}
await collections.complete(collection.id, { pages: input.pages.length, items });
return { collectionId: collection.id, pages: input.pages.length, items };
`;
}

function predecessorStateScriptArgs(): JsonObject {
  return {
    pages: [
      {
        items: [
          {
            id: 1,
            title: "Alpha",
            votes: 2,
            metadata: { topic: "governance", tags: ["nested", "page"] },
          },
          {
            id: 2,
            title: "Beta",
            votes: 3,
            metadata: { topic: "governance", tags: ["nested"] },
          },
        ],
        next: "2",
      },
      {
        items: [
          {
            id: 3,
            title: "Gamma",
            votes: 4,
            metadata: { topic: "governance", tags: ["page-two"] },
          },
          {
            id: 4,
            title: "Delta",
            votes: 5,
            metadata: {
              topic: "governance",
              tags: ["page-two", "nested"],
            },
          },
        ],
      },
    ],
  };
}

function derivedCollectionScriptSource(): string {
  return `const collection = await collections.create({
  name: "Derived proposal index",
  description: "Compact proposal fields from the raw qualification crawl",
  kind: "derived",
  sourceCollectionIds: [input.rawCollectionId],
});
let items = 0;
for await (const page of collections.pages(input.rawCollectionId)) {
  for (const proposal of page.items) {
    await collections.append(collection.id, {
      id: proposal.id,
      title: proposal.title,
      votes: proposal.votes,
      topic: proposal.metadata.topic,
    }, "proposal-" + proposal.id);
    items += 1;
  }
}
await collections.complete(collection.id, { items });
return { collectionId: collection.id, items };
`;
}

async function assertBlastResidentAuthority(
  page: Page,
  frame: Frame,
  runtime: InstalledRuntime,
  authority: BlastAuthority = runtime.blastAuthority,
): Promise<void> {
  const url = new URL(frame.url());
  const expectedPrefix = persistentAppFramePrefix({
    browserOriginNonce: authority.browserOriginNonce,
  });
  assert(
    url.hostname === `${expectedPrefix}--${runtime.neutronCanisterId}.localhost`,
    "Blast resident hostname does not bind its current nonce",
  );
  assert(url.port === "8000", "Blast resident used the wrong local gateway port");
  assert(url.pathname === "/app/blast/service.html", "Blast resident used the wrong path");
  assert(
    url.searchParams.get("installation-uid") === authority.installationUid &&
      url.searchParams.get("resident-frame-security") ===
        "persistent_dedicated_v1" &&
      url.searchParams.get("browser-origin-nonce") ===
        authority.browserOriginNonce &&
      url.searchParams.get("browser-origin-authority-epoch") ===
        authority.browserOriginAuthorityEpoch,
    "Blast resident URL does not carry its complete current authority binding",
  );
  const locator = page.locator(
    '[data-tid="app-background-frame"][data-app-id="blast"]',
  );
  await locator.waitFor({ state: "attached" });
  assert((await locator.count()) === 1, "Kernel mounted multiple Blast residents");
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-tid="app-background-frame"][data-app-id="blast"]')
        ?.getAttribute("data-resident-launch") === "ready",
  );
  assert(
    (await locator.getAttribute("data-resident-launch-error")) === null,
    "Blast resident reported a launch error",
  );
  assert(
    (await locator.getAttribute("sandbox")) === "allow-scripts allow-same-origin",
    "Blast resident did not use the originful persistent sandbox",
  );
  assert(
    (await locator.getAttribute("credentialless")) === null,
    "Blast persistent resident unexpectedly used credentialless mode",
  );
  assert(
    (await locator.evaluate((element) =>
      "credentialless" in element
        ? Boolean(
            (
              element as HTMLIFrameElement & {
                credentialless?: boolean;
              }
            ).credentialless,
          )
        : false
    )) === false,
    "Blast persistent resident enabled the credentialless iframe property",
  );
  assert(
    url.searchParams.get("app") === "blast" &&
      url.searchParams.get("role") === "background",
    "Blast resident URL does not identify the exact background surface",
  );
  assert(
    (await frame.evaluate(() => location.origin)) === url.origin,
    "Blast resident Window does not observe its nonce-bound origin",
  );
  assert(
    url.origin !==
      localCanisterOrigin(runtime.neutronCanisterId, "http://localhost:8000"),
    "Blast resident shared the Kernel origin",
  );
}

async function inspectBlastBrowserStorage(frame: Frame): Promise<Readonly<{
  principal: string;
  privateKeyExtractable: boolean;
  privateKeyType: string;
  privateKeyAlgorithm: string;
  privateKeyCurve: string;
  privateKeyUsages: string[];
}>> {
  return await frame.evaluate(async () => {
    const databases = await indexedDB.databases();
    const names = databases.map(({ name }) => name).filter(Boolean);
    for (const required of [
      "neutron-blast-keyring-v1",
      "neutron-blast-collections-v1",
    ]) {
      if (!names.includes(required)) {
        throw new Error(`Blast IndexedDB ${required} is unavailable`);
      }
    }
    const open = (name: string) =>
      new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });
    const keyring = await open("neutron-blast-keyring-v1");
    try {
      const record = await new Promise<Record<string, unknown> | undefined>(
        (resolve, reject) => {
          const transaction = keyring.transaction("keys", "readonly");
          const request = transaction.objectStore("keys").get(0);
          request.onerror = () => reject(request.error);
          request.onsuccess = () => resolve(request.result);
        },
      );
      if (!record || typeof record.principal !== "string") {
        throw new Error("Blast keyring slot zero is unavailable");
      }
      const pair = record.keyPair as CryptoKeyPair | undefined;
      const key = pair?.privateKey;
      if (!key) throw new Error("Blast keyring private key is unavailable");
      const algorithm = key.algorithm as EcKeyAlgorithm;
      return {
        principal: record.principal,
        privateKeyExtractable: key.extractable,
        privateKeyType: key.type,
        privateKeyAlgorithm: algorithm.name,
        privateKeyCurve: algorithm.namedCurve,
        privateKeyUsages: [...key.usages],
      };
    } finally {
      keyring.close();
    }
  });
}

async function waitForFrame(
  page: Page,
  appId: string,
  role: "background" | "tile",
): Promise<Frame> {
  const selector =
    role === "background"
      ? `[data-tid="app-background-frame"][data-app-id="${appId}"]`
      : `iframe[data-app-id="${appId}"][data-tile-id="driver"]`;
  await page
    .locator(selector)
    .last()
    .waitFor({ state: "attached", timeout: 30_000 });
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const element = page.locator(selector).last();
    const handle = await element.elementHandle();
    const frame = await handle?.contentFrame();
    if (frame && frame.url().includes(`/app/${appId}/`)) return frame;
    await page.waitForTimeout(100);
  }
  throw new Error(`Installed ${appId} ${role} frame did not load`);
}

function assertMethod(methods: unknown[], name: string, kind: string): void {
  assert(
    methods.some(
      (method) =>
        isObject(method) && method.name === name && method.kind === kind,
    ),
    `ICBlast scan omitted ${name}:${kind}`,
  );
}

function assertOneSignedCallChallenge(value: unknown, decision: string): void {
  assertArray(value, `${decision} consent challenges`);
  const signed = value.filter(
    (challenge) => isObject(challenge) && challenge.kind === "signed_canister_call",
  );
  assert(
    signed.length === 1 &&
      isObject(signed[0]) &&
      signed[0].requesterAppId === "blast" &&
      signed[0].decision === decision,
    `${decision} did not receive one exact Blast signed-call challenge: ${JSON.stringify(value)}`,
  );
}

function assertWorkerRequests(requests: Set<string>): void {
  assert(
    [...requests].some((url) => /\/script_worker\.js(?:\?|$)/u.test(url)),
    "Installed script execution did not load Blast's QuickJS Worker",
  );
  assert(
    [...requests].some((url) => /\/query_worker\.js(?:\?|$)/u.test(url)),
    "Installed collection query did not load Blast's JSONata Worker",
  );
}

function packageVersions(deployment: PreparedDeployment): BlastPackageVersions {
  const versions = new Map(
    deployment.packages.map(({ manifest }) => [manifest.id, manifest.version]),
  );
  const kernel = versions.get("kernel");
  const agent = versions.get("agent");
  const blast = versions.get("blast");
  assert(
    kernel !== undefined && agent !== undefined && blast !== undefined,
    "Deployment omitted Kernel, Agent, or Blast",
  );
  return { kernel, agent, blast };
}

async function currentArchive(
  appId: "kernel" | "agent" | "blast",
): Promise<string> {
  const version = await sourceManifestVersion(appId);
  const archive = path.join(
    REPOSITORY_ROOT,
    "apps",
    appId,
    packageArchiveFilename(appId, version),
  );
  await access(archive, constants.R_OK);
  return archive;
}

async function assertStrictCanisterCallKernelArchive(
  archivePath: string,
): Promise<void> {
  const unpacked = unpackNeutronPackage(
    new Uint8Array(await readFile(archivePath)),
  );
  const decoder = new TextDecoder();
  const browserJavaScript = Object.entries(unpacked)
    .filter(([packagePath]) =>
      packagePath.startsWith("web/") && packagePath.endsWith(".js")
    )
    .map(([, bytes]) => decoder.decode(bytes))
    .join("\n");
  assert(
    browserJavaScript.includes("canister.schema_v2") &&
      browserJavaScript.includes("canister.call_dialog_v2"),
    "Blast installed qualification requires a freshly packaged Kernel with strict v2 canister calls; the selected archive is stale",
  );
}

async function sourceManifestVersion(
  appId: "kernel" | "agent" | "blast",
): Promise<number> {
  const manifest = JSON.parse(
    await readFile(
      path.join(REPOSITORY_ROOT, "apps", appId, "neutron.json"),
      "utf8",
    ),
  ) as { id?: unknown; version?: unknown };
  assert(
    manifest.id === appId && Number.isSafeInteger(manifest.version),
    `Current ${appId} manifest is invalid`,
  );
  return manifest.version as number;
}

async function launchQualificationChromium(): Promise<Browser> {
  const executablePath = await discoverNixChromium();
  return await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: [
      "--disable-background-networking",
      "--host-resolver-rules=MAP localhost 127.0.0.2,MAP *.localhost 127.0.0.2",
    ],
  });
}

async function discoverNixChromium(): Promise<string | undefined> {
  if (process.platform !== "linux") return undefined;
  let entries: string[];
  try {
    entries = await readdir("/nix/store");
  } catch {
    return undefined;
  }
  for (const entry of entries.filter((name) => name.includes("-chromium-")).sort()) {
    const candidate = path.join("/nix/store", entry, "bin", "chromium");
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next immutable Chromium derivation.
    }
  }
  return undefined;
}

function requiredObject(value: unknown, label: string): JsonObject {
  if (!isObject(value)) throw new Error(`${label} is not an object`);
  return value;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertArray(value: unknown, label: string): asserts value is unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} is not an array`);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is not a non-empty string`);
  }
  return value;
}

function requiredNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} is not a non-negative safe integer`);
  }
  return value;
}

function requiredNatText(value: unknown, label: string): string {
  const text = requiredString(value, label);
  if (!/^(?:0|[1-9][0-9]*)$/u.test(text)) {
    throw new Error(`${label} is not a canonical Nat string`);
  }
  return text;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

declare global {
  interface Window {
    __NEUTRON_PLAYWRIGHT_LOGIN_AS__?: (seed: number) => Promise<string>;
    __BLAST_QUALIFICATION_PORT__?: Readonly<{
      ready(): Promise<void>;
      exec(action: string, payload: unknown): Promise<unknown>;
    }>;
    __BLAST_QUALIFICATION_AGENT__?: Readonly<{
      prepare(value: unknown): void;
      cancel(): boolean;
      inspect(): Readonly<{
        pending: boolean;
        result: unknown;
        error: string | null;
      }>;
    }>;
  }
}

async function main(args: readonly string[]): Promise<void> {
  if (args.length !== 1 || args[0] !== "--release") {
    throw new Error(
      "Usage: bun test/qualification/blast/run.ts --release",
    );
  }
  console.log(JSON.stringify(await runInstalledBlastQualification(), null, 2));
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    () => process.exit(0),
    (error) => {
      console.error(
        error instanceof Error ? error.stack ?? error.message : String(error),
      );
      process.exit(1);
    },
  );
}
