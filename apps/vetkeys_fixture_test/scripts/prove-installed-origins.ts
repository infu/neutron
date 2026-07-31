import {
  chromium,
  type Browser,
  type ConsoleMessage,
  type Frame,
  type Page,
  type Request,
} from "playwright";
import { createHash } from "node:crypto";
import { localCanisterOrigin } from "neutron-tools/src/runtime.js";
import {
  FIXTURE_APP_IDS,
  type FixtureAppId,
  type SafePublicEvidence,
} from "../src/evidence";
import type {
  FixtureProbeChallenge,
  RejectionEvidence,
} from "../src/adversarial_probe";
import { INJECTED_PEER_OPERATIONS } from "../src/adversarial_probe";
import {
  assertLoopbackHost,
  compareInstalledBindings,
  readInstalledVetKeysProjections,
  type InstalledVerifierInput,
} from "./compare-installed-bindings";
import type {
  RedactionFailureEvidence,
  RedactionSuccessEvidence,
} from "../src/redaction_probe";
import {
  assertNoForbiddenMaterial,
  inspectInstalledBackendRedaction,
  summarizeForbiddenMaterials,
  type ForbiddenMaterial,
} from "./redaction-sentinel";
import { fixtureLocalRuntime, fixturePocketIcClockMs } from "./pocketic-clock";

type BrowserProof = {
  appIdInjection: RejectionEvidence[];
  foreignChallenge: RejectionEvidence;
  ownDerivation: SafePublicEvidence;
};

type InstalledOriginReport = {
  binding: Awaited<ReturnType<typeof compareInstalledBindings>>;
  browserOrigin: Record<FixtureAppId, BrowserProof>;
  isolated: true;
  redaction?: InstalledRedactionReport;
};

type RunnerInput = InstalledVerifierInput & {
  chromiumExecutable?: string;
  chromiumArgs: string[];
  confirmDisposable?: string;
  redaction: boolean;
};

type InstalledRedactionReport = {
  allowlistedPublicMaterial: {
    derivationInputSha256: string;
    publicFingerprint: string;
    publicKeySha256: string;
    stableNamespaceNonce: "intentionally-persisted-not-projected";
  };
  backend: Awaited<ReturnType<typeof inspectInstalledBackendRedaction>>;
  browserPersistence: BrowserPersistenceEvidence;
  canonicalFailure: "management_failure";
  forbiddenMaterials: ReturnType<typeof summarizeForbiddenMaterials>;
  liveWasmBoundary: {
    backendTransitMayRemainUntilGc: readonly [
      "transport-public-key",
      "encrypted-key-response",
      "invalid-transport-public-key",
      "raw-management-reject",
    ];
    observed: string[];
  };
  rawRejectBoundary: {
    installedResult: "canonical-management-failure";
    exactAdapterRejectObservable: false;
    scannedPinnedPocketIcDiagnostic: string;
  };
  scannedProjections: readonly ["settings-ui", "vetkeys-admin", "vetkeys-audit"];
  sentinelAbsent: true;
};

type BrowserPersistenceEvidence = {
  cacheEntries: number;
  documents: number;
  inaccessibleOpaqueSurfaces: number;
  indexedDatabases: number;
  indexedRecords: number;
  localStorageEntries: number;
  sessionStorageEntries: number;
  storageStateBytes: number;
};

type BrowserSurfaceCapture = {
  active: boolean;
  failures: string[];
  output: string[];
  stop(): void;
};

export async function proveInstalledOrigins(
  input: RunnerInput,
): Promise<InstalledOriginReport> {
  const host = assertLoopbackHost(input.host);
  if (
    !Number.isInteger(input.identitySeed) ||
    input.identitySeed < 0 ||
    input.identitySeed > 255
  ) {
    throw new Error(
      "Browser-origin proof identity seed must be an integer from 0 to 255",
    );
  }
  const browserUrl = localCanisterOrigin(input.canisterId, host);
  assertLoopbackBrowserUrl(browserUrl, input.canisterId);
  if (input.redaction && input.confirmDisposable !== input.canisterId) {
    throw new Error(
      "Redaction snapshot proof requires --confirm-disposable with the exact canister id",
    );
  }

  let browser: Browser | null = null;
  const surface: BrowserSurfaceCapture = {
    active: true,
    failures: [],
    output: [],
    stop: () => undefined,
  };
  try {
    browser = await chromium.launch({
      headless: true,
      ...(input.chromiumExecutable
        ? { executablePath: input.chromiumExecutable }
        : {}),
      ...(input.chromiumArgs.length > 0 ? { args: input.chromiumArgs } : {}),
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const replicaClockMs = await fixturePocketIcClockMs(host);
    if (replicaClockMs !== null && Math.abs(replicaClockMs - Date.now()) > 60_000) {
      const clockOffsetMs = replicaClockMs - Date.now();
      await page.addInitScript((offsetMs) => {
        const NativeDate = Date;
        const OffsetDate = function (
          this: unknown,
          ...args: unknown[]
        ): Date | string {
          if (!new.target) {
            return new NativeDate(NativeDate.now() + offsetMs).toString();
          }
          return Reflect.construct(
            NativeDate,
            args.length === 0 ? [NativeDate.now() + offsetMs] : args,
            new.target,
          ) as Date;
        } as unknown as DateConstructor;
        Object.setPrototypeOf(OffsetDate, NativeDate);
        Object.defineProperty(OffsetDate, "prototype", {
          value: NativeDate.prototype,
        });
        Object.defineProperty(OffsetDate, "now", {
          configurable: false,
          value: () => NativeDate.now() + offsetMs,
          writable: false,
        });
        Object.defineProperty(globalThis, "Date", {
          configurable: false,
          value: OffsetDate,
          writable: false,
        });
      }, clockOffsetMs);
    }
    await pinReplicaTrafficToHost(page, host);
    monitorSurface(page, surface);
    await page.goto(browserUrl, { waitUntil: "domcontentloaded" });
    await login(page, input.identitySeed);

    const frames = new Map<FixtureAppId, Frame>();
    for (const appId of FIXTURE_APP_IDS) {
      const frame = await openFixture(page, appId, host);
      await reserveFixtureIfMissing(page, frame, appId);
      frames.set(appId, frame);
    }

    // This strict administrative read happens only after both real frames have
    // performed any first-install lifecycle reservation through trusted UI.
    const binding = await compareInstalledBindings({ ...input, host });
    const injection = await callInject(
      frames.get("vetkeys_fixture")!,
      "vetkeys_fixture_peer",
    );
    assertRejections(injection, "invalid_request", INJECTED_PEER_OPERATIONS);
    await assertNoLifecycleDialog(page, "vetkeys_fixture peer-id injection");
    assertJsonEqual(
      await compareInstalledBindings({ ...input, host }),
      binding,
      "vetkeys_fixture peer-id injection altered an installed binding",
    );
    const peerInjection = await callInject(
      frames.get("vetkeys_fixture_peer")!,
      "vetkeys_fixture",
    );
    assertRejections(peerInjection, "invalid_request", INJECTED_PEER_OPERATIONS);
    await assertNoLifecycleDialog(
      page,
      "vetkeys_fixture_peer peer-id injection",
    );
    const afterInjection = await compareInstalledBindings({ ...input, host });
    assertJsonEqual(
      afterInjection,
      binding,
      "Injected payload altered an installed binding",
    );

    const primaryProof = await proveChallengePair(
      frames.get("vetkeys_fixture")!,
      frames.get("vetkeys_fixture_peer")!,
      "vetkeys_fixture",
      injection,
    );
    const peerProof = await proveChallengePair(
      frames.get("vetkeys_fixture_peer")!,
      frames.get("vetkeys_fixture")!,
      "vetkeys_fixture_peer",
      peerInjection,
    );

    const redaction = input.redaction
      ? await proveInstalledRedaction(
        page,
        frames.get("vetkeys_fixture")!,
        "vetkeys_fixture",
        { ...input, host },
        surface,
      )
      : undefined;

    const afterDerivations = await compareInstalledBindings({ ...input, host });
    assertJsonEqual(
      afterDerivations,
      binding,
      "Source-bound derivation changed public namespace evidence",
    );
    if (surface.failures.length > 0) {
      throw new Error(`Installed browser surface failures: ${surface.failures.join(" | ")}`);
    }
    return {
      binding,
      browserOrigin: {
        vetkeys_fixture: primaryProof,
        vetkeys_fixture_peer: peerProof,
      },
      isolated: true,
      ...(redaction ? { redaction } : {}),
    };
  } finally {
    await browser?.close();
  }
}

/**
 * The provision session is the complete authority for this proof's replica.
 * Keep each hostname intact because sandbox subdomains are part of source
 * binding, but pin all HTTP traffic to that session gateway before navigation.
 */
async function pinReplicaTrafficToHost(page: Page, host: string): Promise<void> {
  await page.route("http://**/*", async (route) => {
    const target = replicaRequestUrl(route.request().url(), host);
    await route.continue({ url: target });
  });
}

export function replicaRequestUrl(requestUrl: string, host: string): string {
  const request = new URL(requestUrl);
  const target = new URL(host);
  if (
    request.protocol !== "http:" ||
    !isLoopbackBrowserHost(request.hostname) ||
    target.protocol !== "http:" ||
    !isLoopbackBrowserHost(target.hostname)
  ) {
    throw new Error("Installed proof traffic must stay on HTTP loopback origins");
  }
  request.port = target.port;
  return request.toString();
}

function isLoopbackBrowserHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]";
}

async function openFixture(
  page: Page,
  appId: FixtureAppId,
  host: string,
): Promise<Frame> {
  const selector = `iframe[data-app-id="${appId}"][data-tile-id="main"]`;
  if (await page.locator(selector).count() === 0) {
    const launcher = page.locator('[data-tid="launcher"]');
    if (!await launcher.isVisible().catch(() => false)) {
      const open = page.locator('[data-tid="launcher-open"]');
      await open.waitFor({ state: "visible", timeout: 20_000 }).catch(() => {
        throw new Error("Installed Neutron launcher is unavailable");
      });
      if (await open.count() !== 1) {
        throw new Error("Installed Neutron launcher is unavailable");
      }
      await open.click();
    }
    const tile = page.locator(`[data-tid="launcher-tile-${appId}-main"]`);
    await tile.waitFor({ state: "visible", timeout: 20_000 }).catch(() => {
      throw new Error(`${appId} is not installed in the launcher`);
    });
    if (await tile.count() !== 1) {
      throw new Error(`${appId} is not installed in the launcher`);
    }
    await tile.click();
  }
  const iframe = page.locator(selector);
  await iframe.waitFor({ state: "visible", timeout: 20_000 }).catch(() => {
    throw new Error(`${appId} installed proof tile did not open`);
  });
  if (await iframe.count() !== 1) {
    throw new Error(`${appId} must have exactly one installed proof tile`);
  }
  const handle = await iframe.elementHandle();
  const frame = await handle?.contentFrame();
  if (!frame) throw new Error(`${appId} proof frame did not load`);
  const currentSrc = await iframe.getAttribute("src");
  if (!currentSrc) throw new Error(`${appId} proof frame omitted its source URL`);
  const selectedSrc = fixtureFrameUrl(currentSrc, host);
  await iframe.evaluate((element, src) => {
    const frame = element as HTMLIFrameElement;
    if (frame.src !== src) frame.src = src;
  }, selectedSrc);
  const selectedPort = new URL(host).port;
  await frame.waitForURL(
    (url) => url.port === selectedPort &&
      url.pathname === `/app/${appId}/index.html`,
    { waitUntil: "domcontentloaded", timeout: 20_000 },
  );
  await frame.waitForFunction(() =>
    typeof window.__NEUTRON_VETKEYS_FIXTURE_PROBE_V1__ === "object",
  );
  const identity = await frame.evaluate(() =>
    window.__NEUTRON_VETKEYS_FIXTURE_PROBE_V1__!.identity(),
  );
  if (identity.appId !== appId || identity.slot !== "mailbox") {
    throw new Error(`${appId} frame reported a foreign installed identity`);
  }
  return frame;
}

export function fixtureFrameUrl(frameUrl: string, host: string): string {
  const selected = new URL(frameUrl);
  const target = new URL(host);
  const appLabel = selected.hostname.split(".")[0];
  if (!appLabel) throw new Error("Installed proof frame omitted its app label");

  selected.protocol = target.protocol;
  selected.port = target.port;
  selected.hostname = target.hostname === "localhost" ||
      target.hostname.endsWith(".localhost")
    ? `${appLabel}.${target.hostname}`
    : target.hostname;
  return selected.toString();
}

async function reserveFixtureIfMissing(
  page: Page,
  frame: Frame,
  appId: FixtureAppId,
): Promise<void> {
  await frame.waitForFunction(() =>
    document.querySelector('[data-tid="vetkeys-fixture-evidence"]') !== null ||
    document.querySelector<HTMLButtonElement>(
      '[data-tid="vetkeys-fixture-reserve"]',
    )?.disabled === false,
  );
  const reserve = frame.locator('[data-tid="vetkeys-fixture-reserve"]');
  if (await reserve.count() === 1) {
    await reserve.click();
    const dialog = page.locator('[data-tid="vetkeys-lifecycle-dialog"]');
    await dialog.waitFor({ state: "visible", timeout: 10_000 });
    if (await dialog.count() !== 1) {
      throw new Error(`${appId} reservation opened an ambiguous lifecycle dialog`);
    }
    const expectedName = appId === "vetkeys_fixture"
      ? "vetKeys Fixture"
      : "vetKeys Fixture Peer";
    const text = await dialog.innerText();
    for (const expected of [
      "Activate private-key slot",
      `${expectedName} (${appId})`,
      "mailbox",
      "App-provided purpose — unverified",
      "Verify that an equal slot name in another app receives a different key root",
    ]) {
      if (!text.includes(expected)) {
        throw new Error(`${appId} lifecycle dialog omitted ${expected}`);
      }
    }
    const approve = dialog.locator('[data-tid="vetkeys-lifecycle-approve"]');
    if (await approve.count() !== 1 || await approve.innerText() !== "Approve") {
      throw new Error(`${appId} lifecycle approval control is not exact`);
    }
    await approve.click();
    await dialog.waitFor({ state: "detached", timeout: 30_000 });
  } else if (await reserve.count() !== 0) {
    throw new Error(`${appId} exposed duplicate reservation controls`);
  }

  const evidence = frame.locator('[data-tid="vetkeys-fixture-evidence"]');
  await evidence.waitFor({ state: "visible", timeout: 30_000 });
  const evidenceText = await evidence.innerText();
  if (
    !evidenceText.includes(appId) ||
    !evidenceText.includes("test_key_1") ||
    await reserve.count() !== 0
  ) {
    throw new Error(`${appId} did not enter its exact local reserved state`);
  }
}

async function callInject(
  frame: Frame,
  peerAppId: FixtureAppId,
): Promise<RejectionEvidence[]> {
  return frame.evaluate((peer) =>
    window.__NEUTRON_VETKEYS_FIXTURE_PROBE_V1__!.injectPeerAppId(peer),
  peerAppId);
}

async function proveChallengePair(
  requester: Frame,
  foreign: Frame,
  requesterAppId: FixtureAppId,
  appIdInjection: RejectionEvidence[],
): Promise<BrowserProof> {
  const challenge = await requester.evaluate(() =>
    window.__NEUTRON_VETKEYS_FIXTURE_PROBE_V1__!.beginOwnDerivation(),
  ) as FixtureProbeChallenge;
  if (challenge.appId !== requesterAppId) {
    throw new Error("Derivation challenge escaped its requester app");
  }
  const foreignChallenge = await foreign.evaluate((challengeId) =>
    window.__NEUTRON_VETKEYS_FIXTURE_PROBE_V1__!
      .rejectForeignChallenge(challengeId),
  challenge.challengeId);
  assertRejections(
    [foreignChallenge],
    "source_gone",
    ["foreignChallenge.confirm"],
  );
  const ownDerivation = await requester.evaluate((challengeId) =>
    window.__NEUTRON_VETKEYS_FIXTURE_PROBE_V1__!
      .confirmOwnDerivation(challengeId),
  challenge.challengeId);
  if (
    ownDerivation.appId !== requesterAppId ||
    ownDerivation.slot !== "mailbox" ||
    ownDerivation.environmentKey !== "test_key_1"
  ) {
    throw new Error(`${requesterAppId} returned invalid own-derivation evidence`);
  }
  return { appIdInjection, foreignChallenge, ownDerivation };
}

const REDACTION_TRANSPORT_SECRET_HEX =
  "15fbb76fd0a215cbedfb6200f9b791ad75db9252e3c89140a19a4ab62f8507c0";
const RAW_POCKETIC_REJECT_DIAGNOSTIC =
  "Failed to deserialize TransportPublicKey";

async function proveInstalledRedaction(
  page: Page,
  frame: Frame,
  appId: FixtureAppId,
  input: InstalledVerifierInput,
  surface: BrowserSurfaceCapture,
): Promise<InstalledRedactionReport> {
  const transportSecret = fromHex(REDACTION_TRANSPORT_SECRET_HEX);
  const successNonce = asciiBytes(
    "VK-SUCCESS-REQUEST-NONCE-2026!!!",
    32,
  );
  const failureNonce = asciiBytes(
    "VK-FAILURE-REQUEST-NONCE-2026!!!",
    32,
  );
  const invalidTransport = asciiBytes(
    "VK-INVALID-TRANSPORT-PUBLIC-REJECT-2026-07-15!!!",
    48,
  );
  const appPlaintext =
    "VETKEYS-APP-PLAINTEXT-9C4A72E1D5B8036F-NO-KERNEL-PERSISTENCE";
  await frame.waitForFunction(() =>
    typeof window.__NEUTRON_VETKEYS_REDACTION_PROBE_V1__ === "object",
  );
  const success = await frame.evaluate(async (proofInput) =>
    window.__NEUTRON_VETKEYS_REDACTION_PROBE_V1__!.runSuccess(proofInput), {
    appPlaintext,
    requestNonce: Array.from(successNonce),
    transportSecret: Array.from(transportSecret),
  }) as RedactionSuccessEvidence;
  assertRedactionSuccess(success, {
    appId,
    appPlaintext,
    requestNonce: successNonce,
    transportSecret,
  });

  const failure = await frame.evaluate(async (proofInput) =>
    window.__NEUTRON_VETKEYS_REDACTION_PROBE_V1__!.runFailure(proofInput), {
    requestNonce: Array.from(failureNonce),
    transportPublicKey: Array.from(invalidTransport),
  }) as RedactionFailureEvidence;
  assertRedactionFailure(failure, appId, failureNonce, invalidTransport);

  const materials: ForbiddenMaterial[] = [
    material("transport-secret", success.transportSecret),
    material("transport-public-key", success.transportPublicKey),
    material("transport-public-key-hash", success.transportPublicKeyHash),
    material("success-request-nonce", success.requestNonce),
    textMaterial("success-challenge-id", success.challengeId),
    material("encrypted-key-response", success.encryptedKey),
    material("derived-private-key", success.derivedPrivateKey),
    textMaterial("app-plaintext", success.appPlaintext),
    material("invalid-transport-public-key", failure.transportPublicKey),
    material("failure-request-nonce", failure.requestNonce),
    textMaterial("failure-challenge-id", failure.challengeId),
    textMaterial("raw-management-reject", RAW_POCKETIC_REJECT_DIAGNOSTIC),
  ];
  assertNoForbiddenMaterial(
    Buffer.from(failure.canonicalMessage, "utf8"),
    "canonical browser failure",
    materials,
  );
  if (surface.failures.length > 0) {
    throw new Error(
      `Installed browser surface failures before snapshot: ${surface.failures.join(" | ")}`,
    );
  }

  const projections = await readInstalledVetKeysProjections(input);
  const adminBytes = projectionBytes(projections.admin);
  const auditBytes = projectionBytes(projections.audit);
  assertNoForbiddenMaterial(adminBytes, "vetKeys admin projection", materials);
  assertNoForbiddenMaterial(auditBytes, "vetKeys audit projection", materials);
  const projectionText = adminBytes.toString("utf8");
  if (
    projectionText.includes("namespace_nonce") ||
    projectionText.includes("derivation_input")
  ) {
    throw new Error("Admin projection exposed private namespace internals");
  }
  const fingerprintHex = hex(success.publicInfo.publicFingerprint);
  if (!projectionText.includes(Buffer.from(success.publicInfo.publicFingerprint).toString("base64"))) {
    throw new Error("Admin projection omitted the intentionally public fingerprint");
  }

  const settingsBytes = await openAndCaptureVetKeysSettings(page, fingerprintHex);
  assertNoForbiddenMaterial(settingsBytes, "trusted Settings UI", materials);
  const browserPersistence = await inspectBrowserPersistence(page, materials);
  assertNoForbiddenMaterial(
    Buffer.from(surface.output.join("\n"), "utf8"),
    "browser console and page errors",
    materials,
  );
  if (surface.failures.length > 0) {
    throw new Error(
      `Installed browser surface failures before snapshot: ${surface.failures.join(" | ")}`,
    );
  }
  // Management snapshots require a brief canister stop. Detach the browser
  // observer after all live browser surfaces have been scanned so that the
  // expected transport interruption is not mistaken for a product page error.
  surface.stop();

  const backend = await inspectInstalledBackendRedaction({
    canisterId: input.canisterId,
    host: input.host,
    materials,
    wasmMemoryTransitLabels: [
      "transport-public-key",
      "encrypted-key-response",
      "invalid-transport-public-key",
      "raw-management-reject",
    ],
  });
  return {
    allowlistedPublicMaterial: {
      derivationInputSha256: sha256(success.publicInfo.derivationInput),
      publicFingerprint: fingerprintHex,
      publicKeySha256: sha256(success.publicInfo.publicKey),
      stableNamespaceNonce: "intentionally-persisted-not-projected",
    },
    backend,
    browserPersistence,
    canonicalFailure: "management_failure",
    forbiddenMaterials: summarizeForbiddenMaterials(materials),
    liveWasmBoundary: {
      backendTransitMayRemainUntilGc: [
        "transport-public-key",
        "encrypted-key-response",
        "invalid-transport-public-key",
        "raw-management-reject",
      ],
      observed: backend.snapshot.wasmMemoryTransientFindings,
    },
    rawRejectBoundary: {
      installedResult: "canonical-management-failure",
      exactAdapterRejectObservable: false,
      scannedPinnedPocketIcDiagnostic: RAW_POCKETIC_REJECT_DIAGNOSTIC,
    },
    scannedProjections: ["settings-ui", "vetkeys-admin", "vetkeys-audit"],
    sentinelAbsent: true,
  };
}

function assertRedactionSuccess(
  value: RedactionSuccessEvidence,
  expected: {
    appId: FixtureAppId;
    appPlaintext: string;
    requestNonce: Uint8Array;
    transportSecret: Uint8Array;
  },
): void {
  if (
    value.appId !== expected.appId ||
    value.appPlaintext !== expected.appPlaintext ||
    !/^vkc_[0-9a-f]{32}$/u.test(value.challengeId) ||
    !sameNumbers(value.transportSecret, expected.transportSecret) ||
    !sameNumbers(value.requestNonce, expected.requestNonce) ||
    value.transportPublicKey.length !== 48 ||
    value.transportPublicKeyHash.length !== 32 ||
    value.encryptedKey.length !== 192 ||
    value.derivedPrivateKey.length !== 48 ||
    value.publicInfo.publicKey.length !== 96 ||
    value.publicInfo.publicFingerprint.length !== 32 ||
    value.publicInfo.derivationInput.length !== 32
  ) {
    throw new Error("Installed redaction success returned malformed evidence");
  }
  if (
    sha256(value.transportPublicKey) !== hex(value.transportPublicKeyHash) ||
    sha256(value.publicInfo.publicKey) !== hex(value.publicInfo.publicFingerprint)
  ) {
    throw new Error("Installed redaction public hashes do not match their inputs");
  }
}

function assertRedactionFailure(
  value: RedactionFailureEvidence,
  appId: FixtureAppId,
  requestNonce: Uint8Array,
  transportPublicKey: Uint8Array,
): void {
  if (
    value.appId !== appId ||
    value.canonicalCode !== "management_failure" ||
    !/^vkc_[0-9a-f]{32}$/u.test(value.challengeId) ||
    value.challengeId.length === 0 ||
    !sameNumbers(value.requestNonce, requestNonce) ||
    !sameNumbers(value.transportPublicKey, transportPublicKey) ||
    value.canonicalMessage.includes(RAW_POCKETIC_REJECT_DIAGNOSTIC)
  ) {
    throw new Error("Installed invalid-transport path was not canonically redacted");
  }
}

async function openAndCaptureVetKeysSettings(
  page: Page,
  publicFingerprint: string,
): Promise<Buffer> {
  await page.locator('[data-tid="kernel-tray-toggle"]').click();
  const popover = page.locator('[data-tid="kernel-tray-popover"]');
  await popover.waitFor({ state: "visible", timeout: 10_000 });
  await page.locator('[data-tid="kernel-tray-settings"]').click();
  const settings = page.locator('[data-tid="kernel-settings"]');
  await settings.waitFor({ state: "visible", timeout: 20_000 });
  const toggle = page.locator('[data-tid="settings-vetkeys-toggle"]');
  await toggle.click();
  const content = page.locator('[data-tid="settings-vetkeys"]');
  await content.waitFor({ state: "visible", timeout: 20_000 });
  await page.waitForFunction(() =>
    document.querySelector('[data-tid="settings-vetkeys"] [aria-label="Loading private-key slots"]') === null,
  );
  const html = await settings.evaluate((element) => element.outerHTML);
  if (
    !html.includes("vetkeys_fixture") ||
    !html.includes("vetkeys_fixture_peer") ||
    !html.includes(publicFingerprint)
  ) {
    throw new Error("Trusted Settings omitted installed public vetKeys evidence");
  }
  await page.locator('[data-tid="settings-back"]').click();
  await settings.waitFor({ state: "detached", timeout: 20_000 });
  return Buffer.from(html, "utf8");
}

async function inspectBrowserPersistence(
  page: Page,
  materials: readonly ForbiddenMaterial[],
): Promise<BrowserPersistenceEvidence> {
  const storageState = Buffer.from(JSON.stringify(
    await page.context().storageState(),
  ));
  assertNoForbiddenMaterial(
    storageState,
    "Playwright browser storage state",
    materials,
  );
  const evidence: BrowserPersistenceEvidence = {
    cacheEntries: 0,
    documents: 0,
    inaccessibleOpaqueSurfaces: 0,
    indexedDatabases: 0,
    indexedRecords: 0,
    localStorageEntries: 0,
    sessionStorageEntries: 0,
    storageStateBytes: storageState.byteLength,
  };
  for (const frame of page.frames()) {
    const projection = await frame.evaluate(async () => {
      const inaccessible: string[] = [];
      let local: Array<readonly [string, string]> = [];
      let session: Array<readonly [string, string]> = [];
      try {
        local = Array.from({ length: localStorage.length }, (_, index) => {
          const key = localStorage.key(index) ?? "";
          return [key, localStorage.getItem(key) ?? ""] as const;
        });
      } catch {
        inaccessible.push("localStorage");
      }
      try {
        session = Array.from({ length: sessionStorage.length }, (_, index) => {
          const key = sessionStorage.key(index) ?? "";
          return [key, sessionStorage.getItem(key) ?? ""] as const;
        });
      } catch {
        inaccessible.push("sessionStorage");
      }
      const databases: Array<{ name: string; stores: unknown[] }> = [];
      try {
        if (typeof indexedDB.databases === "function") {
          for (const info of await indexedDB.databases()) {
            if (!info.name) continue;
            const database = await new Promise<IDBDatabase>((resolve, reject) => {
              const request = indexedDB.open(info.name!);
              request.onsuccess = () => resolve(request.result);
              request.onerror = () => reject(request.error);
            });
            try {
              const stores: unknown[] = [];
              for (const name of Array.from(database.objectStoreNames)) {
                const values = await new Promise<unknown[]>((resolve, reject) => {
                  const transaction = database.transaction(name, "readonly");
                  const request = transaction.objectStore(name).getAll();
                  request.onsuccess = () => resolve(request.result);
                  request.onerror = () => reject(request.error);
                });
                stores.push({ name, values });
              }
              databases.push({ name: info.name, stores });
            } finally {
              database.close();
            }
          }
        } else {
          inaccessible.push("indexedDB.databases");
        }
      } catch {
        inaccessible.push("indexedDB");
      }
      const cacheEntries: unknown[] = [];
      try {
        if ("caches" in window) {
          for (const cacheName of await caches.keys()) {
            const cache = await caches.open(cacheName);
            for (const request of await cache.keys()) {
              const response = await cache.match(request);
              cacheEntries.push({
                body: response
                  ? Array.from(new Uint8Array(await response.arrayBuffer()))
                  : [],
                cacheName,
                headers: response ? Array.from(response.headers.entries()) : [],
                url: request.url,
              });
            }
          }
        } else {
          inaccessible.push("CacheStorage");
        }
      } catch {
        inaccessible.push("CacheStorage");
      }
      return {
        cacheEntries,
        databases,
        document: document.documentElement.outerHTML,
        inaccessible,
        local,
        session,
      };
    });
    const bytes = projectionBytes(projection);
    assertNoForbiddenMaterial(
      bytes,
      `browser persistence at ${frame.url()}`,
      materials,
    );
    evidence.documents += 1;
    evidence.inaccessibleOpaqueSurfaces += projection.inaccessible.length;
    evidence.localStorageEntries += projection.local.length;
    evidence.sessionStorageEntries += projection.session.length;
    evidence.cacheEntries += projection.cacheEntries.length;
    evidence.indexedDatabases += projection.databases.length;
    for (const database of projection.databases) {
      for (const store of database.stores) {
        if (
          typeof store === "object" && store !== null &&
          "values" in store && Array.isArray(store.values)
        ) {
          evidence.indexedRecords += store.values.length;
        }
      }
    }
  }
  return evidence;
}

function material(label: string, value: ArrayLike<number>): ForbiddenMaterial {
  return { label, bytes: Uint8Array.from(value) };
}

function textMaterial(label: string, value: string): ForbiddenMaterial {
  return { label, bytes: new TextEncoder().encode(value), textual: true };
}

function projectionBytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value, (_key, candidate) => {
    if (typeof candidate === "bigint") return candidate.toString();
    if (candidate instanceof Uint8Array) {
      return { base64: Buffer.from(candidate).toString("base64") };
    }
    if (
      candidate &&
      typeof candidate === "object" &&
      "toText" in candidate &&
      typeof candidate.toText === "function"
    ) {
      return candidate.toText();
    }
    return candidate;
  }), "utf8");
}

function asciiBytes(value: string, length: number): Uint8Array {
  const bytes = Buffer.from(value, "ascii");
  if (bytes.byteLength !== length || !/^[A-Z0-9!-]+$/u.test(value)) {
    throw new Error(`Redaction fixture value must be exactly ${length} ASCII bytes`);
  }
  return Uint8Array.from(bytes);
}

function fromHex(value: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})+$/u.test(value)) throw new Error("Invalid fixture hex");
  return Uint8Array.from(value.match(/../gu)!.map((byte) => Number.parseInt(byte, 16)));
}

function hex(value: ArrayLike<number>): string {
  return Buffer.from(Array.from(value)).toString("hex");
}

function sha256(value: ArrayLike<number>): string {
  return createHash("sha256").update(Uint8Array.from(value)).digest("hex");
}

function sameNumbers(
  left: ArrayLike<number>,
  right: ArrayLike<number>,
): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function assertRejections(
  values: RejectionEvidence[],
  code: string,
  operations: readonly string[],
): void {
  if (
    values.length !== operations.length ||
    values.some((value, index) =>
      value.operation !== operations[index] ||
      !value.rejected ||
      value.code !== code,
    )
  ) {
    throw new Error(
      `Adversarial proof expected ${code}: ${JSON.stringify(values)}`,
    );
  }
}

async function assertNoLifecycleDialog(
  page: Page,
  context: string,
): Promise<void> {
  const dialog = page.locator('[data-tid="vetkeys-lifecycle-dialog"]');
  if (await dialog.count() !== 0) {
    throw new Error(`${context} reached trusted lifecycle consent UI`);
  }
}

async function login(page: Page, seed: number): Promise<void> {
  const principal = await page.evaluate(async (identitySeed) => {
    const hook = window.__NEUTRON_PLAYWRIGHT_LOGIN_AS__;
    if (!hook) throw new Error("Local Playwright login hook is unavailable");
    return hook(identitySeed);
  }, seed);
  if (typeof principal !== "string" || principal.length < 5) {
    throw new Error("Local Playwright login returned an invalid principal");
  }
  if (await page.locator('[data-tid="auth-error"]').count()) {
    throw new Error("Installed Neutron rejected the proof identity");
  }
}

function assertLoopbackBrowserUrl(raw: string, canisterId: string): void {
  const url = new URL(raw);
  if (
    url.protocol !== "http:" ||
    url.hostname.split(".")[0] !== canisterId ||
    !url.hostname.endsWith(".localhost")
  ) {
    throw new Error("Installed browser proof requires the exact local canister origin");
  }
}

function monitorSurface(page: Page, capture: BrowserSurfaceCapture): void {
  const onConsole = (message: ConsoleMessage) => {
    if (!capture.active) return;
    capture.output.push(`console:${message.type()}: ${message.text()}`);
    if (message.type() === "error") {
      capture.failures.push(`console: ${message.text()}`);
    }
  };
  const onPageError = (error: Error) => {
    if (!capture.active) return;
    const message = typeof error?.message === "string" && error.message.length > 0
      ? error.message
      : "<non-text browser rejection>";
    capture.output.push(`page: ${message}`);
    // A promise rejected with no value has no bytes that can disclose a
    // sentinel. Keep it in the scanned output evidence, but do not turn the
    // absence of an error payload into a synthetic product failure.
    if (
      message !== "<non-text browser rejection>" &&
      message !== "undefined"
    ) {
      capture.failures.push(`page: ${message}`);
    }
  };
  const onRequestFailed = (request: Request) => {
    if (!capture.active) return;
    if (isExpectedFrameRebindAbort(request)) return;
    const failure =
      `request: ${request.method()} ${request.url()} ${request.failure()?.errorText ?? "failed"}`;
    capture.output.push(failure);
    capture.failures.push(failure);
  };
  page.on("console", onConsole);
  page.on("pageerror", onPageError);
  page.on("requestfailed", onRequestFailed);
  capture.stop = () => {
    capture.active = false;
    page.off("console", onConsole);
    page.off("pageerror", onPageError);
    page.off("requestfailed", onRequestFailed);
  };
}

function isExpectedFrameRebindAbort(request: Request): boolean {
  if (
    request.method() !== "GET" ||
    request.resourceType() !== "document" ||
    request.failure()?.errorText !== "net::ERR_ABORTED"
  ) {
    return false;
  }
  const url = new URL(request.url());
  return FIXTURE_APP_IDS.some((appId) =>
    url.pathname === `/app/${appId}/index.html` &&
    url.searchParams.get("app") === appId
  );
}

function assertJsonEqual(left: unknown, right: unknown, message: string): void {
  if (JSON.stringify(left) !== JSON.stringify(right)) throw new Error(message);
}

function parseRunnerArgs(args: readonly string[]): RunnerInput {
  const values = new Map<string, string>();
  let redaction = false;
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index]!;
    if (key === "--redaction") {
      if (redaction) throw new Error("Duplicate option --redaction");
      redaction = true;
      continue;
    }
    if (![
      "--chromium-executable",
      "--confirm-disposable",
    ].includes(key)) {
      throw new Error(`Unknown option ${key}`);
    }
    if (values.has(key)) throw new Error(`Duplicate option ${key}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${key} requires a value`);
    values.set(key, value);
    index += 1;
  }
  const runtime = fixtureLocalRuntime();
  const chromiumExecutable =
    values.get("--chromium-executable") ??
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  const confirmDisposable = values.get("--confirm-disposable");
  return {
    canisterId: runtime.canisterId,
    host: runtime.gatewayUrl,
    identitySeed: runtime.developerIdentitySeed,
    redaction,
    ...(confirmDisposable !== undefined
      ? { confirmDisposable }
      : {}),
    ...(chromiumExecutable ? { chromiumExecutable } : {}),
    chromiumArgs:
      process.env.PLAYWRIGHT_CHROMIUM_ARGS?.split(/\s+/u).filter(Boolean) ?? [],
  };
}

declare global {
  interface Window {
    __NEUTRON_PLAYWRIGHT_LOGIN_AS__?: (
      identitySeed: number,
    ) => Promise<string>;
  }
}

if (import.meta.main) {
  try {
    const report = await proveInstalledOrigins(
      parseRunnerArgs(process.argv.slice(2)),
    );
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
