import { describe, expect, test } from "bun:test";
import type { Identity } from "@dfinity/agent";
import { Principal } from "@dfinity/principal";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { ASSEMBLER_ID } from "neutron-compiler/src/assemble.js";
import { preparePackageInstall } from "neutron-compiler/src/install.js";
import { hashContent } from "neutron-tools/src/hash.js";
import {
  assertSupportedCertificateVersions,
  SUPPORTED_CERTIFICATE_VERSIONS_METADATA_V1,
  withSupportedCertificateVersions,
} from "neutron-tools/src/wasm_metadata.js";
import {
  chunkWasm,
  sha256Hex,
  type PreparedDeployment,
} from "../src/artifact.ts";
import {
  createDeploymentEvidenceV1,
  createDeploymentObservationV1,
  persistDeploymentProofBundle,
  type DeploymentEvidenceProviderV1,
} from "../src/deployment_evidence.ts";
import { serializeTransactionPayload } from "../src/payload.ts";
import type { BlastIdentity } from "../src/identity.ts";
import {
  buildSessionPlan,
  type ProvisionOptions,
} from "../src/provision.ts";
import {
  runReinstall,
  type ReinstallClient,
  type ReinstallOptions,
} from "../src/reinstall.ts";
import {
  adoptionReceiptFingerprint,
  creationReceiptFingerprint,
  createProvisionJournal,
  currentDeployment,
  mainnetExecutionLockPath,
  readSession,
  writeSession,
  type AdoptionReceipt,
  type ProvisionJournal,
} from "../src/session.ts";
import { testKernelConnectionProviderSupport } from "./package_fixture.ts";

// Keep this deployer distinct from provision/session test files: Bun evaluates
// files in parallel and the production mutex is intentionally principal-wide.
const DEPLOYER = Principal.selfAuthenticating(
  new Uint8Array(32).fill(29),
).toText();
const SUBNET = Principal.selfAuthenticating(new Uint8Array(32).fill(19)).toText();
const CANISTER = "rrkah-fqaaa-aaaaa-aaaaq-cai";
const NOW = new Date("2026-07-19T12:00:00.000Z");
const SETTINGS = "33".repeat(32);
const CONFIG_SHA256 = "55".repeat(32);
const ADVANCED_CONFIG_SHA256 = "66".repeat(32);
const SOURCE_EXPECTED_PROOF = new TextEncoder().encode(
  "reinstall source expected registry proof",
);
const SOURCE_OBSERVED_PROOF = new TextEncoder().encode(
  "reinstall source observed registry proof",
);

describe("whole-canister reinstall", () => {
  test("programmatic calls require exact pins before identity, journal, archive, or network work", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "neutron-unpinned-reinstall-"));
    const calls = { identity: 0, prepare: 0, client: 0, evidence: 0 };
    try {
      const options = {
        configSha256: CONFIG_SHA256,
        host: "https://icp-api.io",
        identityId: 7,
        targetSubnet: SUBNET,
        sessionPath: path.join(root, "missing.ndeploy.session.json"),
        execute: true,
      } as unknown as ReinstallOptions;

      await expect(
        runReinstall(options, {
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
          logger: { log() {} },
        }),
      ).rejects.toThrow("exact format-3 pins");

      expect(calls).toEqual({
        identity: 0,
        prepare: 0,
        client: 0,
        evidence: 0,
      });
      await expect(stat(options.sessionPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("plans read-only without changing the unified journal", async () => {
    await withFixture(async (fixture) => {
      fixture.options.configSha256 = ADVANCED_CONFIG_SHA256;
      const before = await readFile(fixture.options.sessionPath);
      const result = await runReinstall(fixture.options, fixture.dependencies);
      expect(result.mode).toBe("plan");
      expect(result.plan.deploymentEvidenceExpected).toBeDefined();
      expect(result.plan.sourceDeploymentEvidence?.fingerprint).toBe(
        fixture.sourceEvidence.fingerprint,
      );
      expect(result.plan.wasmMetadata).toEqual(
        SUPPORTED_CERTIFICATE_VERSIONS_METADATA_V1,
      );
      expect(fixture.calls.evidence).toBe(1);
      expect(fixture.calls).toMatchObject({
        stop: 0,
        stage: 0,
        snapshots: 0,
        reinstall: 0,
        start: 0,
        seed: 0,
        access: 0,
        verify: 0,
      });
      expect(await readFile(fixture.options.sessionPath)).toEqual(before);
      expect(await activePayloads(fixture.options.sessionPath)).toEqual([]);
    });
  }, 20_000);

  test("reuses the canister and preserves its origin payment receipt", async () => {
    await withFixture(async (fixture) => {
      fixture.options.execute = true;
      fixture.options.configSha256 = ADVANCED_CONFIG_SHA256;
      const original = await readSession(fixture.options.sessionPath);

      const result = await runReinstall(fixture.options, fixture.dependencies);

      expect(result.mode).toBe("executed");
      expect(result.canisterId).toBe(CANISTER);
      expect(result.session.current).toMatchObject({
        kind: "reinstall",
        canisterId: CANISTER,
        completedAt: expect.any(String),
        planFingerprint: result.plan.fingerprint,
        wasmMetadata: SUPPORTED_CERTIFICATE_VERSIONS_METADATA_V1,
        sourceSessionFingerprint: original?.origin?.fingerprint,
        deploymentEvidence: {
          fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
        fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      expect(result.session.active).toBeUndefined();
      expect(result.session.configSha256).toBe(ADVANCED_CONFIG_SHA256);
      expect(result.session.origin).toEqual(original?.origin);
      expect(fixture.calls).toMatchObject({
        confirm: 1,
        stage: 1,
        stop: 1,
        snapshots: 3,
        reinstall: 1,
        start: 2,
        seed: 1,
        access: 1,
        verify: 1,
        evidence: 2,
      });
      expect(fixture.reinstallRequests).toEqual([
        {
          canisterId: CANISTER,
          previousModuleHash: fixture.source.transportWasmSha256,
          targetModuleHash: fixture.target.transportWasmSha256,
        },
      ]);
      expect(
        (await stat(fixture.options.sessionPath)).mode & 0o777,
      ).toBe(0o600);
      expect(await activePayloads(fixture.options.sessionPath)).toEqual([]);
    });
  }, 20_000);

  test("reinstalls from an adoption receipt without fabricating payment origin", async () => {
    await withFixture(async (fixture) => {
      const adoption = adoptionReceipt(fixture.source);
      const journal: ProvisionJournal = {
        schema: 3,
        configSha256: CONFIG_SHA256,
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
        runtime: { kind: "ic" },
        adoption,
      };
      await writeSession(fixture.options.sessionPath, journal, NOW);
      fixture.options.execute = true;
      fixture.options.configSha256 = ADVANCED_CONFIG_SHA256;

      const result = await runReinstall(
        fixture.options,
        fixture.dependencies,
      );

      expect(result.plan.sourceSessionFingerprint).toBe(adoption.fingerprint);
      expect(result.session.origin).toBeUndefined();
      expect(result.session.adoption).toEqual(adoption);
      expect(result.session.schema).toBe(3);
      expect(result.session.configSha256).toBe(ADVANCED_CONFIG_SHA256);
      expect(result.session.adoption?.configSha256).toBe(CONFIG_SHA256);
      expect(result.session.current).toMatchObject({
        kind: "reinstall",
        canisterId: CANISTER,
        planFingerprint: result.plan.fingerprint,
      });
      expect(result.session.active).toBeUndefined();
    });
  }, 20_000);

  test("resumes the immutable transaction without rebuilding or reinstalling twice", async () => {
    await withFixture(async (fixture) => {
      fixture.options.execute = true;
      let firstSeed = true;
      fixture.dependencies.seed = async () => {
        fixture.calls.seed += 1;
        if (firstSeed) {
          firstSeed = false;
          throw new Error("simulated asset upload interruption");
        }
      };
      await expect(
        runReinstall(fixture.options, fixture.dependencies),
      ).rejects.toThrow("asset upload interruption");
      expect(fixture.calls.reinstall).toBe(1);
      const interrupted = await readSession(fixture.options.sessionPath);
      expect(interrupted?.active?.kind).toBe("reinstall");
      expect(await activePayloads(fixture.options.sessionPath)).toHaveLength(1);

      fixture.options.configSha256 = ADVANCED_CONFIG_SHA256;
      await expect(
        runReinstall(fixture.options, fixture.dependencies),
      ).rejects.toThrow("active IC transaction is bound");
      fixture.options.configSha256 = CONFIG_SHA256;
      fixture.setStatus("stopped");
      fixture.dependencies.prepare = async () => {
        throw new Error("resume must not compile package archives");
      };
      const result = await runReinstall(fixture.options, fixture.dependencies);
      expect(result.session.current?.kind).toBe("reinstall");
      expect(result.session.active).toBeUndefined();
      expect(await activePayloads(fixture.options.sessionPath)).toEqual([]);
      expect(fixture.calls.reinstall).toBe(1);
      expect(fixture.calls.confirm).toBe(1);
      expect(fixture.calls.seed).toBe(2);
      expect(fixture.calls.start).toBe(3);
      expect(fixture.getStatus()).toBe("running");
    });
  }, 20_000);

  test("recovers when reinstall committed before its phase timestamp was written", async () => {
    await withFixture(async (fixture) => {
      fixture.options.execute = true;
      let loseReply = true;
      let physicalReinstalls = 0;
      fixture.client.reinstallChunkedWasm = async (request) => {
        fixture.calls.reinstall += 1;
        const targetHash = Buffer.from(request.transportWasmHash).toString(
          "hex",
        );
        if (fixture.getModuleHash() !== targetHash) {
          physicalReinstalls += 1;
          fixture.setModuleHash(targetHash);
        }
        if (loseReply) {
          loseReply = false;
          throw new Error("transport lost after physical reinstall");
        }
      };

      await expect(
        runReinstall(fixture.options, fixture.dependencies),
      ).rejects.toThrow("transport lost after physical reinstall");
      expect(physicalReinstalls).toBe(1);

      const result = await runReinstall(fixture.options, fixture.dependencies);
      expect(result.session.current?.kind).toBe("reinstall");
      expect(fixture.calls.reinstall).toBe(2);
      expect(physicalReinstalls).toBe(1);
      expect(fixture.calls.confirm).toBe(1);
    });
  }, 20_000);

  test("returns an originally stopped canister to the stopped state", async () => {
    await withFixture(async (fixture) => {
      fixture.options.execute = true;
      fixture.setStatus("stopped");
      const result = await runReinstall(fixture.options, fixture.dependencies);
      expect(result.plan.originalStatus).toBe("stopped");
      expect(result.session.current?.kind).toBe("reinstall");
      expect(result.session.active).toBeUndefined();
      expect(fixture.getStatus()).toBe("stopped");
      expect(fixture.calls.stop).toBe(2);
      expect(fixture.calls.start).toBe(1);
    });
  }, 20_000);

  test("starts a distinct operation for every completed reset without retaining payloads", async () => {
    await withFixture(async (fixture) => {
      fixture.options.execute = true;
      const creationBefore = (await readSession(fixture.options.sessionPath))?.origin;
      let builds = 0;
      fixture.dependencies.prepare = async (_paths, compileOptions) => {
        expect(compileOptions?.deploymentNonce).toMatch(/^[0-9a-f]{32}$/);
        builds += 1;
        const prepared = deployment(
          `repeat_${builds}`,
          new Uint8Array([0, 97, 115, 109, 20 + builds]),
        );
        prepared.packageArtifacts = fixture.options.expectedArtifacts.map(
          (artifact) => ({ ...artifact }),
        );
        return prepared;
      };

      const first = await runReinstall(fixture.options, fixture.dependencies);
      const second = await runReinstall(fixture.options, fixture.dependencies);
      expect(first.plan.deploymentNonce).not.toBe(second.plan.deploymentNonce);
      expect(first.plan.transportWasmSha256).not.toBe(
        second.plan.transportWasmSha256,
      );
      expect(fixture.calls.confirm).toBe(2);
      expect(fixture.calls.reinstall).toBe(2);
      expect(builds).toBe(2);
      expect(await activePayloads(fixture.options.sessionPath)).toEqual([]);
      expect((await readSession(fixture.options.sessionPath))?.origin).toEqual(
        creationBefore,
      );
    });
  }, 20_000);

  test("refuses live-state drift after confirmation before stopping", async () => {
    await withFixture(async (fixture) => {
      fixture.options.execute = true;
      fixture.dependencies.confirm = async () => {
        fixture.calls.confirm += 1;
        fixture.setSettingsFingerprint("44".repeat(32));
      };
      await expect(
        runReinstall(fixture.options, fixture.dependencies),
      ).rejects.toThrow("settings changed");
      expect(fixture.calls.stage).toBe(0);
      expect(fixture.calls.stop).toBe(0);
      expect(fixture.calls.reinstall).toBe(0);
      expect(fixture.getStatus()).toBe("running");
      expect((await readSession(fixture.options.sessionPath))?.active).toBeUndefined();
      expect(await activePayloads(fixture.options.sessionPath)).toEqual([]);
    });
  }, 20_000);

  test("leaves an installed reset resumable when observed registry facts drift", async () => {
    await withFixture(async (fixture) => {
      fixture.options.execute = true;
      const originalProvider =
        fixture.dependencies.deploymentEvidenceProvider!;
      fixture.dependencies.deploymentEvidenceProvider = {
        async observe(request) {
          const result = await originalProvider.observe(request);
          if (fixture.calls.evidence === 2) {
            return {
              ...result,
              observation: {
                ...result.observation,
                sevEnabled: true,
              },
            };
          }
          return result;
        },
      };

      await expect(
        runReinstall(fixture.options, fixture.dependencies),
      ).rejects.toThrow("observed sevEnabled does not match");
      const interrupted = await readSession(fixture.options.sessionPath);
      expect(interrupted?.active?.kind).toBe("reinstall");
      if (interrupted?.active?.kind !== "reinstall") {
        throw new Error("expected resumable reinstall");
      }
      expect(interrupted.active.state.wasmInstalledAt).toBeDefined();
      expect(interrupted.active.state.deploymentEvidence).toBeUndefined();
      expect(interrupted.active.state.verifiedAt).toBeUndefined();
      expect(fixture.calls.reinstall).toBe(1);

      fixture.dependencies.deploymentEvidenceProvider = originalProvider;
      const resumed = await runReinstall(
        fixture.options,
        fixture.dependencies,
      );
      expect(resumed.session.current?.kind).toBe("reinstall");
      if (resumed.session.current?.kind !== "reinstall") {
        throw new Error("expected completed reinstall");
      }
      expect(resumed.session.current.deploymentEvidence).toBeDefined();
      expect(fixture.calls.reinstall).toBe(1);
      expect(fixture.calls.evidence).toBe(3);
    });
  }, 20_000);

  test("re-verifies and reconciles run state after a pre-receipt interruption", async () => {
    await withFixture(async (fixture) => {
      fixture.options.execute = true;
      let failFinalSnapshotSweep = true;
      fixture.client.deleteAllCanisterSnapshots = async (canisterId) => {
        expect(canisterId).toBe(CANISTER);
        fixture.calls.snapshots += 1;
        if (fixture.calls.snapshots === 3 && failFinalSnapshotSweep) {
          failFinalSnapshotSweep = false;
          throw new Error("interrupted before receipt");
        }
        return 0;
      };

      await expect(
        runReinstall(fixture.options, fixture.dependencies),
      ).rejects.toThrow("interrupted before receipt");
      fixture.setStatus("stopped");

      const result = await runReinstall(fixture.options, fixture.dependencies);
      expect(result.session.current?.kind).toBe("reinstall");
      expect(result.session.active).toBeUndefined();
      expect(fixture.getStatus()).toBe("running");
      expect(fixture.calls.seed).toBe(1);
      expect(fixture.calls.verify).toBe(2);
      expect(fixture.calls.start).toBe(3);
    });
  }, 20_000);

  test("requires a completed creation receipt before building or calling the IC", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "neutron-reinstall-missing-"));
    try {
      let remoteCalls = 0;
      await expect(
        runReinstall(
          {
            configSha256: CONFIG_SHA256,
            host: "https://icp-api.io",
            identityId: 7,
            targetSubnet: SUBNET,
            sessionPath: path.join(
              root,
              "missing.ndeploy.session.json",
            ),
            expectedArtifacts: [
              {
                path: path.join(root, "kernel.neutron"),
                id: "kernel",
                version: 100,
                sha256: "1".repeat(64),
                bytes: 1,
              },
            ],
            execute: true,
          },
          {
            loadIdentity: async () => identity(),
            createClient: async () => {
              remoteCalls += 1;
              return {} as ReinstallClient;
            },
          },
        ),
      ).rejects.toThrow("existing provision journal");
      expect(remoteCalls).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("requires the certified Registry provider before contacting the IC", async () => {
    await withFixture(async (fixture) => {
      let remoteCalls = 0;
      delete fixture.dependencies.deploymentEvidenceProvider;
      fixture.dependencies.createClient = async () => {
        remoteCalls += 1;
        return fixture.client;
      };

      await expect(
        runReinstall(fixture.options, fixture.dependencies),
      ).rejects.toThrow("deployment evidence provider is required");
      expect(remoteCalls).toBe(0);
    });
  });
});

type Fixture = Awaited<ReturnType<typeof createFixture>>;

async function withFixture(run: (fixture: Fixture) => Promise<void>) {
  const fixture = await createFixture();
  try {
    await run(fixture);
  } finally {
    await rm(mainnetExecutionLockPath(DEPLOYER), { force: true });
    await rm(fixture.root, { recursive: true, force: true });
  }
}

async function createFixture() {
  await rm(mainnetExecutionLockPath(DEPLOYER), { force: true });
  const root = await mkdtemp(path.join(tmpdir(), "neutron-reinstall-test-"));
  const source = deployment("source", new Uint8Array([0, 97, 115, 109, 1]));
  const target = deployment("target", new Uint8Array([0, 97, 115, 109, 2]));
  const blastIdentity = identity();
  const sessionPath = path.join(root, "config.ndeploy.session.json");
  const sourcePayload = serializeTransactionPayload(source);
  const provisionOptions: ProvisionOptions = {
    configSha256: CONFIG_SHA256,
    host: "https://icp-api.io",
    identityId: blastIdentity.id,
    targetSubnet: SUBNET,
    amountE8s: 500_000_000n,
    expectedArtifacts: source.packageArtifacts,
    controllers: [],
    sessionPath,
    execute: true,
  };
  const sourcePlan = buildSessionPlan({
    options: provisionOptions,
    identity: blastIdentity,
    deployment: source,
    initialControllers: [DEPLOYER],
    payload: sourcePayload,
    deploymentEvidenceExpected: sourceDeploymentEvidence().expected,
  });
  const journal = createProvisionJournal(CONFIG_SHA256, sourcePlan, 10_000n, NOW);
  if (journal.active?.kind !== "create") throw new Error("expected creation");
  const creation = journal.active.state;
  creation.transfer.blockIndex = "42";
  creation.canisterId = CANISTER;
  creation.controllersVerifiedAt = NOW.toISOString();
  creation.wasmInstalledAt = NOW.toISOString();
  creation.assetsSeededAt = NOW.toISOString();
  creation.initialAccessVerifiedAt = NOW.toISOString();
  creation.deploymentEvidence = sourceDeploymentEvidence();
  creation.verifiedAt = NOW.toISOString();
  creation.fingerprint = creationReceiptFingerprint(creation);
  journal.origin = creation;
  journal.current = currentDeployment(
    "create",
    sourcePlan,
    CANISTER,
    NOW.toISOString(),
    creation.deploymentEvidence,
    creation.fingerprint,
  );
  delete journal.active;
  await persistDeploymentProofBundle(sessionPath, SOURCE_EXPECTED_PROOF);
  await persistDeploymentProofBundle(sessionPath, SOURCE_OBSERVED_PROOF);
  await writeSession(sessionPath, journal, NOW);

  const calls = {
    confirm: 0,
    stop: 0,
    stage: 0,
    snapshots: 0,
    reinstall: 0,
    start: 0,
    seed: 0,
    access: 0,
    verify: 0,
    evidence: 0,
  };
  let moduleHash = source.transportWasmSha256;
  let status: "running" | "stopped" = "running";
  let settingsFingerprint = SETTINGS;
  const reinstallRequests: Array<{
    canisterId: string;
    previousModuleHash: string;
    targetModuleHash: string;
  }> = [];
  const operational = () => ({
    status,
    version: 1n,
    cycles: 10_000_000_000_000n,
    moduleHash,
    settingsFingerprint,
    controllers: [CANISTER, DEPLOYER].sort(),
  });
  const client: ReinstallClient = {
    async certifiedState() {
      return {
        subnetId: SUBNET,
        controllers: [CANISTER, DEPLOYER].sort(),
        moduleHash,
      };
    },
    async operationalState() {
      return operational();
    },
    async ensureStopped() {
      calls.stop += 1;
      status = "stopped";
      return operational();
    },
    async stageWasmChunks({ canisterId }) {
      expect(canisterId).toBe(CANISTER);
      calls.stage += 1;
    },
    async deleteAllCanisterSnapshots(canisterId) {
      expect(canisterId).toBe(CANISTER);
      calls.snapshots += 1;
      return 0;
    },
    async ensureRunning() {
      calls.start += 1;
      status = "running";
      return operational();
    },
    async reinstallChunkedWasm(request) {
      calls.reinstall += 1;
      const targetModuleHash = Buffer.from(request.transportWasmHash).toString(
        "hex",
      );
      reinstallRequests.push({
        canisterId: request.canisterId,
        previousModuleHash: request.previousModuleHash,
        targetModuleHash,
      });
      moduleHash = targetModuleHash;
    },
    kernelActor() {
      return {} as ReturnType<ReinstallClient["kernelActor"]>;
    },
    async verifyInitialKernelAccess() {
      calls.access += 1;
    },
  };
  const options: ReinstallOptions = {
    configSha256: CONFIG_SHA256,
    host: "https://icp-api.io",
    identityId: blastIdentity.id,
    targetSubnet: SUBNET,
    sessionPath,
    expectedArtifacts: target.packageArtifacts,
    execute: false,
  };
  const dependencies: Parameters<typeof runReinstall>[1] = {
    loadIdentity: async () => blastIdentity,
    prepare: async (_paths, compileOptions) => {
      expect(compileOptions?.deploymentNonce).toMatch(/^[0-9a-f]{32}$/);
      return target;
    },
    createClient: async () => client,
    confirm: async ({ canisterId }) => {
      calls.confirm += 1;
      expect(canisterId).toBe(CANISTER);
    },
    seed: async () => {
      calls.seed += 1;
    },
    verify: async () => {
      calls.verify += 1;
    },
    deploymentEvidenceProvider: {
      async observe() {
        calls.evidence += 1;
        const call = calls.evidence;
        return {
          observation: {
            schema: 1,
            source: "ic_registry_certified_v1",
            subnetId: SUBNET,
            registryVersion: (100 + call).toString(),
            subnetType: "application",
            nodeCount: 13,
            sevEnabled: false,
            pricingProfile: "application_13_node",
            verifiedAt: new Date(NOW.getTime() + call).toISOString(),
          },
          proofBundle: new TextEncoder().encode(
            `reinstall registry proof ${call}`,
          ),
        };
      },
    } satisfies DeploymentEvidenceProviderV1,
    now: () => NOW,
    logger: { log() {} },
  };
  return {
    root,
    source,
    target,
    calls,
    reinstallRequests,
    options,
    dependencies,
    client,
    sourceEvidence: sourceDeploymentEvidence(),
    setStatus(value: "running" | "stopped") {
      status = value;
    },
    getStatus() {
      return status;
    },
    setModuleHash(value: string) {
      moduleHash = value;
    },
    getModuleHash() {
      return moduleHash;
    },
    setSettingsFingerprint(value: string) {
      settingsFingerprint = value;
    },
  };
}

function identity(): BlastIdentity {
  return {
    id: 7,
    principal: DEPLOYER,
    secretPath: "/home/test/.config/blast/secret",
    identity: {
      getPrincipal: () => Principal.fromText(DEPLOYER),
    } as Identity,
  };
}

function adoptionReceipt(
  source: PreparedDeployment,
): AdoptionReceipt {
  const base: Omit<AdoptionReceipt, "fingerprint"> = {
    kind: "adopted",
    adoptedAt: NOW.toISOString(),
    configSha256: CONFIG_SHA256,
    host: "https://icp-api.io",
    identityId: 7,
    deployerPrincipal: DEPLOYER,
    targetSubnet: SUBNET,
    canisterId: CANISTER,
    controllers: [CANISTER, DEPLOYER].sort(),
    status: "running",
    moduleHash: source.transportWasmSha256,
    settingsFingerprint: SETTINGS,
    runtime: {
      deploymentId: source.compiled.deploymentId,
      compilerId: source.compiled.compilerId,
      assemblerId: ASSEMBLER_ID,
      packages: [{ id: "kernel", version: 100 }],
    },
    access: {
      snapshotVersion: "1",
      authorizedPrincipals: [DEPLOYER],
      controllerLimit: "10",
    },
    deploymentEvidence: sourceDeploymentEvidence(),
  };
  return { ...base, fingerprint: adoptionReceiptFingerprint(base) };
}

function sourceDeploymentEvidence() {
  const expected = createDeploymentObservationV1(
    {
      schema: 1,
      source: "ic_registry_certified_v1",
      subnetId: SUBNET,
      registryVersion: "1",
      subnetType: "application",
      nodeCount: 13,
      sevEnabled: false,
      pricingProfile: "application_13_node",
      verifiedAt: NOW.toISOString(),
    },
    SOURCE_EXPECTED_PROOF,
  );
  const observed = createDeploymentObservationV1(
    {
      schema: 1,
      source: "ic_registry_certified_v1",
      subnetId: SUBNET,
      registryVersion: "2",
      subnetType: "application",
      nodeCount: 13,
      sevEnabled: false,
      pricingProfile: "application_13_node",
      verifiedAt: new Date(NOW.getTime() + 1).toISOString(),
    },
    SOURCE_OBSERVED_PROOF,
  );
  return createDeploymentEvidenceV1(expected, observed, {
    expected: SOURCE_EXPECTED_PROOF,
    observed: SOURCE_OBSERVED_PROOF,
  });
}

function deployment(
  name: string,
  marker: Uint8Array,
): PreparedDeployment {
  const archive = testKernelArchive();
  const rawWasm = withSupportedCertificateVersions(testWasm(marker));
  const transportWasm = new Uint8Array(gzipSync(rawWasm));
  return {
    packages: [preparePackageInstall(archive)],
    packageArchives: [archive],
    packageArtifacts: [
      {
        path: `/repo/apps/kernel/kernel.${name}.neutron`,
        id: "kernel",
        version: 100,
        sha256: sha256Hex(archive),
        bytes: archive.byteLength,
      },
    ],
    compiled: {
      wasm: rawWasm,
      candid: `service : { ${name}: () -> () }`,
      stable: `stable-${name}`,
      deploymentId: sha256Hex(new TextEncoder().encode(name)).slice(0, 32),
      compilerId: "compiler-test",
    },
    wasmMetadata: assertSupportedCertificateVersions(rawWasm),
    transportWasm,
    rawWasmSha256: sha256Hex(rawWasm),
    transportWasmSha256: sha256Hex(transportWasm),
    candidSha256: sha256Hex(
      new TextEncoder().encode(`service : { ${name}: () -> () }`),
    ),
    stableSha256: sha256Hex(new TextEncoder().encode(`stable-${name}`)),
    chunks: chunkWasm(transportWasm),
  };
}

function testWasm(marker: Uint8Array): Uint8Array {
  const name = new TextEncoder().encode("test");
  const payloadBytes = 1 + name.byteLength + marker.byteLength;
  if (payloadBytes >= 0x80) throw new Error("Test Wasm marker is too large");
  const wasm = new Uint8Array(8 + 2 + payloadBytes);
  wasm.set([0, 97, 115, 109, 1, 0, 0, 0]);
  let offset = 8;
  wasm[offset++] = 0;
  wasm[offset++] = payloadBytes;
  wasm[offset++] = name.byteLength;
  wasm.set(name, offset);
  offset += name.byteLength;
  wasm.set(marker, offset);
  return wasm;
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
        version: 100,
        entry,
        func: { hello_world: { type: "update", async: false } },
      }),
    ),
    "web/index.html": new TextEncoder().encode("<main>test</main>"),
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

function encodeMessagePackString(value: string): Uint8Array {
  const content = Buffer.from(value, "utf8");
  if (content.byteLength < 32) {
    return new Uint8Array(
      Buffer.concat([Buffer.from([0xa0 | content.byteLength]), content]),
    );
  }
  if (content.byteLength <= 0xff) {
    return new Uint8Array(
      Buffer.concat([Buffer.from([0xd9, content.byteLength]), content]),
    );
  }
  throw new Error("Test MessagePack string is unexpectedly large");
}

function encodeMessagePackBinary(value: Uint8Array): Uint8Array {
  if (value.byteLength <= 0xff) {
    return new Uint8Array(
      Buffer.concat([Buffer.from([0xc4, value.byteLength]), value]),
    );
  }
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0xc5, value.byteLength >>> 8, value.byteLength & 0xff]),
      value,
    ]),
  );
}

async function activePayloads(sessionPath: string): Promise<string[]> {
  const directory = path.join(path.dirname(sessionPath), ".neutron", "provision");
  try {
    return (await readdir(directory)).filter((name) => name.endsWith(".payload-v3"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
