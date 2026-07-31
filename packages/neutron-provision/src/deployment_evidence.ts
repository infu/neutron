import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { link, lstat, mkdir, open, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { Principal } from "@dfinity/principal";

export const DEPLOYMENT_OBSERVATION_SCHEMA_V1 = 1;
export const DEPLOYMENT_EVIDENCE_SCHEMA_V1 = 1;
export const DEPLOYMENT_OBSERVATION_SOURCE_V1 =
  "ic_registry_certified_v1" as const;
export const DEPLOYMENT_PRICING_PROFILE_V1 =
  "application_13_node" as const;
export const MAX_DEPLOYMENT_PROOF_BUNDLE_BYTES = 16 * 1024 * 1024;

const SESSION_SUFFIX = ".ndeploy.session.json";
const PROOF_ARTIFACT_SUFFIX = ".registry-proof-v1";
const OBSERVATION_FINGERPRINT_DOMAIN =
  "neutron-deployment-observation-v1\0";
const EVIDENCE_FINGERPRINT_DOMAIN = "neutron-deployment-evidence-v1\0";
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CANONICAL_NAT_PATTERN = /^(0|[1-9][0-9]*)$/;
const ANONYMOUS_PRINCIPAL = Principal.anonymous().toText();

export type DeploymentSubnetTypeV1 =
  | "application"
  | "verified_application"
  | "system"
  | "fiduciary";

export type DeploymentObservationClaimsV1 = {
  schema: typeof DEPLOYMENT_OBSERVATION_SCHEMA_V1;
  source: typeof DEPLOYMENT_OBSERVATION_SOURCE_V1;
  subnetId: string;
  registryVersion: string;
  subnetType: DeploymentSubnetTypeV1;
  nodeCount: number;
  sevEnabled: boolean;
  pricingProfile: typeof DEPLOYMENT_PRICING_PROFILE_V1;
  verifiedAt: string;
};

export type DeploymentObservationV1 = DeploymentObservationClaimsV1 & {
  evidenceSha256: string;
  fingerprint: string;
};

export type DeploymentEvidenceV1 = {
  schema: typeof DEPLOYMENT_EVIDENCE_SCHEMA_V1;
  expected: DeploymentObservationV1;
  observed: DeploymentObservationV1;
  fingerprint: string;
};

export type DeploymentEvidenceProofBundlesV1 = {
  expected: Uint8Array;
  observed: Uint8Array;
};

export type DeploymentObservationRequestV1 = {
  subnetId: string;
};

export type DeploymentObservationProviderResultV1 = {
  observation: DeploymentObservationClaimsV1;
  proofBundle: Uint8Array;
};

/**
 * Network-specific Registry verification lives behind this boundary. The
 * stock pinned-mainnet implementation is in ic_registry_evidence.ts; this
 * schema module never falls back to an unauthenticated observation.
 */
export interface DeploymentEvidenceProviderV1 {
  observe(
    request: DeploymentObservationRequestV1,
  ): Promise<DeploymentObservationProviderResultV1>;
}

export type DeploymentProofArtifactV1 = {
  path: string;
  sha256: string;
  bytes: number;
};

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * RFC 8785 JSON Canonicalization Scheme (JCS).
 *
 * Inputs must already be JSON/I-JSON values. In addition to the RFC rules this
 * boundary rejects accessors, sparse arrays, symbols, custom prototypes, and
 * non-enumerable properties so cryptographic input cannot depend on JavaScript
 * object behavior which is absent from the JSON data model.
 */
export function rfc8785Jcs(value: JsonValue): string {
  return serializeJcs(value, new Set<object>(), "$");
}

export function rfc8785JcsBytes(value: JsonValue): Uint8Array {
  return new TextEncoder().encode(rfc8785Jcs(value));
}

/**
 * Parse JSON while enforcing the I-JSON properties JCS relies on, including
 * rejecting duplicate names before JSON.parse can silently collapse them.
 */
export function parseIJson(source: string): JsonValue {
  if (typeof source !== "string") {
    throw new Error("I-JSON source must be a string");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error("Malformed I-JSON", { cause: error });
  }
  assertNoDuplicateJsonNames(source);
  // Serialization performs the remaining I-JSON checks (finite binary64
  // numbers and valid Unicode scalar strings).
  rfc8785Jcs(parsed as JsonValue);
  return parsed as JsonValue;
}

export function deploymentObservationFingerprintV1(
  observation:
    | Omit<DeploymentObservationV1, "fingerprint">
    | DeploymentObservationV1,
): string {
  assertObservationFingerprintInput(
    observation,
    "deployment observation fingerprint input",
  );
  const semantic = observationWithoutFingerprint(observation);
  return domainSeparatedJcsSha256(
    OBSERVATION_FINGERPRINT_DOMAIN,
    semantic as unknown as JsonValue,
  );
}

export function deploymentEvidenceFingerprintV1(
  evidence: Omit<DeploymentEvidenceV1, "fingerprint"> | DeploymentEvidenceV1,
): string {
  const input = record(evidence, "deployment evidence fingerprint input");
  const hasFingerprint = Object.prototype.hasOwnProperty.call(
    input,
    "fingerprint",
  );
  exactKeys(
    input,
    hasFingerprint
      ? ["schema", "expected", "observed", "fingerprint"]
      : ["schema", "expected", "observed"],
    "deployment evidence fingerprint input",
  );
  if (hasFingerprint) {
    sha256String(
      input.fingerprint,
      "deployment evidence fingerprint input.fingerprint",
    );
  }
  const semantic = {
    schema: evidence.schema,
    expected: exactObservation(evidence.expected),
    observed: exactObservation(evidence.observed),
  };
  if (semantic.schema !== DEPLOYMENT_EVIDENCE_SCHEMA_V1) {
    invalid(
      "deployment evidence fingerprint input.schema",
      `must equal ${DEPLOYMENT_EVIDENCE_SCHEMA_V1}`,
    );
  }
  assertDeploymentObservationV1(
    semantic.expected,
    "deployment evidence fingerprint input.expected",
  );
  assertDeploymentObservationV1(
    semantic.observed,
    "deployment evidence fingerprint input.observed",
  );
  return domainSeparatedJcsSha256(
    EVIDENCE_FINGERPRINT_DOMAIN,
    semantic as unknown as JsonValue,
  );
}

function assertObservationFingerprintInput(
  value: unknown,
  label: string,
): void {
  const observation = record(value, label);
  const hasFingerprint = Object.prototype.hasOwnProperty.call(
    observation,
    "fingerprint",
  );
  exactKeys(
    observation,
    hasFingerprint
      ? [
          "schema",
          "source",
          "subnetId",
          "registryVersion",
          "subnetType",
          "nodeCount",
          "sevEnabled",
          "pricingProfile",
          "evidenceSha256",
          "verifiedAt",
          "fingerprint",
        ]
      : [
          "schema",
          "source",
          "subnetId",
          "registryVersion",
          "subnetType",
          "nodeCount",
          "sevEnabled",
          "pricingProfile",
          "evidenceSha256",
          "verifiedAt",
        ],
    label,
  );
  assertObservationFields(observation, label);
  sha256String(observation.evidenceSha256, `${label}.evidenceSha256`);
  if (hasFingerprint) {
    sha256String(observation.fingerprint, `${label}.fingerprint`);
  }
}

/**
 * Bind verified normalized registry fields to the exact certified proof bytes.
 */
export function createDeploymentObservationV1(
  claims: DeploymentObservationClaimsV1,
  proofBundle: Uint8Array,
): DeploymentObservationV1 {
  assertObservationClaimsV1(claims, "deployment observation claims");
  const evidenceSha256 = deploymentProofBundleSha256(proofBundle);
  const withoutFingerprint = {
    schema: claims.schema,
    source: claims.source,
    subnetId: claims.subnetId,
    registryVersion: claims.registryVersion,
    subnetType: claims.subnetType,
    nodeCount: claims.nodeCount,
    sevEnabled: claims.sevEnabled,
    pricingProfile: claims.pricingProfile,
    evidenceSha256,
    verifiedAt: claims.verifiedAt,
  };
  const observation: DeploymentObservationV1 = {
    ...withoutFingerprint,
    fingerprint: deploymentObservationFingerprintV1(withoutFingerprint),
  };
  assertDeploymentObservationV1(observation);
  return observation;
}

export function createDeploymentEvidenceV1(
  expected: DeploymentObservationV1,
  observed: DeploymentObservationV1,
  proofBundles: DeploymentEvidenceProofBundlesV1,
): DeploymentEvidenceV1 {
  const exactProofBundles = deploymentEvidenceProofBundles(
    proofBundles,
    "deployment evidence proof bundles",
  );
  assertDeploymentObservationProofV1(
    expected,
    exactProofBundles.expected,
    "deployment evidence expected",
  );
  assertDeploymentObservationProofV1(
    observed,
    exactProofBundles.observed,
    "deployment evidence observed",
  );
  assertCompatibleDeploymentObservationsV1(expected, observed);
  const withoutFingerprint: Omit<DeploymentEvidenceV1, "fingerprint"> = {
    schema: DEPLOYMENT_EVIDENCE_SCHEMA_V1,
    expected: exactObservation(expected),
    observed: exactObservation(observed),
  };
  return {
    ...withoutFingerprint,
    fingerprint: deploymentEvidenceFingerprintV1(withoutFingerprint),
  };
}

/**
 * Validate a provider result and bind it to the requested canonical subnet.
 */
export async function collectDeploymentObservationV1(
  provider: DeploymentEvidenceProviderV1,
  request: DeploymentObservationRequestV1,
): Promise<DeploymentObservationProviderResultV1 & {
  observation: DeploymentObservationV1;
}> {
  if (
    typeof provider !== "object" ||
    provider === null ||
    typeof provider.observe !== "function"
  ) {
    throw new Error("Deployment evidence provider must implement observe()");
  }
  const requestedSubnet = canonicalPrincipal(
    request.subnetId,
    "deployment observation request.subnetId",
  );
  const result = await provider.observe({ subnetId: requestedSubnet });
  const providerResult = record(result, "deployment evidence provider result");
  exactKeys(
    providerResult,
    ["observation", "proofBundle"],
    "deployment evidence provider result",
  );
  const claims = providerResult.observation;
  assertObservationClaimsV1(claims, "deployment evidence provider observation");
  if (claims.subnetId !== requestedSubnet) {
    invalid(
      "deployment evidence provider observation.subnetId",
      `does not match requested subnet ${requestedSubnet}`,
    );
  }
  const proofBundle = deploymentProofBundle(
    providerResult.proofBundle,
    "deployment evidence provider proofBundle",
  );
  return {
    observation: createDeploymentObservationV1(claims, proofBundle),
    proofBundle,
  };
}

export function assertObservationClaimsV1(
  value: unknown,
  label = "deployment observation claims",
): asserts value is DeploymentObservationClaimsV1 {
  const observation = record(value, label);
  exactKeys(
    observation,
    [
      "schema",
      "source",
      "subnetId",
      "registryVersion",
      "subnetType",
      "nodeCount",
      "sevEnabled",
      "pricingProfile",
      "verifiedAt",
    ],
    label,
  );
  assertObservationFields(observation, label);
}

export function assertDeploymentObservationV1(
  value: unknown,
  label = "deployment observation",
): asserts value is DeploymentObservationV1 {
  const observation = record(value, label);
  exactKeys(
    observation,
    [
      "schema",
      "source",
      "subnetId",
      "registryVersion",
      "subnetType",
      "nodeCount",
      "sevEnabled",
      "pricingProfile",
      "evidenceSha256",
      "verifiedAt",
      "fingerprint",
    ],
    label,
  );
  assertObservationFields(observation, label);
  sha256String(observation.evidenceSha256, `${label}.evidenceSha256`);
  sha256String(observation.fingerprint, `${label}.fingerprint`);
  if (
    observation.fingerprint !==
    deploymentObservationFingerprintV1(
      observation as unknown as DeploymentObservationV1,
    )
  ) {
    invalid(label, "fingerprint does not match the normalized observation");
  }
}

export function assertDeploymentEvidenceV1(
  value: unknown,
  label = "deployment evidence",
): asserts value is DeploymentEvidenceV1 {
  const evidence = record(value, label);
  exactKeys(
    evidence,
    ["schema", "expected", "observed", "fingerprint"],
    label,
  );
  if (evidence.schema !== DEPLOYMENT_EVIDENCE_SCHEMA_V1) {
    invalid(
      `${label}.schema`,
      `must equal ${DEPLOYMENT_EVIDENCE_SCHEMA_V1}`,
    );
  }
  assertDeploymentObservationV1(evidence.expected, `${label}.expected`);
  assertDeploymentObservationV1(evidence.observed, `${label}.observed`);
  assertCompatibleDeploymentObservationsV1(
    evidence.expected,
    evidence.observed,
    label,
  );
  sha256String(evidence.fingerprint, `${label}.fingerprint`);
  if (
    evidence.fingerprint !==
    deploymentEvidenceFingerprintV1(
      evidence as unknown as DeploymentEvidenceV1,
    )
  ) {
    invalid(label, "fingerprint does not match expected and observed evidence");
  }
}

/**
 * Full acceptance boundary: closed schemas, every fingerprint, normalized
 * expected/observed compatibility, and both exact proof-bundle digests.
 */
export function validateDeploymentEvidenceV1(
  value: unknown,
  proofBundles: DeploymentEvidenceProofBundlesV1,
  label = "deployment evidence",
): DeploymentEvidenceV1 {
  assertDeploymentEvidenceV1(value, label);
  const exactProofBundles = deploymentEvidenceProofBundles(
    proofBundles,
    `${label} proof bundles`,
  );
  assertDeploymentObservationProofV1(
    value.expected,
    exactProofBundles.expected,
    `${label}.expected`,
  );
  assertDeploymentObservationProofV1(
    value.observed,
    exactProofBundles.observed,
    `${label}.observed`,
  );
  return value;
}

export function assertDeploymentObservationProofV1(
  observation: DeploymentObservationV1,
  proofBundle: Uint8Array,
  label = "deployment observation",
): void {
  assertDeploymentObservationV1(observation, label);
  const actual = deploymentProofBundleSha256(proofBundle);
  if (actual !== observation.evidenceSha256) {
    invalid(
      `${label}.evidenceSha256`,
      `does not match proof bundle SHA-256 ${actual}`,
    );
  }
}

/**
 * The execution proof may be newer, but it must describe exactly the placement
 * and pricing facts approved during planning.
 */
export function assertCompatibleDeploymentObservationsV1(
  expected: DeploymentObservationV1,
  observed: DeploymentObservationV1,
  label = "deployment evidence",
): void {
  assertDeploymentObservationV1(expected, `${label}.expected`);
  assertDeploymentObservationV1(observed, `${label}.observed`);
  for (const field of [
    "source",
    "subnetId",
    "subnetType",
    "nodeCount",
    "sevEnabled",
    "pricingProfile",
  ] as const) {
    if (expected[field] !== observed[field]) {
      invalid(
        label,
        `observed ${field} does not match the expected observation`,
      );
    }
  }
  if (
    compareCanonicalNats(
      observed.registryVersion,
      expected.registryVersion,
    ) < 0
  ) {
    invalid(label, "observed registryVersion predates the expected proof");
  }
  if (
    Date.parse(observed.verifiedAt) <
    Date.parse(expected.verifiedAt)
  ) {
    invalid(label, "observed verifiedAt predates the expected proof");
  }
}

function compareCanonicalNats(left: string, right: string): number {
  if (left.length !== right.length) {
    return left.length < right.length ? -1 : 1;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

export function deploymentProofBundleSha256(proofBundle: Uint8Array): string {
  const bytes = deploymentProofBundle(proofBundle, "deployment proof bundle");
  return createHash("sha256").update(bytes).digest("hex");
}

export function deploymentProofBundlePath(
  sessionPath: string,
  evidenceSha256: string,
): string {
  sha256String(evidenceSha256, "deployment proof bundle SHA-256");
  const location = deploymentProofLocation(sessionPath);
  return path.join(
    location.directory,
    `${location.stem}-${evidenceSha256}${PROOF_ARTIFACT_SUFFIX}`,
  );
}

/**
 * Durably publish an owner-read-only proof bundle without replacing an
 * existing content-addressed artifact.
 */
export async function persistDeploymentProofBundle(
  sessionPath: string,
  proofBundle: Uint8Array,
  expectedSha256?: string,
): Promise<DeploymentProofArtifactV1> {
  const bytes = deploymentProofBundle(proofBundle, "deployment proof bundle");
  const sha256 = deploymentProofBundleSha256(bytes);
  if (expectedSha256 !== undefined) {
    sha256String(expectedSha256, "expected deployment proof bundle SHA-256");
    if (expectedSha256 !== sha256) {
      throw new Error(
        `Deployment proof bundle digest mismatch: ${sha256} != ${expectedSha256}`,
      );
    }
  }
  const filename = deploymentProofBundlePath(sessionPath, sha256);
  const directory = path.dirname(filename);
  await ensureSecureProofDirectory(directory);
  const temporary = `${filename}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.chmod(0o400);
    await handle.close();
    handle = undefined;
    try {
      await link(temporary, filename);
      await fsyncDirectory(directory);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      const existing = await readDeploymentProofBundle(sessionPath, sha256);
      if (!equalBytes(existing, bytes)) {
        throw new Error(
          `Refusing to replace immutable deployment proof bundle ${filename}`,
        );
      }
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  return { path: filename, sha256, bytes: bytes.byteLength };
}

export async function readDeploymentProofBundle(
  sessionPath: string,
  evidenceSha256: string,
): Promise<Uint8Array> {
  const filename = deploymentProofBundlePath(sessionPath, evidenceSha256);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (
      isNodeError(error) &&
      (error.code === "ENOENT" || error.code === "ELOOP")
    ) {
      throw new Error(
        `Deployment proof bundle is missing or unsafe: ${filename}`,
      );
    }
    throw error;
  }
  try {
    const metadata = await handle.stat();
    assertPrivateImmutableFile(
      metadata,
      `deployment proof bundle ${filename}`,
    );
    if (
      metadata.size < 1 ||
      metadata.size > MAX_DEPLOYMENT_PROOF_BUNDLE_BYTES
    ) {
      throw new Error(
        `Deployment proof bundle must contain 1 through ${MAX_DEPLOYMENT_PROOF_BUNDLE_BYTES} bytes`,
      );
    }
    const bytes = new Uint8Array(await handle.readFile());
    const actual = deploymentProofBundleSha256(bytes);
    if (actual !== evidenceSha256) {
      throw new Error(
        `Deployment proof bundle digest mismatch: ${actual} != ${evidenceSha256}`,
      );
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

export function readDeploymentProofBundleSync(
  sessionPath: string,
  evidenceSha256: string,
): Uint8Array {
  const filename = deploymentProofBundlePath(sessionPath, evidenceSha256);
  let descriptor: number;
  try {
    descriptor = openSync(
      filename,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    if (
      isNodeError(error) &&
      (error.code === "ENOENT" || error.code === "ELOOP")
    ) {
      throw new Error(
        `Deployment proof bundle is missing or unsafe: ${filename}`,
      );
    }
    throw error;
  }
  try {
    const metadata = fstatSync(descriptor);
    assertPrivateImmutableFile(
      metadata,
      `deployment proof bundle ${filename}`,
    );
    if (
      metadata.size < 1 ||
      metadata.size > MAX_DEPLOYMENT_PROOF_BUNDLE_BYTES
    ) {
      throw new Error(
        `Deployment proof bundle must contain 1 through ${MAX_DEPLOYMENT_PROOF_BUNDLE_BYTES} bytes`,
      );
    }
    const bytes = new Uint8Array(readFileSync(descriptor));
    const actual = deploymentProofBundleSha256(bytes);
    if (actual !== evidenceSha256) {
      throw new Error(
        `Deployment proof bundle digest mismatch: ${actual} != ${evidenceSha256}`,
      );
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Remove proof artifacts for this session which are not referenced by a
 * current expected/observed pair. Unknown files and other sessions are left
 * untouched.
 */
export async function sweepUnreferencedDeploymentProofBundles(
  sessionPath: string,
  preserveSha256: readonly string[] = [],
): Promise<number> {
  const preserve = new Set<string>();
  for (const [index, digest] of preserveSha256.entries()) {
    sha256String(
      digest,
      `preserved deployment proof bundle SHA-256[${index}]`,
    );
    preserve.add(digest);
  }
  const location = deploymentProofLocation(sessionPath);
  if (!(await secureProofDirectoryExists(location.directory))) return 0;
  const finalPattern = new RegExp(
    `^${escapeRegExp(location.stem)}-([0-9a-f]{64})${escapeRegExp(
      PROOF_ARTIFACT_SUFFIX,
    )}$`,
  );
  const temporaryPattern = new RegExp(
    `^${escapeRegExp(location.stem)}-([0-9a-f]{64})${escapeRegExp(
      PROOF_ARTIFACT_SUFFIX,
    )}\\.tmp-[1-9][0-9]*-[0-9a-f]{12}$`,
  );
  let removed = 0;
  for (const entry of await readdir(location.directory, {
    withFileTypes: true,
  })) {
    const final = finalPattern.exec(entry.name);
    const temporary = temporaryPattern.exec(entry.name);
    if (!final && !temporary) continue;
    const filename = path.join(location.directory, entry.name);
    const metadata = await lstat(filename);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Refusing symlink deployment proof bundle ${filename}`);
    }
    if (final) {
      assertPrivateImmutableFile(
        metadata,
        `deployment proof bundle ${filename}`,
      );
      if (preserve.has(final[1]!)) continue;
    } else {
      assertPrivateOwnedFile(
        metadata,
        `temporary deployment proof bundle ${filename}`,
      );
    }
    await rm(filename);
    removed += 1;
  }
  if (removed > 0) await fsyncDirectory(location.directory);
  return removed;
}

function serializeJcs(
  value: JsonValue,
  ancestors: Set<object>,
  label: string,
): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      invalid(label, "contains NaN or Infinity");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    assertUnicodeScalarString(value, label);
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    invalid(label, `contains non-JSON value ${typeof value}`);
  }
  if (ancestors.has(value)) invalid(label, "contains a cycle");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      assertPlainJsonArray(value, label);
      const encoded: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        encoded.push(serializeJcs(value[index]!, ancestors, `${label}[${index}]`));
      }
      return `[${encoded.join(",")}]`;
    }
    assertPlainJsonObject(value, label);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(value).sort(compareUtf16);
    return `{${keys
      .map((key) => {
        assertUnicodeScalarString(key, `${label} property name`);
        const descriptor = descriptors[key]!;
        return `${JSON.stringify(key)}:${serializeJcs(
          descriptor.value as JsonValue,
          ancestors,
          `${label}.${key}`,
        )}`;
      })
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function assertPlainJsonArray(value: JsonValue[], label: string): void {
  const ownKeys = Reflect.ownKeys(value);
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      invalid(label, "contains a sparse array slot");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      invalid(`${label}[${index}]`, "must be a plain enumerable JSON value");
    }
  }
  const expectedKeys = value.length + 1;
  if (
    ownKeys.length !== expectedKeys ||
    ownKeys.some(
      (key) =>
        typeof key !== "string" ||
        (key !== "length" &&
          (!/^(0|[1-9][0-9]*)$/.test(key) ||
            Number(key) >= value.length)),
    )
  ) {
    invalid(label, "has non-JSON array properties");
  }
}

function assertPlainJsonObject(
  value: { [key: string]: JsonValue },
  label: string,
): void {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    invalid(label, "must have a plain JSON object prototype");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(value);
  for (const key of ownKeys) {
    if (typeof key !== "string") {
      invalid(label, "contains a symbol property");
    }
    const descriptor = descriptors[key]!;
    if (!descriptor.enumerable || !("value" in descriptor)) {
      invalid(`${label}.${key}`, "must be a plain enumerable JSON value");
    }
  }
}

function compareUtf16(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertUnicodeScalarString(value: string, label: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        invalid(label, "contains a lone high surrogate");
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      invalid(label, "contains a lone low surrogate");
    }
  }
}

function assertNoDuplicateJsonNames(source: string): void {
  let index = 0;

  function whitespace(): void {
    while (
      source[index] === " " ||
      source[index] === "\t" ||
      source[index] === "\n" ||
      source[index] === "\r"
    ) {
      index += 1;
    }
  }

  function stringToken(): string {
    const start = index;
    if (source[index] !== '"') throw new Error("Malformed I-JSON string");
    index += 1;
    while (index < source.length) {
      const character = source[index]!;
      if (character === '"') {
        index += 1;
        return JSON.parse(source.slice(start, index)) as string;
      }
      if (character === "\\") {
        index += source[index + 1] === "u" ? 6 : 2;
      } else {
        index += 1;
      }
    }
    throw new Error("Malformed I-JSON string");
  }

  function value(): void {
    whitespace();
    const character = source[index];
    if (character === "{") {
      object();
      return;
    }
    if (character === "[") {
      array();
      return;
    }
    if (character === '"') {
      stringToken();
      return;
    }
    const number = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
    number.lastIndex = index;
    const match = number.exec(source);
    if (match) {
      index = number.lastIndex;
      return;
    }
    for (const literal of ["true", "false", "null"]) {
      if (source.startsWith(literal, index)) {
        index += literal.length;
        return;
      }
    }
    throw new Error("Malformed I-JSON value");
  }

  function object(): void {
    index += 1;
    whitespace();
    const names = new Set<string>();
    if (source[index] === "}") {
      index += 1;
      return;
    }
    while (index < source.length) {
      whitespace();
      const name = stringToken();
      if (names.has(name)) {
        throw new Error(`I-JSON object contains duplicate property ${JSON.stringify(name)}`);
      }
      names.add(name);
      whitespace();
      if (source[index] !== ":") throw new Error("Malformed I-JSON object");
      index += 1;
      value();
      whitespace();
      if (source[index] === "}") {
        index += 1;
        return;
      }
      if (source[index] !== ",") throw new Error("Malformed I-JSON object");
      index += 1;
    }
    throw new Error("Malformed I-JSON object");
  }

  function array(): void {
    index += 1;
    whitespace();
    if (source[index] === "]") {
      index += 1;
      return;
    }
    while (index < source.length) {
      value();
      whitespace();
      if (source[index] === "]") {
        index += 1;
        return;
      }
      if (source[index] !== ",") throw new Error("Malformed I-JSON array");
      index += 1;
    }
    throw new Error("Malformed I-JSON array");
  }

  value();
  whitespace();
  if (index !== source.length) throw new Error("Malformed I-JSON trailing data");
}

function domainSeparatedJcsSha256(domain: string, value: JsonValue): string {
  return createHash("sha256")
    .update(domain, "utf8")
    .update(rfc8785JcsBytes(value))
    .digest("hex");
}

function observationWithoutFingerprint(
  observation:
    | Omit<DeploymentObservationV1, "fingerprint">
    | DeploymentObservationV1,
): Omit<DeploymentObservationV1, "fingerprint"> {
  return {
    schema: observation.schema,
    source: observation.source,
    subnetId: observation.subnetId,
    registryVersion: observation.registryVersion,
    subnetType: observation.subnetType,
    nodeCount: observation.nodeCount,
    sevEnabled: observation.sevEnabled,
    pricingProfile: observation.pricingProfile,
    evidenceSha256: observation.evidenceSha256,
    verifiedAt: observation.verifiedAt,
  };
}

function exactObservation(
  observation: DeploymentObservationV1,
): DeploymentObservationV1 {
  return {
    schema: observation.schema,
    source: observation.source,
    subnetId: observation.subnetId,
    registryVersion: observation.registryVersion,
    subnetType: observation.subnetType,
    nodeCount: observation.nodeCount,
    sevEnabled: observation.sevEnabled,
    pricingProfile: observation.pricingProfile,
    evidenceSha256: observation.evidenceSha256,
    verifiedAt: observation.verifiedAt,
    fingerprint: observation.fingerprint,
  };
}

function assertObservationFields(
  observation: Record<string, unknown>,
  label: string,
): void {
  if (observation.schema !== DEPLOYMENT_OBSERVATION_SCHEMA_V1) {
    invalid(
      `${label}.schema`,
      `must equal ${DEPLOYMENT_OBSERVATION_SCHEMA_V1}`,
    );
  }
  if (observation.source !== DEPLOYMENT_OBSERVATION_SOURCE_V1) {
    invalid(
      `${label}.source`,
      `must equal ${DEPLOYMENT_OBSERVATION_SOURCE_V1}`,
    );
  }
  canonicalPrincipal(observation.subnetId, `${label}.subnetId`);
  canonicalNat(observation.registryVersion, `${label}.registryVersion`);
  if (
    observation.subnetType !== "application" &&
    observation.subnetType !== "verified_application" &&
    observation.subnetType !== "system" &&
    observation.subnetType !== "fiduciary"
  ) {
    invalid(`${label}.subnetType`, "is not a recognized subnet type");
  }
  safeInteger(observation.nodeCount, `${label}.nodeCount`, 1, 64);
  if (typeof observation.sevEnabled !== "boolean") {
    invalid(`${label}.sevEnabled`, "must be a boolean");
  }
  if (observation.pricingProfile !== DEPLOYMENT_PRICING_PROFILE_V1) {
    invalid(
      `${label}.pricingProfile`,
      `must equal ${DEPLOYMENT_PRICING_PROFILE_V1}`,
    );
  }
  const applicationFamily =
    observation.subnetType === "application" ||
    observation.subnetType === "verified_application";
  if (
    !applicationFamily ||
    (observation.nodeCount !== 13 &&
      !(observation.nodeCount === 7 && observation.sevEnabled === true))
  ) {
    invalid(
      label,
      `${DEPLOYMENT_PRICING_PROFILE_V1} supports 13-node application-family subnets and equivalent 7-node SEV application-family subnets`,
    );
  }
  canonicalTimestamp(observation.verifiedAt, `${label}.verifiedAt`);
}

function deploymentProofBundle(value: unknown, label: string): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    invalid(label, "must be a Uint8Array");
  }
  if (
    value.byteLength < 1 ||
    value.byteLength > MAX_DEPLOYMENT_PROOF_BUNDLE_BYTES
  ) {
    invalid(
      label,
      `must contain 1 through ${MAX_DEPLOYMENT_PROOF_BUNDLE_BYTES} bytes`,
    );
  }
  return value;
}

function deploymentEvidenceProofBundles(
  value: unknown,
  label: string,
): DeploymentEvidenceProofBundlesV1 {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !Object.prototype.hasOwnProperty.call(value, "expected") ||
    !Object.prototype.hasOwnProperty.call(value, "observed")
  ) {
    invalid(label, "requires expected and observed registry proof bundles");
  }
  const bundles = record(value, label);
  exactKeys(bundles, ["expected", "observed"], label);
  return {
    expected: deploymentProofBundle(
      bundles.expected,
      `${label}.expected`,
    ),
    observed: deploymentProofBundle(
      bundles.observed,
      `${label}.observed`,
    ),
  };
}

function deploymentProofLocation(sessionPath: string): {
  directory: string;
  stem: string;
} {
  const resolved = path.resolve(sessionPath);
  if (!resolved.endsWith(SESSION_SUFFIX)) {
    throw new Error(
      `Deployment session path must end with ${SESSION_SUFFIX}: ${resolved}`,
    );
  }
  const stem = path.basename(resolved, SESSION_SUFFIX);
  if (stem.length === 0) {
    throw new Error(`Deployment session path must have a name: ${resolved}`);
  }
  return {
    directory: path.join(path.dirname(resolved), ".neutron", "provision"),
    stem,
  };
}

async function ensureSecureProofDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await assertSecureProofDirectory(directory);
}

async function secureProofDirectoryExists(directory: string): Promise<boolean> {
  try {
    await assertSecureProofDirectory(directory);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

async function assertSecureProofDirectory(directory: string): Promise<void> {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(
      `Deployment proof directory must be a real directory: ${directory}`,
    );
  }
  const uid = process.getuid?.();
  if (uid !== undefined && metadata.uid !== uid) {
    throw new Error(
      `Deployment proof directory is not owned by current user: ${directory}`,
    );
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error(`Deployment proof directory must be private: ${directory}`);
  }
}

function assertPrivateImmutableFile(
  metadata: Awaited<ReturnType<typeof lstat>>,
  label: string,
): void {
  assertPrivateOwnedFile(metadata, label);
  if ((Number(metadata.mode) & 0o222) !== 0) {
    throw new Error(`${label} must be immutable (mode 0400 or stricter)`);
  }
}

function assertPrivateOwnedFile(
  metadata: Awaited<ReturnType<typeof lstat>>,
  label: string,
): void {
  if (!metadata.isFile()) throw new Error(`${label} must be a regular file`);
  const uid = process.getuid?.();
  if (uid !== undefined && metadata.uid !== uid) {
    throw new Error(`${label} is not owned by current user`);
  }
  if ((Number(metadata.mode) & 0o077) !== 0) {
    throw new Error(`${label} must be private`);
  }
}

async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    invalid(label, "must be a plain object");
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  label: string,
): void {
  const expected = new Set(required);
  const unknown = Object.keys(value).filter((key) => !expected.has(key));
  const missing = required.filter(
    (key) => !Object.prototype.hasOwnProperty.call(value, key),
  );
  if (unknown.length > 0) {
    invalid(label, `has unknown field(s): ${unknown.join(", ")}`);
  }
  if (missing.length > 0) {
    invalid(label, `is missing field(s): ${missing.join(", ")}`);
  }
  if (Reflect.ownKeys(value).length !== Object.keys(value).length) {
    invalid(label, "contains non-enumerable or symbol fields");
  }
  for (const descriptor of Object.values(
    Object.getOwnPropertyDescriptors(value),
  )) {
    if (!descriptor.enumerable || !("value" in descriptor)) {
      invalid(label, "contains an accessor or non-enumerable field");
    }
  }
}

function canonicalPrincipal(value: unknown, label: string): string {
  if (typeof value !== "string") invalid(label, "must be a principal");
  let principal: Principal;
  try {
    principal = Principal.fromText(value);
  } catch {
    invalid(label, "must be a valid principal");
  }
  const canonical = principal.toText();
  if (canonical !== value || canonical === ANONYMOUS_PRINCIPAL) {
    invalid(label, "must be a canonical non-anonymous principal");
  }
  return canonical;
}

function canonicalNat(value: unknown, label: string): string {
  if (typeof value !== "string" || !CANONICAL_NAT_PATTERN.test(value)) {
    invalid(label, "must be a canonical unsigned decimal natural number");
  }
  return value;
}

function canonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string") {
    invalid(label, "must be a canonical UTC ISO-8601 timestamp");
  }
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== value) {
    invalid(label, "must be a canonical UTC ISO-8601 timestamp");
  }
  return value;
}

function safeInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    invalid(label, `must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function sha256String(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    invalid(label, "must be 64 lowercase hexadecimal characters");
  }
  return value;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function invalid(label: string, message: string): never {
  throw new Error(`Invalid ${label}: ${message}`);
}
