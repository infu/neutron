import { describe, expect, test } from "bun:test";
import type { Identity } from "@dfinity/agent";
import { Principal } from "@dfinity/principal";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ASSEMBLER_ID } from "neutron-compiler/src/assemble.js";
import type { KernelRuntimeInfo } from "neutron-compiler/src/install.js";
import {
  runAdopt,
  type AdoptClient,
  type AdoptOptions,
} from "../src/adopt.ts";
import {
  DEPLOYMENT_OBSERVATION_SCHEMA_V1,
  DEPLOYMENT_OBSERVATION_SOURCE_V1,
  DEPLOYMENT_PRICING_PROFILE_V1,
  deploymentProofBundlePath,
  type DeploymentObservationClaimsV1,
} from "../src/deployment_evidence.ts";
import type { BlastIdentity } from "../src/identity.ts";
import type {
  CanisterOperationalState,
  CertifiedCanisterState,
  KernelAccessSnapshot,
} from "../src/ic_client.ts";
import { MAX_PACKAGE_ARCHIVES } from "../src/artifact.ts";
import {
  mainnetExecutionLockPath,
  PROVISION_JOURNAL_SCHEMA,
  readSession,
} from "../src/session.ts";
// Keep this deployer distinct from the other provisioner fixtures: the
// production mutex is intentionally principal-wide and test files run in
// parallel.
const DEPLOYER = Principal.selfAuthenticating(
  new Uint8Array(32).fill(43),
).toText();
const SUBNET = Principal.selfAuthenticating(new Uint8Array(32).fill(44)).toText();
const CANISTER = "rrkah-fqaaa-aaaaa-aaaaq-cai";
const CONTROLLERS = [CANISTER, DEPLOYER].sort();
const CONFIG_SHA256 = "11".repeat(32);
const MODULE_HASH = "22".repeat(32);
const SETTINGS_FINGERPRINT = "33".repeat(32);
const NOW = new Date("2026-07-23T12:00:00.000Z");

describe("schema-3 production adoption", () => {
  test("rejects a live app inventory above the product ceiling", async () => {
    await withFixture(async (fixture) => {
      const current = runtimeInfo();
      const template = current.apps[0]!;
      const kernel = current.apps[1]!;
      fixture.behavior.runtime = () => ({
        ...current,
        apps: [
          kernel,
          ...Array.from({ length: MAX_PACKAGE_ARCHIVES }, (_, index) => ({
            ...template,
            scope: {
              app_id: `app${index.toString().padStart(3, "0")}`,
              installation_uid: BigInt(index + 2),
            },
          })),
        ],
      });

      await expect(
        runAdopt(fixture.options, fixture.dependencies),
      ).rejects.toThrow("app inventory exceeds the adoption limit");
      expect(await exists(fixture.options.sessionPath)).toBe(false);
    });
  });

  test("rejects a predecessor or foreign assembler before adoption", async () => {
    await withFixture(async (fixture) => {
      const current = runtimeInfo();
      fixture.behavior.runtime = () => ({
        ...current,
        assembler_id: "neutron_actor_v24",
      });

      await expect(
        runAdopt(fixture.options, fixture.dependencies),
      ).rejects.toThrow(
        `Kernel runtime assembler neutron_actor_v24 does not match ${ASSEMBLER_ID}`,
      );
      expect(await exists(fixture.options.sessionPath)).toBe(false);
    });
  });

  test("plans from live evidence without writing a receipt", async () => {
    await withFixture(async (fixture) => {
      const result = await runAdopt(fixture.options, fixture.dependencies);

      expect(result.mode).toBe("plan");
      expect(result.canisterId).toBe(CANISTER);
      expect(result.session).toBeNull();
      expect(result.receipt).toMatchObject({
        kind: "adopted",
        adoptedAt: NOW.toISOString(),
        configSha256: CONFIG_SHA256,
        identityId: fixture.identity.id,
        deployerPrincipal: DEPLOYER,
        targetSubnet: SUBNET,
        canisterId: CANISTER,
        controllers: CONTROLLERS,
        moduleHash: MODULE_HASH,
        settingsFingerprint: SETTINGS_FINGERPRINT,
        runtime: {
          deploymentId: "live-deployment",
          compilerId: "live-compiler",
          assemblerId: ASSEMBLER_ID,
          packages: [
            { id: "kernel", version: 100 },
            { id: "mail", version: 101 },
          ],
        },
        access: {
          snapshotVersion: "7",
          authorizedPrincipals: [DEPLOYER],
          controllerLimit: "10",
        },
        deploymentEvidence: {
          schema: 1,
          expected: {
            registryVersion: "7",
            evidenceSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
            fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
          },
          observed: {
            registryVersion: "8",
            evidenceSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
            fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
          },
          fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
        fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      expect(fixture.calls).toEqual({
        identity: 1,
        createClient: 1,
        certified: 2,
        operational: 2,
        runtime: 1,
        access: 1,
        evidence: 2,
      });
      expect(await exists(fixture.options.sessionPath)).toBe(false);
    });
  });

  test("executes only after a second proof and writes a mode-0600 adoption journal", async () => {
    await withFixture(async (fixture) => {
      fixture.options.execute = true;

      const result = await runAdopt(fixture.options, fixture.dependencies);

      expect(result.mode).toBe("executed");
      expect(fixture.calls).toEqual({
        identity: 1,
        createClient: 1,
        certified: 4,
        operational: 4,
        runtime: 2,
        access: 2,
        evidence: 2,
      });
      expect((await stat(fixture.options.sessionPath)).mode & 0o777).toBe(0o600);

      const journal = await readSession(fixture.options.sessionPath);
      expect(journal).not.toBeNull();
      expect(journal).toEqual(result.session);
      expect(journal).toMatchObject({
        schema: PROVISION_JOURNAL_SCHEMA,
        configSha256: CONFIG_SHA256,
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
        runtime: { kind: "ic" },
        adoption: result.receipt,
      });
      expect(journal?.origin).toBeUndefined();
      expect(journal?.current).toBeUndefined();
      expect(journal?.active).toBeUndefined();
      if (!journal?.adoption) throw new Error("expected adoption receipt");
      expect(journal.adoption.fingerprint).toBe(result.receipt.fingerprint);
      const evidence = journal.adoption.deploymentEvidence;
      if (!evidence) throw new Error("expected deployment evidence");
      expect(
        (await stat(
          deploymentProofBundlePath(
            fixture.options.sessionPath,
            evidence.expected.evidenceSha256,
          ),
        )).mode & 0o777,
      ).toBe(0o400);
      expect(
        (await stat(
          deploymentProofBundlePath(
            fixture.options.sessionPath,
            evidence.observed.evidenceSha256,
          ),
        )).mode & 0o777,
      ).toBe(0o400);
    });
  });

  test("accepts a newer compatible registry proof for the final receipt", async () => {
    await withFixture(async (fixture) => {
      fixture.options.execute = true;
      fixture.behavior.evidence = (call) =>
        evidenceObservation(
          call === 1 ? "41" : "73",
          call === 1
            ? new Date(NOW.getTime() - 1_000).toISOString()
            : NOW.toISOString(),
        );

      const result = await runAdopt(fixture.options, fixture.dependencies);

      expect(result.receipt.deploymentEvidence?.expected.registryVersion).toBe(
        "41",
      );
      expect(result.receipt.deploymentEvidence?.observed.registryVersion).toBe(
        "73",
      );
      expect(
        result.receipt.deploymentEvidence?.expected.evidenceSha256,
      ).not.toBe(
        result.receipt.deploymentEvidence?.observed.evidenceSha256,
      );
      expect(fixture.calls.evidence).toBe(2);
    });
  });

  test("rejects incompatible observed registry placement without writing a receipt", async () => {
    await withFixture(async (fixture) => {
      fixture.options.execute = true;
      fixture.behavior.evidence = (call) => ({
        ...evidenceObservation(call === 1 ? "7" : "8", NOW.toISOString()),
        sevEnabled: call !== 1,
      });

      await expect(
        runAdopt(fixture.options, fixture.dependencies),
      ).rejects.toThrow("observed sevEnabled does not match");

      expect(fixture.calls.evidence).toBe(2);
      expect(await exists(fixture.options.sessionPath)).toBe(false);
    });
  });

  test("does not write a receipt when the second live proof changes", async () => {
    await withFixture(async (fixture) => {
      fixture.options.execute = true;
      fixture.behavior.runtime = (call) => ({
        ...runtimeInfo(),
        compiler_id: call === 2 ? "changed-compiler" : "live-compiler",
      });

      await expect(
        runAdopt(fixture.options, fixture.dependencies),
      ).rejects.toThrow("Adoption evidence changed before the receipt could be written");

      expect(fixture.calls.runtime).toBe(2);
      expect(fixture.calls.access).toBe(2);
      expect(fixture.calls.evidence).toBe(2);
      expect(await exists(fixture.options.sessionPath)).toBe(false);
    });
  });

  test("rechecks canister state after the final registry proof", async () => {
    await withFixture(async (fixture) => {
      fixture.options.execute = true;
      fixture.behavior.evidence = (call) => {
        if (call === 2) {
          fixture.behavior.operational = () => ({
            ...operationalState(),
            settingsFingerprint: "44".repeat(32),
          });
        }
        return evidenceObservation(
          call === 1 ? "7" : "8",
          NOW.toISOString(),
        );
      };

      await expect(
        runAdopt(fixture.options, fixture.dependencies),
      ).rejects.toThrow(
        "Adoption evidence changed before the receipt could be written",
      );
      expect(fixture.calls.evidence).toBe(2);
      expect(await exists(fixture.options.sessionPath)).toBe(false);
    });
  });

  test("rejects an existing session before creating a remote client", async () => {
    await withFixture(async (fixture) => {
      fixture.options.execute = true;
      await runAdopt(fixture.options, fixture.dependencies);
      resetCalls(fixture.calls);
      fixture.options.execute = false;

      await expect(
        runAdopt(fixture.options, fixture.dependencies),
      ).rejects.toThrow("Adoption requires an empty deployment session");

      expect(fixture.calls).toEqual({
        identity: 1,
        createClient: 0,
        certified: 0,
        operational: 0,
        runtime: 0,
        access: 0,
        evidence: 0,
      });
    });
  });

  test("rejects live state that changes during one proof", async () => {
    await withFixture(async (fixture) => {
      fixture.behavior.operational = (call) => ({
        ...operationalState(),
        settingsFingerprint:
          call === 2 ? "44".repeat(32) : SETTINGS_FINGERPRINT,
      });

      await expect(
        runAdopt(fixture.options, fixture.dependencies),
      ).rejects.toThrow("Canister state changed during adoption verification");

      expect(await exists(fixture.options.sessionPath)).toBe(false);
    });
  });

  test("rejects live controller evidence that omits self-control", async () => {
    await withFixture(async (fixture) => {
      const controllers = [DEPLOYER];
      fixture.behavior.certified = () => ({
        ...certifiedState(),
        controllers,
      });
      fixture.behavior.operational = () => ({
        ...operationalState(),
        controllers,
      });

      await expect(
        runAdopt(fixture.options, fixture.dependencies),
      ).rejects.toThrow("Live controllers do not exactly match");

      expect(fixture.calls.runtime).toBe(0);
      expect(fixture.calls.access).toBe(0);
      expect(await exists(fixture.options.sessionPath)).toBe(false);
    });
  });

  test("rejects runtime inventory that does not belong to its deployment", async () => {
    await withFixture(async (fixture) => {
      const runtime = runtimeInfo();
      fixture.behavior.runtime = () => ({
        ...runtime,
        apps: runtime.apps.map((app) =>
          app.scope.app_id === "mail"
            ? { ...app, deployment_id: "different-deployment" }
            : app,
        ),
      });

      await expect(
        runAdopt(fixture.options, fixture.dependencies),
      ).rejects.toThrow(
        "Kernel runtime app mail does not match runtime deployment live-deployment",
      );

      expect(await exists(fixture.options.sessionPath)).toBe(false);
    });
  });

  test("rejects access evidence whose controllers drift from certified state", async () => {
    await withFixture(async (fixture) => {
      fixture.behavior.access = () => ({
        ...accessSnapshot(),
        controllers: [DEPLOYER],
      });

      await expect(
        runAdopt(fixture.options, fixture.dependencies),
      ).rejects.toThrow(
        "Kernel access controllers do not match certified controllers",
      );

      expect(await exists(fixture.options.sessionPath)).toBe(false);
    });
  });
});

type Calls = {
  identity: number;
  createClient: number;
  certified: number;
  operational: number;
  runtime: number;
  access: number;
  evidence: number;
};

type Behavior = {
  certified: (call: number) => CertifiedCanisterState;
  operational: (call: number) => CanisterOperationalState;
  runtime: (call: number) => KernelRuntimeInfo;
  access: (call: number) => KernelAccessSnapshot;
  evidence: (call: number) => DeploymentObservationClaimsV1;
};

type Fixture = {
  root: string;
  options: AdoptOptions;
  identity: BlastIdentity;
  calls: Calls;
  behavior: Behavior;
  dependencies: Parameters<typeof runAdopt>[1];
};

async function withFixture(
  run: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const fixture = await createFixture();
  try {
    await run(fixture);
  } finally {
    await rm(mainnetExecutionLockPath(DEPLOYER), { force: true });
    await rm(fixture.root, { recursive: true, force: true });
  }
}

async function createFixture(): Promise<Fixture> {
  await rm(mainnetExecutionLockPath(DEPLOYER), { force: true });
  const root = await mkdtemp(path.join(tmpdir(), "neutron-adopt-test-"));
  const identity: BlastIdentity = {
    id: 17,
    principal: DEPLOYER,
    secretPath: "/home/test/.config/blast/secret",
    identity: {
      getPrincipal: () => Principal.fromText(DEPLOYER),
    } as Identity,
  };
  const calls: Calls = {
    identity: 0,
    createClient: 0,
    certified: 0,
    operational: 0,
    runtime: 0,
    access: 0,
    evidence: 0,
  };
  const behavior: Behavior = {
    certified: () => certifiedState(),
    operational: () => operationalState(),
    runtime: () => runtimeInfo(),
    access: () => accessSnapshot(),
    evidence: (call) =>
      evidenceObservation(
        call === 1 ? "7" : "8",
        call === 1
          ? new Date(NOW.getTime() - 1_000).toISOString()
          : NOW.toISOString(),
      ),
  };
  const client: AdoptClient = {
    async certifiedState(canisterId) {
      expect(canisterId).toBe(CANISTER);
      calls.certified += 1;
      return behavior.certified(calls.certified);
    },
    async operationalState(canisterId) {
      expect(canisterId).toBe(CANISTER);
      calls.operational += 1;
      return behavior.operational(calls.operational);
    },
    kernelActor(canisterId) {
      expect(canisterId).toBe(CANISTER);
      return {
        async kernel_runtime_info() {
          calls.runtime += 1;
          return behavior.runtime(calls.runtime);
        },
      } as ReturnType<AdoptClient["kernelActor"]>;
    },
    async kernelAccessSnapshot(canisterId) {
      expect(canisterId).toBe(CANISTER);
      calls.access += 1;
      return behavior.access(calls.access);
    },
  };
  const options: AdoptOptions = {
    configSha256: CONFIG_SHA256,
    host: "https://icp-api.io",
    identityId: identity.id,
    targetSubnet: SUBNET,
    controllers: [],
    canisterId: CANISTER,
    sessionPath: path.join(root, "config.ndeploy.session.json"),
    execute: false,
  };
  const dependencies: Parameters<typeof runAdopt>[1] = {
    loadIdentity: async (id) => {
      calls.identity += 1;
      expect(id).toBe(identity.id);
      return identity;
    },
    createClient: async ({ host, identity: loadedIdentity }) => {
      calls.createClient += 1;
      expect(host).toBe(options.host);
      expect(loadedIdentity).toBe(identity.identity);
      return client;
    },
    deploymentEvidenceProvider: {
      async observe({ subnetId }) {
        expect(subnetId).toBe(SUBNET);
        calls.evidence += 1;
        return {
          observation: behavior.evidence(calls.evidence),
          proofBundle: Uint8Array.of(
            0x4e,
            0x45,
            0x55,
            0x54,
            calls.evidence,
          ),
        };
      },
    },
    now: () => NOW,
    logger: { log() {} },
  };
  return { root, options, identity, calls, behavior, dependencies };
}

function certifiedState(): CertifiedCanisterState {
  return {
    subnetId: SUBNET,
    controllers: [...CONTROLLERS],
    moduleHash: MODULE_HASH,
  };
}

function operationalState(): CanisterOperationalState {
  return {
    status: "running",
    version: 9n,
    cycles: 5_000_000_000_000n,
    moduleHash: MODULE_HASH,
    settingsFingerprint: SETTINGS_FINGERPRINT,
    controllers: [...CONTROLLERS],
  };
}

function runtimeInfo(): KernelRuntimeInfo {
  return {
    deployment_id: "live-deployment",
    assembler_id: ASSEMBLER_ID,
    compiler_id: "live-compiler",
    apps: [
      {
        scope: { app_id: "mail", installation_uid: 2n },
        version: 101n,
        deployment_id: "live-deployment",
        capability_plan_fingerprint: "mail-plan",
        browser_origin_nonce: "11".repeat(16),
        browser_origin_authority_epoch: 1n,
        resident_frame_security: { credentialless_opaque_v1: null },
      },
      {
        scope: { app_id: "kernel", installation_uid: 1n },
        version: 100n,
        deployment_id: "live-deployment",
        capability_plan_fingerprint: "kernel-plan",
        browser_origin_nonce: "00".repeat(16),
        browser_origin_authority_epoch: 1n,
        resident_frame_security: { persistent_dedicated_v1: null },
      },
    ],
    memories: [],
  };
}

function accessSnapshot(): KernelAccessSnapshot {
  return {
    snapshotVersion: 7n,
    authorizedPrincipals: [DEPLOYER],
    controllers: [...CONTROLLERS],
    selfPrincipal: CANISTER,
    controllerLimit: 10n,
  };
}

function resetCalls(calls: Calls): void {
  calls.identity = 0;
  calls.createClient = 0;
  calls.certified = 0;
  calls.operational = 0;
  calls.runtime = 0;
  calls.access = 0;
  calls.evidence = 0;
}

function evidenceObservation(
  registryVersion: string,
  verifiedAt: string,
): DeploymentObservationClaimsV1 {
  return {
    schema: DEPLOYMENT_OBSERVATION_SCHEMA_V1,
    source: DEPLOYMENT_OBSERVATION_SOURCE_V1,
    subnetId: SUBNET,
    registryVersion,
    subnetType: "application",
    nodeCount: 13,
    sevEnabled: false,
    pricingProfile: DEPLOYMENT_PRICING_PROFILE_V1,
    verifiedAt,
  };
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}
