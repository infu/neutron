import { describe, expect, test } from "bun:test";
import type { Identity } from "@dfinity/agent";
import { Principal } from "@dfinity/principal";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import {
  ASSEMBLER_ID,
  supportsBrowserSurfaceOrigins,
} from "neutron-compiler/src/assemble.js";
import {
  buildPackagesInstallAssets,
  KERNEL_CONNECTION_PROVIDER_SUPPORT_PATH,
  preparePackageInstall,
  type KernelPackageInstaller,
  type KernelStaticRequest,
} from "neutron-compiler/src/install.js";
import { hashContent } from "neutron-tools/src/hash.js";
import {
  NEUTRON_BROWSER_SURFACE_ORIGINS_MARKER_PATH,
  browserSurfaceOriginsPackageMarkerBytes,
} from "neutron-tools/src/package_surface_origins.js";
import {
  assertSupportedCertificateVersions,
  SUPPORTED_CERTIFICATE_VERSIONS_METADATA_V1,
  withSupportedCertificateVersions,
} from "neutron-tools/src/wasm_metadata.js";
import {
  buildFreshInstallProvenance,
  chunkWasm,
  sha256Hex,
  type PreparedDeployment,
} from "../src/artifact.ts";
import {
  DEPLOYMENT_OBSERVATION_SCHEMA_V1,
  DEPLOYMENT_OBSERVATION_SOURCE_V1,
  DEPLOYMENT_PRICING_PROFILE_V1,
  deploymentProofBundlePath,
  type DeploymentEvidenceProviderV1,
  type DeploymentObservationClaimsV1,
} from "../src/deployment_evidence.ts";
import type { BlastIdentity } from "../src/identity.ts";
import {
  defaultIcpAccountIdentifier,
  IcpTransferBadFeeError,
} from "../src/ic_client.ts";
import {
  LEGACY_TRANSACTION_PAYLOAD_VERSION,
  TRANSACTION_PAYLOAD_VERSION,
  parseTransactionPayload,
  persistTransactionPayload,
  serializeTransactionPayload,
  transactionPayloadPath,
} from "../src/payload.ts";
import { deploymentRuntimeConfig } from "../src/runtime_config.ts";
import {
  INSTALL_PROVENANCE_PATH,
  runProvision,
  seedFreshKernel,
  verifyFreshKernel,
  type ProvisionClient,
  type ProvisionOptions,
} from "../src/provision.ts";
import type { KernelActor } from "../src/kernel.ts";
import { testKernelConnectionProviderSupport } from "./package_fixture.ts";

const DEPLOYER =
  "pcofx-mj5y3-27jya-3jcsk-jzcy2-2y6yj-bvf32-ousik-tb3ks-uyjkz-rqe";
const SUBNET = Principal.selfAuthenticating(new Uint8Array(32).fill(7)).toText();
const CANISTER = "rrkah-fqaaa-aaaaa-aaaaq-cai";

describe("fresh kernel assets", () => {
  test("payload v4 is explicit while a v3 resume remains an unmarked v25 bridge", async () => {
    await withFixture(async ({ deployment }) => {
      const serialized = serializeTransactionPayload(deployment);
      expect(serialized.version).toBe(TRANSACTION_PAYLOAD_VERSION);
      const current = parseTransactionPayload(
        serialized.bytes,
        deployment.packageArtifacts,
        TRANSACTION_PAYLOAD_VERSION,
      );
      expect(current.compiled.assemblerId).toBe(ASSEMBLER_ID);
      expect(current.compiled.browserSurfaceOriginAppIds).toEqual([]);

      const legacyBytes = rewriteTransactionPayloadHeader(
        serialized.bytes,
        (header) => {
          header.schema = LEGACY_TRANSACTION_PAYLOAD_VERSION;
          delete header.assemblerId;
          delete header.browserSurfaceOriginAppIds;
        },
      );
      const legacy = parseTransactionPayload(
        legacyBytes,
        deployment.packageArtifacts,
        LEGACY_TRANSACTION_PAYLOAD_VERSION,
      );
      expect(legacy.compiled.assemblerId).toBe("neutron_actor_v25");
      expect(legacy.compiled.browserSurfaceOriginAppIds).toEqual([]);
      expect(() =>
        parseTransactionPayload(
          legacyBytes,
          deployment.packageArtifacts,
          TRANSACTION_PAYLOAD_VERSION,
        ),
      ).toThrow("does not match journal version");

      const invalidLegacy = rewriteTransactionPayloadHeader(
        serialized.bytes,
        (header) => {
          header.schema = LEGACY_TRANSACTION_PAYLOAD_VERSION;
        },
      );
      expect(() => parseTransactionPayload(invalidLegacy)).toThrow(
        "browserSurfaceOriginAppIds",
      );
      const invalidCurrent = rewriteTransactionPayloadHeader(
        serialized.bytes,
        (header) => {
          delete header.browserSurfaceOriginAppIds;
        },
      );
      expect(() => parseTransactionPayload(invalidCurrent)).toThrow(
        "browserSurfaceOriginAppIds",
      );
      const wrongCurrentAssembler = rewriteTransactionPayloadHeader(
        serialized.bytes,
        (header) => {
          header.assemblerId = "neutron_actor_v25";
        },
      );
      expect(() => parseTransactionPayload(wrongCurrentAssembler)).toThrow(
        "does not match selected Kernel 316",
      );

      const provenance = buildFreshInstallProvenance(legacy);
      const valid = freshKernelVerificationFixture({
        deployment: legacy,
        provenance,
        assemblerId: "neutron_actor_v25",
      });
      await verifyFreshKernel({
        actor: valid.actor,
        canisterId: CANISTER,
        host: "https://icp-api.io",
        deployment: legacy,
        fetchImpl: valid.fetchImpl,
      });

      const unexpectedLegacySidecar = freshKernelVerificationFixture({
        deployment: legacy,
        provenance,
        browserSurfaceOriginsSidecarPresent: true,
        assemblerId: "neutron_actor_v25",
      });
      await expect(
        verifyFreshKernel({
          actor: unexpectedLegacySidecar.actor,
          canisterId: CANISTER,
          host: "https://icp-api.io",
          deployment: legacy,
          fetchImpl: unexpectedLegacySidecar.fetchImpl,
        }),
      ).rejects.toThrow("cannot contain");

      const missingCurrentSidecar = freshKernelVerificationFixture({
        deployment,
        provenance: buildFreshInstallProvenance(deployment),
        browserSurfaceOriginsSidecarPresent: false,
      });
      await expect(
        verifyFreshKernel({
          actor: missingCurrentSidecar.actor,
          canisterId: CANISTER,
          host: "https://icp-api.io",
          deployment,
          fetchImpl: missingCurrentSidecar.fetchImpl,
        }),
      ).rejects.toThrow("missing its browser-surface origins sidecar");

      const wrongGeneration = freshKernelVerificationFixture({
        deployment: legacy,
        provenance,
      });
      await expect(
        verifyFreshKernel({
          actor: wrongGeneration.actor,
          canisterId: CANISTER,
          host: "https://icp-api.io",
          deployment: legacy,
          fetchImpl: wrongGeneration.fetchImpl,
        }),
      ).rejects.toThrow(
        "Runtime assembler neutron_actor_v26 does not match neutron_actor_v25",
      );
    });
  });

  test("payload round-trip preserves the exact ready-package origin cohort", async () => {
    await withFixture(async ({ deployment }) => {
      const legacyArchive = testOrdinaryAppArchive("legacy_app", false);
      const markedArchive = testOrdinaryAppArchive("marked_app", true);
      const legacy = preparePackageInstall(legacyArchive);
      const marked = preparePackageInstall(markedArchive);
      const selected = {
        ...deployment,
        packages: [...deployment.packages, legacy, marked],
        packageArchives: [
          ...deployment.packageArchives,
          legacyArchive,
          markedArchive,
        ],
        packageArtifacts: [
          ...deployment.packageArtifacts,
          {
            path: "/repo/apps/legacy/legacy.v0.1.0.neutron",
            id: "legacy_app",
            version: 100,
            sha256: sha256Hex(legacyArchive),
            bytes: legacyArchive.byteLength,
          },
          {
            path: "/repo/apps/marked/marked.v0.1.0.neutron",
            id: "marked_app",
            version: 100,
            sha256: sha256Hex(markedArchive),
            bytes: markedArchive.byteLength,
          },
        ],
        compiled: {
          ...deployment.compiled,
          browserSurfaceOriginAppIds: ["marked_app"],
        },
      } satisfies PreparedDeployment;

      const serialized = serializeTransactionPayload(selected);
      const restored = parseTransactionPayload(
        serialized.bytes,
        selected.packageArtifacts,
        TRANSACTION_PAYLOAD_VERSION,
      );
      expect(restored.compiled.browserSurfaceOriginAppIds).toEqual([
        "marked_app",
      ]);

      const forged = rewriteTransactionPayloadHeader(
        serialized.bytes,
        (header) => {
          header.browserSurfaceOriginAppIds = ["legacy_app"];
        },
      );
      expect(() =>
        parseTransactionPayload(
          forged,
          selected.packageArtifacts,
          TRANSACTION_PAYLOAD_VERSION,
        ),
      ).toThrow("must exactly match the selected origin-ready package ids");

      const legacyPayload = rewriteTransactionPayloadHeader(
        serialized.bytes,
        (header) => {
          header.schema = LEGACY_TRANSACTION_PAYLOAD_VERSION;
          delete header.assemblerId;
          delete header.browserSurfaceOriginAppIds;
        },
      );
      expect(
        parseTransactionPayload(
          legacyPayload,
          selected.packageArtifacts,
          LEGACY_TRANSACTION_PAYLOAD_VERSION,
        ).compiled.browserSurfaceOriginAppIds,
      ).toEqual([]);
    });
  });

  test("seeds exact package archive provenance", async () => {
    await withFixture(async ({ deployment }) => {
      const requests: KernelStaticRequest[] = [];
      const actor = {
        async kernel_publication_entropy_initialize(_request: null) {
          return { ok: { fingerprint: new Uint8Array(32) } } as const;
        },
        async kernel_static(request: KernelStaticRequest) {
          requests.push(request);
        },
      } as unknown as KernelActor;

      await seedFreshKernel({
        actor,
        canisterId: CANISTER,
        deployment,
        logger: silentLogger,
      });

      expect(requests.some((request) => "clear" in request)).toBe(false);

      const stores = requests.flatMap((request) =>
        "store" in request && request.store.key === INSTALL_PROVENANCE_PATH
          ? [request.store]
          : [],
      );
      expect(stores).toHaveLength(1);
      const stored = stores[0];
      if (!stored) throw new Error("Install provenance was not seeded");
      expect(stored.val.content_type).toBe("application/json");
      expect(stored.val.content_encoding).toBe("identity");
      expect(stored.val.chunks).toBe(1);
      expect(new TextDecoder().decode(stored.val.content)).toBe(
        JSON.stringify(buildFreshInstallProvenance(deployment)),
      );
      expect(
        requests.filter(
          (request) =>
            "store_chunk" in request &&
            request.store_chunk.key === INSTALL_PROVENANCE_PATH,
        ),
      ).toHaveLength(0);
      expect(
        requests.filter(
          (request) =>
            "store" in request &&
            request.store.key === "/system/browser-surface-origins.json",
        ),
      ).toHaveLength(1);
    });
  });

  test("rejects changed prepared package state before any fresh seed write", async () => {
    await withFixture(async ({ deployment }) => {
      deployment.packages[0]!.files.push({
        path: "app/victim/main.js",
        content: new TextEncoder().encode("cross-app"),
      });
      let calls = 0;
      const actor = {
        async kernel_publication_entropy_initialize(_request: null) {
          calls += 1;
          return { ok: { fingerprint: new Uint8Array(32) } } as const;
        },
        async kernel_static(_request: KernelStaticRequest) {
          calls += 1;
        },
      } as unknown as KernelActor;

      await expect(
        seedFreshKernel({
          actor,
          canisterId: CANISTER,
          deployment,
          logger: silentLogger,
        }),
      ).rejects.toThrow("contents changed after archive review");
      expect(calls).toBe(0);
    });
  });

  test("writes each final asset once without multi-file batching", async () => {
    await withFixture(async ({ deployment }) => {
      const original = deployment.packages[0]!.files.find(({ path }) =>
        path.startsWith("mo/"),
      );
      if (!original) throw new Error("Test Kernel has no content-addressed module");
      const requests: KernelStaticRequest[] = [];
      const actor = {
        async kernel_publication_entropy_initialize(_request: null) {
          return { ok: { fingerprint: new Uint8Array(32) } } as const;
        },
        async kernel_static(request: KernelStaticRequest) {
          requests.push(request);
        },
      } as unknown as KernelActor;

      await seedFreshKernel({
        actor,
        canisterId: CANISTER,
        deployment,
        logger: silentLogger,
      });

      const stores = requests.filter(
        (request) => "store" in request && request.store.key === `/${original.path}`,
      );
      expect(stores).toHaveLength(1);
      expect(
        requests.every(
          (request) =>
            "clear" in request || "store" in request || "store_chunk" in request,
        ),
      ).toBe(true);
    });
  });

  test("postflight requires exact package archive provenance", async () => {
    await withFixture(async ({ deployment }) => {
      const provenance = buildFreshInstallProvenance(deployment);
      const valid = freshKernelVerificationFixture({
        deployment,
        provenance,
      });
      await verifyFreshKernel({
        actor: valid.actor,
        canisterId: CANISTER,
        host: "https://icp-api.io",
        deployment,
        fetchImpl: valid.fetchImpl,
      });
      expect(valid.requestedPaths).toContain(INSTALL_PROVENANCE_PATH);

      const invalidValues: unknown[] = [
        null,
        [],
        { format: 2, apps: {} },
        { format: 1, apps: [] },
        { format: 1, apps: {} },
        {
          format: 1,
          apps: {
            kernel: {
              kind: "manual",
              acquisition: "file",
              package_digest: provenance.apps.kernel!.package_digest,
            },
          },
        },
        {
          format: 1,
          apps: {
            kernel: {
              kind: "provisioned",
              package_digest: "0".repeat(64),
            },
          },
        },
        { ...provenance, extra: true },
      ];
      for (const provenance of invalidValues) {
        const invalid = freshKernelVerificationFixture({
          deployment,
          provenance,
        });
        await expect(
          verifyFreshKernel({
            actor: invalid.actor,
            canisterId: CANISTER,
            host: "https://icp-api.io",
            deployment,
            fetchImpl: invalid.fetchImpl,
          }),
        ).rejects.toThrow(
          "Certified install provenance does not match the fresh package archives",
        );
      }

      const missing = freshKernelVerificationFixture({ deployment });
      await expect(
        verifyFreshKernel({
          actor: missing.actor,
          canisterId: CANISTER,
          host: "https://icp-api.io",
          deployment,
          fetchImpl: missing.fetchImpl,
        }),
      ).rejects.toThrow(`${INSTALL_PROVENANCE_PATH}: 404`);
    });
  });
});

describe("resumable provisioning", () => {
  test("programmatic calls require exact pins before identity, archive, or network work", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "neutron-unpinned-create-"));
    const calls = { identity: 0, prepare: 0, client: 0, evidence: 0 };
    try {
      const options = {
        configSha256: "c".repeat(64),
        host: "https://icp-api.io",
        identityId: 7,
        targetSubnet: SUBNET,
        amountE8s: 500_000_000n,
        controllers: [],
        sessionPath: path.join(root, "config.ndeploy.session.json"),
        execute: true,
      } as unknown as ProvisionOptions;

      await expect(
        runProvision(options, {
          loadIdentity: async () => {
            calls.identity += 1;
            throw new Error("unexpected identity load");
          },
          prepare: async () => {
            calls.prepare += 1;
            throw new Error("unexpected archive preparation");
          },
          createClient: async () => {
            calls.client += 1;
            throw new Error("unexpected client construction");
          },
          deploymentEvidenceProvider: {
            async observe() {
              calls.evidence += 1;
              throw new Error("unexpected evidence request");
            },
          },
          logger: silentLogger,
        }),
      ).rejects.toThrow("exact format-3 pins");

      expect(calls).toEqual({
        identity: 0,
        prepare: 0,
        client: 0,
        evidence: 0,
      });
      expect(await fileExists(options.sessionPath)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects missing final Wasm metadata before evidence or remote mutation", async () => {
    await withFixture(
      async ({ options, identity, deployment, client, calls, provider }) => {
        options.execute = true;
        const invalid = {
          ...deployment,
          compiled: {
            ...deployment.compiled,
            wasm: new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
          },
        };

        await expect(
          runProvision(options, {
            loadIdentity: async () => identity,
            prepare: async () => invalid,
            createClient: async () => client,
            deploymentEvidenceProvider: provider,
            logger: silentLogger,
          }),
        ).rejects.toThrow("Missing Wasm custom section");
        expect(calls).toEqual({
          evidence: 0,
          preflight: 0,
          transfer: 0,
          create: 0,
          controllers: 0,
          install: 0,
          seed: 0,
          access: 0,
          verify: 0,
        });
        expect(await fileExists(options.sessionPath)).toBe(false);
      },
    );
  });

  test("an executing create sweeps a payload orphaned before active was published", async () => {
    await withFixture(async ({ options, identity, deployment, client, calls, provider }) => {
      options.execute = true;
      const orphan = serializeTransactionPayload({
        ...deployment,
        compiled: {
          ...deployment.compiled,
          deploymentId: "pre-active-crash-orphan",
        },
      });
      const orphanPath = await persistTransactionPayload(
        options.sessionPath,
        orphan,
      );
      let checkedBeforeRemote = false;

      await runProvision(options, {
        loadIdentity: async () => identity,
        prepare: async () => deployment,
        createClient: async () => {
          expect(await fileExists(orphanPath)).toBe(false);
          checkedBeforeRemote = true;
          return client;
        },
        deploymentEvidenceProvider: provider,
        confirm: async () => undefined,
        seed: async () => {
          calls.seed += 1;
        },
        verify: async () => {
          calls.verify += 1;
        },
        logger: silentLogger,
      });

      expect(checkedBeforeRemote).toBe(true);
      expect(await fileExists(orphanPath)).toBe(false);
    });
  });

  test("planning performs no remote update and writes no session", async () => {
    await withFixture(async ({ options, identity, deployment, client, calls, provider }) => {
      const result = await runProvision(options, {
        loadIdentity: async () => identity,
        prepare: async () => deployment,
        createClient: async () => client,
        deploymentEvidenceProvider: provider,
        logger: silentLogger,
      });
      expect(result.mode).toBe("plan");
      const expectedEvidence = result.plan.deploymentEvidenceExpected;
      if (!expectedEvidence) throw new Error("expected planned deployment evidence");
      const expectedProofPath = deploymentProofBundlePath(
        options.sessionPath,
        expectedEvidence.evidenceSha256,
      );
      expect(expectedEvidence).toMatchObject({
        schema: 1,
        subnetId: SUBNET,
        registryVersion: "101",
        subnetType: "application",
        nodeCount: 13,
        sevEnabled: false,
        pricingProfile: "application_13_node",
        evidenceSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      expect(result.plan.wasmMetadata).toEqual(
        SUPPORTED_CERTIFICATE_VERSIONS_METADATA_V1,
      );
      expect(calls).toEqual({
        evidence: 1,
        preflight: 1,
        transfer: 0,
        create: 0,
        controllers: 0,
        install: 0,
        seed: 0,
        access: 0,
        verify: 0,
      });
      expect(await fileExists(options.sessionPath)).toBe(false);
      expect(
        await fileExists(
          transactionPayloadPath(options.sessionPath, result.plan.payload.sha256),
        ),
      ).toBe(false);
      expect(
        await fileExists(expectedProofPath),
      ).toBe(false);
    });
  });

  test("requires certified deployment evidence before creating a new plan", async () => {
    await withFixture(async ({ options, identity, deployment, client, calls }) => {
      await expect(
        runProvision(options, {
          loadIdentity: async () => identity,
          prepare: async () => deployment,
          createClient: async () => client,
          logger: silentLogger,
        }),
      ).rejects.toThrow(
        "A certified deployment evidence provider is required",
      );
      expect(calls.preflight).toBe(0);
      expect(calls.evidence).toBe(0);
      expect(await fileExists(options.sessionPath)).toBe(false);
    });
  });

  test("waits for ICP funding, rechecks the fee, then persists the funded fee", async () => {
    await withFixture(async ({ options, identity, deployment, client, calls, provider }) => {
      options.execute = true;
      client.preflight = async () => {
        calls.preflight += 1;
        return {
          ledgerBalanceE8s: 0n,
          ledgerFeeE8s: 10_000n,
          estimatedCycles: 7_500_000_000_000n,
          xdrPermyriadPerIcp: 15_000n,
          targetIsDefault: true,
          targetHasSubnetType: false,
          targetIsAuthorized: false,
        };
      };
      const fundingChecks = [
        { ledgerBalanceE8s: 500_000_000n, ledgerFeeE8s: 20_000n },
        { ledgerBalanceE8s: 500_020_000n, ledgerFeeE8s: 20_000n },
      ];
      client.fundingStatus = async () => {
        const next = fundingChecks.shift();
        if (!next) throw new Error("unexpected funding check");
        return next;
      };
      const requirements: Array<{
        balance: bigint;
        fee: bigint;
        shortfall: bigint;
      }> = [];
      const events: string[] = [];
      const result = await runProvision(options, {
        loadIdentity: async () => identity,
        prepare: async () => deployment,
        createClient: async () => client,
        deploymentEvidenceProvider: provider,
        waitForFunding: async (requirement) => {
          events.push("wait");
          requirements.push({
            balance: requirement.ledgerBalanceE8s,
            fee: requirement.ledgerFeeE8s,
            shortfall: requirement.shortfallE8s,
          });
          expect(requirement.accountIdentifier).toBe(
            defaultIcpAccountIdentifier(Principal.fromText(DEPLOYER)),
          );
          expect(await fileExists(options.sessionPath)).toBe(false);
          expect(await fileExists(path.join(path.dirname(options.sessionPath), ".neutron"))).toBe(false);
          expect(calls.transfer).toBe(0);
        },
        confirm: async (summary) => {
          events.push("confirm");
          expect(summary.amountE8s).toBe(500_000_000n);
          expect(summary.feeE8s).toBe(20_000n);
        },
        seed: async () => {
          calls.seed += 1;
        },
        verify: async () => {
          calls.verify += 1;
        },
        logger: silentLogger,
      });

      expect(requirements).toEqual([
        { balance: 0n, fee: 10_000n, shortfall: 500_010_000n },
        { balance: 500_000_000n, fee: 20_000n, shortfall: 20_000n },
      ]);
      expect(events).toEqual(["wait", "wait", "confirm"]);
      expect(result.preflight).toMatchObject({
        ledgerBalanceE8s: 500_020_000n,
        ledgerFeeE8s: 20_000n,
      });
      expect(result.session?.origin?.transfer.feeE8s).toBe("20000");
      expect(calls.transfer).toBe(1);
    });
  });

  test("reports an actionable funding account without creating paid state", async () => {
    await withFixture(async ({ options, identity, deployment, client, calls, provider }) => {
      options.execute = true;
      client.preflight = async () => {
        calls.preflight += 1;
        return {
          ledgerBalanceE8s: 100_000_000n,
          ledgerFeeE8s: 10_000n,
          estimatedCycles: 7_500_000_000_000n,
          xdrPermyriadPerIcp: 15_000n,
          targetIsDefault: true,
          targetHasSubnetType: false,
          targetIsAuthorized: false,
        };
      };
      const account = defaultIcpAccountIdentifier(Principal.fromText(DEPLOYER));
      await expect(
        runProvision(options, {
          loadIdentity: async () => identity,
          prepare: async () => deployment,
          createClient: async () => client,
          deploymentEvidenceProvider: provider,
          logger: silentLogger,
        }),
      ).rejects.toThrow(account);
      expect(await fileExists(options.sessionPath)).toBe(false);
      expect(await fileExists(path.join(path.dirname(options.sessionPath), ".neutron"))).toBe(false);
      expect(calls.transfer).toBe(0);
    });
  });

  test("a funding wait cancellation leaves no session or payment", async () => {
    await withFixture(async ({ options, identity, deployment, client, calls, provider }) => {
      options.execute = true;
      client.preflight = async () => {
        calls.preflight += 1;
        return {
          ledgerBalanceE8s: 0n,
          ledgerFeeE8s: 10_000n,
          estimatedCycles: 7_500_000_000_000n,
          xdrPermyriadPerIcp: 15_000n,
          targetIsDefault: true,
          targetHasSubnetType: false,
          targetIsAuthorized: false,
        };
      };
      await expect(
        runProvision(options, {
          loadIdentity: async () => identity,
          prepare: async () => deployment,
          createClient: async () => client,
          deploymentEvidenceProvider: provider,
          waitForFunding: async () => {
            throw new Error("operator cancelled funding");
          },
          logger: silentLogger,
        }),
      ).rejects.toThrow("operator cancelled funding");
      expect(await fileExists(options.sessionPath)).toBe(false);
      expect(await fileExists(path.join(path.dirname(options.sessionPath), ".neutron"))).toBe(false);
      expect(calls.transfer).toBe(0);
    });
  });

  test("executes each paid phase once and resumes a completed session", async () => {
    await withFixture(async ({ options, identity, deployment, client, calls, provider }) => {
      options.execute = true;
      const logs: string[] = [];
      const dependencies = {
        loadIdentity: async () => identity,
        prepare: async () => deployment,
        createClient: async () => client,
        deploymentEvidenceProvider: provider,
        confirm: async () => undefined,
        seed: async () => {
          calls.seed += 1;
        },
        verify: async () => {
          calls.verify += 1;
        },
        now: () => new Date("2026-07-19T12:00:00.000Z"),
        logger: { log(message: unknown) { logs.push(String(message)); } },
      };
      const first = await runProvision(options, dependencies);
      expect(first.mode).toBe("executed");
      expect(first.session?.origin?.canisterId).toBe(CANISTER);
      expect(first.session?.origin?.transfer.blockIndex).toBe("42");
      expect(first.session?.origin?.verifiedAt).toBeTruthy();
      expect(first.session?.origin?.deploymentEvidence).toMatchObject({
        schema: 1,
        expected: { registryVersion: "101" },
        observed: { registryVersion: "102" },
        fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      expect(first.session?.origin?.deploymentEvidence?.expected.evidenceSha256)
        .not.toBe(
          first.session?.origin?.deploymentEvidence?.observed.evidenceSha256,
        );
      expect(first.session?.origin?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(first.session?.current).toMatchObject({
        wasmMetadata: SUPPORTED_CERTIFICATE_VERSIONS_METADATA_V1,
        deploymentEvidence:
          first.session?.origin?.deploymentEvidence,
        sourceSessionFingerprint: first.session?.origin?.fingerprint,
        fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      expect(first.session?.active).toBeUndefined();
      expect(calls).toEqual({
        evidence: 2,
        preflight: 1,
        transfer: 1,
        create: 1,
        controllers: 1,
        install: 1,
        seed: 1,
        access: 1,
        verify: 1,
      });

      const saved = await readFile(options.sessionPath, "utf8");
      expect(saved).toContain(`"deployerPrincipal": "${DEPLOYER}"`);
      expect(saved).not.toContain("test-secret-material");
      const payload = transactionPayloadPath(
        options.sessionPath,
        first.plan.payload.sha256,
      );
      expect(await fileExists(payload)).toBe(false);
      for (const observation of [
        first.session!.origin!.deploymentEvidence!.expected,
        first.session!.origin!.deploymentEvidence!.observed,
      ]) {
        const proofPath = deploymentProofBundlePath(
          options.sessionPath,
          observation.evidenceSha256,
        );
        expect(await fileExists(proofPath)).toBe(true);
        expect((await stat(proofPath)).mode & 0o777).toBe(0o400);
      }

      // A hard interruption after the journal completed can also leave an
      // immutable file with no active reference. The next executing command
      // removes it before consulting the completed receipt remotely.
      await persistTransactionPayload(
        options.sessionPath,
        serializeTransactionPayload(deployment),
      );
      expect(await fileExists(payload)).toBe(true);

      options.host = "https://ic0.app";
      await runProvision(options, {
        ...dependencies,
        prepare: async () => {
          throw new Error("resume must not compile package archives");
        },
      });
      expect(calls.transfer).toBe(1);
      expect(calls.create).toBe(1);
      expect(calls.controllers).toBe(1);
      expect(calls.install).toBe(1);
      expect(calls.seed).toBe(1);
      expect(calls.access).toBe(1);
      expect(calls.verify).toBe(1);
      expect(calls.evidence).toBe(2);
      expect(await fileExists(payload)).toBe(false);
      expect(
        logs.some((message) =>
          message.includes("Removed 1 unreferenced transaction payload"),
        ),
      ).toBe(true);
      expect(logs.some((message) => message.includes("no transaction payload retained"))).toBe(true);
    });
  });

  test("does not complete a receipt when observed placement drifts from the plan", async () => {
    await withFixture(async ({
      options,
      identity,
      deployment,
      client,
      calls,
      provider,
      evidenceBehavior,
    }) => {
      options.execute = true;
      evidenceBehavior.observe = (call, subnetId) => {
        const result = deploymentObservation(call, subnetId);
        return call === 2
          ? {
              ...result,
              observation: {
                ...result.observation,
                sevEnabled: true,
              },
            }
          : result;
      };

      await expect(
        runProvision(options, {
          loadIdentity: async () => identity,
          prepare: async () => deployment,
          createClient: async () => client,
          deploymentEvidenceProvider: provider,
          confirm: async () => undefined,
          seed: async () => {
            calls.seed += 1;
          },
          verify: async () => {
            calls.verify += 1;
          },
          logger: silentLogger,
        }),
      ).rejects.toThrow(
        "observed sevEnabled does not match the expected observation",
      );

      const pending = JSON.parse(
        await readFile(options.sessionPath, "utf8"),
      ) as {
        origin?: unknown;
        current?: unknown;
        active: {
          state: {
            verifiedAt?: string;
            deploymentEvidence?: unknown;
            fingerprint?: string;
          };
        };
      };
      expect(pending.origin).toBeUndefined();
      expect(pending.current).toBeUndefined();
      expect(pending.active.state.verifiedAt).toBeUndefined();
      expect(pending.active.state.deploymentEvidence).toBeUndefined();
      expect(pending.active.state.fingerprint).toBeUndefined();
      expect(calls.evidence).toBe(2);
    });
  });

  test("rejects changed remote intent before another payment", async () => {
    await withFixture(async ({ options, identity, deployment, client, calls, provider }) => {
      options.execute = true;
      const dependencies = {
        loadIdentity: async () => identity,
        prepare: async () => deployment,
        createClient: async () => client,
        deploymentEvidenceProvider: provider,
        confirm: async () => undefined,
        seed: async () => {
          calls.seed += 1;
        },
        verify: async () => {
          calls.verify += 1;
        },
        logger: silentLogger,
      };
      await runProvision(options, dependencies);
      options.amountE8s += 1n;
      await expect(
        runProvision(options, {
          ...dependencies,
          prepare: async () => {
            throw new Error("resume must not recompile");
          },
        }),
      ).rejects.toThrow("do not match the provision journal");
      expect(calls.transfer).toBe(1);
    });
  });

  test("recovers an ambiguous ledger response with the persisted fee and timestamp", async () => {
    await withFixture(async ({ options, identity, deployment, client, calls, provider }) => {
      options.execute = true;
      let loseFirstReply = true;
      let prepareCalls = 0;
      const eligibilityRequirements: Array<boolean | undefined> = [];
      const originalPreflight = client.preflight;
      client.preflight = async (input) => {
        eligibilityRequirements.push(input.requireTargetEligible);
        const result = await originalPreflight(input);
        return eligibilityRequirements.length === 1
          ? result
          : { ...result, ledgerBalanceE8s: 0n };
      };
      client.transferCreationIcp = async (input) => {
        calls.transfer += 1;
        expect(input.feeE8s).toBe(10_000n);
        expect(input.createdAtTimeNanos).toBe(1_658_232_000_000_000_000n);
        if (loseFirstReply) {
          loseFirstReply = false;
          throw new Error("transport response lost after commit");
        }
        return 42n;
      };
      const dependencies = {
        loadIdentity: async () => identity,
        prepare: async () => {
          prepareCalls += 1;
          if (prepareCalls > 1) {
            throw new Error("crash recovery must load the durable payload");
          }
          return deployment;
        },
        createClient: async () => client,
        deploymentEvidenceProvider: provider,
        waitForFunding: async () => {
          throw new Error("resume must not wait for funding");
        },
        confirm: async () => undefined,
        seed: async () => {
          calls.seed += 1;
        },
        verify: async () => {
          calls.verify += 1;
        },
        now: () => new Date("2022-07-19T12:00:00.000Z"),
        logger: silentLogger,
      };
      await expect(runProvision(options, dependencies)).rejects.toThrow(
        "response lost",
      );
      const pending = JSON.parse(
        await readFile(options.sessionPath, "utf8"),
      ) as {
        active: { state: { transfer: {
          createdAtTimeNanos: string;
          feeE8s: string;
          blockIndex?: string;
        } } };
      };
      expect(pending.active.state.transfer).toEqual({
        createdAtTimeNanos: "1658232000000000000",
        feeE8s: "10000",
      });

      await runProvision(options, dependencies);
      expect(prepareCalls).toBe(1);
      expect(eligibilityRequirements).toEqual([true, false]);
      expect(calls.transfer).toBe(2);
      expect(calls.evidence).toBe(2);
    });
  });

  test("persists BadFee in the session before retrying the exact uncommitted transfer", async () => {
    await withFixture(async ({ options, identity, deployment, client, calls, provider }) => {
      options.execute = true;
      const transfers: Array<{
        amountE8s: bigint;
        createdAtTimeNanos: bigint;
        feeE8s: bigint;
      }> = [];
      client.transferCreationIcp = async (input) => {
        calls.transfer += 1;
        transfers.push(input);
        if (transfers.length === 1) throw new IcpTransferBadFeeError(20_000n);
        const session = JSON.parse(await readFile(options.sessionPath, "utf8")) as {
          active: { state: { transfer: { feeE8s: string; blockIndex?: string } } };
        };
        expect(session.active.state.transfer).toMatchObject({ feeE8s: "20000" });
        expect(session.active.state.transfer.blockIndex).toBeUndefined();
        return 42n;
      };
      const now = new Date("2026-07-19T12:00:00.000Z");
      await runProvision(options, {
        loadIdentity: async () => identity,
        prepare: async () => deployment,
        createClient: async () => client,
        deploymentEvidenceProvider: provider,
        confirm: async () => undefined,
        seed: async () => {
          calls.seed += 1;
        },
        verify: async () => {
          calls.verify += 1;
        },
        now: () => now,
        logger: silentLogger,
      });

      expect(transfers).toEqual([
        {
          amountE8s: options.amountE8s,
          createdAtTimeNanos: BigInt(now.getTime()) * 1_000_000n,
          feeE8s: 10_000n,
        },
        {
          amountE8s: options.amountE8s,
          createdAtTimeNanos: BigInt(now.getTime()) * 1_000_000n,
          feeE8s: 20_000n,
        },
      ]);
      const completed = JSON.parse(
        await readFile(options.sessionPath, "utf8"),
      ) as {
        origin: { transfer: {
          createdAtTimeNanos: string;
          feeE8s: string;
          blockIndex: string;
        } };
      };
      expect(completed.origin.transfer).toEqual({
        createdAtTimeNanos: (BigInt(now.getTime()) * 1_000_000n).toString(),
        feeE8s: "20000",
        blockIndex: "42",
      });
    });
  });

  test("rejects a corrupted active payload before another remote call", async () => {
    await withFixture(async ({ options, identity, deployment, client, calls, provider }) => {
      options.execute = true;
      client.transferCreationIcp = async () => {
        calls.transfer += 1;
        throw new Error("simulated crash after the session was durable");
      };
      const dependencies = {
        loadIdentity: async () => identity,
        prepare: async () => deployment,
        createClient: async () => client,
        deploymentEvidenceProvider: provider,
        confirm: async () => undefined,
        logger: silentLogger,
      };
      await expect(runProvision(options, dependencies)).rejects.toThrow(
        "simulated crash",
      );
      expect(calls.preflight).toBe(1);

      const saved = JSON.parse(await readFile(options.sessionPath, "utf8")) as {
        active: { state: { plan: { payload: { sha256: string } } } };
      };
      const payloadPath = transactionPayloadPath(
        options.sessionPath,
        saved.active.state.plan.payload.sha256,
      );
      const validBytes = new Uint8Array(await readFile(payloadPath));
      const malformed = validBytes.slice();
      malformed[0] = malformed[0]! ^ 0xff;
      expect(() => parseTransactionPayload(malformed)).toThrow("invalid magic");

      await writeFile(payloadPath, malformed, {
        mode: 0o600,
      });
      await expect(
        runProvision(options, {
          ...dependencies,
          prepare: async () => {
            throw new Error("must not compile around a corrupt payload");
          },
        }),
      ).rejects.toThrow("digest mismatch");
      expect(calls.preflight).toBe(1);
      expect(calls.transfer).toBe(1);
    });
  });

  test("validates the pinned expected proof before resuming remote work", async () => {
    await withFixture(async ({
      options,
      identity,
      deployment,
      client,
      calls,
      provider,
    }) => {
      options.execute = true;
      client.transferCreationIcp = async () => {
        calls.transfer += 1;
        throw new Error("stop after durable evidence");
      };
      const dependencies = {
        loadIdentity: async () => identity,
        prepare: async () => deployment,
        createClient: async () => client,
        deploymentEvidenceProvider: provider,
        confirm: async () => undefined,
        logger: silentLogger,
      };
      await expect(runProvision(options, dependencies)).rejects.toThrow(
        "stop after durable evidence",
      );

      const saved = JSON.parse(
        await readFile(options.sessionPath, "utf8"),
      ) as {
        active: {
          state: {
            plan: {
              deploymentEvidenceExpected: { evidenceSha256: string };
            };
          };
        };
      };
      const proofPath = deploymentProofBundlePath(
        options.sessionPath,
        saved.active.state.plan.deploymentEvidenceExpected.evidenceSha256,
      );
      await rm(proofPath);

      await expect(
        runProvision(options, {
          ...dependencies,
          prepare: async () => {
            throw new Error("resume must use the pinned expectation");
          },
        }),
      ).rejects.toThrow("Deployment proof bundle is missing or unsafe");
      expect(calls.preflight).toBe(1);
      expect(calls.transfer).toBe(1);
      expect(calls.evidence).toBe(1);
    });
  });

  test("takes the deployer-wide mainnet lock before any remote execution", async () => {
    await withFixture(async ({ options, identity, deployment, client, calls, provider }) => {
      options.execute = true;
      let announceEntered!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => {
        announceEntered = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const dependencies = {
        loadIdentity: async () => identity,
        prepare: async () => deployment,
        deploymentEvidenceProvider: provider,
        createClient: async () => {
          announceEntered();
          await held;
          return client;
        },
        confirm: async () => undefined,
        seed: async () => {
          calls.seed += 1;
        },
        verify: async () => {
          calls.verify += 1;
        },
        logger: silentLogger,
      };
      const first = runProvision(options, dependencies);
      try {
        await entered;
        await expect(
          runProvision(
            {
              ...options,
              sessionPath: path.join(
                path.dirname(options.sessionPath),
                "other.ndeploy.session.json",
              ),
            },
            {
              ...dependencies,
              createClient: async () => client,
            },
          ),
        ).rejects.toThrow("already running for deployer");
      } finally {
        release();
        await first;
      }
      expect(calls.transfer).toBe(1);
    });
  });
});

async function withFixture(
  run: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const value = await createFixture();
  try {
    await run(value);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
}

type Calls = {
  evidence: number;
  preflight: number;
  transfer: number;
  create: number;
  controllers: number;
  install: number;
  seed: number;
  access: number;
  verify: number;
};

type EvidenceBehavior = {
  observe: (
    call: number,
    subnetId: string,
  ) => {
    observation: DeploymentObservationClaimsV1;
    proofBundle: Uint8Array;
  };
};

type Fixture = {
  root: string;
  options: ProvisionOptions;
  identity: BlastIdentity;
  deployment: PreparedDeployment;
  client: ProvisionClient;
  provider: DeploymentEvidenceProviderV1;
  evidenceBehavior: EvidenceBehavior;
  calls: Calls;
};

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "neutron-provision-test-"));
  const identity: BlastIdentity = {
    id: 7,
    principal: DEPLOYER,
    secretPath: "/home/test/.config/blast/secret",
    identity: {
      getPrincipal: () => Principal.fromText(DEPLOYER),
    } as Identity,
  };
  const rawWasm = withSupportedCertificateVersions(
    new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
  );
  const wasm = new Uint8Array(gzipSync(rawWasm));
  const archive = testKernelArchive();
  const preparedPackage = preparePackageInstall(archive);
  const deployment = {
    packages: [preparedPackage],
    packageArchives: [archive],
    packageArtifacts: [
      {
        path: "/repo/apps/kernel/kernel.v0.3.16.neutron",
        id: "kernel",
        version: 316,
        sha256: sha256Hex(archive),
        bytes: archive.byteLength,
      },
    ],
    compiled: {
      wasm: rawWasm,
      candid: "service : {}",
      stable: "stable-types",
      deploymentId: "de".repeat(16),
      compilerId: "compiler-test",
      assemblerId: ASSEMBLER_ID,
      browserSurfaceOriginAppIds: [],
    } as PreparedDeployment["compiled"],
    wasmMetadata: assertSupportedCertificateVersions(rawWasm),
    transportWasm: wasm,
    rawWasmSha256: sha256Hex(rawWasm),
    transportWasmSha256: sha256Hex(wasm),
    candidSha256: sha256Hex(new TextEncoder().encode("service : {}")),
    stableSha256: sha256Hex(new TextEncoder().encode("stable-types")),
    chunks: chunkWasm(wasm),
  } satisfies PreparedDeployment;
  const calls = {
    evidence: 0,
    preflight: 0,
    transfer: 0,
    create: 0,
    controllers: 0,
    install: 0,
    seed: 0,
    access: 0,
    verify: 0,
  };
  const evidenceBehavior: EvidenceBehavior = {
    observe(call, subnetId) {
      return deploymentObservation(call, subnetId);
    },
  };
  const provider: DeploymentEvidenceProviderV1 = {
    async observe({ subnetId }) {
      calls.evidence += 1;
      return evidenceBehavior.observe(calls.evidence, subnetId);
    },
  };
  const client: ProvisionClient = {
    async preflight() {
      calls.preflight += 1;
      return {
        ledgerBalanceE8s: 1_000_000_000n,
        ledgerFeeE8s: 10_000n,
        estimatedCycles: 7_500_000_000_000n,
        xdrPermyriadPerIcp: 15_000n,
        targetIsDefault: true,
        targetHasSubnetType: false,
        targetIsAuthorized: false,
      };
    },
    async fundingStatus() {
      return {
        ledgerBalanceE8s: 1_000_000_000n,
        ledgerFeeE8s: 10_000n,
      };
    },
    async transferCreationIcp() {
      calls.transfer += 1;
      return 42n;
    },
    async notifyCreateCanister() {
      calls.create += 1;
      return CANISTER;
    },
    async certifiedState() {
      return {
        subnetId: SUBNET,
        controllers: [CANISTER, DEPLOYER].sort(),
        moduleHash: deployment.transportWasmSha256,
      };
    },
    async ensureControllers() {
      calls.controllers += 1;
      return [CANISTER, DEPLOYER].sort();
    },
    async installChunkedWasm() {
      calls.install += 1;
    },
    kernelActor() {
      return {} as ReturnType<ProvisionClient["kernelActor"]>;
    },
    async verifyInitialKernelAccess() {
      calls.access += 1;
    },
  };
  const options: ProvisionOptions = {
    configSha256: "c".repeat(64),
    host: "https://icp-api.io",
    identityId: 7,
    targetSubnet: SUBNET,
    amountE8s: 500_000_000n,
    expectedArtifacts: deployment.packageArtifacts,
    controllers: [],
    sessionPath: path.join(root, "config.ndeploy.session.json"),
    execute: false,
  };
  return {
    root,
    options,
    identity,
    deployment,
    client,
    provider,
    evidenceBehavior,
    calls,
  };
}

function deploymentObservation(
  call: number,
  subnetId = SUBNET,
): {
  observation: DeploymentObservationClaimsV1;
  proofBundle: Uint8Array;
} {
  return {
    observation: {
      schema: DEPLOYMENT_OBSERVATION_SCHEMA_V1,
      source: DEPLOYMENT_OBSERVATION_SOURCE_V1,
      subnetId,
      registryVersion: (100 + call).toString(),
      subnetType: "application",
      nodeCount: 13,
      sevEnabled: false,
      pricingProfile: DEPLOYMENT_PRICING_PROFILE_V1,
      verifiedAt: new Date(Date.UTC(2020, 0, 1, 0, 0, call)).toISOString(),
    },
    proofBundle: new TextEncoder().encode(
      `certified-registry-proof-v1:${call}`,
    ),
  };
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

const silentLogger = { log() {} };

function freshKernelVerificationFixture({
  deployment,
  assemblerId = ASSEMBLER_ID,
  browserSurfaceOriginsSidecarPresent =
    supportsBrowserSurfaceOrigins(deployment.compiled.assemblerId),
  ...input
}: {
  deployment: PreparedDeployment;
  provenance?: unknown;
  assemblerId?: string;
  browserSurfaceOriginsSidecarPresent?: boolean;
}): {
  actor: KernelPackageInstaller;
  fetchImpl: typeof fetch;
  requestedPaths: string[];
} {
  const assets = buildPackagesInstallAssets({
    existingApps: {},
    existingBrowserSurfaceOriginAppIds: [],
    packages: deployment.packages,
    candid: deployment.compiled.candid,
  });
  const kernel = deployment.packages.find((pkg) => pkg.isKernel);
  if (!kernel) throw new Error("Test deployment is missing its kernel package");
  const bodies = new Map<string, string>();
  bodies.set("/system/apps.json", JSON.stringify(assets.apps));
  if (browserSurfaceOriginsSidecarPresent) {
    bodies.set(
      assets.browserSurfaceOriginsAsset.key,
      new TextDecoder().decode(
        assets.browserSurfaceOriginsAsset.val.content,
      ),
    );
  }
  bodies.set("/pkg/neutron.json", JSON.stringify(kernel.manifest));
  bodies.set("/pkg/neutron.did", deployment.compiled.candid);
  bodies.set("/pkg/neutron.most", deployment.compiled.stable);
  bodies.set(
    KERNEL_CONNECTION_PROVIDER_SUPPORT_PATH,
    new TextDecoder().decode(testKernelConnectionProviderSupport()),
  );
  bodies.set("/pkg/id.json", JSON.stringify({ id: CANISTER }));
  bodies.set("/", "<!doctype html><title>Neutron</title>");
  bodies.set(
    "/system/runtime-config.json",
    JSON.stringify(
      deploymentRuntimeConfig({
        deployment,
        canisterId: CANISTER,
        target: "ic",
      }),
    ),
  );
  for (const file of kernel.files) {
    const key = file.path.startsWith("/") ? file.path : `/${file.path}`;
    if (key.startsWith("/mo/")) {
      bodies.set(key, new TextDecoder().decode(file.content));
    }
  }
  if (Object.prototype.hasOwnProperty.call(input, "provenance")) {
    bodies.set(INSTALL_PROVENANCE_PATH, JSON.stringify(input.provenance));
  }

  const kernelRegistry = assets.apps.kernel;
  if (!kernelRegistry) {
    throw new Error("Test registry is missing its kernel entry");
  }
  const actor: KernelPackageInstaller = {
    async kernel_static() {
      throw new Error("Postflight verification must not update kernel assets");
    },
    async kernel_install_begin_checked() {
      throw new Error("Postflight verification must not begin an install");
    },
    async kernel_install_reservations_prepare() {
      throw new Error("Postflight verification must not prepare reservations");
    },
    async kernel_install_status() {
      throw new Error(
        "Postflight verification must not inspect an install journal",
      );
    },
    async kernel_install_wasm_chunks_clear() {
      throw new Error("Postflight verification must not clear Wasm chunks");
    },
    async kernel_install_wasm_chunk() {
      throw new Error("Postflight verification must not upload Wasm chunks");
    },
    async kernel_install_code_chunked() {
      throw new Error("Postflight verification must not install chunked code");
    },
    async kernel_install_commit() {
      throw new Error("Postflight verification must not commit an install");
    },
    async kernel_install_abort() {
      throw new Error("Postflight verification must not abort an install");
    },
    async kernel_install_code() {
      throw new Error("Postflight verification must not install code");
    },
    async kernel_runtime_info() {
      return {
        deployment_id: deployment.compiled.deploymentId,
        assembler_id: assemblerId,
        compiler_id: deployment.compiled.compilerId,
        apps: [
          {
            scope: { app_id: "kernel", installation_uid: 1n },
            version: kernelRegistry.version,
            deployment_id: deployment.compiled.deploymentId,
            capability_plan_fingerprint:
              kernelRegistry.capability_plan_fingerprint,
            browser_origin_nonce: "0".repeat(32),
            browser_origin_authority_epoch: 1n,
            resident_frame_security: {
              credentialless_opaque_v1: null,
            } as const,
          },
        ],
        memories: [],
      };
    },
    async kernel_static_query(request: { list: { prefix: string } }) {
      return [...bodies.keys()].filter((key) =>
        key.startsWith(request.list.prefix),
      );
    },
  };
  const requestedPaths: string[] = [];
  const fetchImpl = (async (request: RequestInfo | URL) => {
    const url = new URL(
      request instanceof Request ? request.url : String(request),
    );
    requestedPaths.push(url.pathname);
    const body = bodies.get(url.pathname);
    return body === undefined
      ? new Response("not found", { status: 404 })
      : new Response(body, { status: 200 });
  }) as typeof fetch;
  return { actor, fetchImpl, requestedPaths };
}

function rewriteTransactionPayloadHeader(
  bytes: Uint8Array,
  mutate: (header: Record<string, unknown>) => void,
): Uint8Array {
  const magic = new TextEncoder().encode("NEUTRON-PROVISION-PAYLOAD\0");
  const lengthOffset = magic.byteLength;
  const headerOffset = lengthOffset + 4;
  const headerBytes = new DataView(
    bytes.buffer,
    bytes.byteOffset + lengthOffset,
    4,
  ).getUint32(0, false);
  const header = JSON.parse(
    new TextDecoder().decode(
      bytes.subarray(headerOffset, headerOffset + headerBytes),
    ),
  ) as Record<string, unknown>;
  mutate(header);
  const rewrittenHeader = new TextEncoder().encode(JSON.stringify(header));
  const result = new Uint8Array(
    headerOffset +
      rewrittenHeader.byteLength +
      bytes.byteLength -
      headerOffset -
      headerBytes,
  );
  result.set(magic);
  new DataView(result.buffer, lengthOffset, 4).setUint32(
    0,
    rewrittenHeader.byteLength,
    false,
  );
  result.set(rewrittenHeader, headerOffset);
  result.set(
    bytes.subarray(headerOffset + headerBytes),
    headerOffset + rewrittenHeader.byteLength,
  );
  return result;
}

function testKernelArchive(): Uint8Array {
  const module = new TextEncoder().encode(
    'module { public class Init() { public func hello_world() : Text { "ok" } } }',
  );
  const entry = hashContent(module);
  const files: Record<string, Uint8Array> = {
    "neutron.json": new TextEncoder().encode(
      JSON.stringify({
        format: 3,
        id: "kernel",
        name: "Test Kernel",
        version: 316,
        entry,
        func: {
          hello_world: { type: "update", async: false },
        },
      }),
    ),
    "web/index.html": new TextEncoder().encode("<main>test</main>"),
    "web/main.js": new TextEncoder().encode("console.log('test')"),
    [`mo/${entry}.mo`]: module,
    "connection-providers.json": testKernelConnectionProviderSupport(),
  };
  const chunks: Uint8Array[] = [Uint8Array.of(0x80 | Object.keys(files).length)];
  for (const [filename, content] of Object.entries(files)) {
    chunks.push(encodeMessagePackString(filename));
    chunks.push(encodeMessagePackBinary(new Uint8Array(gzipSync(content))));
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function testOrdinaryAppArchive(id: string, ready: boolean): Uint8Array {
  const encoder = new TextEncoder();
  const module = encoder.encode(
    'module { public class Init() { public func hello_world() : Text { "ok" } } }',
  );
  const entry = hashContent(module);
  const files: Record<string, Uint8Array> = {
    "neutron.json": encoder.encode(
      JSON.stringify({
        format: 3,
        id,
        name: id.replaceAll("_", " "),
        version: 100,
        entry,
        func: {
          hello_world: { type: "update", async: false },
        },
      }),
    ),
    "web/index.html": encoder.encode(`<main>${id}</main>`),
    [`mo/${entry}.mo`]: module,
    ...(ready
      ? {
          [NEUTRON_BROWSER_SURFACE_ORIGINS_MARKER_PATH]:
            browserSurfaceOriginsPackageMarkerBytes(),
        }
      : {}),
  };
  const chunks: Uint8Array[] = [Uint8Array.of(0x80 | Object.keys(files).length)];
  for (const [filename, content] of Object.entries(files)) {
    chunks.push(encodeMessagePackString(filename));
    chunks.push(encodeMessagePackBinary(new Uint8Array(gzipSync(content))));
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function encodeMessagePackString(value: string): Uint8Array {
  const content = Buffer.from(value, "utf8");
  if (content.byteLength < 32) {
    return new Uint8Array(Buffer.concat([Buffer.from([0xa0 | content.byteLength]), content]));
  }
  if (content.byteLength <= 0xff) {
    return new Uint8Array(Buffer.concat([Buffer.from([0xd9, content.byteLength]), content]));
  }
  throw new Error("Test MessagePack string is unexpectedly large");
}

function encodeMessagePackBinary(value: Uint8Array): Uint8Array {
  if (value.byteLength <= 0xff) {
    return new Uint8Array(
      Buffer.concat([Buffer.from([0xc4, value.byteLength]), value]),
    );
  }
  if (value.byteLength <= 0xffff) {
    return new Uint8Array(
      Buffer.concat([
        Buffer.from([0xc5, value.byteLength >>> 8, value.byteLength & 0xff]),
        value,
      ]),
    );
  }
  throw new Error("Test MessagePack binary is unexpectedly large");
}
