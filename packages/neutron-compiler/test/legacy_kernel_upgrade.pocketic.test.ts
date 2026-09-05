/**
 * Stateful release qualification for the immutable v0.3.5, v0.3.6, and
 * v0.3.7 predecessor Kernels.
 *
 * This is opt-in because it launches the pinned 113 MB PocketIC binary and
 * performs hundreds of real ingress calls. Run it with:
 *
 *   NEUTRON_RUN_LEGACY_UPGRADE_POCKETIC=1 \
 *   NEUTRON_POCKETIC_BIN=.neutron/cache/bin/pocket-ic-14.0.0-linux-x64/pocket-ic \
 *   bun test packages/neutron-compiler/test/legacy_kernel_upgrade.pocketic.test.ts
 *
 * Qualify the exact code-only Kitchen Sink and Contacts production transitions
 * with their respective reviewed archive digests:
 *
 *   NEUTRON_RUN_FINAL_KITCHENSINK_CANDIDATE_POCKETIC=1 \
 *   NEUTRON_FINAL_KITCHENSINK_CANDIDATE_SHA256=<reviewed-lowercase-sha256> \
 *   NEUTRON_POCKETIC_BIN=.neutron/cache/bin/pocket-ic-14.0.0-linux-x64/pocket-ic \
 *   bun test packages/neutron-compiler/test/legacy_kernel_upgrade.pocketic.test.ts
 *
 *   NEUTRON_RUN_FINAL_CONTACTS_CANDIDATE_POCKETIC=1 \
 *   NEUTRON_FINAL_CONTACTS_CANDIDATE_SHA256=<reviewed-lowercase-sha256> \
 *   NEUTRON_POCKETIC_BIN=.neutron/cache/bin/pocket-ic-14.0.0-linux-x64/pocket-ic \
 *   bun test packages/neutron-compiler/test/legacy_kernel_upgrade.pocketic.test.ts
 *
 * Qualify exact current Wallet predecessor state and the supported skip path
 * against the reviewed successor archive with:
 *
 *   NEUTRON_RUN_FINAL_WALLET_CANDIDATE_POCKETIC=1 \
 *   NEUTRON_FINAL_WALLET_CANDIDATE_SHA256=<reviewed-lowercase-sha256> \
 *   NEUTRON_POCKETIC_BIN=.neutron/cache/bin/pocket-ic-14.0.0-linux-x64/pocket-ic \
 *   bun test packages/neutron-compiler/test/legacy_kernel_upgrade.pocketic.test.ts
 *
 * Qualify non-reuse across a real management snapshot restore with:
 *
 *   NEUTRON_RUN_BROWSER_ORIGIN_SNAPSHOT_POCKETIC=1 \
 *   NEUTRON_POCKETIC_BIN=.neutron/cache/bin/pocket-ic-14.0.0-linux-x64/pocket-ic \
 *   bun test packages/neutron-compiler/test/legacy_kernel_upgrade.pocketic.test.ts
 *
 * After the reviewed current Kernel archive exists, qualify those exact bytes
 * with:
 *
 *   NEUTRON_RUN_FINAL_KERNEL_CANDIDATE_POCKETIC=1 \
 *   NEUTRON_FINAL_KERNEL_CANDIDATE_SHA256=<reviewed-lowercase-sha256> \
 *   NEUTRON_POCKETIC_BIN=.neutron/cache/bin/pocket-ic-14.0.0-linux-x64/pocket-ic \
 *   bun test packages/neutron-compiler/test/legacy_kernel_upgrade.pocketic.test.ts
 *
 * The runner owns a new temporary PocketIC state directory, initially installs
 * each supported predecessor, and then exercises only Neutron's checked
 * in-product upgrade transaction. It never invokes the provisioner's
 * reinstall path.
 *
 * This qualifies the current compiler/install client against the released
 * actors. It deliberately does not claim to exercise either old packaged
 * browser UI, file picker, IndexedDB state, or reload behavior; those remain
 * manual production-candidate checks in real predecessor browser sessions.
 */
import { expect, test } from "bun:test";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { createHash } from "node:crypto";
import {
  execFile as execFileCallback,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import {
  cp,
  copyFile,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gunzipSync, gzipSync } from "node:zlib";
import msgpack from "tiny-msgpack";
import { prepareDeterministicWasmTransport } from "../src/deployment_record.ts";
import { supportsBrowserSurfaceOrigins } from "../src/assemble.ts";
import {
  assertKernelPackageStateMatchesRuntime,
  buildPackagesInstallAssets,
  compileAndDeployPreparedPackages,
  compileFreshPackages,
  compilePackages,
  deployPreparedPackages,
  motokoFilesFromPreparedFiles,
  prepareCompleteDeploymentBuildRecord,
  preparePackageInstall,
  readKernelPackageState,
  recoverPendingInstall,
  uninstallApp,
  type AppInstance,
  type CompileResult,
  type DeployPreparedPackagesResult,
  type InstallStagedAsset,
  type KernelPackageState,
  type PreparedPackageInstall,
  type UnpackedNeutronPackage,
} from "../src/install.ts";
import { physicalAppMethodName } from "neutron-tools/src/physical_names.js";
import {
  NEUTRON_APP_SOURCE_SNAPSHOT_PATH,
  NEUTRON_PACKAGE_ARCHIVE_ONLY_FEATURE,
  NEUTRON_PACKAGE_ARCHIVE_ONLY_LEGAL_PREFIX,
  NEUTRON_PACKAGE_RECORD_PATH,
} from "neutron-tools/src/package_record.js";
import { assertSupportedCertificateVersions } from "neutron-tools/src/wasm_metadata.js";
import {
  LEGACY_KERNEL_RELEASES,
  PRODUCTION_KERNEL_V323_RELEASE,
  PRODUCTION_KERNEL_V324_RELEASE,
  PRODUCTION_KERNEL_V325_RELEASE,
  PRODUCTION_KERNEL_V326_RELEASE,
  PRODUCTION_KERNEL_V327_RELEASE,
  PRODUCTION_KERNEL_V328_RELEASE,
  PRODUCTION_KERNEL_V329_RELEASE,
  PRODUCTION_KERNEL_V330_RELEASE,
  PRODUCTION_KERNEL_V331_RELEASE,
  PRODUCTION_KERNEL_V332_RELEASE,
  RETAINED_KERNEL_V321_RELEASE,
  assertLegacyUpgradeCompileInvariants,
  compileFinalCandidateLegacyKernelUpgradeFixture,
  compileFinalCandidateProductionKernelUpgradeFixture,
  compileFinalCandidateProductionKernelV324UpgradeFixture,
  compileFinalCandidateProductionKernelV325UpgradeFixture,
  compileFinalCandidateProductionKernelV326UpgradeFixture,
  compileFinalCandidateProductionKernelV327UpgradeFixture,
  compileFinalCandidateProductionKernelV328UpgradeFixture,
  compileFinalCandidateProductionKernelV329UpgradeFixture,
  compileFinalCandidateProductionKernelV330UpgradeFixture,
  compileFinalCandidateProductionKernelV331UpgradeFixture,
  compileFinalCandidateProductionKernelV332UpgradeFixture,
  compileFinalCandidateRetainedKernelUpgradeFixture,
  compileLegacyKernelUpgradeFixture,
  type LegacyUpgradeCompileFixture,
} from "./legacy_kernel_upgrade_fixture.ts";

const RUN = process.env.NEUTRON_RUN_LEGACY_UPGRADE_POCKETIC === "1";
const pocketIcTest = RUN ? test : test.skip;
const RUN_FINAL_CANDIDATE =
  process.env.NEUTRON_RUN_FINAL_KERNEL_CANDIDATE_POCKETIC === "1";
const finalCandidateTest = RUN_FINAL_CANDIDATE ? test : test.skip;
const finalWalletCandidateTest =
  process.env.NEUTRON_RUN_FINAL_WALLET_CANDIDATE_POCKETIC === "1"
    ? test
    : test.skip;
const finalKitchenSinkCandidateTest =
  process.env.NEUTRON_RUN_FINAL_KITCHENSINK_CANDIDATE_POCKETIC === "1"
    ? test
    : test.skip;
const finalContactsCandidateTest =
  process.env.NEUTRON_RUN_FINAL_CONTACTS_CANDIDATE_POCKETIC === "1"
    ? test
    : test.skip;
const RUN_BROWSER_ORIGIN_SNAPSHOT =
  process.env.NEUTRON_RUN_BROWSER_ORIGIN_SNAPSHOT_POCKETIC === "1";
const browserOriginSnapshotTest = RUN_BROWSER_ORIGIN_SNAPSHOT
  ? test
  : test.skip;
const PINNED_POCKET_IC_SHA256 =
  "f5009e61bcbff297435a67a8ef9fc02178ebb9ab3ee1ec3ac81f4fc3d49319c4";
const ICP_LEDGER = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const execFile = promisify(execFileCallback);

type DirectPocketIcClient = {
  deleteInstance(instanceId: number): Promise<void>;
  queryCanister(
    instanceId: number,
    call: DirectCanisterCall,
  ): Promise<Uint8Array>;
  submitIngressMessage(
    instanceId: number,
    call: DirectCanisterCall,
  ): Promise<unknown>;
  awaitIngressMessage(
    instanceId: number,
    message: unknown,
  ): Promise<Uint8Array>;
};

type DirectCanisterCall = {
  sender: Principal;
  canisterId: Principal;
  method: string;
  payload: Uint8Array;
  effectivePrincipal?: { CanisterId: string };
};

type ObservedInstallDispatch = {
  inline?: Uint8Array;
  chunks: Array<{ content: Uint8Array; sha256: Uint8Array }>;
  chunkHashes?: Uint8Array[];
  moduleHash?: Uint8Array;
};

function observeInstallDispatch(
  actor: any,
  observed: ObservedInstallDispatch,
): any {
  return new Proxy(actor, {
    get(target, property, receiver) {
      const original = Reflect.get(target, property, receiver);
      if (property === "kernel_install_code") {
        return async (request: { wasm: Uint8Array }) => {
          observed.inline = Uint8Array.from(request.wasm);
          return Reflect.apply(original, target, [request]);
        };
      }
      if (property === "kernel_install_wasm_chunk") {
        return async (request: { chunk: Uint8Array; sha256: Uint8Array }) => {
          observed.chunks.push({
            content: Uint8Array.from(request.chunk),
            sha256: Uint8Array.from(request.sha256),
          });
          return Reflect.apply(original, target, [request]);
        };
      }
      if (property === "kernel_install_code_chunked") {
        return async (request: {
          chunk_hashes: Uint8Array[];
          wasm_module_hash: Uint8Array;
        }) => {
          observed.chunkHashes = request.chunk_hashes.map((hash) =>
            Uint8Array.from(hash),
          );
          observed.moduleHash = Uint8Array.from(request.wasm_module_hash);
          return Reflect.apply(original, target, [request]);
        };
      }
      return typeof original === "function" ? original.bind(target) : original;
    },
  });
}

type PausedInstallDispatch = Readonly<{
  actor: any;
  reached: Promise<void>;
  release(): void;
  captured():
    | Readonly<{ kind: "inline"; request: any }>
    | Readonly<{
        kind: "chunked";
        chunks: readonly any[];
        request: any;
      }>;
}>;

function pauseInstallDispatch(actor: any): PausedInstallDispatch {
  let resolveReached!: () => void;
  let resolveRelease!: () => void;
  const reached = new Promise<void>((resolve) => {
    resolveReached = resolve;
  });
  const released = new Promise<void>((resolve) => {
    resolveRelease = resolve;
  });
  let intercepted = false;
  let inlineRequest: any;
  let chunkedRequest: any;
  const chunks: any[] = [];

  return {
    actor: new Proxy(actor, {
      get(target, property, receiver) {
        const original = Reflect.get(target, property, receiver);
        if (property === "kernel_install_wasm_chunk") {
          return async (request: any) => {
            chunks.push(structuredClone(request));
            return Reflect.apply(original, target, [request]);
          };
        }
        if (
          property === "kernel_install_code" ||
          property === "kernel_install_code_chunked"
        ) {
          return async (...args: unknown[]) => {
            if (intercepted) {
              throw new Error("Install dispatch pause was entered twice");
            }
            intercepted = true;
            if (property === "kernel_install_code") {
              inlineRequest = structuredClone(args[0]);
            } else {
              chunkedRequest = structuredClone(args[0]);
            }
            resolveReached();
            await released;
            return Reflect.apply(original, target, args);
          };
        }
        return typeof original === "function"
          ? original.bind(target)
          : original;
      },
    }),
    reached,
    release: resolveRelease,
    captured() {
      if (inlineRequest !== undefined && chunkedRequest === undefined) {
        return { kind: "inline", request: inlineRequest };
      }
      if (inlineRequest === undefined && chunkedRequest !== undefined) {
        return { kind: "chunked", chunks, request: chunkedRequest };
      }
      throw new Error("Paused install dispatch is unavailable or ambiguous");
    },
  };
}

async function resumeCapturedPendingInstall(
  actor: any,
  paused: PausedInstallDispatch,
  deploymentId: string,
): Promise<void> {
  const captured = paused.captured();
  if (captured.kind === "inline") {
    await actor.kernel_install_code(captured.request).catch(() => undefined);
  } else {
    await actor.kernel_install_wasm_chunks_clear({
      deployment_id: deploymentId,
    });
    for (const chunk of captured.chunks) {
      await actor.kernel_install_wasm_chunk(chunk);
    }
    await actor
      .kernel_install_code_chunked(captured.request)
      .catch(() => undefined);
  }
  expect(
    await recoverPendingInstall(actor, { timeoutMs: 120_000 }),
  ).toEqual({ status: "committed", deploymentId });
}

async function waitForPausedInstallDispatch<T>(
  paused: PausedInstallDispatch,
  deployment: Promise<T>,
): Promise<void> {
  await Promise.race([
    paused.reached,
    deployment.then(
      () => {
        throw new Error("Deployment completed before install dispatch paused");
      },
      (cause: unknown) => {
        throw cause;
      },
    ),
  ]);
}

function observedInstallTransport(
  observed: ObservedInstallDispatch,
): Uint8Array {
  if (observed.inline !== undefined) {
    if (observed.chunks.length !== 0 || observed.chunkHashes !== undefined) {
      throw new Error("Install dispatch mixed inline and chunked transport");
    }
    return observed.inline;
  }
  if (observed.chunkHashes === undefined || observed.moduleHash === undefined) {
    throw new Error("Install transport was not dispatched");
  }
  const contentByHash = new Map(
    observed.chunks.map(({ content, sha256: digest }) => [
      Buffer.from(digest).toString("hex"),
      content,
    ]),
  );
  const ordered = observed.chunkHashes.map((digest) => {
    const digestHex = Buffer.from(digest).toString("hex");
    const content = contentByHash.get(digestHex);
    if (content === undefined || sha256Hex(content) !== digestHex) {
      throw new Error(`Missing observed install chunk ${digestHex}`);
    }
    return content;
  });
  const transport = concatenateBytes(ordered);
  if (
    sha256Hex(transport) !== Buffer.from(observed.moduleHash).toString("hex")
  ) {
    throw new Error(
      "Observed chunked install module hash does not match bytes",
    );
  }
  return transport;
}

function concatenateBytes(parts: readonly Uint8Array[]): Uint8Array {
  const combined = new Uint8Array(
    parts.reduce((total, part) => total + part.byteLength, 0),
  );
  let offset = 0;
  for (const part of parts) {
    combined.set(part, offset);
    offset += part.byteLength;
  }
  return combined;
}

for (const release of LEGACY_KERNEL_RELEASES) {
  pocketIcTest(
    `generated v0.3.16 preserves durable state through the ${release.label} checked self-upgrade`,
    () =>
      runLegacyUpgradeQualification(() =>
        compileLegacyKernelUpgradeFixture(release.version),
      ),
    300_000,
  );

  finalCandidateTest(
    `the reviewed current Kernel archive preserves durable state through the ${release.label} checked self-upgrade`,
    () =>
      runLegacyUpgradeQualification(() =>
        compileFinalCandidateLegacyKernelUpgradeFixture({
          expectedSha256:
            process.env.NEUTRON_FINAL_KERNEL_CANDIDATE_SHA256 ?? "",
          legacyVersion: release.version,
        }),
      ),
    300_000,
  );
}

finalCandidateTest(
  `the reviewed current Kernel archive preserves durable state through the ${RETAINED_KERNEL_V321_RELEASE.label} checked self-upgrade`,
  () =>
    runLegacyUpgradeQualification(() =>
      compileFinalCandidateRetainedKernelUpgradeFixture({
        expectedSha256: process.env.NEUTRON_FINAL_KERNEL_CANDIDATE_SHA256 ?? "",
      }),
    ),
  300_000,
);

finalCandidateTest(
  `the reviewed current Kernel archive preserves durable state through the exact production ${PRODUCTION_KERNEL_V323_RELEASE.label} checked self-upgrade`,
  () =>
    runLegacyUpgradeQualification(() =>
      compileFinalCandidateProductionKernelUpgradeFixture({
        expectedSha256: process.env.NEUTRON_FINAL_KERNEL_CANDIDATE_SHA256 ?? "",
      }),
    ),
  300_000,
);

finalCandidateTest(
  `the reviewed current Kernel archive preserves durable state through the exact production ${PRODUCTION_KERNEL_V324_RELEASE.label} checked self-upgrade`,
  () =>
    runLegacyUpgradeQualification(() =>
      compileFinalCandidateProductionKernelV324UpgradeFixture({
        expectedSha256: process.env.NEUTRON_FINAL_KERNEL_CANDIDATE_SHA256 ?? "",
      }),
    ),
  300_000,
);

finalCandidateTest(
  `the reviewed current Kernel archive preserves durable state through the exact production ${PRODUCTION_KERNEL_V325_RELEASE.label} checked self-upgrade`,
  () =>
    runLegacyUpgradeQualification(() =>
      compileFinalCandidateProductionKernelV325UpgradeFixture({
        expectedSha256: process.env.NEUTRON_FINAL_KERNEL_CANDIDATE_SHA256 ?? "",
      }),
    ),
  300_000,
);

finalCandidateTest(
  `the reviewed current Kernel archive preserves durable state through the exact production ${PRODUCTION_KERNEL_V326_RELEASE.label} checked self-upgrade`,
  () =>
    runLegacyUpgradeQualification(() =>
      compileFinalCandidateProductionKernelV326UpgradeFixture({
        expectedSha256: process.env.NEUTRON_FINAL_KERNEL_CANDIDATE_SHA256 ?? "",
      }),
    ),
  300_000,
);

finalCandidateTest(
  `the reviewed current Kernel archive preserves durable state through the exact production ${PRODUCTION_KERNEL_V327_RELEASE.label} checked self-upgrade`,
  () =>
    runLegacyUpgradeQualification(() =>
      compileFinalCandidateProductionKernelV327UpgradeFixture({
        expectedSha256: process.env.NEUTRON_FINAL_KERNEL_CANDIDATE_SHA256 ?? "",
      }),
    ),
  300_000,
);

finalCandidateTest(
  `the reviewed current Kernel archive preserves durable state through the exact production ${PRODUCTION_KERNEL_V328_RELEASE.label} checked self-upgrade`,
  () =>
    runLegacyUpgradeQualification(() =>
      compileFinalCandidateProductionKernelV328UpgradeFixture({
        expectedSha256: process.env.NEUTRON_FINAL_KERNEL_CANDIDATE_SHA256 ?? "",
      }),
    ),
  300_000,
);

finalCandidateTest(
  `the reviewed current Kernel archive preserves durable state through the exact production ${PRODUCTION_KERNEL_V329_RELEASE.label} checked self-upgrade`,
  () =>
    runLegacyUpgradeQualification(() =>
      compileFinalCandidateProductionKernelV329UpgradeFixture({
        expectedSha256: process.env.NEUTRON_FINAL_KERNEL_CANDIDATE_SHA256 ?? "",
      }),
    ),
  300_000,
);

finalCandidateTest(
  `the reviewed current Kernel archive preserves durable state through the exact production ${PRODUCTION_KERNEL_V330_RELEASE.label} checked self-upgrade`,
  () =>
    runLegacyUpgradeQualification(() =>
      compileFinalCandidateProductionKernelV330UpgradeFixture({
        expectedSha256: process.env.NEUTRON_FINAL_KERNEL_CANDIDATE_SHA256 ?? "",
      }),
    ),
  300_000,
);

finalCandidateTest(
  `the reviewed current Kernel archive preserves durable state through the exact production ${PRODUCTION_KERNEL_V331_RELEASE.label} checked self-upgrade`,
  () =>
    runLegacyUpgradeQualification(() =>
      compileFinalCandidateProductionKernelV331UpgradeFixture({
        expectedSha256: process.env.NEUTRON_FINAL_KERNEL_CANDIDATE_SHA256 ?? "",
      }),
    ),
  300_000,
);

finalCandidateTest(
  `the reviewed current Kernel archive preserves durable state through the exact production ${PRODUCTION_KERNEL_V332_RELEASE.label} checked self-upgrade`,
  () =>
    runLegacyUpgradeQualification(() =>
      compileFinalCandidateProductionKernelV332UpgradeFixture({
        expectedSha256: process.env.NEUTRON_FINAL_KERNEL_CANDIDATE_SHA256 ?? "",
      }),
    ),
  300_000,
);

finalWalletCandidateTest(
  "the reviewed Wallet v0.3.11 archive preserves exact v0.3.10 state through a checked upgrade",
  runWalletUpgradeQualification,
  600_000,
);

finalWalletCandidateTest(
  "the reviewed Wallet v0.3.11 archive preserves exact v0.3.6 state through a skipped checked upgrade",
  () => runProductionAppUpgradeQualification(walletV306UpgradeCase()),
  600_000,
);

finalKitchenSinkCandidateTest(
  "the reviewed Kitchen Sink v0.3.9 archive preserves exact v0.3.8 state through a checked upgrade",
  () => runProductionAppUpgradeQualification(kitchenSinkV309UpgradeCase()),
  600_000,
);

finalKitchenSinkCandidateTest(
  "the reviewed Kitchen Sink v0.3.10 archive preserves exact v0.3.9 state through a checked upgrade",
  () => runProductionAppUpgradeQualification(kitchenSinkV310UpgradeCase()),
  600_000,
);

finalKitchenSinkCandidateTest(
  "the reviewed Kitchen Sink v0.3.11 archive preserves exact v0.3.10 state through a checked upgrade",
  () => runProductionAppUpgradeQualification(kitchenSinkV311UpgradeCase()),
  600_000,
);

finalContactsCandidateTest(
  "the reviewed Contacts v0.3.5 archive preserves exact v0.3.4 state through a checked upgrade",
  () => runProductionAppUpgradeQualification(contactsUpgradeCase()),
  600_000,
);

browserOriginSnapshotTest(
  "restored pre-begin and pending-dispatch branches never reuse browser origins",
  runBrowserOriginSnapshotQualification,
  900_000,
);

async function runWalletUpgradeQualification(): Promise<void> {
  const releases = [
    [
      "Kernel v0.3.23",
      "../../../apps/kernel/kernel.v0.3.23.neutron",
      "kernel",
      323,
      2_448_813,
      "e2e5cea791af54a5052f227fcda57f07ecec1a5b4d11bfb5c79696c75d826334",
    ],
    [
      "Contacts v0.3.1",
      "../../../apps/contacts/contacts.v0.3.1.neutron",
      "contacts",
      301,
      253_319,
      "19591c8db038db92c182b70ce0761e855efc1e7e7f37d3b1503866baa11d097a",
    ],
    [
      "Wallet v0.3.10",
      "../../../apps/wallet/wallet.v0.3.10.neutron",
      "wallet",
      310,
      677_819,
      "a2077b5da0f5623b61e8f8a88f465bcac89ceb43908eed8fa9a5da5aa1aa7442",
    ],
  ] as const;
  const initialArchives = await Promise.all(
    releases.map(async ([label, relativePath, id, version, bytes, sha256]) => {
      const archive = new Uint8Array(
        await readFile(new URL(relativePath, import.meta.url)),
      );
      expect(archive.byteLength, `${label} bytes`).toBe(bytes);
      expect(sha256Hex(archive), `${label} SHA-256`).toBe(sha256);
      return {
        archive,
        prepared: preparePackageInstall(archive, {
          expectedIdentity: { id, version, sha256 },
        }),
      } satisfies PreparedArchive;
    }),
  );
  const initialPackages = initialArchives.map(({ prepared }) => prepared);
  const predecessor = initialPackages.find(
    ({ manifest }) => manifest.id === "wallet",
  );
  if (predecessor === undefined) throw new Error("Wallet v0.3.10 is missing");

  const candidateSha256 =
    process.env.NEUTRON_FINAL_WALLET_CANDIDATE_SHA256 ?? "";
  if (!/^[a-f0-9]{64}$/u.test(candidateSha256)) {
    throw new Error(
      "NEUTRON_FINAL_WALLET_CANDIDATE_SHA256 must be a reviewed lowercase SHA-256",
    );
  }
  const candidateArchive = new Uint8Array(
    await readFile(
      new URL("../../../apps/wallet/wallet.v0.3.11.neutron", import.meta.url),
    ),
  );
  const candidate = preparePackageInstall(candidateArchive, {
    expectedIdentity: {
      id: "wallet",
      version: 311,
      sha256: candidateSha256,
    },
  });
  expect(candidate.manifest.memory).toEqual(predecessor.manifest.memory);
  const initial = await compileFreshPackages({
    packages: initialPackages,
    persistenceMode: "classical",
  });
  const state = freshPackageState(initialPackages, initial);
  const upgraded = await compilePackages({
    packages: [candidate],
    existingModules: state.existingModules,
    existingConfigs: state.existingConfigs,
    existingApps: state.apps,
    existingBrowserSurfaceOriginAppIds: state.browserSurfaceOriginAppIds,
    existingStable: state.previousStable,
    connectionProviderSupport: state.connectionProviderSupport,
    persistenceMode: "classical",
    versionPolicy: "strict-upgrade",
  });

  const provision = await loadProvisionHarness();
  const binary = requiredPocketIcBinary();
  expect(sha256Hex(new Uint8Array(await readFile(binary)))).toBe(
    PINNED_POCKET_IC_SHA256,
  );
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "neutron-wallet-v307-upgrade-pocketic-"),
  );
  let server: ChildProcessWithoutNullStreams | undefined;
  let client: DirectPocketIcClient | undefined;
  let instanceId: number | undefined;

  try {
    const launched = await launchPocketIc(binary, temporaryRoot);
    server = launched.server;
    client = new provision.PocketIcRestClient(launched.controlUrl, {
      requestTimeoutMs: 120_000,
    }) as DirectPocketIcClient;
    const created = await createApplicationInstance(
      launched.controlUrl,
      path.join(temporaryRoot, "state"),
      true,
    );
    instanceId = created.instanceId;
    const deployer = testPrincipal(91);
    const owner = testPrincipal(92);
    const recipients = [testPrincipal(93), testPrincipal(94), testPrincipal(95)];
    const direct = new DirectPocketIcCalls(client, instanceId);
    const canisterId = await direct.createCanister(
      deployer,
      created.defaultEffectiveCanisterId,
    );
    await fundIcp(direct, canisterId, 200_000_000n);
    await direct.installInitial(canisterId, deployer, initial);
    await direct.setControllers(canisterId, deployer, [deployer, canisterId]);

    const actor = provision.createDirectPocketIcKernelActor({
      controlUrl: launched.controlUrl,
      instanceId,
      canisterId: canisterId.toText(),
      caller: deployer,
      client,
    });
    await provision.seedFreshKernel({
      actor,
      canisterId: canisterId.toText(),
      deployment: freshDeployment(initialArchives, initial),
      concurrency: 32,
      logger: silentLogger,
    });
    const token = new Uint8Array(32).fill(0x5c);
    expect(
      await direct.kernelActivation(canisterId, deployer, {
        set: sha256(token),
      }),
    ).toEqual({ ready: null });
    expect(
      await direct.kernelActivation(canisterId, owner, { use: token }),
    ).toEqual({ authorized: null });

    const ownerActor = provision.createDirectPocketIcKernelActor({
      controlUrl: launched.controlUrl,
      instanceId,
      canisterId: canisterId.toText(),
      caller: owner,
      client,
    });
    const runtimeBefore = await ownerActor.kernel_runtime_info();
    const walletBefore = requiredAppInstance(
      normalizeAppInstances(runtimeBefore.apps),
      "wallet",
    );
    expect(walletBefore.version).toBe(predecessor.manifest.version);
    const methods = walletUpgradeMethods();
    const callWallet = (
      name: string,
      method: IDL.FuncClass,
      args: unknown[],
    ) =>
      direct.actorCall(
        canisterId,
        owner,
        physicalAppMethodName("wallet", name),
        method,
        args,
      );
    await callWallet("wallet_set_ledgers", methods.setLedgers, [[ICP_LEDGER]]);

    let seededHistory = (await callWallet(
      "wallet_history_status",
      methods.historyStatus,
      [null],
    )) as WalletUpgradeHistoryStatus;
    for (
      let attempt = 0;
      historyRecordCount(seededHistory) === 0n && attempt < 20;
      attempt += 1
    ) {
      await callWallet("wallet_history_sync", methods.historySync, [null]);
      await delay(100);
      seededHistory = (await callWallet(
        "wallet_history_status",
        methods.historyStatus,
        [null],
      )) as WalletUpgradeHistoryStatus;
    }
    const seededHistoryCount = historyRecordCount(seededHistory);
    expect(seededHistoryCount).toBeGreaterThan(0n);

    const requests = recipients.map((recipient, index) =>
      walletUpgradeFundingRequest(0x31 + index, recipient, 100_001n + BigInt(index)),
    );
    const preparedResults: WalletUpgradePrepareResult[] = [];
    for (const request of requests) {
      const result = (await callWallet(
        "wallet_funding_prepare_v1",
        methods.fundingPrepare,
        [request],
      )) as WalletUpgradePrepareResult;
      expect(result).toMatchObject({
        ok: { prepared: { command_id: walletUpgradeCommandId(request) } },
      });
      preparedResults.push(result);
    }

    const submitted = [];
    for (const request of requests.slice(1)) {
      submitted.push({
        request,
        call: await direct.submitActorCall(
          canisterId,
          owner,
          physicalAppMethodName("wallet", "wallet_funding_execute_v1"),
          methods.fundingExecute,
          [{ command_id: walletUpgradeCommandId(request) }],
        ),
      });
    }
    const dispatched = [];
    for (const { request, call } of submitted) {
      const result = (await direct.awaitActorCall(
        call,
      )) as WalletUpgradeExecution;
      expect(walletUpgradeExecutionCommandId(result)).toEqual(
        walletUpgradeCommandId(request),
      );
      dispatched.push({ request, result });
    }
    const pending = dispatched.find(({ result }) => "pending" in result);
    const terminal = dispatched.find(({ result }) => "transferred" in result);
    if (pending === undefined || terminal === undefined) {
      throw new Error(
        `Concurrent Wallet dispatch did not produce pending + terminal rows: ${JSON.stringify(
          dispatched.map(({ result }) => Object.keys(result)[0]),
        )}`,
      );
    }

    const commandRows = [
      {
        state: "prepared",
        request: requests[0]!,
        before: preparedResults[0]!,
      },
      {
        state: "pending",
        request: pending.request,
        before: (await callWallet(
          "wallet_funding_prepare_v1",
          methods.fundingPrepare,
          [pending.request],
        )) as WalletUpgradePrepareResult,
      },
      {
        state: "terminal",
        request: terminal.request,
        before: (await callWallet(
          "wallet_funding_prepare_v1",
          methods.fundingPrepare,
          [terminal.request],
        )) as WalletUpgradePrepareResult,
      },
    ] as const;
    expect(commandRows[1].before).toMatchObject({
      ok: {
        completed: {
          result: {
            pending: { command_id: walletUpgradeCommandId(pending.request) },
          },
        },
      },
    });
    expect(commandRows[2].before).toMatchObject({
      ok: {
        completed: {
          result: {
            transferred: {
              command_id: walletUpgradeCommandId(terminal.request),
            },
          },
        },
      },
    });

    await callWallet("wallet_refresh_balances", methods.refreshBalances, [null]);
    const snapshotBefore = await callWallet("wallet_snapshot", methods.snapshot, [
      null,
    ]);
    expect(snapshotBefore).toMatchObject({
      configured: true,
      ledgers: [
        {
          principal: ICP_LEDGER,
          balance: [
            200_000_000n -
              terminal.request.intent.direct.amount_atoms -
              10_000n,
          ],
        },
      ],
    });
    const historyBefore = (await callWallet(
      "wallet_history_status",
      methods.historyStatus,
      [null],
    )) as WalletUpgradeHistoryStatus;
    expect(historyRecordCount(historyBefore)).toBeGreaterThan(seededHistoryCount);

    const deployed = await deployExactTransition({
      actor: ownerActor,
      canisterId,
      packages: [candidate],
      state,
      compiled: upgraded,
      expectedDeploymentId: initial.deploymentId,
    });
    expect(deployed.compiled.migrationPlan.removedApps).toEqual([]);
    expect(deployed.compiled.migrationPlan.destructiveMemoryRoots).toEqual([]);
    expect(
      deployed.compiled.migrationPlan.upgrades
        .map((upgrade) =>
          upgrade.kind === "keep"
            ? `${upgrade.owner}/${upgrade.memoryId}@${upgrade.version}`
            : upgrade.kind,
        )
        .sort(),
    ).toEqual([
      "contacts/contacts@2",
      "kernel/kernel@3",
      "kernel/kernel_activation@1",
      "wallet/wallet@1",
      "wallet/wallet_commands@1",
    ]);
    const runtimeAfter = await ownerActor.kernel_runtime_info();
    const walletAfter = requiredAppInstance(
      normalizeAppInstances(runtimeAfter.apps),
      "wallet",
    );
    const compiledWallet = requiredCompiledAppInstance(
      upgraded.appInstanceInventory,
      "wallet",
    );
    expect(walletAfter).toEqual({
      ...walletBefore,
      version: 311,
      deployment_id: deployed.compiled.deploymentId,
      capability_plan_fingerprint: compiledWallet.capability_plan_fingerprint,
      resident_frame_security: compiledWallet.resident_frame_security,
    });
    expect(normalizeMemoryInventory(runtimeAfter.memories)).toEqual(
      normalizeMemoryInventory(runtimeBefore.memories),
    );
    expect(await ownerActor.kernel_install_status(null)).toEqual([]);
    expect(
      await callWallet("wallet_snapshot", methods.snapshot, [null]),
    ).toEqual(snapshotBefore);
    expect(
      await callWallet("wallet_history_status", methods.historyStatus, [null]),
    ).toEqual(historyBefore);
    for (const row of commandRows) {
      for (const conflictRequest of conflictingWalletUpgradeRequests(
        row.request,
      )) {
        const conflict = (await callWallet(
          "wallet_funding_prepare_v1",
          methods.fundingPrepare,
          [conflictRequest],
        )) as WalletUpgradePrepareResult;
        if (!("err" in conflict)) {
          throw new Error(`${row.state} Wallet command lost its durable intent`);
        }
        expect(conflict.err).toContain("conflicts with another intent");
      }
      expect(
        await callWallet("wallet_funding_prepare_v1", methods.fundingPrepare, [
          replacedEndpointWalletUpgradeRequest(row.request, row.state),
        ]),
      ).toEqual(row.before);
    }
    const candidateRequest = walletUpgradeFundingRequest(
      0x3f,
      testPrincipal(99),
      100_099n,
    );
    const candidateCommand = await callWallet(
      "wallet_funding_prepare_v1",
      methods.fundingPrepare,
      [candidateRequest],
    );
    expect(
      await callWallet("wallet_funding_prepare_v1", methods.fundingPrepare, [
        replacedEndpointWalletUpgradeRequest(candidateRequest, "candidate"),
      ]),
    ).toEqual(candidateCommand);
    expect(direct.externalInstallModes).toEqual(["install"]);
  } finally {
    if (client !== undefined && instanceId !== undefined) {
      await client.deleteInstance(instanceId).catch(() => undefined);
    }
    if (server !== undefined) await stopPocketIc(server);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

type WalletUpgradeHistoryStatus = {
  ledgers: Array<{
    ledger: Principal;
    transaction_count: bigint;
    adjustment_count: bigint;
  }>;
};

function historyRecordCount(status: WalletUpgradeHistoryStatus): bigint {
  const ledger = status.ledgers.find(
    (entry) => entry.ledger.toText() === ICP_LEDGER.toText(),
  );
  return ledger === undefined
    ? 0n
    : ledger.transaction_count + ledger.adjustment_count;
}

function walletUpgradeFundingRequest(
  requestByte: number,
  recipient: Principal,
  amountAtoms: bigint,
) {
  return {
    request_id: new Uint8Array(16).fill(requestByte),
    ledger: ICP_LEDGER,
    valid_until_ns: BigInt(Date.now() + 300_000) * 1_000_000n,
    caller: {
      endpoint: "app:wallet_upgrade_fixture:background",
      app_id: "wallet_upgrade_fixture",
      role: ["background"],
    },
    agent_mode: false,
    intent: {
      direct: {
        amount_atoms: amountAtoms,
        to: { owner: recipient, subaccount: [] },
        memo: [],
      },
    },
  };
}

type WalletUpgradeFundingRequest = ReturnType<
  typeof walletUpgradeFundingRequest
>;

type WalletUpgradeCommandId = {
  caller_app_id: string;
  request_id: Uint8Array;
};

type WalletUpgradeExecution =
  | {
      transferred: {
        command_id: WalletUpgradeCommandId;
        block_index: bigint;
        duplicate: boolean;
      };
    }
  | {
      approved: {
        command_id: WalletUpgradeCommandId;
        block_index: [] | [bigint];
        duplicate: boolean;
      };
    }
  | {
      revoked: {
        command_id: WalletUpgradeCommandId;
        block_index: [] | [bigint];
        duplicate: boolean;
      };
    }
  | {
      pending: { command_id: WalletUpgradeCommandId; message: string };
    }
  | {
      rejected: { command_id: WalletUpgradeCommandId; message: string };
    };

type WalletUpgradePrepareResult =
  | {
      ok:
        | {
            prepared: {
              command_id: WalletUpgradeCommandId;
              review: null;
            };
          }
        | {
            completed: {
              review: null;
              result: WalletUpgradeExecution;
            };
          };
    }
  | { err: string };

function walletUpgradeCommandId(
  request: WalletUpgradeFundingRequest,
): WalletUpgradeCommandId {
  return {
    caller_app_id: request.caller.app_id,
    request_id: request.request_id,
  };
}

function walletUpgradeExecutionCommandId(
  result: WalletUpgradeExecution,
): WalletUpgradeCommandId {
  if ("transferred" in result) return result.transferred.command_id;
  if ("approved" in result) return result.approved.command_id;
  if ("revoked" in result) return result.revoked.command_id;
  if ("pending" in result) return result.pending.command_id;
  return result.rejected.command_id;
}

function conflictingWalletUpgradeRequests(
  request: WalletUpgradeFundingRequest,
): WalletUpgradeFundingRequest[] {
  return [
    {
      ...request,
      intent: {
        direct: {
          ...request.intent.direct,
          amount_atoms: request.intent.direct.amount_atoms + 1n,
        },
      },
    },
    { ...request, ledger: testPrincipal(97) },
    { ...request, caller: { ...request.caller, role: ["tile"] } },
    { ...request, agent_mode: true },
  ];
}

function replacedEndpointWalletUpgradeRequest(
  request: WalletUpgradeFundingRequest,
  suffix: string,
): WalletUpgradeFundingRequest {
  return {
    ...request,
    caller: {
      ...request.caller,
      endpoint: `app:wallet_upgrade_fixture:tile:${suffix}:replacement`,
    },
  };
}

function walletUpgradeMethods() {
  const blob = IDL.Vec(IDL.Nat8);
  const account = IDL.Record({
    owner: IDL.Principal,
    subaccount: IDL.Opt(blob),
  });
  const commandId = IDL.Record({
    caller_app_id: IDL.Text,
    request_id: blob,
  });
  const executionMessage = IDL.Record({
    command_id: commandId,
    message: IDL.Text,
  });
  const approvalReceipt = IDL.Record({
    command_id: commandId,
    block_index: IDL.Opt(IDL.Nat),
    duplicate: IDL.Bool,
  });
  const execution = IDL.Variant({
    transferred: IDL.Record({
      command_id: commandId,
      block_index: IDL.Nat,
      duplicate: IDL.Bool,
    }),
    approved: approvalReceipt,
    revoked: approvalReceipt,
    pending: executionMessage,
    rejected: executionMessage,
  });
  const prepareRequest = IDL.Record({
    request_id: blob,
    ledger: IDL.Principal,
    valid_until_ns: IDL.Nat64,
    caller: IDL.Record({
      endpoint: IDL.Text,
      app_id: IDL.Text,
      role: IDL.Opt(IDL.Text),
    }),
    agent_mode: IDL.Bool,
    intent: IDL.Variant({
      direct: IDL.Record({
        amount_atoms: IDL.Nat,
        to: account,
        memo: IDL.Opt(blob),
      }),
    }),
  });
  return {
    setLedgers: IDL.Func([IDL.Vec(IDL.Principal)], [IDL.Reserved], []),
    snapshot: IDL.Func(
      [IDL.Null],
      [
        IDL.Record({
          configured: IDL.Bool,
          ledgers: IDL.Vec(
            IDL.Record({
              principal: IDL.Principal,
              balance: IDL.Opt(IDL.Nat),
            }),
          ),
        }),
      ],
      ["query"],
    ),
    refreshBalances: IDL.Func([IDL.Null], [IDL.Reserved], []),
    historySync: IDL.Func([IDL.Null], [IDL.Reserved], []),
    historyStatus: IDL.Func(
      [IDL.Null],
      [
        IDL.Record({
          ledgers: IDL.Vec(
            IDL.Record({
              ledger: IDL.Principal,
              transaction_count: IDL.Nat,
              adjustment_count: IDL.Nat,
            }),
          ),
        }),
      ],
      ["query"],
    ),
    fundingPrepare: IDL.Func(
      [prepareRequest],
      [
        IDL.Variant({
          ok: IDL.Variant({
            prepared: IDL.Record({
              command_id: commandId,
              review: IDL.Reserved,
            }),
            completed: IDL.Record({
              review: IDL.Reserved,
              result: execution,
            }),
          }),
          err: IDL.Text,
        }),
      ],
      [],
    ),
    fundingExecute: IDL.Func(
      [IDL.Record({ command_id: commandId })],
      [execution],
      [],
    ),
  };
}

async function fundIcp(
  direct: DirectPocketIcCalls,
  owner: Principal,
  amount: bigint,
): Promise<void> {
  const result = (await direct.actorCall(
    ICP_LEDGER,
    Principal.anonymous(),
    "icrc1_transfer",
    IDL.Func(
      [
        IDL.Record({
          from_subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)),
          to: IDL.Record({
            owner: IDL.Principal,
            subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)),
          }),
          amount: IDL.Nat,
          fee: IDL.Opt(IDL.Nat),
          memo: IDL.Opt(IDL.Vec(IDL.Nat8)),
          created_at_time: IDL.Opt(IDL.Nat64),
        }),
      ],
      [IDL.Variant({ Ok: IDL.Nat, Err: IDL.Reserved })],
      [],
    ),
    [
      {
        from_subaccount: [],
        to: { owner, subaccount: [] },
        amount,
        fee: [],
        memo: [],
        created_at_time: [],
      },
    ],
  )) as { Ok: bigint } | { Err: null };
  if (!("Ok" in result)) throw new Error("PocketIC ICP funding failed");
}

async function runBrowserOriginSnapshotQualification(): Promise<void> {
  const provision = await loadProvisionHarness();
  const binary = requiredPocketIcBinary();
  expect(sha256Hex(new Uint8Array(await readFile(binary)))).toBe(
    PINNED_POCKET_IC_SHA256,
  );

  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "neutron-browser-origin-snapshot-pocketic-"),
  );
  let server: ChildProcessWithoutNullStreams | undefined;
  let client: DirectPocketIcClient | undefined;
  let instanceId: number | undefined;

  try {
    const packages = await prepareBrowserOriginSnapshotPackages(temporaryRoot);
    const initialPackages = [
      packages.kernel.prepared,
      packages.authorityV100.prepared,
    ];
    const initial = await compileFreshPackages({ packages: initialPackages });

    const launched = await launchPocketIc(binary, temporaryRoot);
    server = launched.server;
    client = new provision.PocketIcRestClient(launched.controlUrl, {
      requestTimeoutMs: 120_000,
    }) as DirectPocketIcClient;
    const created = await createApplicationInstance(
      launched.controlUrl,
      path.join(temporaryRoot, "state"),
    );
    instanceId = created.instanceId;

    const deployer = testPrincipal(81);
    const direct = new DirectPocketIcCalls(client, instanceId);
    const canisterId = await direct.createCanister(
      deployer,
      created.defaultEffectiveCanisterId,
    );
    await direct.installInitial(canisterId, deployer, initial);
    await direct.setControllers(canisterId, deployer, [deployer, canisterId]);

    const actor = provision.createDirectPocketIcKernelActor({
      controlUrl: launched.controlUrl,
      instanceId,
      canisterId: canisterId.toText(),
      caller: deployer,
      client,
    });
    await provision.seedFreshKernel({
      actor,
      canisterId: canisterId.toText(),
      deployment: freshDeployment(
        [packages.kernel, packages.authorityV100],
        initial,
      ),
      concurrency: 32,
      logger: silentLogger,
    });

    const baselineState = freshPackageState(initialPackages, initial);
    const baselineRuntime = await actor.kernel_runtime_info();
    const baselineAuthority = requiredAppInstance(
      normalizeAppInstances(baselineRuntime.apps),
      "origin_authority",
    );
    expect(baselineAuthority.resident_frame_security).toBe(
      "credentialless_opaque_v1",
    );

    const snapshot = await direct.takeSnapshot(canisterId, deployer);

    const authorityBranch = await compileAndDeployPreparedPackages({
      actor,
      targetCanisterId: canisterId.toText(),
      packages: [packages.authorityV101.prepared],
      state: baselineState,
      expectedDeploymentId: initial.deploymentId,
      verifyTimeoutMs: 120_000,
    });
    const authorityState = advancePackageState(
      baselineState,
      [packages.authorityV101.prepared],
      authorityBranch,
    );
    const discardedAuthority = requiredAppInstance(
      normalizeAppInstances((await actor.kernel_runtime_info()).apps),
      "origin_authority",
    );
    expect(discardedAuthority.scope.installation_uid).toBe(
      baselineAuthority.scope.installation_uid,
    );
    expect(discardedAuthority.resident_frame_security).toBe(
      "credentialless_ephemeral_dedicated_v1",
    );
    expect(discardedAuthority.browser_origin_nonce).not.toBe(
      baselineAuthority.browser_origin_nonce,
    );

    const firstInstall = await compileAndDeployPreparedPackages({
      actor,
      targetCanisterId: canisterId.toText(),
      packages: [packages.hello.prepared],
      state: authorityState,
      expectedDeploymentId: authorityBranch.compiled.deploymentId,
      verifyTimeoutMs: 120_000,
    });
    const firstInstallState = advancePackageState(
      authorityState,
      [packages.hello.prepared],
      firstInstall,
    );
    const discardedFirstInstall = requiredAppInstance(
      normalizeAppInstances((await actor.kernel_runtime_info()).apps),
      "hello",
    );

    const uninstalled = await uninstallApp({
      actor,
      targetCanisterId: canisterId.toText(),
      state: firstInstallState,
      appId: "hello",
      expectedDeploymentId: firstInstall.compiled.deploymentId,
    });
    const uninstalledState = advancePackageState(
      firstInstallState,
      [],
      uninstalled,
      ["hello"],
    );
    expect(
      normalizeAppInstances((await actor.kernel_runtime_info()).apps).some(
        ({ scope }) => scope.app_id === "hello",
      ),
    ).toBe(false);

    const reinstalled = await compileAndDeployPreparedPackages({
      actor,
      targetCanisterId: canisterId.toText(),
      packages: [packages.hello.prepared],
      state: uninstalledState,
      expectedDeploymentId: uninstalled.compiled.deploymentId,
      verifyTimeoutMs: 120_000,
    });
    const discardedReinstall = requiredAppInstance(
      normalizeAppInstances((await actor.kernel_runtime_info()).apps),
      "hello",
    );
    expect(discardedReinstall.scope.installation_uid).not.toBe(
      discardedFirstInstall.scope.installation_uid,
    );
    expect(discardedReinstall.browser_origin_nonce).not.toBe(
      discardedFirstInstall.browser_origin_nonce,
    );

    await direct.loadSnapshot(canisterId, deployer, snapshot.id);
    expect((await actor.kernel_runtime_info()).deployment_id).toBe(
      initial.deploymentId,
    );

    const restoredAuthorityBranch = await deployExactTransition({
      actor,
      canisterId,
      packages: [packages.authorityV101.prepared],
      state: baselineState,
      compiled: authorityBranch.compiled,
      expectedDeploymentId: initial.deploymentId,
    });
    const restoredAuthorityState = advancePackageState(
      baselineState,
      [packages.authorityV101.prepared],
      restoredAuthorityBranch,
    );
    const restoredAuthority = requiredAppInstance(
      normalizeAppInstances((await actor.kernel_runtime_info()).apps),
      "origin_authority",
    );
    expect(restoredAuthority.scope.installation_uid).toBe(
      baselineAuthority.scope.installation_uid,
    );
    expect(restoredAuthority.resident_frame_security).toBe(
      "credentialless_ephemeral_dedicated_v1",
    );
    expect(restoredAuthority.browser_origin_authority_epoch).not.toBe(
      discardedAuthority.browser_origin_authority_epoch,
    );
    expect(restoredAuthority.browser_origin_nonce).not.toBe(
      discardedAuthority.browser_origin_nonce,
    );
    expect(restoredAuthority.browser_origin_nonce).not.toBe(
      baselineAuthority.browser_origin_nonce,
    );

    const restoredInstallBranch = await deployExactTransition({
      actor,
      canisterId,
      packages: [packages.hello.prepared],
      state: restoredAuthorityState,
      compiled: firstInstall.compiled,
      expectedDeploymentId: authorityBranch.compiled.deploymentId,
    });
    const restoredInstall = requiredAppInstance(
      normalizeAppInstances((await actor.kernel_runtime_info()).apps),
      "hello",
    );
    expect(restoredInstall.scope.installation_uid).not.toBe(
      discardedFirstInstall.scope.installation_uid,
    );
    expect(restoredInstall.scope.installation_uid).not.toBe(
      discardedReinstall.scope.installation_uid,
    );
    expect(restoredInstall.browser_origin_nonce).not.toBe(
      discardedFirstInstall.browser_origin_nonce,
    );
    expect(restoredInstall.browser_origin_nonce).not.toBe(
      discardedReinstall.browser_origin_nonce,
    );

    const restoredFullState = advancePackageState(
      restoredAuthorityState,
      [packages.hello.prepared],
      restoredInstallBranch,
    );
    const paused = pauseInstallDispatch(actor);
    const pendingDeployment = compileAndDeployPreparedPackages({
      actor: paused.actor,
      targetCanisterId: canisterId.toText(),
      packages: [
        packages.authorityV102.prepared,
        packages.pendingOrigin.prepared,
      ],
      state: restoredFullState,
      expectedDeploymentId: restoredInstallBranch.compiled.deploymentId,
      verifyTimeoutMs: 120_000,
    });
    const pendingSnapshotState = await (async () => {
      try {
        // deployPreparedPackages awaits kernel_install_begin_checked before it
        // reaches either paused dispatch method. A present status therefore
        // proves the exact deployment journal is durable before the snapshot.
        await waitForPausedInstallDispatch(paused, pendingDeployment);
        const pendingStatus = await actor.kernel_install_status(null);
        expect(pendingStatus).not.toEqual([]);
        return {
          snapshot: await direct.takeSnapshot(canisterId, deployer),
          status: pendingStatus,
        };
      } finally {
        paused.release();
      }
    })();

    const discardedPendingBranch = await pendingDeployment;
    const discardedPendingApps = normalizeAppInstances(
      (await actor.kernel_runtime_info()).apps,
    );
    const discardedPendingAuthority = requiredAppInstance(
      discardedPendingApps,
      "origin_authority",
    );
    const discardedPendingInstall = requiredAppInstance(
      discardedPendingApps,
      "pending_origin",
    );
    expect(discardedPendingAuthority.scope.installation_uid).toBe(
      restoredAuthority.scope.installation_uid,
    );
    expect(discardedPendingAuthority.resident_frame_security).toBe(
      "credentialless_opaque_v1",
    );
    expect(discardedPendingAuthority.browser_origin_authority_epoch).not.toBe(
      restoredAuthority.browser_origin_authority_epoch,
    );

    await direct.loadSnapshot(
      canisterId,
      deployer,
      pendingSnapshotState.snapshot.id,
    );
    expect((await actor.kernel_runtime_info()).deployment_id).toBe(
      restoredInstallBranch.compiled.deploymentId,
    );
    expect(await actor.kernel_install_status(null)).toEqual(
      pendingSnapshotState.status,
    );

    // The restored journal already owns its complete staged snapshot. Resume
    // the exact captured inline/chunked dispatch instead of restaging through
    // the deliberately frozen public static API.
    await resumeCapturedPendingInstall(
      actor,
      paused,
      discardedPendingBranch.compiled.deploymentId,
    );
    const restoredPendingApps = normalizeAppInstances(
      (await actor.kernel_runtime_info()).apps,
    );
    const restoredPendingAuthority = requiredAppInstance(
      restoredPendingApps,
      "origin_authority",
    );
    const restoredPendingInstall = requiredAppInstance(
      restoredPendingApps,
      "pending_origin",
    );
    expect(restoredPendingInstall.scope.installation_uid).not.toBe(
      discardedPendingInstall.scope.installation_uid,
    );
    expect(restoredPendingInstall.browser_origin_nonce).not.toBe(
      discardedPendingInstall.browser_origin_nonce,
    );
    expect(restoredPendingAuthority.scope.installation_uid).toBe(
      discardedPendingAuthority.scope.installation_uid,
    );
    expect(restoredPendingAuthority.browser_origin_authority_epoch).not.toBe(
      discardedPendingAuthority.browser_origin_authority_epoch,
    );
    expect(restoredPendingAuthority.browser_origin_nonce).not.toBe(
      discardedPendingAuthority.browser_origin_nonce,
    );

    // One external install establishes the canister. Every branch transition
    // above goes through the Kernel's checked #upgrade/#keep transaction.
    expect(direct.externalInstallModes).toEqual(["install"]);
  } finally {
    if (client !== undefined && instanceId !== undefined) {
      await client.deleteInstance(instanceId).catch(() => undefined);
    }
    if (server !== undefined) await stopPocketIc(server);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

type PinnedProductionArchive = Readonly<{
  label: string;
  relativePath: string;
  id: string;
  version: number;
  bytes: number;
  sha256: string;
}>;

type ProductionAppUpgradeExercise = Readonly<{
  direct: DirectPocketIcCalls;
  canisterId: Principal;
  owner: Principal;
  callApp(
    name: string,
    method: IDL.FuncClass,
    args: unknown[],
  ): Promise<unknown>;
}>;

type ProductionAppUpgradeCase = Readonly<{
  label: string;
  targetId: string;
  initial: readonly PinnedProductionArchive[];
  candidatePath: string;
  candidateVersion: number;
  candidateSha256?: string;
  candidateSha256Environment?: string;
  withIcp?: boolean;
  seedAndCapture(
    exercise: ProductionAppUpgradeExercise,
  ): Promise<() => Promise<void>>;
}>;

const PRODUCTION_KERNEL_V323_ARCHIVE: PinnedProductionArchive = {
  label: "Kernel v0.3.23",
  relativePath: "../../../apps/kernel/kernel.v0.3.23.neutron",
  id: "kernel",
  version: 323,
  bytes: 2_448_813,
  sha256: "e2e5cea791af54a5052f227fcda57f07ecec1a5b4d11bfb5c79696c75d826334",
};

const PRODUCTION_CONTACTS_V304_ARCHIVE: PinnedProductionArchive = {
  label: "Contacts v0.3.4",
  relativePath: "../../../apps/contacts/contacts.v0.3.4.neutron",
  id: "contacts",
  version: 304,
  bytes: 284_475,
  sha256: "8068c5e4df862c2e7cbf627eb62e00c1dbed79f1bfbeb18d0868ab8123f4196b",
};

const PRODUCTION_KITCHENSINK_V308_ARCHIVE: PinnedProductionArchive = {
  label: "Kitchen Sink v0.3.8",
  relativePath: "../../../apps/kitchensink/kitchensink.v0.3.8.neutron",
  id: "kitchensink",
  version: 308,
  bytes: 430_105,
  sha256: "b92d77a9dc9475116c04311cfad2114275ec264df32303937bdb65c693b6ea96",
};

const PRODUCTION_KITCHENSINK_V309_ARCHIVE: PinnedProductionArchive = {
  label: "Kitchen Sink v0.3.9",
  relativePath: "../../../apps/kitchensink/kitchensink.v0.3.9.neutron",
  id: "kitchensink",
  version: 309,
  bytes: 430_587,
  sha256: "d4810fa66040bd8b7a9f6973bfa427e8a17f0367cf5a463595417833d96c7c7b",
};

const PRODUCTION_KITCHENSINK_V310_ARCHIVE: PinnedProductionArchive = {
  label: "Kitchen Sink v0.3.10",
  relativePath: "../../../apps/kitchensink/kitchensink.v0.3.10.neutron",
  id: "kitchensink",
  version: 310,
  bytes: 430_618,
  sha256: "a9998e28ace0f3525bad787aa0f21ccaaf8389252d6f9bf7d063d36bd284d795",
};

const PRODUCTION_WALLET_V306_ARCHIVE: PinnedProductionArchive = {
  label: "Wallet v0.3.6",
  relativePath: "../../../apps/wallet/wallet.v0.3.6.neutron",
  id: "wallet",
  version: 306,
  bytes: 666_413,
  sha256: "bea0d49e351bb8efa04bf03057b4f9175474a54bd198b382add790718b7b8aae",
};

function kitchenSinkV309UpgradeCase(): ProductionAppUpgradeCase {
  return kitchenSinkUpgradeCase({
    predecessor: PRODUCTION_KITCHENSINK_V308_ARCHIVE,
    candidatePath: "../../../apps/kitchensink/kitchensink.v0.3.9.neutron",
    candidateVersion: 309,
    candidateSha256:
      "d4810fa66040bd8b7a9f6973bfa427e8a17f0367cf5a463595417833d96c7c7b",
  });
}

function kitchenSinkV310UpgradeCase(): ProductionAppUpgradeCase {
  return kitchenSinkUpgradeCase({
    predecessor: PRODUCTION_KITCHENSINK_V309_ARCHIVE,
    candidatePath: "../../../apps/kitchensink/kitchensink.v0.3.10.neutron",
    candidateVersion: 310,
    candidateSha256:
      "a9998e28ace0f3525bad787aa0f21ccaaf8389252d6f9bf7d063d36bd284d795",
  });
}

function kitchenSinkV311UpgradeCase(): ProductionAppUpgradeCase {
  return kitchenSinkUpgradeCase({
    predecessor: PRODUCTION_KITCHENSINK_V310_ARCHIVE,
    candidatePath: "../../../apps/kitchensink/kitchensink.v0.3.11.neutron",
    candidateVersion: 311,
    candidateSha256Environment:
      "NEUTRON_FINAL_KITCHENSINK_CANDIDATE_SHA256",
  });
}

function kitchenSinkUpgradeCase(candidate: Readonly<{
  predecessor: PinnedProductionArchive;
  candidatePath: string;
  candidateVersion: number;
  candidateSha256?: string;
  candidateSha256Environment?: string;
}>): ProductionAppUpgradeCase {
  const methods = kitchenSinkUpgradeMethods();
  return {
    label: `kitchensink-v${candidate.predecessor.version}-to-v${candidate.candidateVersion}`,
    targetId: "kitchensink",
    initial: [
      PRODUCTION_KERNEL_V323_ARCHIVE,
      PRODUCTION_CONTACTS_V304_ARCHIVE,
      candidate.predecessor,
    ],
    candidatePath: candidate.candidatePath,
    candidateVersion: candidate.candidateVersion,
    ...(candidate.candidateSha256 === undefined
      ? {}
      : { candidateSha256: candidate.candidateSha256 }),
    ...(candidate.candidateSha256Environment === undefined
      ? {}
      : {
          candidateSha256Environment:
            candidate.candidateSha256Environment,
        }),
    async seedAndCapture({ callApp }) {
      expect(
        await callApp("save_profile", methods.saveProfile, [
          [
            "Upgrade-qualified Ada",
            "ada+upgrade@example.test",
            `Exact ${candidate.predecessor.label} durable profile`,
            false,
          ],
        ]),
      ).toBe("Saved Upgrade-qualified Ada <ada+upgrade@example.test>");
      expect(
        (await callApp("bump_counter", methods.bumpCounter, [731n])) as bigint,
      ).toBeGreaterThanOrEqual(731n);
      const profileBefore = await callApp(
        "read_profile",
        methods.readProfile,
        [null],
      );
      const counterBefore = (await callApp(
        "read_counter",
        methods.readCounter,
        [null],
      )) as bigint;
      return async () => {
        expect(
          await callApp("read_profile", methods.readProfile, [null]),
        ).toEqual(profileBefore);
        const counterAfter = (await callApp(
          "read_counter",
          methods.readCounter,
          [null],
        )) as bigint;
        // A committed run-on-start task may advance the retained counter once;
        // either value proves the non-default predecessor root was not reset.
        expect([counterBefore, counterBefore + 1n]).toContain(counterAfter);
      };
    },
  };
}

function contactsUpgradeCase(): ProductionAppUpgradeCase {
  const methods = contactsUpgradeMethods();
  const neutronPrincipal = Principal.fromText(
    "rrkah-fqaaa-aaaaa-aaaaq-cai",
  );
  const icOwner = Principal.fromText("togwv-zqaaa-aaaal-qr7aa-cai");
  const subaccount = Uint8Array.from(
    { length: 32 },
    (_, index) => index + 1,
  );
  return {
    label: "contacts-v304-to-v305",
    targetId: "contacts",
    initial: [
      PRODUCTION_KERNEL_V323_ARCHIVE,
      PRODUCTION_CONTACTS_V304_ARCHIVE,
    ],
    candidatePath: "../../../apps/contacts/contacts.v0.3.5.neutron",
    candidateVersion: 305,
    candidateSha256Environment: "NEUTRON_FINAL_CONTACTS_CANDIDATE_SHA256",
    async seedAndCapture({ callApp }) {
      await callApp("contacts_save", methods.save, [
        {
          id: [],
          expected_revision: [],
          kind: { person: null },
          name: "Exact retained contact",
          notes: "Created by Contacts v0.3.4 before the checked upgrade",
          addresses: [
            {
              id: [],
              address_label: ["Neutron"],
              destination: { neutron: neutronPrincipal },
              preferred: false,
            },
            {
              id: [],
              address_label: ["ICRC subaccount"],
              destination: {
                internet_computer: {
                  owner: icOwner,
                  subaccount: [subaccount],
                },
              },
              preferred: false,
            },
          ],
        },
      ]);
      const contactBefore = await callApp("contacts_get", methods.get, [
        { id: 1n },
      ]);
      expect(contactBefore).toMatchObject([
        {
          id: 1n,
          revision: 1n,
          name: "Exact retained contact",
          addresses: [
            { destination: { neutron: neutronPrincipal } },
            {
              destination: {
                internet_computer: {
                  owner: icOwner,
                  subaccount: [subaccount],
                },
              },
            },
          ],
        },
      ]);
      const revisionBefore = await callApp(
        "contacts_revision",
        methods.revision,
        [null],
      );
      expect(revisionBefore).toEqual({ revision: 1n });
      return async () => {
        expect(await callApp("contacts_get", methods.get, [{ id: 1n }])).toEqual(
          contactBefore,
        );
        expect(
          await callApp("contacts_revision", methods.revision, [null]),
        ).toEqual(revisionBefore);
      };
    },
  };
}

function walletV306UpgradeCase(): ProductionAppUpgradeCase {
  const methods = walletUpgradeMethods();
  const request = walletUpgradeFundingRequest(
    0x26,
    testPrincipal(96),
    123_456n,
  );
  return {
    label: "wallet-v306-to-v311",
    targetId: "wallet",
    initial: [
      PRODUCTION_KERNEL_V323_ARCHIVE,
      PRODUCTION_CONTACTS_V304_ARCHIVE,
      PRODUCTION_WALLET_V306_ARCHIVE,
    ],
    candidatePath: "../../../apps/wallet/wallet.v0.3.11.neutron",
    candidateVersion: 311,
    candidateSha256Environment: "NEUTRON_FINAL_WALLET_CANDIDATE_SHA256",
    withIcp: true,
    async seedAndCapture({ callApp }) {
      await callApp("wallet_set_ledgers", methods.setLedgers, [[ICP_LEDGER]]);
      await callApp("wallet_refresh_balances", methods.refreshBalances, [null]);
      const snapshotBefore = await callApp(
        "wallet_snapshot",
        methods.snapshot,
        [null],
      );
      expect(snapshotBefore).toMatchObject({
        configured: true,
        ledgers: [{ principal: ICP_LEDGER, balance: [200_000_000n] }],
      });
      const commandBefore = (await callApp(
        "wallet_funding_prepare_v1",
        methods.fundingPrepare,
        [request],
      )) as WalletUpgradePrepareResult;
      expect(commandBefore).toMatchObject({
        ok: { prepared: { command_id: walletUpgradeCommandId(request) } },
      });
      return async () => {
        expect(
          await callApp("wallet_snapshot", methods.snapshot, [null]),
        ).toEqual(snapshotBefore);
        expect(
          await callApp("wallet_funding_prepare_v1", methods.fundingPrepare, [
            replacedEndpointWalletUpgradeRequest(request, "v306"),
          ]),
        ).toEqual(commandBefore);
        for (const conflictRequest of conflictingWalletUpgradeRequests(
          request,
        )) {
          const conflict = (await callApp(
            "wallet_funding_prepare_v1",
            methods.fundingPrepare,
            [conflictRequest],
          )) as WalletUpgradePrepareResult;
          if (!("err" in conflict)) {
            throw new Error("Wallet v0.3.6 command lost its durable intent");
          }
          expect(conflict.err).toContain("conflicts with another intent");
        }
      };
    },
  };
}

async function runProductionAppUpgradeQualification(
  qualification: ProductionAppUpgradeCase,
): Promise<void> {
  const initialArchives = await Promise.all(
    qualification.initial.map(preparePinnedProductionArchive),
  );
  const initialPackages = initialArchives.map(({ prepared }) => prepared);
  const predecessor = initialPackages.find(
    ({ manifest }) => manifest.id === qualification.targetId,
  );
  if (predecessor === undefined) {
    throw new Error(`${qualification.label} predecessor is missing`);
  }

  const candidateSha256 =
    qualification.candidateSha256 ??
    (qualification.candidateSha256Environment === undefined
      ? ""
      : process.env[qualification.candidateSha256Environment] ?? "");
  if (!/^[a-f0-9]{64}$/u.test(candidateSha256)) {
    throw new Error(
      `${qualification.candidateSha256Environment ?? qualification.label} must provide a reviewed lowercase SHA-256`,
    );
  }
  const candidateArchive = new Uint8Array(
    await readFile(new URL(qualification.candidatePath, import.meta.url)),
  );
  const candidate = preparePackageInstall(candidateArchive, {
    expectedIdentity: {
      id: qualification.targetId,
      version: qualification.candidateVersion,
      sha256: candidateSha256,
    },
  });
  expect(candidate.manifest.memory).toEqual(predecessor.manifest.memory);

  const initial = await compileFreshPackages({
    packages: initialPackages,
    persistenceMode: "classical",
  });
  const state = freshPackageState(initialPackages, initial);
  const upgraded = await compilePackages({
    packages: [candidate],
    existingModules: state.existingModules,
    existingConfigs: state.existingConfigs,
    existingApps: state.apps,
    existingBrowserSurfaceOriginAppIds: state.browserSurfaceOriginAppIds,
    existingStable: state.previousStable,
    connectionProviderSupport: state.connectionProviderSupport,
    persistenceMode: "classical",
    versionPolicy: "strict-upgrade",
  });
  expect(upgraded.compatibilityDiagnostics).toEqual([]);
  expect(upgraded.managedMemoryRetirements).toEqual([]);
  expect(upgraded.migrationPlan.removedApps).toEqual([]);
  expect(upgraded.migrationPlan.destructiveMemoryRoots).toEqual([]);

  const provision = await loadProvisionHarness();
  const binary = requiredPocketIcBinary();
  expect(sha256Hex(new Uint8Array(await readFile(binary)))).toBe(
    PINNED_POCKET_IC_SHA256,
  );
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), `neutron-${qualification.label}-pocketic-`),
  );
  let server: ChildProcessWithoutNullStreams | undefined;
  let client: DirectPocketIcClient | undefined;
  let instanceId: number | undefined;

  try {
    const launched = await launchPocketIc(binary, temporaryRoot);
    server = launched.server;
    client = new provision.PocketIcRestClient(launched.controlUrl, {
      requestTimeoutMs: 120_000,
    }) as DirectPocketIcClient;
    const created = await createApplicationInstance(
      launched.controlUrl,
      path.join(temporaryRoot, "state"),
      qualification.withIcp ?? false,
    );
    instanceId = created.instanceId;
    const deployer = testPrincipal(101);
    const owner = testPrincipal(102);
    const direct = new DirectPocketIcCalls(client, instanceId);
    const canisterId = await direct.createCanister(
      deployer,
      created.defaultEffectiveCanisterId,
    );
    if (qualification.withIcp === true) {
      await fundIcp(direct, canisterId, 200_000_000n);
    }
    await direct.installInitial(canisterId, deployer, initial);
    await direct.setControllers(canisterId, deployer, [deployer, canisterId]);

    const deployerActor = provision.createDirectPocketIcKernelActor({
      controlUrl: launched.controlUrl,
      instanceId,
      canisterId: canisterId.toText(),
      caller: deployer,
      client,
    });
    await provision.seedFreshKernel({
      actor: deployerActor,
      canisterId: canisterId.toText(),
      deployment: freshDeployment(initialArchives, initial),
      concurrency: 32,
      logger: silentLogger,
    });
    const token = new Uint8Array(32).fill(0x6d);
    expect(
      await direct.kernelActivation(canisterId, deployer, {
        set: sha256(token),
      }),
    ).toEqual({ ready: null });
    expect(
      await direct.kernelActivation(canisterId, owner, { use: token }),
    ).toEqual({ authorized: null });

    const ownerActor = provision.createDirectPocketIcKernelActor({
      controlUrl: launched.controlUrl,
      instanceId,
      canisterId: canisterId.toText(),
      caller: owner,
      client,
    });
    const runtimeBefore = await ownerActor.kernel_runtime_info();
    const appBefore = requiredAppInstance(
      normalizeAppInstances(runtimeBefore.apps),
      qualification.targetId,
    );
    expect(appBefore.version).toBe(predecessor.manifest.version);
    const callApp = (
      name: string,
      method: IDL.FuncClass,
      args: unknown[],
    ) =>
      direct.actorCall(
        canisterId,
        owner,
        physicalAppMethodName(qualification.targetId, name),
        method,
        args,
      );
    const assertDurableState = await qualification.seedAndCapture({
      direct,
      canisterId,
      owner,
      callApp,
    });

    const deployed = await deployExactTransition({
      actor: ownerActor,
      canisterId,
      packages: [candidate],
      state,
      compiled: upgraded,
      expectedDeploymentId: initial.deploymentId,
    });
    const memoryRootsBefore = normalizeMemoryInventory(runtimeBefore.memories)
      .map(([memoryOwner, id, version]) => `${memoryOwner}/${id}@${version}`)
      .sort();
    expect(
      deployed.compiled.migrationPlan.upgrades
        .map((upgrade) =>
          upgrade.kind === "keep"
            ? `${upgrade.owner}/${upgrade.memoryId}@${upgrade.version}`
            : upgrade.kind,
        )
        .sort(),
    ).toEqual(memoryRootsBefore);

    const runtimeAfter = await ownerActor.kernel_runtime_info();
    const appAfter = requiredAppInstance(
      normalizeAppInstances(runtimeAfter.apps),
      qualification.targetId,
    );
    const compiledApp = requiredCompiledAppInstance(
      upgraded.appInstanceInventory,
      qualification.targetId,
    );
    expect(appAfter).toEqual({
      ...appBefore,
      version: qualification.candidateVersion,
      deployment_id: deployed.compiled.deploymentId,
      capability_plan_fingerprint: compiledApp.capability_plan_fingerprint,
      resident_frame_security: compiledApp.resident_frame_security,
    });
    expect(normalizeMemoryInventory(runtimeAfter.memories)).toEqual(
      normalizeMemoryInventory(runtimeBefore.memories),
    );
    expect(await ownerActor.kernel_install_status(null)).toEqual([]);
    await assertDurableState();
    expect(direct.externalInstallModes).toEqual(["install"]);
  } finally {
    if (client !== undefined && instanceId !== undefined) {
      await client.deleteInstance(instanceId).catch(() => undefined);
    }
    if (server !== undefined) await stopPocketIc(server);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function preparePinnedProductionArchive(
  release: PinnedProductionArchive,
): Promise<PreparedArchive> {
  const archive = new Uint8Array(
    await readFile(new URL(release.relativePath, import.meta.url)),
  );
  expect(archive.byteLength, `${release.label} bytes`).toBe(release.bytes);
  expect(sha256Hex(archive), `${release.label} SHA-256`).toBe(release.sha256);
  return {
    archive,
    prepared: preparePackageInstall(archive, {
      expectedIdentity: {
        id: release.id,
        version: release.version,
        sha256: release.sha256,
      },
    }),
  };
}

function kitchenSinkUpgradeMethods() {
  return {
    saveProfile: IDL.Func(
      [IDL.Tuple(IDL.Text, IDL.Text, IDL.Text, IDL.Bool)],
      [IDL.Text],
      [],
    ),
    readProfile: IDL.Func([IDL.Null], [IDL.Text], ["query"]),
    bumpCounter: IDL.Func([IDL.Nat], [IDL.Nat], []),
    readCounter: IDL.Func([IDL.Null], [IDL.Nat], ["query"]),
  };
}

function contactsUpgradeMethods() {
  const blob = IDL.Vec(IDL.Nat8);
  const contactKind = IDL.Variant({ person: IDL.Null, self: IDL.Null });
  const destination = IDL.Variant({
    neutron: IDL.Principal,
    internet_computer: IDL.Record({
      owner: IDL.Principal,
      subaccount: IDL.Opt(blob),
    }),
    bitcoin_mainnet: IDL.Text,
    dogecoin_mainnet: IDL.Text,
    ethereum_mainnet: IDL.Text,
    solana_mainnet: IDL.Text,
  });
  const addressInput = IDL.Record({
    id: IDL.Opt(IDL.Nat),
    address_label: IDL.Opt(IDL.Text),
    destination,
    preferred: IDL.Bool,
  });
  const address = IDL.Record({
    id: IDL.Nat,
    address_label: IDL.Opt(IDL.Text),
    destination,
    preferred: IDL.Bool,
  });
  const contact = IDL.Record({
    id: IDL.Nat,
    revision: IDL.Nat,
    kind: contactKind,
    name: IDL.Text,
    notes: IDL.Text,
    addresses: IDL.Vec(address),
    created_at: IDL.Int,
    updated_at: IDL.Int,
  });
  return {
    save: IDL.Func(
      [
        IDL.Record({
          id: IDL.Opt(IDL.Nat),
          expected_revision: IDL.Opt(IDL.Nat),
          kind: contactKind,
          name: IDL.Text,
          notes: IDL.Text,
          addresses: IDL.Vec(addressInput),
        }),
      ],
      [IDL.Reserved],
      [],
    ),
    get: IDL.Func(
      [IDL.Record({ id: IDL.Nat })],
      [IDL.Opt(contact)],
      ["query"],
    ),
    revision: IDL.Func(
      [IDL.Null],
      [IDL.Record({ revision: IDL.Nat })],
      ["query"],
    ),
  };
}

type PreparedArchive = Readonly<{
  archive: Uint8Array;
  prepared: PreparedPackageInstall;
}>;

async function prepareBrowserOriginSnapshotPackages(
  temporaryRoot: string,
): Promise<
  Readonly<{
    kernel: PreparedArchive;
    authorityV100: PreparedArchive;
    authorityV101: PreparedArchive;
    authorityV102: PreparedArchive;
    hello: PreparedArchive;
    pendingOrigin: PreparedArchive;
  }>
> {
  const kernel = await prepareWorkingTreeKernelPackage(temporaryRoot);
  const authorityV100 = preparedTestArchive(
    residentAuthorityPackageFiles(100, false),
  );
  const authorityV101 = preparedTestArchive(
    residentAuthorityPackageFiles(101, true),
  );
  const authorityV102 = preparedTestArchive(
    residentAuthorityPackageFiles(102, false),
  );
  const pendingOrigin = preparedTestArchive(pendingOriginPackageFiles());
  const helloArchive = new Uint8Array(
    await readFile(
      new URL("../../../apps/hello/hello.v0.2.1.neutron", import.meta.url),
    ),
  );
  return {
    kernel,
    authorityV100,
    authorityV101,
    authorityV102,
    pendingOrigin,
    hello: {
      archive: helloArchive,
      prepared: preparePackageInstall(helloArchive),
    },
  };
}

function pendingOriginPackageFiles(): UnpackedNeutronPackage {
  const moduleContent = encoder.encode("module { public class Init() {} }");
  const entry = sha256Hex(moduleContent);
  const files: UnpackedNeutronPackage = {
    "neutron.json": encoder.encode(
      JSON.stringify({
        format: 3,
        id: "pending_origin",
        name: "Pending origin",
        version: 100,
        entry,
        tiles: [
          {
            id: "main",
            title: "Pending origin",
            path: "index.html",
            icon: "static/icon.svg",
          },
        ],
      }),
    ),
    "web/index.html": encoder.encode(
      "<!doctype html><title>Pending origin fixture</title>",
    ),
    "web/static/icon.svg": encoder.encode(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>',
    ),
    [`mo/${entry}.mo`]: moduleContent,
  };
  addTestPackageRecord(files, false);
  return files;
}

async function prepareWorkingTreeKernelPackage(
  temporaryRoot: string,
): Promise<PreparedArchive> {
  // Keep the compiler project independent from the scripts project. These
  // computed imports exist only in this explicitly opted-in qualification.
  const scriptsSource = "../../neutron-scripts/src/";
  const [{ packageMotoko }, { parsePackageString }] = await Promise.all([
    import(scriptsSource + "mopack.ts"),
    import(scriptsSource + "walk.ts"),
  ]);
  const kernelRoot = fileURLToPath(
    new URL("../../../apps/kernel/", import.meta.url),
  );
  const temporaryKernel = path.join(temporaryRoot, "working-kernel");
  await cp(
    path.join(kernelRoot, "backend"),
    path.join(temporaryKernel, "backend"),
    { recursive: true },
  );
  await Promise.all([
    copyFile(
      path.join(kernelRoot, "neutron.json"),
      path.join(temporaryKernel, "neutron.json"),
    ),
    copyFile(
      path.join(kernelRoot, "neutron.lock.json"),
      path.join(temporaryKernel, "neutron.lock.json"),
    ),
  ]);

  const { stdout } = await execFile("mops", ["sources"], {
    cwd: kernelRoot,
    maxBuffer: 4 * 1024 * 1024,
  });
  const parsedSourcePackages = parsePackageString(stdout) as Record<
    string,
    string
  >;
  const sourcePackages = Object.fromEntries(
    Object.entries(parsedSourcePackages).map(([name, sourcePath]) => [
      name,
      path.resolve(kernelRoot, sourcePath),
    ]),
  );
  await packageMotoko({ cwd: temporaryKernel, packages: sourcePackages });

  const dist = path.join(temporaryKernel, "dist");
  const files: UnpackedNeutronPackage = {
    "neutron.json": new Uint8Array(
      await readFile(path.join(dist, "neutron.json")),
    ),
    "neutron.lock.json": new Uint8Array(
      await readFile(path.join(dist, "neutron.lock.json")),
    ),
    "connection-providers.json": new Uint8Array(
      await readFile(
        path.join(kernelRoot, "connections/provider-support.generated.json"),
      ),
    ),
    "web/index.html": encoder.encode(
      "<!doctype html><title>Kernel test</title>",
    ),
  };
  const moduleRoot = path.join(dist, "mo");
  for (const filename of (await readdir(moduleRoot)).sort()) {
    files[`mo/${filename}`] = new Uint8Array(
      await readFile(path.join(moduleRoot, filename)),
    );
  }
  addTestPackageRecord(files, true);
  return preparedTestArchive(files);
}

function residentAuthorityPackageFiles(
  version: number,
  dedicated: boolean,
): UnpackedNeutronPackage {
  const moduleContent = encoder.encode("module { public class Init() {} }");
  const entry = sha256Hex(moduleContent);
  const files: UnpackedNeutronPackage = {
    "neutron.json": encoder.encode(
      JSON.stringify({
        format: 3,
        id: "origin_authority",
        name: "Origin authority",
        version,
        entry,
        background: { path: "service.html" },
        ...(dedicated
          ? {
              capabilities: {
                dedicated_resident_origin: {
                  api: 1,
                  surface: "background",
                  mode: "credentialless_ephemeral_v1",
                },
              },
            }
          : {}),
      }),
    ),
    "web/service.html": encoder.encode(
      "<!doctype html><title>Resident authority fixture</title>",
    ),
    [`mo/${entry}.mo`]: moduleContent,
  };
  addTestPackageRecord(files, false);
  return files;
}

function addTestPackageRecord(
  files: UnpackedNeutronPackage,
  isKernel: boolean,
): void {
  const manifest = JSON.parse(decoder.decode(files["neutron.json"]!)) as {
    id: string;
    version: number;
    memory?: Record<string, unknown>;
    package_features?: string[];
  };
  if (!isKernel) {
    manifest.package_features = [NEUTRON_PACKAGE_ARCHIVE_ONLY_FEATURE];
    files["neutron.json"] = encoder.encode(JSON.stringify(manifest));
  }
  const licensePath = isKernel
    ? "legal/LICENSE.test.txt"
    : `${NEUTRON_PACKAGE_ARCHIVE_ONLY_LEGAL_PREFIX}LICENSE.test.txt`;
  const noticePath = "legal/APPLICATION-NOTICE.txt";
  const license = encoder.encode("PocketIC qualification fixture license\n");
  const notice = encoder.encode("PocketIC qualification fixture\n");
  files[licensePath] = license;
  files[noticePath] = notice;

  let source: Uint8Array | undefined;
  if (!isKernel) {
    source = msgpack.encode({
      format: 1,
      package: { id: manifest.id, version: manifest.version },
      files: [
        {
          path: "neutron.json",
          mode: 0o644,
          content: files["neutron.json"]!,
        },
      ],
    });
    files[NEUTRON_APP_SOURCE_SNAPSHOT_PATH] = source;
  }

  const lock = files["neutron.lock.json"];
  files[NEUTRON_PACKAGE_RECORD_PATH] = encoder.encode(
    JSON.stringify({
      format: 1,
      ...(!isKernel
        ? { features: [NEUTRON_PACKAGE_ARCHIVE_ONLY_FEATURE] }
        : {}),
      package: {
        id: manifest.id,
        version: manifest.version,
        manifest: embeddedTestFile("neutron.json", files["neutron.json"]!),
      },
      license: {
        id: "LicenseRef-PocketIC-Test-1.0",
        texts: [
          {
            id: "LicenseRef-PocketIC-Test-1.0",
            ...embeddedTestFile(licensePath, license),
          },
        ],
      },
      source: isKernel
        ? { kind: "status", status: "not-provided" }
        : {
            kind: "embedded",
            revision: "browser-origin-snapshot-test",
            ...embeddedTestFile(NEUTRON_APP_SOURCE_SNAPSHOT_PATH, source!),
          },
      dependencies: [],
      notices: [embeddedTestFile(noticePath, notice)],
      memory:
        lock === undefined
          ? null
          : { lock: embeddedTestFile("neutron.lock.json", lock) },
      build: isKernel
        ? { inputs: [], commands: [] }
        : {
            inputs: [embeddedTestFile("neutron.json", files["neutron.json"]!)],
            commands: [
              {
                purpose: "package",
                cwd: ".",
                argv: ["npm", "run", "package"],
              },
            ],
          },
    }),
  );
}

function embeddedTestFile(pathname: string, content: Uint8Array) {
  return {
    path: pathname,
    sha256: sha256Hex(content),
    bytes: content.byteLength,
  };
}

function preparedTestArchive(files: UnpackedNeutronPackage): PreparedArchive {
  const archive = msgpack.encode(
    Object.fromEntries(
      Object.entries(files)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([pathname, content]) => [pathname, gzipSync(content)]),
    ),
  );
  return { archive, prepared: preparePackageInstall(archive) };
}

function freshDeployment(
  packages: readonly PreparedArchive[],
  compiled: CompileResult,
): unknown {
  const transportWasm = new Uint8Array(gzipSync(compiled.wasm));
  return {
    packages: packages.map(({ prepared }) => prepared),
    packageArchives: packages.map(({ archive }) => archive),
    packageArtifacts: packages.map(({ archive, prepared }) => ({
      path: `working-tree/${prepared.manifest.id}.neutron`,
      id: prepared.manifest.id,
      version: prepared.manifest.version,
      sha256: sha256Hex(archive),
      bytes: archive.byteLength,
    })),
    compiled,
    wasmMetadata: assertSupportedCertificateVersions(compiled.wasm),
    transportWasm,
    rawWasmSha256: sha256Hex(compiled.wasm),
    transportWasmSha256: sha256Hex(transportWasm),
    candidSha256: sha256Hex(encoder.encode(compiled.candid)),
    stableSha256: sha256Hex(encoder.encode(compiled.stable)),
    chunks: chunkWasm(transportWasm),
  };
}

function freshPackageState(
  packages: readonly PreparedPackageInstall[],
  compiled: CompileResult,
): KernelPackageState {
  const installed = buildPackagesInstallAssets({
    existingApps: {},
    existingBrowserSurfaceOriginAppIds: [],
    packages: [...packages],
    candid: compiled.candid,
  });
  const kernel = packages.find(({ isKernel }) => isKernel);
  if (kernel?.connectionProviderSupport === undefined) {
    throw new Error("Working-tree Kernel has no connection-provider catalog");
  }
  return {
    registry: installed.apps,
    apps: installed.apps,
    browserSurfaceOriginAppIds: installed.browserSurfaceOriginAppIds,
    browserSurfaceOriginsSidecarPresent: true,
    existingConfigs: Object.fromEntries(
      packages.map(({ manifest }) => [manifest.id, manifest]),
    ),
    existingModules: motokoFilesFromPreparedFiles(
      packages.flatMap(({ files }) => files),
    ),
    previousStable: compiled.stable,
    connectionProviderSupport: kernel.connectionProviderSupport,
  };
}

function legacyPackageState(
  fixture: LegacyUpgradeCompileFixture,
): KernelPackageState {
  const connectionProviderSupport =
    fixture.legacyKernel.connectionProviderSupport;
  if (connectionProviderSupport === undefined) {
    throw new Error("Legacy Kernel has no connection-provider catalog");
  }
  return {
    registry: fixture.existingApps,
    apps: fixture.existingApps,
    browserSurfaceOriginAppIds: fixture.initial.browserSurfaceOriginAppIds,
    browserSurfaceOriginsSidecarPresent: supportsBrowserSurfaceOrigins(
      fixture.initial.assemblerId,
    ),
    existingConfigs: {
      kernel: fixture.legacyKernel.manifest,
      hello: fixture.hello.manifest,
    },
    existingModules: motokoFilesFromPreparedFiles([
      ...fixture.legacyKernel.files,
      ...fixture.hello.files,
    ]),
    previousStable: fixture.initial.stable,
    connectionProviderSupport,
  };
}

function advancePackageState(
  state: KernelPackageState,
  packages: readonly PreparedPackageInstall[],
  result: DeployPreparedPackagesResult,
  removedApps: readonly string[] = [],
): KernelPackageState {
  const removed = new Set(removedApps);
  const configs = Object.fromEntries(
    Object.entries(state.existingConfigs).filter(([id]) => !removed.has(id)),
  );
  for (const { manifest } of packages) configs[manifest.id] = manifest;

  const modules = new Map(
    state.existingModules.map((module) => [module.path, module]),
  );
  for (const module of motokoFilesFromPreparedFiles(
    packages.flatMap(({ files }) => files),
  )) {
    modules.set(module.path, module);
  }
  const retainedPaths = new Set(result.compiled.modulePaths);
  const existingModules = [...modules.values()].filter(({ path: modulePath }) =>
    retainedPaths.has(modulePath),
  );

  return {
    registry: result.apps,
    apps: result.apps,
    browserSurfaceOriginAppIds: result.compiled.browserSurfaceOriginAppIds,
    browserSurfaceOriginsSidecarPresent: true,
    existingConfigs: configs,
    existingModules,
    previousStable: result.compiled.stable,
    connectionProviderSupport: state.connectionProviderSupport,
  };
}

async function deployExactTransition({
  actor,
  canisterId,
  packages,
  state,
  compiled,
  expectedDeploymentId,
}: {
  actor: any;
  canisterId: Principal;
  packages: PreparedPackageInstall[];
  state: KernelPackageState;
  compiled: CompileResult;
  expectedDeploymentId: string;
}): Promise<DeployPreparedPackagesResult> {
  const deploymentBuildRecord = prepareCompleteDeploymentBuildRecord({
    targetCanisterId: canisterId.toText(),
    packages,
    state,
    compiled,
    expectedDeploymentId,
  }).record;
  return deployPreparedPackages({
    actor,
    targetCanisterId: canisterId.toText(),
    packages,
    compiled,
    existingApps: state.apps,
    existingBrowserSurfaceOriginAppIds: state.browserSurfaceOriginAppIds,
    previousModulePaths: state.existingModules.map(
      ({ path: modulePath }) => modulePath,
    ),
    deploymentBuildRecord,
    expectedDeploymentId,
    verifyTimeoutMs: 120_000,
  });
}

async function runLegacyUpgradeQualification(
  loadFixture: () => Promise<LegacyUpgradeCompileFixture>,
): Promise<void> {
  const fixture = await loadFixture();
  const candidateVersion = fixture.candidateKernel.manifest.version;
  assertLegacyUpgradeCompileInvariants(fixture);
  const provision = await loadProvisionHarness();
  const binary = requiredPocketIcBinary();
  expect(sha256Hex(new Uint8Array(await readFile(binary)))).toBe(
    PINNED_POCKET_IC_SHA256,
  );

  const temporaryRoot = await mkdtemp(
    path.join(
      tmpdir(),
      `neutron-v${fixture.identity.package.version}-upgrade-pocketic-`,
    ),
  );
  let server: ChildProcessWithoutNullStreams | undefined;
  let client: DirectPocketIcClient | undefined;
  let instanceId: number | undefined;

  try {
    const launched = await launchPocketIc(binary, temporaryRoot);
    server = launched.server;
    client = new provision.PocketIcRestClient(launched.controlUrl, {
      requestTimeoutMs: 120_000,
    }) as DirectPocketIcClient;
    const created = await createApplicationInstance(
      launched.controlUrl,
      path.join(temporaryRoot, "state"),
    );
    instanceId = created.instanceId;

    const deployer = testPrincipal(71);
    const owner = testPrincipal(72);
    const backup = testPrincipal(73);
    const outsider = testPrincipal(74);
    const direct = new DirectPocketIcCalls(client, instanceId);
    const canisterId = await direct.createCanister(
      deployer,
      created.defaultEffectiveCanisterId,
    );
    await direct.installInitial(canisterId, deployer, fixture.initial);
    await direct.setControllers(canisterId, deployer, [deployer, canisterId]);

    const actor = provision.createDirectPocketIcKernelActor({
      controlUrl: launched.controlUrl,
      instanceId,
      canisterId: canisterId.toText(),
      caller: deployer,
      client,
    });
    const deployment = initialDeployment(fixture, fixture.initial);
    await provision.seedFreshKernel({
      actor,
      canisterId: canisterId.toText(),
      deployment,
      concurrency: 32,
      logger: silentLogger,
    });

    const initialRuntime = await actor.kernel_runtime_info();
    const initialAppInstances = normalizeAppInstances(initialRuntime.apps);
    expect(normalizeMemoryInventory(initialRuntime.memories)).toEqual([
      ["hello", "hello", 1],
      ["kernel", "kernel", 3],
      ["kernel", "kernel_activation", 1],
    ]);
    expect(
      initialRuntime.apps
        .map(({ scope }: { scope: { app_id: string } }) => scope.app_id)
        .sort(),
    ).toEqual(["hello", "kernel"]);
    const initialHelloInstance = requiredAppInstance(
      initialAppInstances,
      "hello",
    );
    const initialKernelInstance = requiredAppInstance(
      initialAppInstances,
      "kernel",
    );
    const compiledInitialHello = requiredCompiledAppInstance(
      fixture.initial.appInstanceInventory,
      "hello",
    );
    expect(initialHelloInstance.deployment_id).toBe(
      fixture.initial.deploymentId,
    );
    expect(BigInt(initialHelloInstance.scope.installation_uid)).toBeGreaterThan(
      0n,
    );
    expect(initialHelloInstance.capability_plan_fingerprint).toBe(
      compiledInitialHello.capability_plan_fingerprint,
    );
    expect(initialHelloInstance.resident_frame_security).toBe(
      compiledInitialHello.resident_frame_security,
    );
    expect(initialHelloInstance.browser_origin_nonce).toMatch(
      /^[a-f0-9]{32}$/u,
    );
    expect(initialHelloInstance.browser_origin_authority_epoch).toBe("1");

    const token = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
    const tokenHash = sha256(token);
    expect(
      await direct.kernelActivation(canisterId, deployer, {
        set: tokenHash,
      }),
    ).toEqual({ ready: null });
    expect(await direct.isAuthorized(canisterId, deployer)).toBe(false);
    expect(
      await direct.kernelActivation(canisterId, owner, { use: token }),
    ).toEqual({ authorized: null });
    expect(await direct.isAuthorized(canisterId, owner)).toBe(true);

    await direct.addController(canisterId, owner, owner);
    await direct.recoverAuthorization(canisterId, owner, backup);
    expect(await direct.isAuthorized(canisterId, backup)).toBe(true);
    expect(await direct.controllers(canisterId, owner)).toEqual(
      canonicalPrincipals([deployer, canisterId, owner]),
    );

    const durableHelloValue = `durable-v${fixture.identity.package.version}`;
    expect(await direct.helloWorld(canisterId, owner, durableHelloValue)).toBe(
      "Neutron",
    );
    const initialProvenance = await direct.readJsonAsset(
      canisterId,
      "/system/install-provenance.json",
    );
    expect(initialProvenance).toMatchObject({
      format: 1,
      apps: {
        hello: { kind: "provisioned" },
        kernel: { kind: "provisioned" },
      },
    });
    const initialRegistry = jsonObject(
      await direct.readJsonAsset(canisterId, "/system/apps.json"),
      "initial app registry",
    );

    expect(initialRegistry).toEqual(fixture.existingApps);
    const nextProvenance = {
      format: 1,
      apps: {
        ...(initialProvenance as { apps: Record<string, unknown> }).apps,
        kernel: {
          kind: "manual",
          acquisition: "file",
          package_digest: sha256Hex(fixture.candidateArchive),
        },
      },
    };
    const stagedAssets: InstallStagedAsset[] = [
      {
        target: "/system/install-provenance.json",
        content: encoder.encode(JSON.stringify(nextProvenance)),
        contentType: "application/json",
      },
    ];
    const ownerActor = provision.createDirectPocketIcKernelActor({
      controlUrl: launched.controlUrl,
      instanceId,
      canisterId: canisterId.toText(),
      caller: owner,
      client,
    });
    const installDispatch: ObservedInstallDispatch = { chunks: [] };
    const observedOwnerActor = observeInstallDispatch(
      ownerActor,
      installDispatch,
    );
    const initialState = legacyPackageState(fixture);
    const deploymentBuildRecord = prepareCompleteDeploymentBuildRecord({
      targetCanisterId: canisterId.toText(),
      packages: [fixture.candidateKernel],
      state: initialState,
      compiled: fixture.upgraded,
      expectedDeploymentId: fixture.initial.deploymentId,
    }).record;
    const steps: string[] = [];
    const deployed = await deployPreparedPackages({
      actor: observedOwnerActor,
      targetCanisterId: canisterId.toText(),
      packages: [fixture.candidateKernel],
      compiled: fixture.upgraded,
      existingApps: initialState.apps,
      existingBrowserSurfaceOriginAppIds:
        initialState.browserSurfaceOriginAppIds,
      previousModulePaths: initialState.existingModules.map(
        ({ path: modulePath }) => modulePath,
      ),
      expectedDeploymentId: fixture.initial.deploymentId,
      stagedAssets,
      deploymentBuildRecord,
      verifyTimeoutMs: 120_000,
      onStep: (step) => steps.push(step),
    });
    expect(steps).toEqual([
      "upload-modules",
      "stage-assets",
      "record-journal",
      "install-code",
      "verify-runtime",
      "commit-assets",
      "complete",
    ]);
    expect(await ownerActor.kernel_install_status(null)).toEqual([]);
    const expectedTransport = prepareDeterministicWasmTransport(
      fixture.upgraded.wasm,
    ).transportWasm;
    expect(observedInstallTransport(installDispatch)).toEqual(
      expectedTransport,
    );

    const upgradedRuntime = await ownerActor.kernel_runtime_info();
    expect(upgradedRuntime.deployment_id).toBe(fixture.upgraded.deploymentId);
    expect(normalizeMemoryInventory(upgradedRuntime.memories)).toEqual(
      normalizeMemoryInventory(initialRuntime.memories),
    );
    expect(
      upgradedRuntime.apps.map(
        ({
          scope,
          version,
        }: {
          scope: { app_id: string };
          version: number | bigint;
        }) => [scope.app_id, Number(version)],
      ),
    ).toEqual([
      ["hello", 201],
      ["kernel", candidateVersion],
    ]);
    const upgradedAppInstances = normalizeAppInstances(upgradedRuntime.apps);
    expect(requiredAppInstance(upgradedAppInstances, "hello")).toEqual({
      ...initialHelloInstance,
      deployment_id: fixture.upgraded.deploymentId,
    });
    const compiledKernelInstance = requiredCompiledAppInstance(
      fixture.upgraded.appInstanceInventory,
      "kernel",
    );
    expect(requiredAppInstance(upgradedAppInstances, "kernel")).toEqual({
      ...initialKernelInstance,
      version: candidateVersion,
      deployment_id: fixture.upgraded.deploymentId,
      capability_plan_fingerprint:
        compiledKernelInstance.capability_plan_fingerprint,
      resident_frame_security: compiledKernelInstance.resident_frame_security,
    });

    // Hello's v1 managed-memory value is the semantic state assertion: the
    // first post-upgrade call must return the value written by the predecessor.
    expect(await direct.helloWorld(canisterId, owner, "after-upgrade")).toBe(
      durableHelloValue,
    );
    expect(await direct.isAuthorized(canisterId, owner)).toBe(true);
    expect(await direct.isAuthorized(canisterId, backup)).toBe(true);
    expect(
      await direct.kernelActivation(canisterId, owner, { use: token }),
    ).toEqual({ already_authorized: null });
    expect(await direct.isAuthorized(canisterId, outsider)).toBe(false);
    expect(
      await direct.kernelActivation(canisterId, outsider, { use: token }),
    ).toEqual({ already_activated: null });
    expect(await direct.isAuthorized(canisterId, outsider)).toBe(false);
    expect(await direct.controllers(canisterId, owner)).toEqual(
      canonicalPrincipals([deployer, canisterId, owner]),
    );

    const finalProvenance = await direct.readJsonAsset(
      canisterId,
      "/system/install-provenance.json",
    );
    expect(finalProvenance).toEqual(nextProvenance);
    const finalRegistry = jsonObject(
      await direct.readJsonAsset(canisterId, "/system/apps.json"),
      "upgraded app registry",
    );
    expect(finalRegistry).toEqual(deployed.apps);
    expect(finalRegistry.hello).toEqual(initialRegistry.hello);
    expect(
      jsonObject(finalRegistry.kernel, "upgraded Kernel registry entry"),
    ).toMatchObject({ version: candidateVersion });
    expect(
      await ownerActor.kernel_static_query({ list: { prefix: "/pkg/legal/" } }),
    ).toContain("/pkg/legal/package-record.v1.json");
    expect(
      await direct.readJsonAsset(
        canisterId,
        "/pkg/legal/package-record.v1.json",
      ),
    ).toMatchObject({
      format: 1,
      package: { id: "kernel", version: candidateVersion },
    });

    const installedModuleContents = new Map(
      motokoFilesFromPreparedFiles([
        ...fixture.candidateKernel.files,
        ...fixture.hello.files,
      ]).map(({ path: modulePath, content }) => [`/mo/${modulePath}`, content]),
    );
    const recoveredState = await readKernelPackageState({
      listStatic: (prefix) =>
        ownerActor.kernel_static_query({ list: { prefix } }),
      fetchText: (assetPath) => {
        if (assetPath.startsWith("/mo/")) {
          const content = installedModuleContents.get(assetPath);
          if (content === undefined) {
            throw new Error(
              `Installed module ${assetPath} is absent from the candidate packages`,
            );
          }
          return Promise.resolve(content);
        }
        return direct.readTextAsset(canisterId, assetPath);
      },
      fetchJson: (assetPath, fallback) =>
        direct.readJsonAssetOr(canisterId, assetPath, fallback),
    });
    expect(finalRegistry).toEqual(recoveredState.apps);
    expect(
      recoveredState.existingModules.map(({ path: modulePath }) => modulePath),
    ).toEqual(fixture.upgraded.modulePaths);
    expect(recoveredState.previousStable).toBe(fixture.upgraded.stable);
    expect(() =>
      assertKernelPackageStateMatchesRuntime(recoveredState, upgradedRuntime),
    ).not.toThrow();

    const unchangedCompile = await compilePackages({
      packages: [],
      existingModules: recoveredState.existingModules,
      existingConfigs: recoveredState.existingConfigs,
      existingApps: recoveredState.apps,
      existingBrowserSurfaceOriginAppIds:
        recoveredState.browserSurfaceOriginAppIds,
      existingStable: recoveredState.previousStable,
      connectionProviderSupport: recoveredState.connectionProviderSupport,
      persistenceMode: fixture.release.persistenceMode,
    });
    expect(unchangedCompile.compatibilityDiagnostics).toEqual([]);
    expect(unchangedCompile.migrationPlan).toEqual(
      fixture.upgraded.migrationPlan,
    );
    expect(unchangedCompile.managedMemoryRetirements).toEqual([]);
    expect(unchangedCompile.appInstanceInventory).toEqual(
      fixture.upgraded.appInstanceInventory,
    );
    expect(unchangedCompile.managedMemoryInventory).toEqual(
      fixture.upgraded.managedMemoryInventory,
    );
    expect(unchangedCompile.previousManagedMemoryInventory).toEqual(
      unchangedCompile.managedMemoryInventory,
    );
    expect(unchangedCompile.deploymentId).toBe(fixture.upgraded.deploymentId);
    expect(unchangedCompile.compilerId).toBe(fixture.upgraded.compilerId);
    expect(unchangedCompile.deploymentNonce).toBeNull();
    expect(unchangedCompile.modulePaths).toEqual(fixture.upgraded.modulePaths);
    expect(unchangedCompile.candid).toBe(fixture.upgraded.candid);
    expect(unchangedCompile.stable).toBe(fixture.upgraded.stable);
    expect(unchangedCompile.wasm).toEqual(fixture.upgraded.wasm);
    expect(
      Buffer.from(await direct.moduleHash(canisterId, owner)).toString("hex"),
    ).toBe(sha256Hex(expectedTransport));

    // The harness makes exactly one external management installation: the
    // initial install. The second transition was dispatched by the running
    // Kernel's checked journal with its released persistence lineage.
    expect(direct.externalInstallModes).toEqual(["install"]);
  } finally {
    if (client !== undefined && instanceId !== undefined) {
      await client.deleteInstance(instanceId).catch(() => undefined);
    }
    if (server !== undefined) await stopPocketIc(server);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

const silentLogger = { log() {} };

async function loadProvisionHarness(): Promise<{
  PocketIcRestClient: new (
    controlUrl: string,
    options: { requestTimeoutMs: number },
  ) => DirectPocketIcClient;
  createDirectPocketIcKernelActor: (input: Record<string, unknown>) => any;
  seedFreshKernel: (input: Record<string, unknown>) => Promise<void>;
}> {
  // Keep this release runner in the compiler test project without making its
  // production package depend on the provisioner. The computed specifiers are
  // resolved only by this explicitly invoked test process.
  const provisionSource = "../../neutron-provision/src/";
  const [rest, kernel, provision] = await Promise.all([
    import(provisionSource + "pocketic_rest.ts"),
    import(provisionSource + "kernel.ts"),
    import(provisionSource + "provision.ts"),
  ]);
  return {
    PocketIcRestClient: rest.PocketIcRestClient,
    createDirectPocketIcKernelActor: kernel.createDirectPocketIcKernelActor,
    seedFreshKernel: provision.seedFreshKernel,
  };
}

class DirectPocketIcCalls {
  readonly externalInstallModes: string[] = [];
  readonly #managementMethods: Map<string, IDL.FuncClass>;

  constructor(
    readonly client: DirectPocketIcClient,
    readonly instanceId: number,
  ) {
    this.#managementMethods = new Map(testManagementIdl()._fields);
  }

  async createCanister(
    caller: Principal,
    effectiveCanisterId: string,
  ): Promise<Principal> {
    const result = (await this.managementCall(
      "provisional_create_canister_with_cycles",
      [
        {
          amount: [100_000_000_000_000n],
          settings: [emptySettings([caller])],
          specified_id: [],
          sender_canister_version: [],
        },
      ],
      caller,
      { CanisterId: effectiveCanisterId },
    )) as { canister_id: Principal };
    return result.canister_id;
  }

  async setControllers(
    canisterId: Principal,
    caller: Principal,
    controllers: Principal[],
  ): Promise<void> {
    await this.managementCall(
      "update_settings",
      [
        {
          canister_id: canisterId,
          settings: emptySettings(controllers),
          sender_canister_version: [],
        },
      ],
      caller,
      effectiveCanister(canisterId),
    );
  }

  async takeSnapshot(
    canisterId: Principal,
    caller: Principal,
  ): Promise<{
    id: Uint8Array;
    taken_at_timestamp: bigint;
    total_size: bigint;
  }> {
    await this.managementCall(
      "stop_canister",
      [{ canister_id: canisterId }],
      caller,
      effectiveCanister(canisterId),
    );
    try {
      return (await this.managementCall(
        "take_canister_snapshot",
        [
          {
            canister_id: canisterId,
            replace_snapshot: [],
            sender_canister_version: [],
            uninstall_code: [],
          },
        ],
        caller,
        effectiveCanister(canisterId),
      )) as {
        id: Uint8Array;
        taken_at_timestamp: bigint;
        total_size: bigint;
      };
    } finally {
      await this.managementCall(
        "start_canister",
        [{ canister_id: canisterId }],
        caller,
        effectiveCanister(canisterId),
      );
    }
  }

  async loadSnapshot(
    canisterId: Principal,
    caller: Principal,
    snapshotId: Uint8Array,
  ): Promise<void> {
    await this.managementCall(
      "stop_canister",
      [{ canister_id: canisterId }],
      caller,
      effectiveCanister(canisterId),
    );
    try {
      await this.managementCall(
        "load_canister_snapshot",
        [
          {
            canister_id: canisterId,
            snapshot_id: snapshotId,
            sender_canister_version: [],
          },
        ],
        caller,
        effectiveCanister(canisterId),
      );
    } finally {
      await this.managementCall(
        "start_canister",
        [{ canister_id: canisterId }],
        caller,
        effectiveCanister(canisterId),
      );
    }
  }

  async moduleHash(
    canisterId: Principal,
    caller: Principal,
  ): Promise<Uint8Array> {
    const status = (await this.managementCall(
      "canister_status",
      [{ canister_id: canisterId }],
      caller,
      effectiveCanister(canisterId),
    )) as { module_hash: [] | [Uint8Array] };
    const moduleHash = status.module_hash[0];
    if (!(moduleHash instanceof Uint8Array) || moduleHash.byteLength !== 32) {
      throw new Error("Management canister_status has no 32-byte module hash");
    }
    return moduleHash;
  }

  async installInitial(
    canisterId: Principal,
    caller: Principal,
    compiled: CompileResult,
  ): Promise<void> {
    const transport = new Uint8Array(gzipSync(compiled.wasm));
    const chunks = chunkWasm(transport);
    await this.managementCall(
      "clear_chunk_store",
      [{ canister_id: canisterId }],
      caller,
      effectiveCanister(canisterId),
    );
    for (const chunk of chunks) {
      const uploaded = (await this.managementCall(
        "upload_chunk",
        [{ canister_id: canisterId, chunk: chunk.bytes }],
        caller,
        effectiveCanister(canisterId),
      )) as { hash: Uint8Array };
      expect(Buffer.from(uploaded.hash).toString("hex")).toBe(chunk.hashHex);
    }
    this.externalInstallModes.push("install");
    await this.managementCall(
      "install_chunked_code",
      [
        {
          mode: { install: null },
          target_canister: canisterId,
          store_canister: [],
          chunk_hashes_list: chunks.map(({ hash }) => ({ hash })),
          wasm_module_hash: sha256(transport),
          arg: IDL.encode([], []),
          sender_canister_version: [],
        },
      ],
      caller,
      effectiveCanister(canisterId),
    );
    await this.managementCall(
      "clear_chunk_store",
      [{ canister_id: canisterId }],
      caller,
      effectiveCanister(canisterId),
    );
  }

  kernelActivation(
    canisterId: Principal,
    caller: Principal,
    request: { set: Uint8Array } | { use: Uint8Array },
  ): Promise<unknown> {
    const activation = IDL.Variant({
      set: IDL.Vec(IDL.Nat8),
      use: IDL.Vec(IDL.Nat8),
    });
    const result = IDL.Variant({
      ready: IDL.Null,
      authorized: IDL.Null,
      already_authorized: IDL.Null,
      already_set: IDL.Null,
      already_activated: IDL.Null,
      invalid: IDL.Null,
    });
    return this.actorCall(
      canisterId,
      caller,
      "kernel_activation",
      IDL.Func([activation], [result], []),
      [request],
    );
  }

  async isAuthorized(
    canisterId: Principal,
    caller: Principal,
  ): Promise<boolean> {
    return (await this.actorCall(
      canisterId,
      caller,
      "kernel_check_authorized",
      IDL.Func([IDL.Null], [IDL.Bool], ["query"]),
      [null],
    )) as boolean;
  }

  async addController(
    canisterId: Principal,
    caller: Principal,
    controller: Principal,
  ): Promise<void> {
    await this.actorCall(
      canisterId,
      caller,
      "kernel_controller_add",
      IDL.Func([IDL.Principal], [accessSnapshotType()], []),
      [controller],
    );
  }

  async recoverAuthorization(
    canisterId: Principal,
    caller: Principal,
    principal: Principal,
  ): Promise<void> {
    await this.actorCall(
      canisterId,
      caller,
      "kernel_authorized_recover",
      IDL.Func([IDL.Principal], [], []),
      [principal],
    );
  }

  async controllers(
    canisterId: Principal,
    caller: Principal,
  ): Promise<string[]> {
    const snapshot = (await this.actorCall(
      canisterId,
      caller,
      "kernel_access_snapshot",
      IDL.Func([IDL.Null], [accessSnapshotType()], []),
      [null],
    )) as { controllers: Principal[] };
    return canonicalPrincipals(snapshot.controllers);
  }

  async helloWorld(
    canisterId: Principal,
    caller: Principal,
    value: string,
  ): Promise<string> {
    return (await this.actorCall(
      canisterId,
      caller,
      physicalAppMethodName("hello", "hello_world"),
      IDL.Func([IDL.Text], [IDL.Text], []),
      [value],
    )) as string;
  }

  async readJsonAsset(canisterId: Principal, path: string): Promise<unknown> {
    const response = await this.readAsset(canisterId, path);
    expect(response.statusCode).toBe(200);
    return JSON.parse(decoder.decode(response.body));
  }

  async readJsonAssetOr<T>(
    canisterId: Principal,
    path: string,
    fallback: T,
  ): Promise<T> {
    const response = await this.readAsset(canisterId, path);
    if (response.statusCode === 404) return fallback;
    expect(response.statusCode).toBe(200);
    return JSON.parse(decoder.decode(response.body)) as T;
  }

  async readTextAsset(canisterId: Principal, path: string): Promise<string> {
    const response = await this.readAsset(canisterId, path);
    expect(response.statusCode).toBe(200);
    return decoder.decode(response.body);
  }

  private async readAsset(
    canisterId: Principal,
    path: string,
  ): Promise<{ statusCode: number; body: Uint8Array }> {
    const response = (await this.actorCall(
      canisterId,
      Principal.anonymous(),
      "http_request",
      httpRequestMethod(),
      [
        {
          method: "GET",
          url: path,
          headers: [["Host", `${canisterId.toText()}.localhost:8000`]],
          body: new Uint8Array(),
          certificate_version: [2],
        },
      ],
    )) as {
      body: Uint8Array;
      headers: Array<[string, string]>;
      streaming_strategy: unknown[];
      status_code: number;
    };
    expect(response.streaming_strategy).toEqual([]);
    const encoding = response.headers.find(
      ([name]) => name.toLowerCase() === "content-encoding",
    )?.[1];
    const body =
      encoding === "gzip"
        ? new Uint8Array(gunzipSync(response.body))
        : response.body;
    return { statusCode: response.status_code, body };
  }

  private async managementCall(
    name: string,
    args: unknown[],
    caller: Principal,
    effectivePrincipal: { CanisterId: string },
  ): Promise<unknown> {
    const method = this.#managementMethods.get(name);
    if (method === undefined)
      throw new Error(`Missing management method ${name}`);
    return this.call(
      Principal.fromText("aaaaa-aa"),
      caller,
      name,
      method,
      args,
      effectivePrincipal,
    );
  }

  actorCall(
    canisterId: Principal,
    caller: Principal,
    name: string,
    method: IDL.FuncClass,
    args: unknown[],
  ): Promise<unknown> {
    return this.call(canisterId, caller, name, method, args);
  }

  async submitActorCall(
    canisterId: Principal,
    caller: Principal,
    name: string,
    method: IDL.FuncClass,
    args: unknown[],
  ): Promise<{ message: unknown; method: IDL.FuncClass }> {
    if (method.annotations.includes("query")) {
      throw new Error("Cannot submit a query as ingress");
    }
    const message = await this.client.submitIngressMessage(this.instanceId, {
      canisterId,
      sender: caller,
      method: name,
      payload: new Uint8Array(IDL.encode(method.argTypes, args)),
    });
    return { message, method };
  }

  async awaitActorCall({
    message,
    method,
  }: {
    message: unknown;
    method: IDL.FuncClass;
  }): Promise<unknown> {
    const response = await this.client.awaitIngressMessage(
      this.instanceId,
      message,
    );
    const values = IDL.decode(method.retTypes, response);
    return values.length === 0 ? undefined : values[0];
  }

  private async call(
    canisterId: Principal,
    caller: Principal,
    name: string,
    method: IDL.FuncClass,
    args: unknown[],
    effectivePrincipal?: { CanisterId: string },
  ): Promise<unknown> {
    const payload = new Uint8Array(IDL.encode(method.argTypes, args));
    const request = {
      canisterId,
      sender: caller,
      method: name,
      payload,
      ...(effectivePrincipal ? { effectivePrincipal } : {}),
    };
    const response = method.annotations.includes("query")
      ? await this.client.queryCanister(this.instanceId, request)
      : await this.client.awaitIngressMessage(
          this.instanceId,
          await this.client.submitIngressMessage(this.instanceId, request),
        );
    const values = IDL.decode(method.retTypes, response);
    return values.length === 0 ? undefined : values[0];
  }
}

function initialDeployment(
  fixture: LegacyUpgradeCompileFixture,
  compiled: CompileResult,
): unknown {
  const transportWasm = new Uint8Array(gzipSync(compiled.wasm));
  return {
    packages: [fixture.legacyKernel, fixture.hello],
    packageArchives: [fixture.legacyArchive, fixture.helloArchive],
    packageArtifacts: [
      {
        path: `test-fixture/${fixture.release.archive.slice(2)}`,
        id: "kernel",
        version: fixture.identity.package.version,
        sha256: sha256Hex(fixture.legacyArchive),
        bytes: fixture.legacyArchive.byteLength,
      },
      {
        path: "test-fixture/hello.v0.2.1.neutron",
        id: "hello",
        version: 201,
        sha256: sha256Hex(fixture.helloArchive),
        bytes: fixture.helloArchive.byteLength,
      },
    ],
    compiled,
    wasmMetadata: assertSupportedCertificateVersions(compiled.wasm),
    transportWasm,
    rawWasmSha256: sha256Hex(compiled.wasm),
    transportWasmSha256: sha256Hex(transportWasm),
    candidSha256: sha256Hex(encoder.encode(compiled.candid)),
    stableSha256: sha256Hex(encoder.encode(compiled.stable)),
    chunks: chunkWasm(transportWasm),
  };
}

function emptySettings(controllers: Principal[]) {
  return {
    controllers: [controllers],
    compute_allocation: [],
    memory_allocation: [],
    freezing_threshold: [],
    reserved_cycles_limit: [],
    log_visibility: [],
    wasm_memory_limit: [],
    wasm_memory_threshold: [],
    environment_variables: [],
    snapshot_visibility: [],
    minimum_incoming_canister_call_cycles: [],
  };
}

function testManagementIdl(): IDL.ServiceClass {
  const settings = IDL.Record({
    controllers: IDL.Opt(IDL.Vec(IDL.Principal)),
    compute_allocation: IDL.Opt(IDL.Nat),
    memory_allocation: IDL.Opt(IDL.Nat),
    freezing_threshold: IDL.Opt(IDL.Nat),
    reserved_cycles_limit: IDL.Opt(IDL.Nat),
    log_visibility: IDL.Opt(IDL.Empty),
    wasm_memory_limit: IDL.Opt(IDL.Nat),
    wasm_memory_threshold: IDL.Opt(IDL.Nat),
    environment_variables: IDL.Opt(
      IDL.Vec(IDL.Record({ name: IDL.Text, value: IDL.Text })),
    ),
    snapshot_visibility: IDL.Opt(IDL.Empty),
    minimum_incoming_canister_call_cycles: IDL.Opt(IDL.Nat),
  });
  const chunkHash = IDL.Record({ hash: IDL.Vec(IDL.Nat8) });
  const canister = IDL.Record({ canister_id: IDL.Principal });
  const snapshot = IDL.Record({
    id: IDL.Vec(IDL.Nat8),
    taken_at_timestamp: IDL.Nat64,
    total_size: IDL.Nat64,
  });
  return IDL.Service({
    provisional_create_canister_with_cycles: IDL.Func(
      [
        IDL.Record({
          amount: IDL.Opt(IDL.Nat),
          settings: IDL.Opt(settings),
          specified_id: IDL.Opt(IDL.Principal),
          sender_canister_version: IDL.Opt(IDL.Nat64),
        }),
      ],
      [IDL.Record({ canister_id: IDL.Principal })],
      [],
    ),
    update_settings: IDL.Func(
      [
        IDL.Record({
          canister_id: IDL.Principal,
          settings,
          sender_canister_version: IDL.Opt(IDL.Nat64),
        }),
      ],
      [],
      [],
    ),
    canister_status: IDL.Func(
      [IDL.Record({ canister_id: IDL.Principal })],
      [IDL.Record({ module_hash: IDL.Opt(IDL.Vec(IDL.Nat8)) })],
      [],
    ),
    stop_canister: IDL.Func([canister], [], []),
    start_canister: IDL.Func([canister], [], []),
    take_canister_snapshot: IDL.Func(
      [
        IDL.Record({
          canister_id: IDL.Principal,
          replace_snapshot: IDL.Opt(IDL.Vec(IDL.Nat8)),
          sender_canister_version: IDL.Opt(IDL.Nat64),
          uninstall_code: IDL.Opt(IDL.Bool),
        }),
      ],
      [snapshot],
      [],
    ),
    load_canister_snapshot: IDL.Func(
      [
        IDL.Record({
          canister_id: IDL.Principal,
          snapshot_id: IDL.Vec(IDL.Nat8),
          sender_canister_version: IDL.Opt(IDL.Nat64),
        }),
      ],
      [],
      [],
    ),
    clear_chunk_store: IDL.Func(
      [IDL.Record({ canister_id: IDL.Principal })],
      [],
      [],
    ),
    upload_chunk: IDL.Func(
      [IDL.Record({ canister_id: IDL.Principal, chunk: IDL.Vec(IDL.Nat8) })],
      [chunkHash],
      [],
    ),
    install_chunked_code: IDL.Func(
      [
        IDL.Record({
          mode: IDL.Variant({
            install: IDL.Null,
            reinstall: IDL.Null,
            upgrade: IDL.Opt(
              IDL.Record({
                skip_pre_upgrade: IDL.Opt(IDL.Bool),
                wasm_memory_persistence: IDL.Opt(
                  IDL.Variant({ keep: IDL.Null, replace: IDL.Null }),
                ),
              }),
            ),
          }),
          target_canister: IDL.Principal,
          store_canister: IDL.Opt(IDL.Principal),
          chunk_hashes_list: IDL.Vec(chunkHash),
          wasm_module_hash: IDL.Vec(IDL.Nat8),
          arg: IDL.Vec(IDL.Nat8),
          sender_canister_version: IDL.Opt(IDL.Nat64),
        }),
      ],
      [],
      [],
    ),
  });
}

function accessSnapshotType() {
  return IDL.Record({
    snapshot_version: IDL.Nat,
    authorized_principals: IDL.Vec(IDL.Principal),
    controllers: IDL.Vec(IDL.Principal),
    self_principal: IDL.Principal,
    controller_limit: IDL.Nat,
  });
}

function httpRequestMethod(): IDL.FuncClass {
  const header = IDL.Tuple(IDL.Text, IDL.Text);
  const token = IDL.Record({
    key: IDL.Text,
    sha256: IDL.Opt(IDL.Vec(IDL.Nat8)),
    index: IDL.Nat,
    content_encoding: IDL.Text,
  });
  const callback = IDL.Func(
    [token],
    [IDL.Record({ token: IDL.Opt(token), body: IDL.Vec(IDL.Nat8) })],
    ["query"],
  );
  const response = IDL.Record({
    body: IDL.Vec(IDL.Nat8),
    headers: IDL.Vec(header),
    streaming_strategy: IDL.Opt(
      IDL.Variant({
        Callback: IDL.Record({ token, callback }),
      }),
    ),
    status_code: IDL.Nat16,
    upgrade: IDL.Opt(IDL.Bool),
  });
  const request = IDL.Record({
    method: IDL.Text,
    url: IDL.Text,
    headers: IDL.Vec(header),
    body: IDL.Vec(IDL.Nat8),
    certificate_version: IDL.Opt(IDL.Nat16),
  });
  return IDL.Func([request], [response], ["query"]);
}

function normalizeMemoryInventory(
  memories: Array<{ owner: string; id: string; version: number | bigint }>,
): Array<[string, string, number]> {
  return memories.map(({ owner, id, version }) => [owner, id, Number(version)]);
}

type AppInstanceSnapshot = Readonly<{
  scope: Readonly<{ app_id: string; installation_uid: string }>;
  version: number;
  deployment_id: string;
  capability_plan_fingerprint: string;
  browser_origin_nonce: string;
  browser_origin_authority_epoch: string;
  resident_frame_security: string;
}>;

function normalizeAppInstances(
  instances: AppInstance[],
): AppInstanceSnapshot[] {
  return instances
    .map((instance) => {
      const securityTags = Object.keys(instance.resident_frame_security);
      if (securityTags.length !== 1) {
        throw new Error("Runtime app instance has invalid frame security");
      }
      return {
        scope: {
          app_id: instance.scope.app_id,
          installation_uid: BigInt(instance.scope.installation_uid).toString(),
        },
        version: Number(instance.version),
        deployment_id: instance.deployment_id,
        capability_plan_fingerprint: instance.capability_plan_fingerprint,
        browser_origin_nonce: instance.browser_origin_nonce,
        browser_origin_authority_epoch: BigInt(
          instance.browser_origin_authority_epoch,
        ).toString(),
        resident_frame_security: securityTags[0]!,
      };
    })
    .sort((left, right) =>
      left.scope.app_id < right.scope.app_id
        ? -1
        : left.scope.app_id > right.scope.app_id
          ? 1
          : 0,
    );
}

function requiredAppInstance(
  instances: readonly AppInstanceSnapshot[],
  appId: string,
): AppInstanceSnapshot {
  const instance = instances.find(({ scope }) => scope.app_id === appId);
  if (instance === undefined) {
    throw new Error(`Runtime app instance ${appId} is missing`);
  }
  return instance;
}

function requiredCompiledAppInstance(
  instances: readonly Readonly<{
    app_id: string;
    capability_plan_fingerprint: string;
    resident_frame_security: string;
  }>[],
  appId: string,
): Readonly<{
  app_id: string;
  capability_plan_fingerprint: string;
  resident_frame_security: string;
}> {
  const instance = instances.find(({ app_id }) => app_id === appId);
  if (instance === undefined) {
    throw new Error(`Compiled app instance ${appId} is missing`);
  }
  return instance;
}

function jsonObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is not a JSON object`);
  }
  return value as Record<string, unknown>;
}

function canonicalPrincipals(principals: Principal[]): string[] {
  return principals
    .map((principal) => principal.toText())
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function effectiveCanister(canisterId: Principal): { CanisterId: string } {
  return {
    CanisterId: Buffer.from(canisterId.toUint8Array()).toString("base64"),
  };
}

function testPrincipal(seedByte: number): Principal {
  return Principal.selfAuthenticating(new Uint8Array(32).fill(seedByte));
}

function chunkWasm(wasm: Uint8Array): Array<{
  bytes: Uint8Array;
  hash: Uint8Array;
  hashHex: string;
}> {
  const chunks = [];
  for (let start = 0; start < wasm.byteLength; start += 1024 * 1024) {
    const bytes = wasm.slice(
      start,
      Math.min(wasm.byteLength, start + 1024 * 1024),
    );
    const hash = sha256(bytes);
    chunks.push({ bytes, hash, hashHex: Buffer.from(hash).toString("hex") });
  }
  return chunks;
}

function sha256(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function requiredPocketIcBinary(): string {
  const value = process.env.NEUTRON_POCKETIC_BIN;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      "NEUTRON_POCKETIC_BIN must name the pinned PocketIC 14.0.0 executable",
    );
  }
  return path.resolve(value);
}

async function launchPocketIc(
  binary: string,
  temporaryRoot: string,
): Promise<{
  server: ChildProcessWithoutNullStreams;
  controlUrl: string;
}> {
  const metadata = await stat(binary);
  if (!metadata.isFile()) throw new Error("PocketIC binary is not a file");
  const portFile = path.join(temporaryRoot, "control.port");
  const server = spawn(
    binary,
    ["--ttl", "120", "--port-file", portFile, "--log-levels", "error"],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let stderr = "";
  server.stderr.on("data", (chunk) => {
    stderr = (stderr + String(chunk)).slice(-8_192);
  });
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (server.exitCode !== null) {
      throw new Error(`PocketIC exited before startup: ${stderr}`);
    }
    try {
      const port = Number((await readFile(portFile, "utf8")).trim());
      if (Number.isInteger(port) && port > 0 && port <= 65_535) {
        return { server, controlUrl: `http://127.0.0.1:${port}/` };
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    await delay(25);
  }
  await stopPocketIc(server);
  throw new Error(`PocketIC did not publish its control port: ${stderr}`);
}

async function createApplicationInstance(
  controlUrl: string,
  stateDirectory: string,
  withIcp = false,
): Promise<{ instanceId: number; defaultEffectiveCanisterId: string }> {
  const subnet = {
    state_config: "New",
    instruction_config: "Production",
    subnet_admins: null,
    cost_schedule: "Normal",
  };
  const config = {
    subnet_config_set: {
      nns: withIcp ? subnet : null,
      sns: null,
      ii: null,
      fiduciary: withIcp ? subnet : null,
      bitcoin: null,
      test_threshold_keys: null,
      system: [],
      application: [subnet],
      cloud_engine: [],
      verified_application: [],
    },
    http_gateway_config: null,
    state_dir: stateDirectory,
    icp_config: null,
    log_level: null,
    bitcoind_addr: null,
    dogecoind_addr: null,
    icp_features: {
      registry: withIcp ? "DefaultConfig" : null,
      cycles_minting: withIcp ? "DefaultConfig" : null,
      icp_token: withIcp ? "DefaultConfig" : null,
      cycles_token: null,
      nns_governance: null,
      sns: null,
      ii: null,
      nns_ui: null,
      bitcoin: null,
      dogecoin: null,
      canister_migration: null,
    },
    incomplete_state: "Disabled",
    initial_time: { AutoProgress: { artificial_delay_ms: null } },
    mainnet_nns_subnet_id: withIcp,
    disable_ingress_validation: false,
  };
  const response = await fetch(new URL("instances", controlUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
  const body = (await response.json()) as {
    Created?: {
      instance_id: number;
      topology: {
        default_effective_canister_id: { canister_id: string };
      };
    };
  };
  if (!response.ok || body.Created === undefined) {
    throw new Error(
      `PocketIC instance creation failed: ${JSON.stringify(body)}`,
    );
  }
  return {
    instanceId: body.Created.instance_id,
    defaultEffectiveCanisterId:
      body.Created.topology.default_effective_canister_id.canister_id,
  };
}

async function stopPocketIc(
  server: ChildProcessWithoutNullStreams,
): Promise<void> {
  if (server.exitCode !== null) return;
  server.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise<boolean>((resolve) => server.once("exit", () => resolve(true))),
    delay(5_000).then(() => false),
  ]);
  if (!exited && server.exitCode === null) {
    server.kill("SIGKILL");
    await new Promise<void>((resolve) => server.once("exit", () => resolve()));
  }
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
