import { createHash } from "node:crypto";
import {
  Actor,
  Cbor,
  Certificate,
  HttpAgent,
  LookupPathStatus,
  type ActorSubclass,
  type Identity,
} from "@dfinity/agent";
import { Principal } from "@dfinity/principal";
import { toHex } from "./artifact.ts";
import {
  collectDeploymentObservationV1,
  createDeploymentEvidenceV1,
  validateDeploymentEvidenceV1,
  type DeploymentEvidenceProofBundlesV1,
  type DeploymentEvidenceProviderV1,
  type DeploymentEvidenceV1,
  type DeploymentObservationV1,
} from "./deployment_evidence.ts";
import {
  IC_MAINNET_ROOT_KEY_SHA256,
  IC_REGISTRY_CANISTER_ID_V1,
  IC_REGISTRY_EVIDENCE_SOURCE_V1,
  createIcRegistryCertifiedEvidenceProvider,
  icMainnetRootKey,
  verifyIcRegistryCertifiedObservationProofV1,
} from "./ic_registry_evidence.ts";
import {
  DEFAULT_IC_HOST,
  MANAGEMENT_CANISTER_ID,
  type CanisterRunState,
} from "./ic_client.ts";
import { managementIdl, type ManagementActor } from "./idl.ts";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_CERTIFICATE_BYTES = 4 * 1024 * 1024;

export type DeployedKernelExpectedState = Readonly<{
  canisterId: string;
  moduleHash: string;
  controllers: readonly string[];
}>;

export type DeployedKernelCertifiedState = Readonly<{
  certificate: Uint8Array;
  certifiedTimeNanos: string;
  subnetId: string;
  moduleHash: string;
  controllers: readonly string[];
}>;

export type DeployedKernelOperationalState = Readonly<{
  status: CanisterRunState;
  canisterVersion: bigint;
  moduleHash: string | null;
  controllers: readonly string[];
}>;

export type DeployedKernelObservation = Readonly<{
  canisterId: string;
  rootKeySha256: typeof IC_MAINNET_ROOT_KEY_SHA256;
  certifiedState: DeployedKernelCertifiedState;
  operationalState: DeployedKernelOperationalState & {
    status: "running";
    moduleHash: string;
  };
  registryEvidence: DeploymentEvidenceV1;
  registryProofBundles: DeploymentEvidenceProofBundlesV1;
}>;

export type VerifyDeployedKernelObservationInput = Readonly<{
  expected: DeployedKernelExpectedState;
  readStateCertificate: Uint8Array;
  operationalState: DeployedKernelOperationalState;
  registryEvidence: DeploymentEvidenceV1;
  registryProofBundles: DeploymentEvidenceProofBundlesV1;
}>;

export type RunDeployedKernelObservationOptions = Readonly<{
  host?: string;
  identity: Identity;
  expected: DeployedKernelExpectedState;
  existingRegistryEvidence: DeploymentEvidenceV1;
  existingRegistryProofBundles: DeploymentEvidenceProofBundlesV1;
}>;

type RegistryProofVerifier = (input: {
  observation: DeploymentObservationV1;
  proofBundle: Uint8Array;
}) => Promise<void>;

type LiveCanisterObservation = Readonly<{
  readStateCertificate: Uint8Array;
  operationalState: DeployedKernelOperationalState;
}>;

export type DeployedKernelObservationDependencies = Readonly<{
  /**
   * Test seams. Production callers omit all dependencies.
   */
  registryProvider?: DeploymentEvidenceProviderV1;
  verifyRegistryProof?: RegistryProofVerifier;
  verifyReadStateCertificate?: (input: {
    canisterId: string;
    certificate: Uint8Array;
  }) => Promise<DeployedKernelCertifiedState>;
  observeCanister?: (input: {
    host: string;
    identity: Identity;
    canisterId: string;
  }) => Promise<LiveCanisterObservation>;
}>;

/**
 * Verify the same deployed Kernel through three independent authenticated
 * views: certified read_state, management canister_status, and certified
 * Registry placement evidence.
 */
export async function verifyDeployedKernelObservation(
  input: VerifyDeployedKernelObservationInput,
  dependencies: Pick<
    DeployedKernelObservationDependencies,
    "verifyRegistryProof" | "verifyReadStateCertificate"
  > = {},
): Promise<DeployedKernelObservation> {
  const expected = normalizeExpectedState(input.expected);
  const proofBundles = cloneProofBundles(input.registryProofBundles);
  const evidence = await verifyRegistryEvidence(
    input.registryEvidence,
    proofBundles,
    dependencies.verifyRegistryProof ??
      verifyIcRegistryCertifiedObservationProofV1,
  );
  const certifiedState = await (
    dependencies.verifyReadStateCertificate ?? verifyKernelReadStateCertificate
  )({
    canisterId: expected.canisterId,
    certificate: boundedCertificate(input.readStateCertificate),
  });
  return verifyStateBindings({
    expected,
    certifiedState,
    operationalState: input.operationalState,
    registryEvidence: evidence,
    registryProofBundles: proofBundles,
  });
}

/**
 * Refresh the provision journal's Registry placement evidence and compare it
 * with live, pinned-root Kernel state. This function is read-only.
 */
export async function runDeployedKernelObservation(
  options: RunDeployedKernelObservationOptions,
  dependencies: DeployedKernelObservationDependencies = {},
): Promise<DeployedKernelObservation> {
  const host = bareHttpsOrigin(options.host ?? DEFAULT_IC_HOST);
  assertIdentity(options.identity);
  const expected = normalizeExpectedState(options.expected);
  const existingProofs = cloneProofBundles(
    options.existingRegistryProofBundles,
  );
  const verifyProof =
    dependencies.verifyRegistryProof ??
    verifyIcRegistryCertifiedObservationProofV1;
  const existingEvidence = await verifyRegistryEvidence(
    options.existingRegistryEvidence,
    existingProofs,
    verifyProof,
  );
  const provider =
    dependencies.registryProvider ??
    createIcRegistryCertifiedEvidenceProvider({
      host,
      policy: {
        source: IC_REGISTRY_EVIDENCE_SOURCE_V1,
        registry_canister: IC_REGISTRY_CANISTER_ID_V1,
        root_key_sha256: IC_MAINNET_ROOT_KEY_SHA256,
        pricing_profile: existingEvidence.observed.pricingProfile,
      },
    });
  const observeCanister =
    dependencies.observeCanister ?? observeLiveCanister;
  const [refreshedRegistry, live] = await Promise.all([
    collectDeploymentObservationV1(provider, {
      subnetId: existingEvidence.observed.subnetId,
    }),
    observeCanister({
      host,
      identity: options.identity,
      canisterId: expected.canisterId,
    }),
  ]);
  await verifyProof({
    observation: refreshedRegistry.observation,
    proofBundle: refreshedRegistry.proofBundle,
  });
  const registryProofBundles = {
    expected: existingProofs.expected,
    observed: refreshedRegistry.proofBundle.slice(),
  };
  const registryEvidence = createDeploymentEvidenceV1(
    existingEvidence.expected,
    refreshedRegistry.observation,
    registryProofBundles,
  );
  const certifiedState = await (
    dependencies.verifyReadStateCertificate ?? verifyKernelReadStateCertificate
  )({
    canisterId: expected.canisterId,
    certificate: boundedCertificate(live.readStateCertificate),
  });
  return verifyStateBindings({
    expected,
    certifiedState,
    operationalState: live.operationalState,
    registryEvidence,
    registryProofBundles,
  });
}

async function verifyRegistryEvidence(
  evidence: DeploymentEvidenceV1,
  proofBundles: DeploymentEvidenceProofBundlesV1,
  verifyProof: RegistryProofVerifier,
): Promise<DeploymentEvidenceV1> {
  const validated = validateDeploymentEvidenceV1(evidence, proofBundles);
  await Promise.all([
    verifyProof({
      observation: validated.expected,
      proofBundle: proofBundles.expected,
    }),
    verifyProof({
      observation: validated.observed,
      proofBundle: proofBundles.observed,
    }),
  ]);
  return validated;
}

function verifyStateBindings(input: {
  expected: DeployedKernelExpectedState;
  certifiedState: DeployedKernelCertifiedState;
  operationalState: DeployedKernelOperationalState;
  registryEvidence: DeploymentEvidenceV1;
  registryProofBundles: DeploymentEvidenceProofBundlesV1;
}): DeployedKernelObservation {
  const certified = normalizeCertifiedState(input.certifiedState);
  const operational = normalizeOperationalState(input.operationalState);
  if (operational.status !== "running") {
    throw new Error("Deployed Kernel is not running");
  }
  if (operational.moduleHash === null) {
    throw new Error("Management canister_status did not contain an installed module hash");
  }
  if (certified.moduleHash !== input.expected.moduleHash) {
    throw new Error("Certified module hash does not match the expected Kernel Wasm");
  }
  if (!sameStrings(certified.controllers, input.expected.controllers)) {
    throw new Error("Certified controllers do not match the expected Kernel controllers");
  }
  if (operational.moduleHash !== certified.moduleHash) {
    throw new Error("Management module hash does not match certified read_state");
  }
  if (!sameStrings(operational.controllers, certified.controllers)) {
    throw new Error("Management controllers do not match certified read_state");
  }
  if (input.registryEvidence.observed.subnetId !== certified.subnetId) {
    throw new Error("Certified Kernel subnet does not match Registry placement evidence");
  }
  return {
    canisterId: input.expected.canisterId,
    rootKeySha256: IC_MAINNET_ROOT_KEY_SHA256,
    certifiedState: { ...certified, moduleHash: certified.moduleHash },
    operationalState: {
      ...operational,
      status: "running",
      moduleHash: operational.moduleHash,
    },
    registryEvidence: input.registryEvidence,
    registryProofBundles: cloneProofBundles(input.registryProofBundles),
  };
}

async function observeLiveCanister(input: {
  host: string;
  identity: Identity;
  canisterId: string;
}): Promise<LiveCanisterObservation> {
  const rootKey = icMainnetRootKey();
  const agent = await HttpAgent.create({
    host: input.host,
    identity: input.identity,
    rootKey: rootKey.slice(),
    shouldFetchRootKey: false,
    shouldSyncTime: false,
    verifyQuerySignatures: true,
  });
  if (
    agent.rootKey === null ||
    !equalBytes(agent.rootKey, rootKey) ||
    sha256Hex(agent.rootKey) !== IC_MAINNET_ROOT_KEY_SHA256
  ) {
    throw new Error("IC agent root key does not match the pinned mainnet root key");
  }
  const principal = Principal.fromText(input.canisterId);
  const encoded = new TextEncoder();
  const canisterPath = [encoded.encode("canister"), principal.toUint8Array()];
  const [readState, operational] = await Promise.all([
    agent.readState(principal, {
      paths: [
        [encoded.encode("time")],
        [...canisterPath, encoded.encode("module_hash")],
        [...canisterPath, encoded.encode("controllers")],
      ],
    }),
    (
      Actor.createActor<ManagementActor>(managementIdl, {
        agent,
        canisterId: Principal.fromText(MANAGEMENT_CANISTER_ID),
        effectiveCanisterId: principal,
      }) as ActorSubclass<ManagementActor>
    ).canister_status({
      canister_id: principal,
    }),
  ]);
  return {
    readStateCertificate: boundedCertificate(readState.certificate),
    operationalState: {
      status:
        "running" in operational.status
          ? "running"
          : "stopping" in operational.status
            ? "stopping"
            : "stopped",
      canisterVersion: operational.version,
      moduleHash:
        operational.module_hash.length === 0
          ? null
          : exactModuleHash(operational.module_hash[0]),
      controllers: operational.settings.controllers.map((controller) =>
        controller.toText(),
      ),
    },
  };
}

/**
 * Verify a raw IC read_state certificate against the compiled mainnet root and
 * derive every Kernel state claim from its authenticated hash tree.
 */
export async function verifyKernelReadStateCertificate(input: {
  canisterId: string;
  certificate: Uint8Array;
}): Promise<DeployedKernelCertifiedState> {
  const canisterId = Principal.fromText(
    canonicalNonAnonymousPrincipal(
      input.canisterId,
      "Certified Kernel canister",
    ),
  );
  const certificateBytes = boundedCertificate(input.certificate);
  const certificate = await Certificate.create({
    certificate: certificateBytes,
    rootKey: icMainnetRootKey(),
    canisterId,
  });
  const canisterPath = ["canister", canisterId.toUint8Array()] as const;
  const certifiedTime = foundLookup(
    certificate.lookup_path(["time"]),
    "Certified time",
  );
  const moduleHash = foundLookup(
    certificate.lookup_path([...canisterPath, "module_hash"]),
    "Certified Kernel module hash",
  );
  if (moduleHash.byteLength !== 32) {
    throw new Error("Certified Kernel module hash must contain 32 bytes");
  }
  const controllerBytes = foundLookup(
    certificate.lookup_path([...canisterPath, "controllers"]),
    "Certified Kernel controllers",
  );
  const delegation = certificate.cert.delegation;
  if (
    delegation === undefined ||
    !(delegation.subnet_id instanceof Uint8Array)
  ) {
    throw new Error(
      "Certified Kernel read_state must contain a subnet delegation",
    );
  }
  return {
    certificate: certificateBytes,
    certifiedTimeNanos: decodeUnsignedLeb128(
      certifiedTime,
      "Certified time",
    ).toString(),
    subnetId: canonicalNonAnonymousPrincipal(
      Principal.fromUint8Array(delegation.subnet_id).toText(),
      "Certified Kernel subnet",
    ),
    moduleHash: toHex(moduleHash),
    controllers: decodeCertifiedControllers(controllerBytes),
  };
}

function normalizeExpectedState(
  value: DeployedKernelExpectedState,
): DeployedKernelExpectedState {
  return {
    canisterId: canonicalNonAnonymousPrincipal(
      value.canisterId,
      "Expected Kernel canister",
    ),
    moduleHash: sha256(value.moduleHash, "Expected Kernel module hash"),
    controllers: canonicalControllers(
      value.controllers,
      "Expected Kernel controllers",
    ),
  };
}

function normalizeCertifiedState(
  value: DeployedKernelCertifiedState,
): DeployedKernelCertifiedState {
  return {
    certificate: boundedCertificate(value.certificate),
    certifiedTimeNanos: canonicalPositiveNat(
      value.certifiedTimeNanos,
      "Certified Kernel time",
    ),
    subnetId: canonicalNonAnonymousPrincipal(
      value.subnetId,
      "Certified Kernel subnet",
    ),
    moduleHash: sha256(value.moduleHash, "Certified Kernel module hash"),
    controllers: canonicalControllers(
      value.controllers,
      "Certified Kernel controllers",
    ),
  };
}

function normalizeOperationalState(
  value: DeployedKernelOperationalState,
): DeployedKernelOperationalState {
  if (
    value.status !== "running" &&
    value.status !== "stopping" &&
    value.status !== "stopped"
  ) {
    throw new Error("Management canister status is invalid");
  }
  if (typeof value.canisterVersion !== "bigint" || value.canisterVersion < 0n) {
    throw new Error("Management canister version must be a non-negative bigint");
  }
  return {
    status: value.status,
    canisterVersion: value.canisterVersion,
    moduleHash:
      value.moduleHash === null
        ? null
        : sha256(value.moduleHash, "Management Kernel module hash"),
    controllers: canonicalControllers(
      value.controllers,
      "Management Kernel controllers",
    ),
  };
}

function canonicalControllers(
  values: readonly string[],
  label: string,
): readonly string[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > 10) {
    throw new Error(`${label} must contain one to ten principals`);
  }
  const normalized = values
    .map((value, index) =>
      canonicalNonAnonymousPrincipal(value, `${label}[${index}]`),
    )
    .sort();
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`${label} must not contain duplicates`);
  }
  return normalized;
}

function canonicalNonAnonymousPrincipal(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a principal`);
  let principal: Principal;
  try {
    principal = Principal.fromText(value);
  } catch (error) {
    throw new Error(`${label} must be a principal`, { cause: error });
  }
  const canonical = principal.toText();
  if (
    canonical !== value ||
    principal.isAnonymous() ||
    canonical === MANAGEMENT_CANISTER_ID
  ) {
    throw new Error(`${label} must be a canonical non-anonymous principal`);
  }
  return canonical;
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function boundedCertificate(value: unknown): Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength < 1 ||
    value.byteLength > MAX_CERTIFICATE_BYTES
  ) {
    throw new Error(
      `Kernel read_state certificate must contain 1 through ${MAX_CERTIFICATE_BYTES} bytes`,
    );
  }
  return value.slice();
}

function foundLookup(
  lookup: ReturnType<Certificate["lookup_path"]>,
  label: string,
): Uint8Array {
  if (
    lookup.status !== LookupPathStatus.Found ||
    !(lookup.value instanceof Uint8Array)
  ) {
    throw new Error(`${label} is absent from the verified certificate tree`);
  }
  return lookup.value;
}

function decodeCertifiedControllers(bytes: Uint8Array): readonly string[] {
  let decoded: unknown;
  try {
    decoded = Cbor.decode<unknown>(bytes);
  } catch (error) {
    throw new Error("Certified Kernel controllers are not valid CBOR", {
      cause: error,
    });
  }
  if (
    !Array.isArray(decoded) ||
    decoded.some((entry) => !(entry instanceof Uint8Array))
  ) {
    throw new Error("Certified Kernel controllers must be principal blobs");
  }
  return canonicalControllers(
    decoded.map((entry) =>
      Principal.fromUint8Array(entry as Uint8Array).toText(),
    ),
    "Certified Kernel controllers",
  );
}

function decodeUnsignedLeb128(bytes: Uint8Array, label: string): bigint {
  let value = 0n;
  let shift = 0n;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (index >= 19) throw new Error(`${label} is too large`);
    const byte = bytes[index]!;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      if (index !== bytes.byteLength - 1) {
        throw new Error(`${label} contains trailing bytes`);
      }
      return value;
    }
    shift += 7n;
  }
  throw new Error(`${label} is truncated`);
}

function canonicalPositiveNat(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !/^[1-9][0-9]*$/u.test(value)
  ) {
    throw new Error(`${label} must be a positive canonical nat`);
  }
  return value;
}

function exactModuleHash(value: Uint8Array | undefined): string {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw new Error(
      "Management canister_status did not contain one 32-byte module hash",
    );
  }
  return toHex(value);
}

function cloneProofBundles(
  value: DeploymentEvidenceProofBundlesV1,
): DeploymentEvidenceProofBundlesV1 {
  if (
    typeof value !== "object" ||
    value === null ||
    !(value.expected instanceof Uint8Array) ||
    !(value.observed instanceof Uint8Array)
  ) {
    throw new Error("Registry proof bundles must be byte arrays");
  }
  return {
    expected: value.expected.slice(),
    observed: value.observed.slice(),
  };
}

function bareHttpsOrigin(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Deployed Kernel observation host must be an HTTPS origin");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error("Deployed Kernel observation host must be an HTTPS origin", {
      cause: error,
    });
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("Deployed Kernel observation host must be a bare HTTPS origin");
  }
  return url.origin;
}

function assertIdentity(value: Identity): void {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof value.getPrincipal !== "function" ||
    typeof value.transformRequest !== "function" ||
    value.getPrincipal().isAnonymous()
  ) {
    throw new Error("Deployed Kernel observation requires an authenticated identity");
  }
}

function sha256Hex(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index])
  );
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
