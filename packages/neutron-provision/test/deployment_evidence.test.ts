import { Principal } from "@dfinity/principal";
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertCompatibleDeploymentObservationsV1,
  assertDeploymentEvidenceV1,
  assertDeploymentObservationProofV1,
  assertDeploymentObservationV1,
  assertObservationClaimsV1,
  collectDeploymentObservationV1,
  createDeploymentEvidenceV1,
  createDeploymentObservationV1,
  deploymentEvidenceFingerprintV1,
  deploymentObservationFingerprintV1,
  deploymentProofBundlePath,
  deploymentProofBundleSha256,
  parseIJson,
  persistDeploymentProofBundle,
  readDeploymentProofBundle,
  rfc8785Jcs,
  rfc8785JcsBytes,
  sweepUnreferencedDeploymentProofBundles,
  validateDeploymentEvidenceV1,
  type DeploymentEvidenceV1,
  type DeploymentObservationClaimsV1,
  type DeploymentObservationV1,
} from "../src/deployment_evidence.ts";

const SUBNET =
  "brlsh-zidhj-3yy3e-6vqbz-7xnih-xeq2l-as5oc-g32c4-i5pdn-2wwof-oae";
const OTHER_SUBNET = Principal.selfAuthenticating(
  new Uint8Array(32).fill(41),
).toText();
const EXPECTED_PROOF = new TextEncoder().encode("expected-registry-proof");
const OBSERVED_PROOF = new TextEncoder().encode("observed-registry-proof");
const EXPECTED_PROOF_SHA256 =
  "ce953fdab01ff8679d351b091cca3633abafd827d9a47b6bf2a4001412c9ba2b";
const OBSERVED_PROOF_SHA256 =
  "4da3bf7fe18b4f2c659c0e4297dd39ec2f661a10af3b1633c6bff7743921c224";

const temporaryRoots = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...temporaryRoots].map((root) => rm(root, { recursive: true, force: true })),
  );
  temporaryRoots.clear();
});

describe("RFC 8785 JCS", () => {
  test("matches the RFC 8785 primitive and recursive-order vector", () => {
    const value = {
      numbers: [333333333.33333329, 1e30, 4.5, 2e-3, 1e-27],
      string: "€$\u000f\nA'B\"\\\\\"/",
      literals: [null, true, false],
    };
    const canonical =
      "{\"literals\":[null,true,false],\"numbers\":[333333333.3333333," +
      "1e+30,4.5,0.002,1e-27],\"string\":\"€$\\u000f\\nA'B\\\"\\\\\\\\\\\"/\"}";

    expect(rfc8785Jcs(value)).toBe(canonical);
    expect(rfc8785JcsBytes(value)).toEqual(new TextEncoder().encode(canonical));
  });

  test("sorts raw property names by unsigned UTF-16 code units", () => {
    const value = {
      "\u20ac": "Euro Sign",
      "\r": "Carriage Return",
      "\ufb33": "Hebrew Letter Dalet With Dagesh",
      "1": "One",
      "\ud83d\ude00": "Emoji: Grinning Face",
      "\u0080": "Control",
      "\u00f6": "Latin Small Letter O With Diaeresis",
    };

    expect(rfc8785Jcs(value)).toBe(
      "{\"\\r\":\"Carriage Return\",\"1\":\"One\",\"\u0080\":\"Control\"," +
        "\"ö\":\"Latin Small Letter O With Diaeresis\",\"€\":\"Euro Sign\"," +
        "\"😀\":\"Emoji: Grinning Face\",\"דּ\":\"Hebrew Letter Dalet With Dagesh\"}",
    );
  });

  test("uses ECMAScript binary64 number serialization", () => {
    expect(rfc8785Jcs([0, -0, 1e30, 4.5, 0.002, 1e-27])).toBe(
      "[0,0,1e+30,4.5,0.002,1e-27]",
    );
    expect(rfc8785Jcs([Number.MIN_VALUE, Number.MAX_VALUE])).toBe(
      "[5e-324,1.7976931348623157e+308]",
    );
  });

  test("rejects non-I-JSON and JavaScript-only object behavior", () => {
    expect(() => rfc8785Jcs(Number.NaN)).toThrow("NaN or Infinity");
    expect(() => rfc8785Jcs(Number.POSITIVE_INFINITY)).toThrow(
      "NaN or Infinity",
    );
    expect(() => rfc8785Jcs("\ud800")).toThrow("lone high surrogate");
    expect(() => rfc8785Jcs("\udc00")).toThrow("lone low surrogate");
    expect(() =>
      rfc8785Jcs({ "\ud800": "invalid property name" }),
    ).toThrow("lone high surrogate");

    const sparse: unknown[] = new Array(2);
    sparse[0] = null;
    expect(() => rfc8785Jcs(sparse as never)).toThrow("sparse array");

    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => rfc8785Jcs(cyclic as never)).toThrow("cycle");

    const accessor = {};
    Object.defineProperty(accessor, "value", {
      enumerable: true,
      get: () => 1,
    });
    expect(() => rfc8785Jcs(accessor as never)).toThrow("plain enumerable");
    expect(() => rfc8785Jcs(new Date(0) as never)).toThrow(
      "plain JSON object prototype",
    );
    expect(() => rfc8785Jcs({ value: undefined } as never)).toThrow(
      "non-JSON value undefined",
    );
  });

  test("rejects duplicate decoded names before JSON.parse can collapse them", () => {
    expect(() => parseIJson("{\"a\":1,\"a\":2}")).toThrow(
      "duplicate property",
    );
    expect(() => parseIJson("{\"a\":1,\"\\u0061\":2}")).toThrow(
      "duplicate property",
    );
    expect(() => parseIJson("{\"outer\":{\"x\":1,\"x\":2}}")).toThrow(
      "duplicate property",
    );
    expect(parseIJson(" { \"b\": 2, \"a\": [true, null] } ")).toEqual({
      b: 2,
      a: [true, null],
    });
  });
});

describe("deployment evidence schemas and fingerprints", () => {
  test("freezes observation and outer domain-separated golden vectors", () => {
    const expected = expectedObservation();
    const observed = observedObservation();
    const evidence = createDeploymentEvidenceV1(expected, observed, {
      expected: EXPECTED_PROOF,
      observed: OBSERVED_PROOF,
    });

    expect(expected.evidenceSha256).toBe(EXPECTED_PROOF_SHA256);
    expect(observed.evidenceSha256).toBe(OBSERVED_PROOF_SHA256);
    expect(expected.fingerprint).toBe(
      "0a9e02c0f59813635b4e3ad35451a3263374385d18d0cd2cc882c6e3aefac3e9",
    );
    expect(observed.fingerprint).toBe(
      "e7518966da10fbe624a94cc0d1162054935af4537988ddb931b9440862422bec",
    );
    expect(evidence.fingerprint).toBe(
      "1d8c4588f42efa0a6726893af775b3f7b7e2e09d77c0881945eb2197a0297b08",
    );
    expect(deploymentObservationFingerprintV1(expected)).toBe(
      expected.fingerprint,
    );
    expect(deploymentEvidenceFingerprintV1(evidence)).toBe(
      evidence.fingerprint,
    );
  });

  test("accepts only the reviewed 13-node application-family pricing profile", () => {
    for (const subnetType of [
      "application",
      "verified_application",
    ] as const) {
      expect(() =>
        createDeploymentObservationV1(
          claims({ subnetType, nodeCount: 13 }),
          EXPECTED_PROOF,
        ),
      ).not.toThrow();
    }
    for (const patch of [
      { subnetType: "system" as const },
      { subnetType: "fiduciary" as const },
      { nodeCount: 1 },
      { nodeCount: 64 },
    ]) {
      expect(() =>
        createDeploymentObservationV1(
          claims(patch),
          EXPECTED_PROOF,
        ),
      ).toThrow("application-family");
    }
  });

  test("rejects extra, missing, and noncanonical claim fields", () => {
    expect(() =>
      assertObservationClaimsV1({ ...claims(), extra: true }),
    ).toThrow("unknown field");

    const missing = { ...claims() } as Record<string, unknown>;
    delete missing.registryVersion;
    expect(() => assertObservationClaimsV1(missing)).toThrow("missing field");

    for (const patch of [
      { schema: 2 },
      { source: "dashboard_screenshot" },
      { subnetId: SUBNET.toUpperCase() },
      { registryVersion: "01" },
      { registryVersion: "+1" },
      { registryVersion: "1.0" },
      { subnetType: "cloud_engine" },
      { nodeCount: 0 },
      { nodeCount: 65 },
      { nodeCount: 13.5 },
      { sevEnabled: 1 },
      { pricingProfile: "application_34_node" },
      { verifiedAt: "2026-07-23T12:00:00Z" },
      { verifiedAt: "2026-07-23 12:00:00.000Z" },
    ]) {
      expect(() =>
        assertObservationClaimsV1({ ...claims(), ...patch }),
      ).toThrow();
    }
  });

  test("rejects observation extra fields, bad digests, and bad fingerprints", () => {
    const observation = expectedObservation();
    expect(() =>
      assertDeploymentObservationV1({ ...observation, extra: true }),
    ).toThrow("unknown field");
    expect(() =>
      assertDeploymentObservationV1({
        ...observation,
        evidenceSha256: observation.evidenceSha256.toUpperCase(),
      }),
    ).toThrow("64 lowercase");
    expect(() =>
      assertDeploymentObservationV1({
        ...observation,
        fingerprint: "0".repeat(64),
      }),
    ).toThrow("fingerprint does not match");
  });

  test("rejects outer extra fields and any nested or outer fingerprint drift", () => {
    const evidence = validEvidence();
    expect(() =>
      assertDeploymentEvidenceV1({ ...evidence, extra: true }),
    ).toThrow("unknown field");
    expect(() =>
      assertDeploymentEvidenceV1({
        ...evidence,
        fingerprint: "f".repeat(64),
      }),
    ).toThrow("fingerprint does not match");
    expect(() =>
      assertDeploymentEvidenceV1({
        ...evidence,
        expected: {
          ...evidence.expected,
          fingerprint: "f".repeat(64),
        },
      }),
    ).toThrow("fingerprint does not match");
  });

  test("requires the exact proof bytes for both observations", () => {
    const evidence = validEvidence();
    expect(
      validateDeploymentEvidenceV1(evidence, {
        expected: EXPECTED_PROOF,
        observed: OBSERVED_PROOF,
      }),
    ).toBe(evidence);
    expect(() =>
      validateDeploymentEvidenceV1(evidence, {
        expected: OBSERVED_PROOF,
        observed: OBSERVED_PROOF,
      }),
    ).toThrow("does not match proof bundle SHA-256");
    expect(() =>
      assertDeploymentObservationProofV1(
        evidence.observed,
        EXPECTED_PROOF,
      ),
    ).toThrow("does not match proof bundle SHA-256");
    expect(() =>
      validateDeploymentEvidenceV1(evidence, undefined as never),
    ).toThrow("requires expected and observed");
    expect(() =>
      validateDeploymentEvidenceV1(evidence, {
        expected: EXPECTED_PROOF,
        observed: OBSERVED_PROOF,
        extra: true,
      } as never),
    ).toThrow("unknown field");
  });
});

describe("expected and observed compatibility", () => {
  test("permits a newer registry proof and verification time", () => {
    expect(() =>
      assertCompatibleDeploymentObservationsV1(
        expectedObservation(),
        observedObservation(),
      ),
    ).not.toThrow();
  });

  test("rejects placement, TEE, and pricing-fact drift", () => {
    const expected = expectedObservation();
    for (const patch of [
      { subnetId: OTHER_SUBNET },
      { subnetType: "verified_application" as const },
      { sevEnabled: true },
    ]) {
      const observed = createDeploymentObservationV1(
        claims({
          registryVersion: "101",
          verifiedAt: "2026-07-23T12:01:00.000Z",
          ...patch,
        }),
        OBSERVED_PROOF,
      );
      expect(() =>
        assertCompatibleDeploymentObservationsV1(expected, observed),
      ).toThrow("does not match");
    }
  });

  test("rejects a registry or wall-clock regression", () => {
    const expected = expectedObservation();
    const oldRegistry = createDeploymentObservationV1(
      claims({
        registryVersion: "99",
        verifiedAt: "2026-07-23T12:01:00.000Z",
      }),
      OBSERVED_PROOF,
    );
    expect(() =>
      assertCompatibleDeploymentObservationsV1(expected, oldRegistry),
    ).toThrow("registryVersion predates");

    const oldTime = createDeploymentObservationV1(
      claims({
        registryVersion: "101",
        verifiedAt: "2026-07-23T11:59:59.999Z",
      }),
      OBSERVED_PROOF,
    );
    expect(() =>
      assertCompatibleDeploymentObservationsV1(expected, oldTime),
    ).toThrow("verifiedAt predates");
  });
});

describe("deployment evidence provider boundary", () => {
  test("binds a provider's normalized fields and exact proof to the request", async () => {
    const result = await collectDeploymentObservationV1(
      {
        async observe(request) {
          expect(request).toEqual({ subnetId: SUBNET });
          return { observation: claims(), proofBundle: EXPECTED_PROOF };
        },
      },
      { subnetId: SUBNET },
    );

    expect(result.observation.evidenceSha256).toBe(EXPECTED_PROOF_SHA256);
    expect(result.proofBundle).toEqual(EXPECTED_PROOF);
    assertDeploymentObservationProofV1(
      result.observation,
      result.proofBundle,
    );
  });

  test("rejects provider subnet drift, extra result fields, and malformed proof bytes", async () => {
    await expect(
      collectDeploymentObservationV1(
        {
          async observe() {
            return {
              observation: claims({ subnetId: OTHER_SUBNET }),
              proofBundle: EXPECTED_PROOF,
            };
          },
        },
        { subnetId: SUBNET },
      ),
    ).rejects.toThrow("does not match requested subnet");

    await expect(
      collectDeploymentObservationV1(
        {
          async observe() {
            return {
              observation: claims(),
              proofBundle: EXPECTED_PROOF,
              extra: true,
            } as never;
          },
        },
        { subnetId: SUBNET },
      ),
    ).rejects.toThrow("unknown field");

    await expect(
      collectDeploymentObservationV1(
        {
          async observe() {
            return {
              observation: claims(),
              proofBundle: "not bytes",
            } as never;
          },
        },
        { subnetId: SUBNET },
      ),
    ).rejects.toThrow("must be a Uint8Array");
  });

  test("rejects a noncanonical request before invoking the provider", async () => {
    let called = false;
    await expect(
      collectDeploymentObservationV1(
        {
          async observe() {
            called = true;
            return { observation: claims(), proofBundle: EXPECTED_PROOF };
          },
        },
        { subnetId: Principal.anonymous().toText() },
      ),
    ).rejects.toThrow("canonical non-anonymous principal");
    expect(called).toBe(false);
  });
});

describe("private immutable deployment proof artifacts", () => {
  test("publishes, verifies, and deduplicates a content-addressed mode-0400 file", async () => {
    const session = await temporarySession();
    const first = await persistDeploymentProofBundle(
      session,
      EXPECTED_PROOF,
      EXPECTED_PROOF_SHA256,
    );
    const second = await persistDeploymentProofBundle(
      session,
      EXPECTED_PROOF,
      EXPECTED_PROOF_SHA256,
    );

    expect(first).toEqual(second);
    expect(first.path).toBe(
      deploymentProofBundlePath(session, EXPECTED_PROOF_SHA256),
    );
    expect(first.sha256).toBe(EXPECTED_PROOF_SHA256);
    expect(first.bytes).toBe(EXPECTED_PROOF.byteLength);
    expect((await stat(first.path)).mode & 0o777).toBe(0o400);
    expect(await readDeploymentProofBundle(session, EXPECTED_PROOF_SHA256)).toEqual(
      EXPECTED_PROOF,
    );
    expect(deploymentProofBundleSha256(EXPECTED_PROOF)).toBe(
      EXPECTED_PROOF_SHA256,
    );
  });

  test("rejects missing, mutable-mode, tampered, and symlink artifacts", async () => {
    const session = await temporarySession();
    await expect(
      readDeploymentProofBundle(session, EXPECTED_PROOF_SHA256),
    ).rejects.toThrow("missing or unsafe");

    const artifact = await persistDeploymentProofBundle(
      session,
      EXPECTED_PROOF,
    );
    await chmod(artifact.path, 0o600);
    await expect(
      readDeploymentProofBundle(session, EXPECTED_PROOF_SHA256),
    ).rejects.toThrow("immutable");

    await writeFile(artifact.path, new TextEncoder().encode("tampered"));
    await chmod(artifact.path, 0o400);
    await expect(
      readDeploymentProofBundle(session, EXPECTED_PROOF_SHA256),
    ).rejects.toThrow("digest mismatch");

    const symlinkDigest = deploymentProofBundleSha256(OBSERVED_PROOF);
    const symlinkPath = deploymentProofBundlePath(session, symlinkDigest);
    const target = path.join(path.dirname(session), "outside-proof");
    await writeFile(target, OBSERVED_PROOF, { mode: 0o400 });
    await symlink(target, symlinkPath);
    await expect(
      readDeploymentProofBundle(session, symlinkDigest),
    ).rejects.toThrow("missing or unsafe");
  });

  test("refuses an expected digest mismatch before publishing", async () => {
    const session = await temporarySession();
    await expect(
      persistDeploymentProofBundle(
        session,
        EXPECTED_PROOF,
        OBSERVED_PROOF_SHA256,
      ),
    ).rejects.toThrow("digest mismatch");
    await expect(
      readFile(
        deploymentProofBundlePath(session, OBSERVED_PROOF_SHA256),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("sweeps only this session's unreferenced finals and temporary files", async () => {
    const session = await temporarySession();
    const expected = await persistDeploymentProofBundle(session, EXPECTED_PROOF);
    const observed = await persistDeploymentProofBundle(session, OBSERVED_PROOF);
    const directory = path.dirname(expected.path);
    const stem = path.basename(
      session,
      ".ndeploy.session.json",
    );
    const abandonedTemporary = path.join(
      directory,
      `${stem}-${"a".repeat(64)}.registry-proof-v1.tmp-42-${"b".repeat(12)}`,
    );
    const unrelated = path.join(directory, "unrelated");
    await writeFile(abandonedTemporary, new Uint8Array([1]), { mode: 0o600 });
    await writeFile(unrelated, new Uint8Array([2]), { mode: 0o600 });

    expect(
      await sweepUnreferencedDeploymentProofBundles(session, [
        expected.sha256,
      ]),
    ).toBe(2);
    expect(await readDeploymentProofBundle(session, expected.sha256)).toEqual(
      EXPECTED_PROOF,
    );
    await expect(stat(observed.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(abandonedTemporary)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect([...(await readFile(unrelated))]).toEqual([2]);
  });

  test("rejects non-session paths and empty or oversized bundles", async () => {
    const root = await temporaryRoot();
    expect(() =>
      deploymentProofBundlePath(path.join(root, "journal.json"), "0".repeat(64)),
    ).toThrow(".ndeploy.session.json");
    await expect(
      persistDeploymentProofBundle(
        path.join(root, "config.ndeploy.session.json"),
        new Uint8Array(),
      ),
    ).rejects.toThrow("1 through");
  });
});

function claims(
  overrides: Partial<DeploymentObservationClaimsV1> = {},
): DeploymentObservationClaimsV1 {
  return {
    schema: 1,
    source: "ic_registry_certified_v1",
    subnetId: SUBNET,
    registryVersion: "100",
    subnetType: "application",
    nodeCount: 13,
    sevEnabled: false,
    pricingProfile: "application_13_node",
    verifiedAt: "2026-07-23T12:00:00.000Z",
    ...overrides,
  };
}

function expectedObservation(): DeploymentObservationV1 {
  return createDeploymentObservationV1(claims(), EXPECTED_PROOF);
}

function observedObservation(): DeploymentObservationV1 {
  return createDeploymentObservationV1(
    claims({
      registryVersion: "101",
      verifiedAt: "2026-07-23T12:01:00.000Z",
    }),
    OBSERVED_PROOF,
  );
}

function validEvidence(): DeploymentEvidenceV1 {
  return createDeploymentEvidenceV1(
    expectedObservation(),
    observedObservation(),
    {
      expected: EXPECTED_PROOF,
      observed: OBSERVED_PROOF,
    },
  );
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "neutron-evidence-test-"));
  temporaryRoots.add(root);
  return root;
}

async function temporarySession(): Promise<string> {
  const root = await temporaryRoot();
  const session = path.join(root, "config.ndeploy.session.json");
  await mkdir(root, { recursive: true, mode: 0o700 });
  return session;
}
