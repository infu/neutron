import { Principal } from "@dfinity/principal";
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SUPPORTED_CERTIFICATE_VERSIONS_METADATA_V1 } from "neutron-tools/src/wasm_metadata.js";
import { ASSEMBLER_ID } from "neutron-compiler/src/assemble.js";
import { MAX_PACKAGE_ARCHIVES } from "../src/artifact.ts";
import {
  createDeploymentEvidenceV1,
  createDeploymentObservationV1,
  persistDeploymentProofBundle,
} from "../src/deployment_evidence.ts";
import {
  adoptionReceiptFingerprint,
  assertSessionMatchesPlan,
  createProvisionJournal,
  mainnetExecutionLockPath,
  readSession,
  sessionPlanFingerprint,
  withMainnetExecutionLock,
  withSessionLock,
  writeSession,
  type AdoptionReceipt,
  type ProvisionJournal,
  type SessionPlan,
} from "../src/session.ts";
const DEPLOYER = Principal.selfAuthenticating(new Uint8Array(32).fill(29)).toText();
const SUBNET = Principal.selfAuthenticating(new Uint8Array(32).fill(19)).toText();
const NOW = new Date("2026-07-19T12:00:00.000Z");
const CONFIG_SHA256 = "c".repeat(64);
const CANISTER = "rrkah-fqaaa-aaaaa-aaaaq-cai";

describe("provision journal locking", () => {
  test("serializes one config journal", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "neutron-journal-lock-"));
    const sessionPath = path.join(root, "config.ndeploy.session.json");
    let announceEntered!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      announceEntered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const first = withSessionLock(sessionPath, async () => {
        announceEntered();
        return held;
      });
      await entered;
      await expect(withSessionLock(sessionPath, async () => undefined)).rejects.toThrow(
        "locked by another process",
      );
      await expect(stat(`${sessionPath}.lock`)).resolves.toBeDefined();
      release();
      await first;
      await expect(withSessionLock(sessionPath, async () => "ok")).resolves.toBe("ok");
    } finally {
      release();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("retires a stale process-identity lock after a hard interruption", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "neutron-journal-stale-lock-"));
    const sessionPath = path.join(root, "config.ndeploy.session.json");
    const lockPath = `${sessionPath}.lock`;
    try {
      // Reusing this live PID with a deliberately different start identity
      // proves that PID reuse cannot keep an abandoned lock alive.
      await writeRaw(lockPath, {
        schema: 1,
        pid: process.pid,
        processIdentity: `stale:${process.pid}:previous-start`,
        nonce: "a".repeat(32),
        acquiredAt: NOW.toISOString(),
      });

      await expect(
        withSessionLock(sessionPath, async () => "recovered"),
      ).resolves.toBe("recovered");
      await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses an unsafe stale-lock symlink", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "neutron-journal-symlink-lock-"));
    const sessionPath = path.join(root, "config.ndeploy.session.json");
    const target = path.join(root, "lock-target.json");
    try {
      await writeRaw(target, {
        schema: 1,
        pid: process.pid,
        processIdentity: "stale",
        nonce: "b".repeat(32),
        acquiredAt: NOW.toISOString(),
      });
      await symlink(target, `${sessionPath}.lock`);
      await expect(
        withSessionLock(sessionPath, async () => undefined),
      ).rejects.toThrow("Refusing symlink provision lock");
      expect(JSON.parse(await readFile(target, "utf8"))).toMatchObject({
        nonce: "b".repeat(32),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("serializes mainnet execution by deployer across journal paths", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const first = withMainnetExecutionLock(DEPLOYER, async () => held);
      await new Promise((resolve) => setTimeout(resolve, 10));
      await expect(
        withMainnetExecutionLock(DEPLOYER, async () => "other"),
      ).rejects.toThrow("already running for deployer");
      release();
      await first;
    } finally {
      release();
      await rm(mainnetExecutionLockPath(DEPLOYER), { force: true });
    }
  });
});

describe("provision journal integrity and schema compatibility", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("fingerprints semantic intent rather than checkout paths or gateway", () => {
    const original = validPlan("/checkout-one");
    const movedBase = {
      ...original,
      host: "https://ic0.app",
      identityId: 7,
      packages: original.packages.map((pkg) => ({
        ...pkg,
        path: `/checkout-two/${path.basename(pkg.path)}`,
      })),
    };
    const moved = { ...movedBase, fingerprint: sessionPlanFingerprint(movedBase) };
    expect(moved.fingerprint).toBe(original.fingerprint);
    expect(() =>
      assertSessionMatchesPlan(
        createProvisionJournal(CONFIG_SHA256, original, 10_000n, NOW),
        moved,
      ),
    ).not.toThrow();

    const wrongMetadata = {
      ...original,
      wasmMetadata: { ...original.wasmMetadata, value: "1" as "2" },
    };
    expect(() => sessionPlanFingerprint(wrongMetadata)).toThrow(
      "creation plan.wasmMetadata",
    );

    const evidenceBound = {
      ...original,
      deploymentEvidenceExpected: {
        ...original.deploymentEvidenceExpected,
        fingerprint: "a".repeat(64),
      },
    };
    const changedEvidence = {
      ...evidenceBound,
      deploymentEvidenceExpected: {
        ...evidenceBound.deploymentEvidenceExpected,
        fingerprint: "b".repeat(64),
      },
    };
    expect(sessionPlanFingerprint(evidenceBound)).not.toBe(
      sessionPlanFingerprint(changedEvidence),
    );
  });

  test("writes one private atomic JSON journal", async () => {
    const root = await temporaryRoot(roots);
    const sessionPath = path.join(root, "nested", "config.ndeploy.session.json");
    const journal = createProvisionJournal(CONFIG_SHA256, validPlan(root), 10_000n, NOW);
    await persistDeploymentProofBundle(sessionPath, EXPECTED_PROOF);
    await writeSession(sessionPath, journal, NOW);
    expect((await stat(sessionPath)).mode & 0o777).toBe(0o600);
    expect(await readSession(sessionPath)).toEqual(journal);
    expect(JSON.parse(await readFile(sessionPath, "utf8"))).toMatchObject({
      schema: 3,
      configSha256: CONFIG_SHA256,
      runtime: { kind: "ic" },
      active: { kind: "create" },
    });
  });

  test("rejects legacy, unknown, and tampered state", async () => {
    const root = await temporaryRoot(roots);
    const sessionPath = path.join(root, "config.ndeploy.session.json");
    const journal = createProvisionJournal(CONFIG_SHA256, validPlan(root), 10_000n, NOW);

    await writeRaw(sessionPath, { ...journal, schema: 1 });
    await expect(readSession(sessionPath)).rejects.toThrow("Unsupported provision journal schema");
    await writeRaw(sessionPath, { ...journal, schema: 2 });
    await expect(readSession(sessionPath)).rejects.toThrow("Unsupported provision journal schema");

    await writeRaw(sessionPath, { ...journal, surprise: true });
    await expect(readSession(sessionPath)).rejects.toThrow("unknown field");

    if (journal.active?.kind !== "create") throw new Error("expected create");
    journal.active.state.plan.amountE8s = "600000000";
    await writeRaw(sessionPath, journal);
    await expect(readSession(sessionPath)).rejects.toThrow("fingerprint");

    const metadataJournal = createProvisionJournal(
      CONFIG_SHA256,
      validPlan(root),
      10_000n,
      NOW,
    );
    if (metadataJournal.active?.kind !== "create") {
      throw new Error("expected create");
    }
    metadataJournal.active.state.plan.wasmMetadata = {
      ...SUPPORTED_CERTIFICATE_VERSIONS_METADATA_V1,
      value: "1" as "2",
    };
    metadataJournal.active.state.plan.fingerprint = "8".repeat(64);
    await writeRaw(sessionPath, metadataJournal);
    await expect(readSession(sessionPath)).rejects.toThrow("wasmMetadata");
  });

  test("rejects a schema-3 package array above the product ceiling", async () => {
    const root = await temporaryRoot(roots);
    const sessionPath = path.join(root, "config.ndeploy.session.json");
    const journal = createProvisionJournal(
      CONFIG_SHA256,
      validPlan(root),
      10_000n,
      NOW,
    );
    if (journal.active?.kind !== "create") throw new Error("expected create");
    const template = journal.active.state.plan.packages[0]!;
    journal.active.state.plan.packages = Array.from(
      { length: MAX_PACKAGE_ARCHIVES + 1 },
      (_, index) => ({
        ...template,
        path: path.resolve(root, `app-${index}.neutron`),
        id: index === 0 ? "kernel" : `app${index.toString().padStart(3, "0")}`,
      }),
    );

    await writeRaw(sessionPath, journal);
    await expect(readSession(sessionPath)).rejects.toThrow(
      "must be a non-empty bounded array",
    );
  });

  test("refuses symlink and non-private journal files", async () => {
    const root = await temporaryRoot(roots);
    const actual = path.join(root, "actual.ndeploy.session.json");
    const linked = path.join(root, "linked.ndeploy.session.json");
    await writeRaw(
      actual,
      createProvisionJournal(CONFIG_SHA256, validPlan(root), 10_000n, NOW),
    );
    await symlink(actual, linked);
    await expect(readSession(linked)).rejects.toThrow("Refusing symlink");
    await chmod(actual, 0o644);
    await expect(readSession(actual)).rejects.toThrow("mode 0600");
  });

  test("round-trips a live-verified adoption-only journal", async () => {
    const root = await temporaryRoot(roots);
    const sessionPath = path.join(root, "config.ndeploy.session.json");
    const journal = validAdoptionJournal();
    await persistEvidenceArtifacts(sessionPath);
    await writeSession(sessionPath, journal, NOW);
    expect(await readSession(sessionPath)).toEqual(journal);
    expect((await stat(sessionPath)).mode & 0o777).toBe(0o600);
    expect(journal).toMatchObject({
      schema: 3,
      runtime: { kind: "ic" },
      adoption: {
        kind: "adopted",
        canisterId: CANISTER,
      },
    });
    expect(journal.origin).toBeUndefined();
    expect(journal.current).toBeUndefined();
    expect(journal.active).toBeUndefined();
  });

  test("rejects tampered or structurally conflicting adoption receipts", async () => {
    const root = await temporaryRoot(roots);
    const sessionPath = path.join(root, "config.ndeploy.session.json");

    const tampered = validAdoptionJournal();
    tampered.adoption!.moduleHash = "f".repeat(64);
    await writeRaw(sessionPath, tampered);
    await expect(readSession(sessionPath)).rejects.toThrow("fingerprint");

    const activeCreation = createProvisionJournal(
      CONFIG_SHA256,
      validPlan(root),
      10_000n,
      NOW,
    );
    activeCreation.adoption = validAdoptionReceipt();
    await writeRaw(sessionPath, activeCreation);
    await expect(readSession(sessionPath)).rejects.toThrow(
      "adoption cannot coexist with a creation",
    );

    const obsoleteAssembler = validAdoptionJournal();
    obsoleteAssembler.adoption!.runtime.assemblerId = "neutron_actor_v24";
    obsoleteAssembler.adoption!.fingerprint = adoptionReceiptFingerprint(
      obsoleteAssembler.adoption!,
    );
    await writeRaw(sessionPath, obsoleteAssembler);
    await expect(readSession(sessionPath)).rejects.toThrow(
      `runtime.assemblerId must be the current ${ASSEMBLER_ID}`,
    );
  });

  test("rejects an evidence-bearing journal whose proof artifact is missing", async () => {
    const root = await temporaryRoot(roots);
    const sessionPath = path.join(root, "config.ndeploy.session.json");
    await writeRaw(sessionPath, validAdoptionJournal());
    await expect(readSession(sessionPath)).rejects.toThrow(
      "Deployment proof bundle is missing",
    );
  });
});

function validAdoptionJournal(): ProvisionJournal {
  return {
    schema: 3,
    configSha256: CONFIG_SHA256,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    runtime: { kind: "ic" },
    adoption: validAdoptionReceipt(),
  };
}

function validAdoptionReceipt(): AdoptionReceipt {
  const base: Omit<AdoptionReceipt, "fingerprint"> = {
    kind: "adopted",
    adoptedAt: NOW.toISOString(),
    configSha256: CONFIG_SHA256,
    host: "https://icp-api.io",
    identityId: 0,
    deployerPrincipal: DEPLOYER,
    targetSubnet: SUBNET,
    canisterId: CANISTER,
    controllers: [CANISTER, DEPLOYER].sort(),
    status: "running",
    moduleHash: "8".repeat(64),
    settingsFingerprint: "9".repeat(64),
    runtime: {
      deploymentId: "existing-deployment",
      compilerId: "moc-test",
      assemblerId: ASSEMBLER_ID,
      packages: [{ id: "kernel", version: 100 }],
    },
    access: {
      snapshotVersion: "1",
      authorizedPrincipals: [DEPLOYER],
      controllerLimit: "10",
    },
    deploymentEvidence: validDeploymentEvidence(),
  };
  return { ...base, fingerprint: adoptionReceiptFingerprint(base) };
}

const EXPECTED_PROOF = new TextEncoder().encode("session expected registry proof");
const OBSERVED_PROOF = new TextEncoder().encode("session observed registry proof");

function validDeploymentEvidence() {
  const expected = createDeploymentObservationV1(
    {
      schema: 1,
      source: "ic_registry_certified_v1",
      subnetId: SUBNET,
      registryVersion: "100",
      subnetType: "application",
      nodeCount: 13,
      sevEnabled: false,
      pricingProfile: "application_13_node",
      verifiedAt: NOW.toISOString(),
    },
    EXPECTED_PROOF,
  );
  const observed = createDeploymentObservationV1(
    {
      schema: 1,
      source: "ic_registry_certified_v1",
      subnetId: SUBNET,
      registryVersion: "101",
      subnetType: "application",
      nodeCount: 13,
      sevEnabled: false,
      pricingProfile: "application_13_node",
      verifiedAt: new Date(NOW.getTime() + 1).toISOString(),
    },
    OBSERVED_PROOF,
  );
  return createDeploymentEvidenceV1(expected, observed, {
    expected: EXPECTED_PROOF,
    observed: OBSERVED_PROOF,
  });
}

async function persistEvidenceArtifacts(sessionPath: string): Promise<void> {
  await persistDeploymentProofBundle(sessionPath, EXPECTED_PROOF);
  await persistDeploymentProofBundle(sessionPath, OBSERVED_PROOF);
}

function validPlan(root = "/repo"): SessionPlan {
  const base: Omit<SessionPlan, "fingerprint"> = {
    host: "https://icp-api.io",
    identityId: 0,
    deployerPrincipal: DEPLOYER,
    targetSubnet: SUBNET,
    amountE8s: "500000000",
    initialControllers: [DEPLOYER],
    packages: [
      {
        path: path.resolve(root, "kernel.neutron"),
        id: "kernel",
        version: 100,
        sha256: "1".repeat(64),
        bytes: 1024,
      },
    ],
    compilerId: "moc_test",
    deploymentId: "deployment-test",
    rawWasmSha256: "2".repeat(64),
    wasmMetadata: SUPPORTED_CERTIFICATE_VERSIONS_METADATA_V1,
    transportWasmSha256: "3".repeat(64),
    transportWasmBytes: 1024,
    candidSha256: "4".repeat(64),
    stableSha256: "5".repeat(64),
    chunkHashes: ["6".repeat(64)],
    payload: { version: 3, sha256: "7".repeat(64), bytes: 4096 },
    deploymentEvidenceExpected: validDeploymentEvidence().expected,
  };
  return { ...base, fingerprint: sessionPlanFingerprint(base) };
}

async function temporaryRoot(roots: string[]): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "neutron-journal-test-"));
  roots.push(root);
  return root;
}

async function writeRaw(filename: string, value: unknown): Promise<void> {
  await writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}
