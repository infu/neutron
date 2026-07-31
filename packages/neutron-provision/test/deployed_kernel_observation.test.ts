import { Ed25519KeyIdentity } from "@dfinity/identity";
import { Principal } from "@dfinity/principal";
import { describe, expect, test } from "bun:test";
import {
  createDeploymentEvidenceV1,
  createDeploymentObservationV1,
  type DeploymentEvidenceProofBundlesV1,
  type DeploymentEvidenceV1,
  type DeploymentObservationClaimsV1,
} from "../src/deployment_evidence.ts";
import {
  runDeployedKernelObservation,
  verifyDeployedKernelObservation,
  verifyKernelReadStateCertificate,
  type VerifyDeployedKernelObservationInput,
} from "../src/deployed_kernel_observation.ts";
import { IC_MAINNET_ROOT_KEY_SHA256 } from "../src/ic_registry_evidence.ts";

const CANISTER = Principal.selfAuthenticating(
  new Uint8Array(32).fill(1),
).toText();
const CONTROLLER_A = Principal.selfAuthenticating(
  new Uint8Array(32).fill(2),
).toText();
const CONTROLLER_B = Principal.selfAuthenticating(
  new Uint8Array(32).fill(3),
).toText();
const SUBNET = Principal.selfAuthenticating(
  new Uint8Array(32).fill(4),
).toText();
const OTHER_SUBNET = Principal.selfAuthenticating(
  new Uint8Array(32).fill(5),
).toText();
const MODULE_HASH = "a".repeat(64);
const OTHER_MODULE_HASH = "b".repeat(64);
const READ_STATE_CERTIFICATE = new Uint8Array([0xd9, 0xd9, 0xf7]);
const EXPECTED_PROOF = new TextEncoder().encode("expected Registry proof");
const OBSERVED_PROOF = new TextEncoder().encode("observed Registry proof");

describe("generic deployed Kernel observation", () => {
  test("binds pinned-root certified state, management state, and Registry evidence", async () => {
    const proofChecks: string[] = [];
    const result = await verifyDeployedKernelObservation(validInput(), {
      verifyRegistryProof: async ({ observation }) => {
        proofChecks.push(observation.registryVersion);
      },
      verifyReadStateCertificate: async ({ canisterId, certificate }) => {
        expect(canisterId).toBe(CANISTER);
        expect(certificate).toEqual(READ_STATE_CERTIFICATE);
        return certifiedState();
      },
    });

    expect(result.canisterId).toBe(CANISTER);
    expect(result.rootKeySha256).toBe(IC_MAINNET_ROOT_KEY_SHA256);
    expect(result.certifiedState).toEqual({
      certificate: READ_STATE_CERTIFICATE,
      certifiedTimeNanos: "1774550400123000000",
      subnetId: SUBNET,
      moduleHash: MODULE_HASH,
      controllers: [CONTROLLER_B, CONTROLLER_A].sort(),
    });
    expect(result.operationalState.status).toBe("running");
    expect(result.operationalState.canisterVersion).toBe(7n);
    expect(proofChecks).toEqual(["100", "101"]);
  });

  test("fails closed on every cross-source state mismatch", async () => {
    const noOpProofVerifier = async () => {};
    const cases: Array<
      [string, VerifyDeployedKernelObservationInput, ReturnType<typeof certifiedState>]
    > = [
      [
        "expected Kernel Wasm",
        validInput(),
        certifiedState({ moduleHash: OTHER_MODULE_HASH }),
      ],
      [
        "Management module hash",
        {
          ...validInput(),
          operationalState: {
            ...validInput().operationalState,
            moduleHash: OTHER_MODULE_HASH,
          },
        },
        certifiedState(),
      ],
      [
        "Management controllers",
        {
          ...validInput(),
          operationalState: {
            ...validInput().operationalState,
            controllers: [CONTROLLER_A],
          },
        },
        certifiedState(),
      ],
      [
        "Registry placement",
        validInput(),
        certifiedState({ subnetId: OTHER_SUBNET }),
      ],
      [
        "not running",
        {
          ...validInput(),
          operationalState: {
            ...validInput().operationalState,
            status: "stopped",
          },
        },
        certifiedState(),
      ],
    ];

    for (const [message, input, certified] of cases) {
      await expect(
        verifyDeployedKernelObservation(input, {
          verifyRegistryProof: noOpProofVerifier,
          verifyReadStateCertificate: async () => certified,
        }),
      ).rejects.toThrow(message);
    }
  });

  test("rejects a proof digest mismatch before the proof verifier", async () => {
    let verifierCalled = false;
    await expect(
      verifyDeployedKernelObservation(
        {
          ...validInput(),
          registryProofBundles: {
            expected: new TextEncoder().encode("tampered"),
            observed: OBSERVED_PROOF,
          },
        },
        {
          verifyRegistryProof: async () => {
            verifierCalled = true;
          },
          verifyReadStateCertificate: async () => certifiedState(),
        },
      ),
    ).rejects.toThrow("does not match proof bundle SHA-256");
    expect(verifierCalled).toBe(false);
  });

  test("rejects bytes that merely claim to be a read_state certificate", async () => {
    await expect(
      verifyKernelReadStateCertificate({
        canisterId: CANISTER,
        certificate: READ_STATE_CERTIFICATE,
      }),
    ).rejects.toThrow();
  });

  test("refreshes Registry placement before returning the live observation", async () => {
    const input = validInput();
    const refreshedProof = new TextEncoder().encode("refreshed Registry proof");
    const requests: string[] = [];
    const proofChecks: string[] = [];
    const identity = Ed25519KeyIdentity.generate(
      new Uint8Array(32).fill(17),
    );
    const result = await runDeployedKernelObservation(
      {
        host: "https://icp-api.io",
        identity,
        expected: input.expected,
        existingRegistryEvidence: input.registryEvidence,
        existingRegistryProofBundles: input.registryProofBundles,
      },
      {
        registryProvider: {
          async observe({ subnetId }) {
            requests.push(subnetId);
            return {
              observation: claims({
                registryVersion: "102",
                verifiedAt: "2026-07-23T12:02:00.000Z",
              }),
              proofBundle: refreshedProof,
            };
          },
        },
        verifyRegistryProof: async ({ observation }) => {
          proofChecks.push(observation.registryVersion);
        },
        verifyReadStateCertificate: async ({ canisterId, certificate }) => {
          expect(canisterId).toBe(CANISTER);
          expect(certificate).toEqual(READ_STATE_CERTIFICATE);
          return certifiedState();
        },
        observeCanister: async ({ host, canisterId }) => {
          expect(host).toBe("https://icp-api.io");
          expect(canisterId).toBe(CANISTER);
          return {
            readStateCertificate: READ_STATE_CERTIFICATE,
            operationalState: input.operationalState,
          };
        },
      },
    );

    expect(requests).toEqual([SUBNET]);
    expect(proofChecks).toEqual(["100", "101", "102"]);
    expect(result.registryEvidence.expected.registryVersion).toBe("100");
    expect(result.registryEvidence.observed.registryVersion).toBe("102");
    expect(result.registryProofBundles.observed).toEqual(refreshedProof);
  });
});

function validInput(): VerifyDeployedKernelObservationInput {
  const registryProofBundles: DeploymentEvidenceProofBundlesV1 = {
    expected: EXPECTED_PROOF,
    observed: OBSERVED_PROOF,
  };
  return {
    expected: {
      canisterId: CANISTER,
      moduleHash: MODULE_HASH,
      controllers: [CONTROLLER_A, CONTROLLER_B],
    },
    readStateCertificate: READ_STATE_CERTIFICATE,
    operationalState: {
      status: "running",
      canisterVersion: 7n,
      moduleHash: MODULE_HASH,
      controllers: [CONTROLLER_A, CONTROLLER_B],
    },
    registryEvidence: evidence(registryProofBundles),
    registryProofBundles,
  };
}

function certifiedState(
  overrides: Partial<{
    subnetId: string;
    moduleHash: string;
    controllers: readonly string[];
  }> = {},
) {
  return {
    certificate: READ_STATE_CERTIFICATE,
    certifiedTimeNanos: "1774550400123000000",
    subnetId: SUBNET,
    moduleHash: MODULE_HASH,
    controllers: [CONTROLLER_B, CONTROLLER_A],
    ...overrides,
  };
}

function evidence(
  proofBundles: DeploymentEvidenceProofBundlesV1,
): DeploymentEvidenceV1 {
  const expected = createDeploymentObservationV1(
    claims(),
    proofBundles.expected,
  );
  const observed = createDeploymentObservationV1(
    claims({
      registryVersion: "101",
      verifiedAt: "2026-07-23T12:01:00.000Z",
    }),
    proofBundles.observed,
  );
  return createDeploymentEvidenceV1(expected, observed, proofBundles);
}

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
