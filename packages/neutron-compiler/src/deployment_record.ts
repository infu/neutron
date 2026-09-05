import { gzipSync } from "fflate";
import { isValidAppId } from "neutron-tools/src/app_ids.js";
import { compareCanonicalText } from "neutron-tools/src/canonical.js";
import { hashContent } from "neutron-tools/src/hash.js";
import { normalizeUpdateSourcePrincipal } from "neutron-tools/src/schema.js";
import { assertAppVersion } from "neutron-tools/src/version.js";
import type { CompileResult } from "./compile.ts";

export { PACKAGE_INFORMATION_RECORD_PATH } from "neutron-tools/src/package_record.js";

const MIB = 1024 * 1024;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const SHA256 = /^[a-f0-9]{64}$/u;
const DEPLOYMENT_ID = /^[a-f0-9]{32}$/u;
const MEMORY_ID = /^[a-zA-Z_][a-zA-Z_0-9]{0,127}$/u;
const TOOL_ID = /^[a-zA-Z0-9._:-]+$/u;
const DEPENDENCY_ALIAS = /^[a-z][a-z0-9_]{0,29}$/u;
const DEPENDENCY_FUNCTION = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const DIAGNOSTIC_CODE = /^[a-zA-Z0-9._:-]+$/u;
const PROHIBITED_TEXT =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\p{Cf}\p{Default_Ignorable_Code_Point}\p{Zl}\p{Zp}]/u;
const OBVIOUS_SECRET =
  /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:basic|bearer)\s+[a-z0-9+/=._~-]{8,})/iu;

export const DEPLOYMENT_BUILD_RECORD_FORMAT = 1 as const;
export const DEPLOYMENT_BUILD_RECORD_PATH =
  "/system/deployment-build-record.json" as const;
export const DEPLOYMENT_BUILD_RECORD_MAX_JSON_BYTES = 4 * MIB;
export const DEPLOYMENT_WASM_MAX_BYTES = 100 * MIB;
export const DEPLOYMENT_WASM_TRANSPORT_ENCODER =
  "fflate@0.8.3:default-level:mtime=0" as const;

const MAX_PACKAGES = 256;
const MAX_DEPENDENCIES_PER_PACKAGE = 32;
const MAX_FUNCTIONS_PER_DEPENDENCY = 64;
const MAX_MANAGED_MEMORIES = 16_384;
const MAX_REACHABLE_MODULES = 20_000;
const MAX_DIAGNOSTICS = 4_096;
const MAX_MEMORY_CHANGES = 16_384;
const MAX_MIGRATION_EDGES = 256;
const MAX_PACKAGE_ARCHIVE_BYTES = 128 * MIB;
const MAX_INSTALL_ARGUMENT_BYTES = 2 * MIB;
const MAX_JSON_DEPTH = 64;
const MAX_RECORD_GRAPH_NODES = 500_000;

export type DeploymentAppInventoryRecord = Readonly<{
  app_id: string;
  version: number;
  capability_plan_fingerprint: string;
  resident_frame_security:
    | "credentialless_opaque_v1"
    | "credentialless_ephemeral_dedicated_v1"
    | "persistent_dedicated_v1";
}>;

export type DeploymentMemoryInventoryRecord = Readonly<{
  owner: string;
  id: string;
  version: number;
  schema: string;
}>;

export type DeploymentPackageArchiveRecord =
  | Readonly<{
      state: "verified";
      sha256: string;
      bytes: number;
    }>
  | Readonly<{
      state: "outer_archive_digest_only";
      sha256: string;
    }>
  | Readonly<{
      state: "legacy_unavailable";
    }>;

export type PackageInformationRecordIdentity =
  | Readonly<{
      state: "verified";
      sha256: string;
    }>
  | Readonly<{
      state: "legacy_unavailable";
    }>
  | Readonly<{
      state: "not_supplied";
    }>;

export type DeploymentPackageDependencyRecord = Readonly<{
  alias: string;
  provider_app_id: string;
  minimum_version: number;
  provider_version: number;
  functions: readonly string[];
}>;

export type DeploymentPackageBuildInput = Readonly<{
  app_id: string;
  version: number;
  archive: DeploymentPackageArchiveRecord;
  package_information: PackageInformationRecordIdentity;
  dependencies: readonly DeploymentPackageDependencyRecord[];
}>;

export type DeploymentDiagnosticRecord = Readonly<{
  source: string;
  range: Readonly<{
    start: Readonly<{ line: number; character: number }>;
    end: Readonly<{ line: number; character: number }>;
  }>;
  severity: number;
  code: string;
  category: string;
  message: string;
}>;

export type DeploymentMemoryResource = Readonly<{
  owner: string;
  memory_id: string;
}>;

export type DeploymentMigrationEdge = Readonly<{
  from: number;
  to: number;
  entry_sha256: string;
  consume: readonly string[];
}>;

export type DeploymentMemoryChange =
  | Readonly<{
      kind: "initialize";
      owner: string;
      memory_id: string;
      to: number;
    }>
  | Readonly<{
      kind: "keep";
      owner: string;
      memory_id: string;
      version: number;
    }>
  | Readonly<{
      kind: "migrate";
      owner: string;
      memory_id: string;
      from: number;
      to: number;
      old_schema_entry_sha256: string;
      path: readonly DeploymentMigrationEdge[];
    }>
  | Readonly<{
      kind: "retire";
      reason: "memory-retirement" | "app-uninstall";
      owner: string;
      memory_id: string;
      from: number;
      old_schema_entry_sha256: string;
    }>;

export type DeploymentWarningsRecord = Readonly<{
  diagnostics: readonly DeploymentDiagnosticRecord[];
  compatibility_diagnostics: readonly DeploymentDiagnosticRecord[];
  memory_changes: readonly DeploymentMemoryChange[];
  removed_apps: readonly string[];
  destructive_memory_roots: readonly DeploymentMemoryResource[];
}>;

export type DeploymentWasmRecord = Readonly<{
  raw: Readonly<{
    sha256: string;
    bytes: number;
    representation: "neutron_compile_result_wasm";
    content_encoding: "identity";
  }>;
  transport: Readonly<{
    sha256: string;
    bytes: number;
    representation: "ic_install_wasm_payload";
    content_encoding: "gzip";
    encoder: typeof DEPLOYMENT_WASM_TRANSPORT_ENCODER;
  }>;
}>;

export type CompleteDeploymentBuildRecord = Readonly<{
  format: typeof DEPLOYMENT_BUILD_RECORD_FORMAT;
  state: "complete";
  deployment_id: string;
  previous: Readonly<{
    deployment_id: string | null;
    stable_signature_sha256: string | null;
    apps: readonly DeploymentAppInventoryRecord[];
    memories: readonly DeploymentMemoryInventoryRecord[];
  }>;
  build: Readonly<{
    compiler_id: string;
    assembler_id: string;
    environment: "production" | "local";
    deployment_nonce: string | null;
    reachable_module_sha256: readonly string[];
  }>;
  packages: readonly DeploymentPackageBuildInput[];
  target: Readonly<{
    apps: readonly DeploymentAppInventoryRecord[];
    memories: readonly DeploymentMemoryInventoryRecord[];
  }>;
  warnings: DeploymentWarningsRecord;
  installation: Readonly<{
    target_canister: string;
    mode: "install" | "upgrade" | "reinstall";
    argument: Readonly<{ sha256: string; bytes: number }>;
    wasm_memory_persistence: "keep" | "replace";
  }>;
  wasm: DeploymentWasmRecord;
}>;

export type LegacyUnavailableCode =
  | "ordered_package_digests"
  | "package_archive_bytes"
  | "source_and_license_record"
  | "raw_compiler_output"
  | "gzip_transport_details"
  | "pre_dispatch_warnings"
  | "installation_inputs"
  | "prior_state";

export type LegacyObservedDeploymentBuildRecord = Readonly<{
  format: typeof DEPLOYMENT_BUILD_RECORD_FORMAT;
  state: "legacy_observed";
  observation: Readonly<{
    target_canister: string;
    deployment_id: string;
    compiler_id: string;
    assembler_id: string;
    apps: readonly DeploymentAppInventoryRecord[];
    memories: readonly DeploymentMemoryInventoryRecord[];
    installed_module: Readonly<{
      sha256: string;
      representation: "ic_canister_status.module_hash";
      source: "ic_certified_read_state_v1";
    }>;
  }>;
  packages: readonly Readonly<{
    app_id: string;
    version: number;
    outer_archive_sha256: string | null;
    package_information_sha256: string | null;
  }>[];
  unavailable: readonly LegacyUnavailableCode[];
}>;

export type DeploymentBuildRecord =
  CompleteDeploymentBuildRecord | LegacyObservedDeploymentBuildRecord;

export type PreparedDeterministicWasmTransport = Readonly<{
  transportWasm: Uint8Array;
  wasmRecord: DeploymentWasmRecord;
}>;

export type DeploymentPackageIdentityInput = Readonly<{
  app_id: string;
  version: number;
  archive: DeploymentPackageArchiveRecord;
  package_information: PackageInformationRecordIdentity;
}>;

export type CompleteDeploymentBuildInput = Readonly<{
  compiled: Pick<
    CompileResult,
    | "wasm"
    | "deploymentId"
    | "compilerId"
    | "modulePaths"
    | "appInstanceInventory"
    | "managedMemoryInventory"
    | "diagnostics"
    | "compatibilityDiagnostics"
    | "dependencyPlan"
    | "migrationPlan"
  > &
    Readonly<{
      deploymentNonce: string | null;
      vetKeysEnvironment: "production" | "local";
    }>;
  assembler_id: string;
  previous: Readonly<{
    deployment_id: string | null;
    /** Exact previous Motoko stable signature; only its SHA-256 is recorded. */
    stable_signature: string | null;
    apps: readonly DeploymentAppInventoryRecord[];
    memories: readonly DeploymentMemoryInventoryRecord[];
  }>;
  /** All target packages, including retained packages, keyed by app id. */
  packages: readonly DeploymentPackageIdentityInput[];
  installation: Readonly<{
    target_canister: string;
    mode: "install" | "upgrade" | "reinstall";
    /** Exact management-canister install argument; only its digest is recorded. */
    argument: Uint8Array;
    wasm_memory_persistence: "keep" | "replace";
  }>;
}>;

export type PreparedCompleteDeploymentBuild = Readonly<{
  record: CompleteDeploymentBuildRecord;
  recordBytes: Uint8Array;
  transportWasm: Uint8Array;
}>;

// Keep deterministic compression with its live compiler bytes, not in a global
// digest cache. Callers only receive copies of the cached compressed buffer.
const wasmTransportCache = new WeakMap<
  Uint8Array,
  PreparedDeterministicWasmTransport
>();

/** Preserve prepared compression across the installer's private raw snapshot. */
export function snapshotWasmForDeployment(rawWasm: Uint8Array): Uint8Array {
  const snapshot = Uint8Array.from(rawWasm);
  const cached = wasmTransportCache.get(rawWasm);
  if (cached) wasmTransportCache.set(snapshot, cached);
  // Cache reuse still requires a matching digest in prepareDeterministicWasmTransport.
  return snapshot;
}

/**
 * Validate and normalize a deployment record into its one canonical ordering.
 * The input language deliberately contains no credentials, raw install args,
 * user authorization material, browser-origin nonces, or installation UIDs.
 */
export function parseDeploymentBuildRecord(
  value: unknown,
): DeploymentBuildRecord {
  assertBoundedPlainDataGraph(value);
  const record = exactRecord(
    value,
    "deployment build record",
    valueState(value) === "complete"
      ? [
          "format",
          "state",
          "deployment_id",
          "previous",
          "build",
          "packages",
          "target",
          "warnings",
          "installation",
          "wasm",
        ]
      : ["format", "state", "observation", "packages", "unavailable"],
  );
  if (record.format !== DEPLOYMENT_BUILD_RECORD_FORMAT) {
    fail("deployment build record has an unsupported format");
  }
  if (record.state === "complete") {
    return assertRecordJsonSize(parseCompleteRecord(record));
  }
  if (record.state === "legacy_observed") {
    return assertRecordJsonSize(parseLegacyRecord(record));
  }
  fail("deployment build record has an invalid state");
}

export function parseDeploymentBuildRecordJson(
  input: string | Uint8Array,
): DeploymentBuildRecord {
  let text: string;
  if (typeof input === "string") {
    if (
      textEncoder.encode(input).byteLength >
      DEPLOYMENT_BUILD_RECORD_MAX_JSON_BYTES
    ) {
      fail("deployment build record JSON exceeds its byte limit");
    }
    text = input;
  } else if (input instanceof Uint8Array) {
    if (input.byteLength > DEPLOYMENT_BUILD_RECORD_MAX_JSON_BYTES) {
      fail("deployment build record JSON exceeds its byte limit");
    }
    try {
      text = textDecoder.decode(input);
    } catch (cause) {
      throw new Error("deployment build record must be valid UTF-8 JSON", {
        cause,
      });
    }
  } else {
    fail("deployment build record JSON must be text or bytes");
  }
  let value: unknown;
  try {
    assertNoDuplicateJsonObjectKeys(text);
    value = JSON.parse(text);
  } catch (cause) {
    throw new Error("deployment build record must be valid unambiguous JSON", {
      cause,
    });
  }
  return parseDeploymentBuildRecord(value);
}

export function canonicalDeploymentBuildRecordJson(value: unknown): string {
  const record = parseDeploymentBuildRecord(value);
  const text = `${JSON.stringify(sortJsonKeys(record), null, 2)}\n`;
  if (
    textEncoder.encode(text).byteLength > DEPLOYMENT_BUILD_RECORD_MAX_JSON_BYTES
  ) {
    fail("deployment build record JSON exceeds its byte limit");
  }
  return text;
}

export function serializeDeploymentBuildRecord(value: unknown): Uint8Array {
  return textEncoder.encode(canonicalDeploymentBuildRecordJson(value));
}

/** Domain-separated identity of the canonical UTF-8 record bytes. */
export function deploymentBuildRecordSha256(value: unknown): string {
  const domain = textEncoder.encode("neutron.deployment-build-record.v1\0");
  const record = serializeDeploymentBuildRecord(value);
  const input = new Uint8Array(domain.byteLength + record.byteLength);
  input.set(domain);
  input.set(record, domain.byteLength);
  return hashContent(input);
}

/**
 * Assemble a complete record from compiler facts and caller-observed public
 * predecessor/package identities. Install-layer wrappers remain responsible
 * for obtaining those observations without inventing unavailable facts.
 */
export function createCompleteDeploymentBuildRecord(
  input: CompleteDeploymentBuildInput,
): PreparedCompleteDeploymentBuild {
  const { compiled } = input;
  const identities = new Map<string, DeploymentPackageIdentityInput>();
  for (const [index, candidate] of input.packages.entries()) {
    const id = appId(candidate.app_id, `package identities[${index}].app_id`);
    if (identities.has(id)) fail(`package identities repeat '${id}'`);
    identities.set(id, candidate);
  }
  const packages = compiled.dependencyPlan.order.map((id, index) => {
    const identity = identities.get(id);
    if (!identity) fail(`package identity for ${id} is unavailable`);
    const dependencies = compiled.dependencyPlan.dependenciesByConsumer[id];
    if (!dependencies) fail(`compiler dependency plan is missing ${id}`);
    return {
      app_id: id,
      version: identity.version,
      archive: identity.archive,
      package_information: identity.package_information,
      dependencies: dependencies.map((dependency) => ({
        alias: dependency.alias,
        provider_app_id: dependency.provider,
        minimum_version: dependency.minVersion,
        provider_version: dependency.providerVersion,
        functions: dependency.functions,
      })),
    };
  });
  if (packages.length !== identities.size) {
    fail(
      "package identities do not exactly match the compiler dependency order",
    );
  }

  if (!(input.installation.argument instanceof Uint8Array)) {
    fail("installation argument must be exact bytes");
  }
  const preparedWasm = prepareDeterministicWasmTransport(compiled.wasm);
  const candidate = {
    format: DEPLOYMENT_BUILD_RECORD_FORMAT,
    state: "complete",
    deployment_id: compiled.deploymentId,
    previous: {
      deployment_id: input.previous.deployment_id,
      stable_signature_sha256:
        input.previous.stable_signature === null
          ? null
          : hashContent(input.previous.stable_signature),
      apps: input.previous.apps,
      memories: input.previous.memories,
    },
    build: {
      compiler_id: compiled.compilerId,
      assembler_id: input.assembler_id,
      environment: compiled.vetKeysEnvironment,
      deployment_nonce: compiled.deploymentNonce,
      reachable_module_sha256: compiled.modulePaths.map((path, index) =>
        modulePathDigest(path, `compiled.modulePaths[${index}]`),
      ),
    },
    packages,
    target: {
      apps: compiled.appInstanceInventory,
      memories: compiled.managedMemoryInventory,
    },
    warnings: {
      diagnostics: compiled.diagnostics,
      compatibility_diagnostics: compiled.compatibilityDiagnostics,
      memory_changes: compiled.migrationPlan.upgrades.map(
        memoryChangeFromCompiler,
      ),
      removed_apps: compiled.migrationPlan.removedApps,
      destructive_memory_roots:
        compiled.migrationPlan.destructiveMemoryRoots.map(
          ({ owner, memoryId }) => ({ owner, memory_id: memoryId }),
        ),
    },
    installation: {
      target_canister: input.installation.target_canister,
      mode: input.installation.mode,
      argument: {
        sha256: hashContent(input.installation.argument),
        bytes: input.installation.argument.byteLength,
      },
      wasm_memory_persistence: input.installation.wasm_memory_persistence,
    },
    wasm: preparedWasm.wasmRecord,
  };
  const record = parseDeploymentBuildRecord(candidate);
  if (record.state !== "complete")
    fail("complete deployment record normalized incorrectly");
  return Object.freeze({
    record,
    recordBytes: serializeDeploymentBuildRecord(record),
    transportWasm: preparedWasm.transportWasm,
  });
}

/**
 * Produce the exact deterministic gzip bytes that must be sent to the IC and
 * bind both their identity and the raw compiler output in one deployment-level
 * record. Callers must dispatch `transportWasm`, not recompress independently.
 */
export function prepareDeterministicWasmTransport(
  rawWasm: Uint8Array,
): PreparedDeterministicWasmTransport {
  if (!(rawWasm instanceof Uint8Array)) fail("raw Wasm must be exact bytes");
  const rawSnapshot = Uint8Array.from(rawWasm);
  assertRawWasm(rawSnapshot);
  const rawSha256 = hashContent(rawSnapshot);
  const cached = wasmTransportCache.get(rawWasm);
  if (
    cached?.wasmRecord.raw.bytes === rawSnapshot.byteLength &&
    cached.wasmRecord.raw.sha256 === rawSha256
  ) {
    return Object.freeze({
      transportWasm: cached.transportWasm.slice(),
      wasmRecord: cached.wasmRecord,
    });
  }
  const transportWasm = gzipSync(rawSnapshot, { mtime: 0 });
  assertWasmSize(transportWasm, "gzip installation payload");
  const wasmRecord: DeploymentWasmRecord = deepFreeze({
    raw: {
      sha256: rawSha256,
      bytes: rawSnapshot.byteLength,
      representation: "neutron_compile_result_wasm",
      content_encoding: "identity",
    },
    transport: {
      sha256: hashContent(transportWasm),
      bytes: transportWasm.byteLength,
      representation: "ic_install_wasm_payload",
      content_encoding: "gzip",
      encoder: DEPLOYMENT_WASM_TRANSPORT_ENCODER,
    },
  });
  wasmTransportCache.set(rawWasm, { transportWasm, wasmRecord });
  return Object.freeze({ transportWasm: transportWasm.slice(), wasmRecord });
}

/** Verify hashes, sizes, and the exact deterministic gzip representation. */
export function assertWasmRecord(
  rawWasm: Uint8Array,
  transportWasm: Uint8Array,
  value: unknown,
): DeploymentWasmRecord {
  assertRawWasm(rawWasm);
  assertWasmSize(transportWasm, "gzip installation payload");
  const record = parseWasmRecord(value, "deployment wasm");
  const prepared = prepareDeterministicWasmTransport(rawWasm);
  if (!equalBytes(transportWasm, prepared.transportWasm)) {
    fail("deployment Wasm transport is not the deterministic gzip payload");
  }
  if (JSON.stringify(record) !== JSON.stringify(prepared.wasmRecord)) {
    fail("deployment Wasm record does not match its exact bytes");
  }
  return record;
}

function parseCompleteRecord(
  record: Record<string, unknown>,
): CompleteDeploymentBuildRecord {
  const deploymentId = digest32(record.deployment_id, "deployment_id");
  const previousRecord = exactRecord(record.previous, "previous", [
    "deployment_id",
    "stable_signature_sha256",
    "apps",
    "memories",
  ]);
  const previousDeployment = nullable(previousRecord.deployment_id, (item) =>
    digest32(item, "previous.deployment_id"),
  );
  const previousStable = nullable(
    previousRecord.stable_signature_sha256,
    (item) => digest(item, "previous.stable_signature_sha256"),
  );
  const previousApps = parseAppInventory(
    previousRecord.apps,
    "previous.apps",
    0,
  );
  const previousMemories = parseMemoryInventory(
    previousRecord.memories,
    "previous.memories",
    previousApps,
  );

  const buildRecord = exactRecord(record.build, "build", [
    "compiler_id",
    "assembler_id",
    "environment",
    "deployment_nonce",
    "reachable_module_sha256",
  ]);
  const compilerId = toolId(buildRecord.compiler_id, "build.compiler_id");
  const assemblerId = toolId(buildRecord.assembler_id, "build.assembler_id");
  if (
    buildRecord.environment !== "production" &&
    buildRecord.environment !== "local"
  ) {
    fail("build.environment must be production or local");
  }
  const deploymentNonce = nullable(buildRecord.deployment_nonce, (item) =>
    digest32(item, "build.deployment_nonce"),
  );
  const reachableModules = canonicalDigestSet(
    buildRecord.reachable_module_sha256,
    "build.reachable_module_sha256",
    MAX_REACHABLE_MODULES,
  );

  const packages = parsePackages(record.packages);
  const targetRecord = exactRecord(record.target, "target", [
    "apps",
    "memories",
  ]);
  const targetApps = parseAppInventory(targetRecord.apps, "target.apps", 1);
  const targetMemories = parseMemoryInventory(
    targetRecord.memories,
    "target.memories",
    targetApps,
  );
  assertPackagesMatchTarget(packages, targetApps);

  const warnings = parseWarnings(record.warnings);
  assertWarningsMatchInventories(
    warnings,
    previousApps,
    previousMemories,
    targetApps,
    targetMemories,
  );

  const installationRecord = exactRecord(record.installation, "installation", [
    "target_canister",
    "mode",
    "argument",
    "wasm_memory_persistence",
  ]);
  const targetCanister = canisterId(
    installationRecord.target_canister,
    "installation.target_canister",
  );
  if (
    installationRecord.mode !== "install" &&
    installationRecord.mode !== "upgrade" &&
    installationRecord.mode !== "reinstall"
  ) {
    fail("installation.mode is invalid");
  }
  if (
    installationRecord.wasm_memory_persistence !== "keep" &&
    installationRecord.wasm_memory_persistence !== "replace"
  ) {
    fail("installation.wasm_memory_persistence is invalid");
  }
  const argumentRecord = exactRecord(
    installationRecord.argument,
    "installation.argument",
    ["sha256", "bytes"],
  );
  const argument = deepFreeze({
    sha256: digest(argumentRecord.sha256, "installation.argument.sha256"),
    bytes: byteLength(
      argumentRecord.bytes,
      "installation.argument.bytes",
      true,
      MAX_INSTALL_ARGUMENT_BYTES,
    ),
  });
  const wasm = parseWasmRecord(record.wasm, "wasm");

  return deepFreeze({
    format: DEPLOYMENT_BUILD_RECORD_FORMAT,
    state: "complete",
    deployment_id: deploymentId,
    previous: {
      deployment_id: previousDeployment,
      stable_signature_sha256: previousStable,
      apps: previousApps,
      memories: previousMemories,
    },
    build: {
      compiler_id: compilerId,
      assembler_id: assemblerId,
      environment: buildRecord.environment,
      deployment_nonce: deploymentNonce,
      reachable_module_sha256: reachableModules,
    },
    packages,
    target: { apps: targetApps, memories: targetMemories },
    warnings,
    installation: {
      target_canister: targetCanister,
      mode: installationRecord.mode,
      argument,
      wasm_memory_persistence: installationRecord.wasm_memory_persistence,
    },
    wasm,
  });
}

function parseLegacyRecord(
  record: Record<string, unknown>,
): LegacyObservedDeploymentBuildRecord {
  const observation = exactRecord(record.observation, "observation", [
    "target_canister",
    "deployment_id",
    "compiler_id",
    "assembler_id",
    "apps",
    "memories",
    "installed_module",
  ]);
  const apps = parseAppInventory(observation.apps, "observation.apps", 1);
  const memories = parseMemoryInventory(
    observation.memories,
    "observation.memories",
    apps,
  );
  const installed = exactRecord(
    observation.installed_module,
    "observation.installed_module",
    ["sha256", "representation", "source"],
  );
  if (installed.representation !== "ic_canister_status.module_hash") {
    fail("observation.installed_module.representation is invalid");
  }
  if (installed.source !== "ic_certified_read_state_v1") {
    fail("observation.installed_module.source is invalid");
  }
  const packages = boundedArray(
    record.packages,
    "packages",
    1,
    MAX_PACKAGES,
  ).map((item, index) => {
    const candidate = exactRecord(item, `packages[${index}]`, [
      "app_id",
      "version",
      "outer_archive_sha256",
      "package_information_sha256",
    ]);
    return deepFreeze({
      app_id: appId(candidate.app_id, `packages[${index}].app_id`),
      version: appVersion(candidate.version, `packages[${index}].version`),
      outer_archive_sha256: nullable(candidate.outer_archive_sha256, (value) =>
        digest(value, `packages[${index}].outer_archive_sha256`),
      ),
      package_information_sha256: nullable(
        candidate.package_information_sha256,
        (value) =>
          digest(value, `packages[${index}].package_information_sha256`),
      ),
    });
  });
  assertPackageOrder(packages);
  assertSimplePackagesMatchApps(packages, apps);
  const unavailable = canonicalEnumSet(
    record.unavailable,
    "unavailable",
    [
      "ordered_package_digests",
      "package_archive_bytes",
      "source_and_license_record",
      "raw_compiler_output",
      "gzip_transport_details",
      "pre_dispatch_warnings",
      "installation_inputs",
      "prior_state",
    ] as const,
    1,
  );
  for (const required of [
    "package_archive_bytes",
    "raw_compiler_output",
    "gzip_transport_details",
    "pre_dispatch_warnings",
    "installation_inputs",
    "prior_state",
  ] as const) {
    if (!unavailable.includes(required)) {
      fail(`legacy observation must declare ${required} unavailable`);
    }
  }
  if (
    packages.some(
      ({ outer_archive_sha256 }) => outer_archive_sha256 === null,
    ) &&
    !unavailable.includes("ordered_package_digests")
  ) {
    fail("legacy package digest gaps must be declared unavailable");
  }
  if (
    packages.some(
      ({ package_information_sha256 }) => package_information_sha256 === null,
    ) &&
    !unavailable.includes("source_and_license_record")
  ) {
    fail("legacy package information gaps must be declared unavailable");
  }

  return deepFreeze({
    format: DEPLOYMENT_BUILD_RECORD_FORMAT,
    state: "legacy_observed",
    observation: {
      target_canister: canisterId(
        observation.target_canister,
        "observation.target_canister",
      ),
      deployment_id: boundedText(
        observation.deployment_id,
        "observation.deployment_id",
        1,
        256,
      ),
      compiler_id: legacyToolId(
        observation.compiler_id,
        "observation.compiler_id",
      ),
      assembler_id: legacyToolId(
        observation.assembler_id,
        "observation.assembler_id",
      ),
      apps,
      memories,
      installed_module: {
        sha256: digest(installed.sha256, "observation.installed_module.sha256"),
        representation: "ic_canister_status.module_hash",
        source: "ic_certified_read_state_v1",
      },
    },
    packages,
    unavailable,
  });
}

function parsePackages(value: unknown): readonly DeploymentPackageBuildInput[] {
  const packages = boundedArray(value, "packages", 1, MAX_PACKAGES).map(
    (item, index) => {
      const label = `packages[${index}]`;
      const record = exactRecord(item, label, [
        "app_id",
        "version",
        "archive",
        "package_information",
        "dependencies",
      ]);
      const dependencies = boundedArray(
        record.dependencies,
        `${label}.dependencies`,
        0,
        MAX_DEPENDENCIES_PER_PACKAGE,
      )
        .map((dependency, dependencyIndex) =>
          parseDependency(
            dependency,
            `${label}.dependencies[${dependencyIndex}]`,
          ),
        )
        .sort(compareDependencies);
      rejectDuplicateBy(
        dependencies,
        ({ alias }) => alias,
        `${label}.dependencies`,
      );
      const archive = parsePackageArchive(record.archive, `${label}.archive`);
      const packageInformation = parsePackageInformation(
        record.package_information,
        `${label}.package_information`,
      );
      if (
        packageInformation.state === "not_supplied" &&
        archive.state !== "verified"
      ) {
        fail(
          `${label}.package_information not_supplied requires a verified archive`,
        );
      }
      return deepFreeze({
        app_id: appId(record.app_id, `${label}.app_id`),
        version: appVersion(record.version, `${label}.version`),
        archive,
        package_information: packageInformation,
        dependencies,
      });
    },
  );
  assertPackageOrder(packages);
  const positions = new Map(packages.map((pkg, index) => [pkg.app_id, index]));
  for (const [index, pkg] of packages.entries()) {
    for (const dependency of pkg.dependencies) {
      const providerIndex = positions.get(dependency.provider_app_id);
      if (providerIndex === undefined || providerIndex >= index) {
        fail(
          `package ${pkg.app_id} dependency ${dependency.alias} must name an earlier provider`,
        );
      }
      const provider = packages[providerIndex]!;
      if (
        dependency.provider_version !== provider.version ||
        provider.version < dependency.minimum_version
      ) {
        fail(
          `package ${pkg.app_id} dependency ${dependency.alias} has inconsistent versions`,
        );
      }
    }
  }
  return Object.freeze(packages);
}

function parseDependency(
  value: unknown,
  label: string,
): DeploymentPackageDependencyRecord {
  const record = exactRecord(value, label, [
    "alias",
    "provider_app_id",
    "minimum_version",
    "provider_version",
    "functions",
  ]);
  const alias = boundedText(record.alias, `${label}.alias`, 1, 30);
  if (!DEPENDENCY_ALIAS.test(alias)) fail(`${label}.alias is invalid`);
  const functions = canonicalTextSet(
    record.functions,
    `${label}.functions`,
    1,
    MAX_FUNCTIONS_PER_DEPENDENCY,
    128,
  );
  for (const [index, functionName] of functions.entries()) {
    if (!DEPENDENCY_FUNCTION.test(functionName)) {
      fail(`${label}.functions[${index}] is not a valid function name`);
    }
  }
  return deepFreeze({
    alias,
    provider_app_id: appId(record.provider_app_id, `${label}.provider_app_id`),
    minimum_version: appVersion(
      record.minimum_version,
      `${label}.minimum_version`,
    ),
    provider_version: appVersion(
      record.provider_version,
      `${label}.provider_version`,
    ),
    functions,
  });
}

function parsePackageArchive(
  value: unknown,
  label: string,
): DeploymentPackageArchiveRecord {
  const state = valueState(value);
  const record = exactRecord(
    value,
    label,
    state === "verified"
      ? ["state", "sha256", "bytes"]
      : state === "outer_archive_digest_only"
        ? ["state", "sha256"]
        : ["state"],
  );
  if (record.state === "verified") {
    return deepFreeze({
      state: "verified",
      sha256: digest(record.sha256, `${label}.sha256`),
      bytes: byteLength(
        record.bytes,
        `${label}.bytes`,
        false,
        MAX_PACKAGE_ARCHIVE_BYTES,
      ),
    });
  }
  if (record.state === "outer_archive_digest_only") {
    return deepFreeze({
      state: "outer_archive_digest_only",
      sha256: digest(record.sha256, `${label}.sha256`),
    });
  }
  if (record.state === "legacy_unavailable") {
    return Object.freeze({ state: "legacy_unavailable" });
  }
  fail(`${label}.state is invalid`);
}

function parsePackageInformation(
  value: unknown,
  label: string,
): PackageInformationRecordIdentity {
  const state = valueState(value);
  const record = exactRecord(
    value,
    label,
    state === "verified" ? ["state", "sha256"] : ["state"],
  );
  if (record.state === "verified") {
    return deepFreeze({
      state: "verified",
      sha256: digest(record.sha256, `${label}.sha256`),
    });
  }
  if (record.state === "legacy_unavailable") {
    return Object.freeze({ state: "legacy_unavailable" });
  }
  if (record.state === "not_supplied") {
    return Object.freeze({ state: "not_supplied" });
  }
  fail(`${label}.state is invalid`);
}

function parseAppInventory(
  value: unknown,
  label: string,
  minimum: number,
): readonly DeploymentAppInventoryRecord[] {
  const apps = boundedArray(value, label, minimum, MAX_PACKAGES)
    .map((item, index) => {
      const itemLabel = `${label}[${index}]`;
      const record = exactRecord(item, itemLabel, [
        "app_id",
        "version",
        "capability_plan_fingerprint",
        "resident_frame_security",
      ]);
      const residentFrameSecurity = frameSecurity(
        record.resident_frame_security,
        `${itemLabel}.resident_frame_security`,
      );
      return deepFreeze({
        app_id: appId(record.app_id, `${itemLabel}.app_id`),
        version: appVersion(record.version, `${itemLabel}.version`),
        capability_plan_fingerprint: digest(
          record.capability_plan_fingerprint,
          `${itemLabel}.capability_plan_fingerprint`,
        ),
        resident_frame_security: residentFrameSecurity,
      });
    })
    .sort((left, right) => compareCanonicalText(left.app_id, right.app_id));
  rejectDuplicateBy(apps, ({ app_id }) => app_id, label);
  if (apps.length > 0 && !apps.some(({ app_id }) => app_id === "kernel")) {
    fail(`${label} is missing kernel`);
  }
  return Object.freeze(apps);
}

function parseMemoryInventory(
  value: unknown,
  label: string,
  apps: readonly DeploymentAppInventoryRecord[],
): readonly DeploymentMemoryInventoryRecord[] {
  const owners = new Set(apps.map(({ app_id }) => app_id));
  const memories = boundedArray(value, label, 0, MAX_MANAGED_MEMORIES)
    .map((item, index) => {
      const itemLabel = `${label}[${index}]`;
      const record = exactRecord(item, itemLabel, [
        "owner",
        "id",
        "version",
        "schema",
      ]);
      const owner = appId(record.owner, `${itemLabel}.owner`);
      if (!owners.has(owner))
        fail(`${itemLabel}.owner is not in the app inventory`);
      return deepFreeze({
        owner,
        id: memoryId(record.id, `${itemLabel}.id`),
        version: memoryVersion(record.version, `${itemLabel}.version`),
        schema: digest(record.schema, `${itemLabel}.schema`),
      });
    })
    .sort(compareMemories);
  rejectDuplicateBy(memories, memoryKey, label);
  return Object.freeze(memories);
}

function parseWarnings(value: unknown): DeploymentWarningsRecord {
  const record = exactRecord(value, "warnings", [
    "diagnostics",
    "compatibility_diagnostics",
    "memory_changes",
    "removed_apps",
    "destructive_memory_roots",
  ]);
  const diagnostics = parseDiagnostics(
    record.diagnostics,
    "warnings.diagnostics",
  );
  const compatibilityDiagnostics = parseDiagnostics(
    record.compatibility_diagnostics,
    "warnings.compatibility_diagnostics",
  );
  const memoryChanges = boundedArray(
    record.memory_changes,
    "warnings.memory_changes",
    0,
    MAX_MEMORY_CHANGES,
  )
    .map((item, index) =>
      parseMemoryChange(item, `warnings.memory_changes[${index}]`),
    )
    .sort(compareMemoryChanges);
  rejectDuplicateBy(memoryChanges, memoryChangeKey, "warnings.memory_changes");
  const removedApps = canonicalAppIdSet(
    record.removed_apps,
    "warnings.removed_apps",
    MAX_PACKAGES,
  );
  const destructiveMemoryRoots = parseMemoryResources(
    record.destructive_memory_roots,
    "warnings.destructive_memory_roots",
  );
  const retirements = memoryChanges
    .filter(
      (item): item is Extract<DeploymentMemoryChange, { kind: "retire" }> =>
        item.kind === "retire",
    )
    .map(({ owner, memory_id }) => ({ owner, memory_id }))
    .sort(compareMemoryResources);
  if (JSON.stringify(retirements) !== JSON.stringify(destructiveMemoryRoots)) {
    fail("warnings destructive roots must exactly match memory retirements");
  }
  return deepFreeze({
    diagnostics,
    compatibility_diagnostics: compatibilityDiagnostics,
    memory_changes: memoryChanges,
    removed_apps: removedApps,
    destructive_memory_roots: destructiveMemoryRoots,
  });
}

function parseDiagnostics(
  value: unknown,
  label: string,
): readonly DeploymentDiagnosticRecord[] {
  const diagnostics = boundedArray(value, label, 0, MAX_DIAGNOSTICS)
    .map((item, index) => {
      const itemLabel = `${label}[${index}]`;
      const record = exactRecord(item, itemLabel, [
        "source",
        "range",
        "severity",
        "code",
        "category",
        "message",
      ]);
      const range = exactRecord(record.range, `${itemLabel}.range`, [
        "start",
        "end",
      ]);
      const start = parsePosition(range.start, `${itemLabel}.range.start`);
      const end = parsePosition(range.end, `${itemLabel}.range.end`);
      if (
        start.line > end.line ||
        (start.line === end.line && start.character > end.character)
      ) {
        fail(`${itemLabel}.range is reversed`);
      }
      const code = boundedText(record.code, `${itemLabel}.code`, 1, 64);
      if (!DIAGNOSTIC_CODE.test(code)) fail(`${itemLabel}.code is invalid`);
      return deepFreeze({
        source: boundedText(record.source, `${itemLabel}.source`, 1, 1_024),
        range: { start, end },
        severity: safeInteger(record.severity, `${itemLabel}.severity`, 1, 4),
        code,
        category: boundedText(record.category, `${itemLabel}.category`, 1, 128),
        message: boundedText(
          record.message,
          `${itemLabel}.message`,
          1,
          16_384,
          true,
        ),
      });
    })
    .sort(compareDiagnostics);
  rejectDuplicateBy(diagnostics, (item) => JSON.stringify(item), label);
  return Object.freeze(diagnostics);
}

function parsePosition(
  value: unknown,
  label: string,
): Readonly<{ line: number; character: number }> {
  const record = exactRecord(value, label, ["line", "character"]);
  return deepFreeze({
    line: safeInteger(record.line, `${label}.line`, 0, 0x7fff_ffff),
    character: safeInteger(
      record.character,
      `${label}.character`,
      0,
      0x7fff_ffff,
    ),
  });
}

function parseMemoryChange(
  value: unknown,
  label: string,
): DeploymentMemoryChange {
  const kind = valueState(value, "kind");
  const fields =
    kind === "initialize"
      ? ["kind", "owner", "memory_id", "to"]
      : kind === "keep"
        ? ["kind", "owner", "memory_id", "version"]
        : kind === "migrate"
          ? [
              "kind",
              "owner",
              "memory_id",
              "from",
              "to",
              "old_schema_entry_sha256",
              "path",
            ]
          : kind === "retire"
            ? [
                "kind",
                "reason",
                "owner",
                "memory_id",
                "from",
                "old_schema_entry_sha256",
              ]
            : ["kind"];
  const record = exactRecord(value, label, fields);
  const owner = appId(record.owner, `${label}.owner`);
  const id = memoryId(record.memory_id, `${label}.memory_id`);
  if (record.kind === "initialize") {
    return deepFreeze({
      kind: "initialize",
      owner,
      memory_id: id,
      to: memoryVersion(record.to, `${label}.to`),
    });
  }
  if (record.kind === "keep") {
    return deepFreeze({
      kind: "keep",
      owner,
      memory_id: id,
      version: memoryVersion(record.version, `${label}.version`),
    });
  }
  if (record.kind === "migrate") {
    const from = memoryVersion(record.from, `${label}.from`);
    const to = memoryVersion(record.to, `${label}.to`);
    if (to <= from) fail(`${label} must increase the memory version`);
    const path = boundedArray(
      record.path,
      `${label}.path`,
      1,
      MAX_MIGRATION_EDGES,
    ).map((edge, index) => parseMigrationEdge(edge, `${label}.path[${index}]`));
    let cursor = from;
    for (const edge of path) {
      if (edge.from !== cursor || edge.to <= edge.from) {
        fail(`${label}.path is not contiguous and increasing`);
      }
      cursor = edge.to;
    }
    if (cursor !== to) fail(`${label}.path does not reach its target version`);
    return deepFreeze({
      kind: "migrate",
      owner,
      memory_id: id,
      from,
      to,
      old_schema_entry_sha256: digest(
        record.old_schema_entry_sha256,
        `${label}.old_schema_entry_sha256`,
      ),
      path,
    });
  }
  if (record.kind === "retire") {
    if (
      record.reason !== "memory-retirement" &&
      record.reason !== "app-uninstall"
    ) {
      fail(`${label}.reason is invalid`);
    }
    return deepFreeze({
      kind: "retire",
      reason: record.reason,
      owner,
      memory_id: id,
      from: memoryVersion(record.from, `${label}.from`),
      old_schema_entry_sha256: digest(
        record.old_schema_entry_sha256,
        `${label}.old_schema_entry_sha256`,
      ),
    });
  }
  fail(`${label}.kind is invalid`);
}

function parseMigrationEdge(
  value: unknown,
  label: string,
): DeploymentMigrationEdge {
  const record = exactRecord(value, label, [
    "from",
    "to",
    "entry_sha256",
    "consume",
  ]);
  return deepFreeze({
    from: memoryVersion(record.from, `${label}.from`),
    to: memoryVersion(record.to, `${label}.to`),
    entry_sha256: digest(record.entry_sha256, `${label}.entry_sha256`),
    consume: canonicalMemoryIdSet(record.consume, `${label}.consume`, 16),
  });
}

function parseMemoryResources(
  value: unknown,
  label: string,
): readonly DeploymentMemoryResource[] {
  const resources = boundedArray(value, label, 0, MAX_MANAGED_MEMORIES)
    .map((item, index) => {
      const itemLabel = `${label}[${index}]`;
      const record = exactRecord(item, itemLabel, ["owner", "memory_id"]);
      return deepFreeze({
        owner: appId(record.owner, `${itemLabel}.owner`),
        memory_id: memoryId(record.memory_id, `${itemLabel}.memory_id`),
      });
    })
    .sort(compareMemoryResources);
  rejectDuplicateBy(resources, resourceKey, label);
  return Object.freeze(resources);
}

function parseWasmRecord(value: unknown, label: string): DeploymentWasmRecord {
  const record = exactRecord(value, label, ["raw", "transport"]);
  const raw = exactRecord(record.raw, `${label}.raw`, [
    "sha256",
    "bytes",
    "representation",
    "content_encoding",
  ]);
  const transport = exactRecord(record.transport, `${label}.transport`, [
    "sha256",
    "bytes",
    "representation",
    "content_encoding",
    "encoder",
  ]);
  if (
    raw.representation !== "neutron_compile_result_wasm" ||
    raw.content_encoding !== "identity"
  ) {
    fail(`${label}.raw has an invalid representation`);
  }
  if (
    transport.representation !== "ic_install_wasm_payload" ||
    transport.content_encoding !== "gzip" ||
    transport.encoder !== DEPLOYMENT_WASM_TRANSPORT_ENCODER
  ) {
    fail(`${label}.transport has an invalid representation`);
  }
  return deepFreeze({
    raw: {
      sha256: digest(raw.sha256, `${label}.raw.sha256`),
      bytes: byteLength(
        raw.bytes,
        `${label}.raw.bytes`,
        false,
        DEPLOYMENT_WASM_MAX_BYTES,
      ),
      representation: "neutron_compile_result_wasm",
      content_encoding: "identity",
    },
    transport: {
      sha256: digest(transport.sha256, `${label}.transport.sha256`),
      bytes: byteLength(
        transport.bytes,
        `${label}.transport.bytes`,
        false,
        DEPLOYMENT_WASM_MAX_BYTES,
      ),
      representation: "ic_install_wasm_payload",
      content_encoding: "gzip",
      encoder: DEPLOYMENT_WASM_TRANSPORT_ENCODER,
    },
  });
}

function assertPackagesMatchTarget(
  packages: readonly DeploymentPackageBuildInput[],
  apps: readonly DeploymentAppInventoryRecord[],
): void {
  const packageVersions = new Map(
    packages.map((pkg) => [pkg.app_id, pkg.version]),
  );
  if (
    packageVersions.size !== apps.length ||
    apps.some(({ app_id, version }) => packageVersions.get(app_id) !== version)
  ) {
    fail("packages must exactly match the target app ids and versions");
  }
}

function assertSimplePackagesMatchApps(
  packages: readonly { app_id: string; version: number }[],
  apps: readonly DeploymentAppInventoryRecord[],
): void {
  const packageVersions = new Map(
    packages.map((pkg) => [pkg.app_id, pkg.version]),
  );
  if (
    packageVersions.size !== apps.length ||
    apps.some(({ app_id, version }) => packageVersions.get(app_id) !== version)
  ) {
    fail("legacy packages must exactly match the observed app inventory");
  }
}

function assertPackageOrder(packages: readonly { app_id: string }[]): void {
  if (packages[0]?.app_id !== "kernel") fail("packages must put kernel first");
  rejectDuplicateBy(packages, ({ app_id }) => app_id, "packages");
}

function assertWarningsMatchInventories(
  warnings: DeploymentWarningsRecord,
  previousApps: readonly DeploymentAppInventoryRecord[],
  previousMemories: readonly DeploymentMemoryInventoryRecord[],
  targetApps: readonly DeploymentAppInventoryRecord[],
  targetMemories: readonly DeploymentMemoryInventoryRecord[],
): void {
  const previousIds = new Set(previousApps.map(({ app_id }) => app_id));
  const targetIds = new Set(targetApps.map(({ app_id }) => app_id));
  const expectedRemoved = [...previousIds]
    .filter((id) => !targetIds.has(id))
    .sort(compareCanonicalText);
  if (
    JSON.stringify(expectedRemoved) !== JSON.stringify(warnings.removed_apps)
  ) {
    fail("warnings.removed_apps does not match the inventory transition");
  }
  const previousRoots = new Map(
    previousMemories.map((memory) => [memoryKey(memory), memory]),
  );
  const targetRoots = new Map(
    targetMemories.map((memory) => [memoryKey(memory), memory]),
  );
  const expectedRoots = new Set([
    ...previousRoots.keys(),
    ...targetRoots.keys(),
  ]);
  if (warnings.memory_changes.length !== expectedRoots.size) {
    fail("warnings.memory_changes does not cover the inventory transition");
  }
  for (const change of warnings.memory_changes) {
    const key = resourceKey(change);
    if (!expectedRoots.delete(key)) {
      fail(
        `memory change ${change.owner}.${change.memory_id} is not in the inventories`,
      );
    }
    const previous = previousRoots.get(key);
    const target = targetRoots.get(key);
    if (change.kind === "initialize") {
      if (previous || !target || target.version !== change.to) {
        fail(
          `memory initialization ${change.owner}.${change.memory_id} is inconsistent`,
        );
      }
      continue;
    }
    if (change.kind === "keep") {
      if (
        !previous ||
        !target ||
        previous.version !== change.version ||
        target.version !== change.version ||
        previous.schema !== target.schema
      ) {
        fail(
          `memory retention ${change.owner}.${change.memory_id} is inconsistent`,
        );
      }
      continue;
    }
    if (change.kind === "migrate") {
      if (
        !previous ||
        !target ||
        previous.version !== change.from ||
        target.version !== change.to
      ) {
        fail(
          `memory migration ${change.owner}.${change.memory_id} is inconsistent`,
        );
      }
      continue;
    }
    if (!previous || target || previous.version !== change.from) {
      fail(
        `memory retirement ${change.owner}.${change.memory_id} is inconsistent`,
      );
    }
  }
  if (expectedRoots.size !== 0) {
    fail("warnings.memory_changes does not cover the inventory transition");
  }

  const removedApps = new Set(warnings.removed_apps);
  const consumableRetirements = new Set<string>();
  for (const change of warnings.memory_changes) {
    if (change.kind !== "retire") continue;
    const expectedReason = removedApps.has(change.owner)
      ? "app-uninstall"
      : "memory-retirement";
    if (change.reason !== expectedReason) {
      fail(
        `memory retirement ${change.owner}.${change.memory_id} has an inconsistent reason`,
      );
    }
    if (change.reason === "memory-retirement") {
      consumableRetirements.add(resourceKey(change));
    }
  }

  const consumedRoots = new Set<string>();
  for (const change of warnings.memory_changes) {
    if (change.kind !== "migrate") continue;
    for (const edge of change.path) {
      for (const consumedMemoryId of edge.consume) {
        const key = resourceKey({
          owner: change.owner,
          memory_id: consumedMemoryId,
        });
        if (!consumableRetirements.has(key)) {
          fail(
            `memory migration ${change.owner}.${change.memory_id} consumes a root not retired by the same owner`,
          );
        }
        if (consumedRoots.has(key)) {
          fail(
            `memory retirement ${change.owner}.${consumedMemoryId} is consumed more than once`,
          );
        }
        consumedRoots.add(key);
      }
    }
  }
}

function modulePathDigest(value: unknown, label: string): string {
  if (typeof value !== "string") fail(`${label} must be a module path`);
  const match = /^([a-f0-9]{64})\.mo$/u.exec(value);
  if (!match) fail(`${label} must be a content-addressed Motoko module path`);
  return match[1]!;
}

function memoryChangeFromCompiler(
  change: CompileResult["migrationPlan"]["upgrades"][number],
): DeploymentMemoryChange {
  if (change.kind === "initialize") {
    return {
      kind: "initialize",
      owner: change.owner,
      memory_id: change.memoryId,
      to: change.to,
    };
  }
  if (change.kind === "keep") {
    return {
      kind: "keep",
      owner: change.owner,
      memory_id: change.memoryId,
      version: change.version,
    };
  }
  if (change.kind === "migrate") {
    return {
      kind: "migrate",
      owner: change.owner,
      memory_id: change.memoryId,
      from: change.from,
      to: change.to,
      old_schema_entry_sha256: change.oldSchemaEntry,
      path: change.path.map((edge) => ({
        from: edge.from,
        to: edge.to,
        entry_sha256: edge.entry,
        consume: edge.consume ?? [],
      })),
    };
  }
  return {
    kind: "retire",
    reason: change.reason,
    owner: change.owner,
    memory_id: change.memoryId,
    from: change.from,
    old_schema_entry_sha256: change.oldSchemaEntry,
  };
}

function assertRawWasm(value: unknown): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array)) fail("raw Wasm must be exact bytes");
  assertWasmSize(value, "raw Wasm");
  if (
    value.byteLength < 8 ||
    value[0] !== 0x00 ||
    value[1] !== 0x61 ||
    value[2] !== 0x73 ||
    value[3] !== 0x6d
  ) {
    fail("raw Wasm is missing the WebAssembly magic header");
  }
}

function assertWasmSize(
  value: unknown,
  label: string,
): asserts value is Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength === 0 ||
    value.byteLength > DEPLOYMENT_WASM_MAX_BYTES
  ) {
    fail(`${label} must contain 1 to ${DEPLOYMENT_WASM_MAX_BYTES} bytes`);
  }
}

/**
 * Bound direct object input before schema normalization expands shared array
 * references. JSON input already has a byte ceiling, but callers may invoke
 * the object parser with a compact graph whose repeated references would
 * otherwise normalize into an enormous tree.
 */
function assertBoundedPlainDataGraph(value: unknown): void {
  let nodes = 0;
  let minimumJsonBytes = 0;
  const ancestors = new WeakSet<object>();

  const charge = (nodeBytes: number): void => {
    nodes += 1;
    minimumJsonBytes += nodeBytes;
    if (nodes > MAX_RECORD_GRAPH_NODES) {
      fail(
        "deployment build record exceeds its direct-object complexity budget",
      );
    }
    if (minimumJsonBytes > DEPLOYMENT_BUILD_RECORD_MAX_JSON_BYTES) {
      fail("deployment build record JSON exceeds its byte limit");
    }
  };

  const visit = (item: unknown, depth: number, label: string): void => {
    if (depth > MAX_JSON_DEPTH) {
      fail(`deployment build record nesting exceeds ${MAX_JSON_DEPTH} levels`);
    }
    if (item === null) {
      charge(4);
      return;
    }
    if (typeof item === "string") {
      // UTF-8 and JSON escaping can only increase this lower bound.
      charge(item.length + 2);
      return;
    }
    if (typeof item === "number") {
      if (!Number.isFinite(item)) fail(`${label} must be finite JSON data`);
      charge(String(item).length);
      return;
    }
    if (typeof item === "boolean") {
      charge(item ? 4 : 5);
      return;
    }
    if (typeof item !== "object") {
      fail(`${label} must contain only plain JSON data`);
    }
    if (ancestors.has(item)) {
      fail("deployment build record must not contain reference cycles");
    }
    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        if (
          Object.getPrototypeOf(item) !== Array.prototype ||
          item.length > MAX_RECORD_GRAPH_NODES
        ) {
          fail(`${label} must be a bounded plain array`);
        }
        const keys = Reflect.ownKeys(item);
        if (
          keys.length !== item.length + 1 ||
          keys.some(
            (key) =>
              key !== "length" &&
              (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key)),
          )
        ) {
          fail(`${label} must be a dense plain array`);
        }
        charge(2 + Math.max(0, item.length - 1));
        for (let index = 0; index < item.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(
            item,
            String(index),
          );
          if (
            !descriptor ||
            !("value" in descriptor) ||
            !descriptor.enumerable
          ) {
            fail(`${label} must be a dense plain array`);
          }
          visit(descriptor.value, depth + 1, `${label}[${index}]`);
        }
        return;
      }

      if (!isPlainRecord(item)) fail(`${label} must be a plain object`);
      const keys = Reflect.ownKeys(item);
      if (keys.some((key) => typeof key !== "string")) {
        fail(`${label} has symbol fields`);
      }
      charge(2 + Math.max(0, keys.length - 1));
      for (const key of keys as string[]) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          fail(`${label}.${key} must be an enumerable data field`);
        }
        // Quotes and the colon are the minimum JSON property overhead.
        minimumJsonBytes += key.length + 3;
        if (minimumJsonBytes > DEPLOYMENT_BUILD_RECORD_MAX_JSON_BYTES) {
          fail("deployment build record JSON exceeds its byte limit");
        }
        visit(descriptor.value, depth + 1, `${label}.${key}`);
      }
    } finally {
      ancestors.delete(item);
    }
  };

  visit(value, 0, "deployment build record");
}

function exactRecord(
  value: unknown,
  label: string,
  fields: readonly string[],
): Record<string, unknown> {
  if (!isPlainRecord(value)) fail(`${label} must be a plain object`);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string"))
    fail(`${label} has symbol fields`);
  const stringKeys = keys as string[];
  if (
    stringKeys.length !== fields.length ||
    fields.some((field) => !stringKeys.includes(field))
  ) {
    const unknown = stringKeys.find((key) => !fields.includes(key));
    fail(
      unknown
        ? `${label} has unknown field '${unknown}'`
        : `${label} has unknown or missing fields`,
    );
  }
  for (const key of stringKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      fail(`${label}.${key} must be an enumerable data field`);
    }
  }
  return value;
}

function boundedArray(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length < minimum ||
    value.length > maximum
  ) {
    fail(`${label} must contain between ${minimum} and ${maximum} entries`);
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.some(
      (key) =>
        key !== "length" &&
        (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key)),
    )
  ) {
    fail(`${label} must be a dense plain array`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      fail(`${label} must be a dense plain array`);
    }
  }
  return value;
}

function boundedText(
  value: unknown,
  label: string,
  minimumBytes: number,
  maximumBytes: number,
  allowLines = false,
): string {
  if (typeof value !== "string" || !hasValidUnicode(value)) {
    fail(`${label} must be valid Unicode text`);
  }
  const bytes = textEncoder.encode(value).byteLength;
  if (bytes < minimumBytes || bytes > maximumBytes) {
    fail(
      `${label} must contain between ${minimumBytes} and ${maximumBytes} UTF-8 bytes`,
    );
  }
  if (PROHIBITED_TEXT.test(value) || (!allowLines && /[\r\n\t]/u.test(value))) {
    fail(`${label} contains prohibited control or invisible text`);
  }
  if (OBVIOUS_SECRET.test(value))
    fail(`${label} contains credential or private-key material`);
  return value;
}

function appId(value: unknown, label: string): string {
  if (!isValidAppId(value)) fail(`${label} is not a valid app id`);
  return value;
}

function memoryId(value: unknown, label: string): string {
  const result = boundedText(value, label, 1, 128);
  if (!MEMORY_ID.test(result)) fail(`${label} is not a valid memory id`);
  return result;
}

function toolId(value: unknown, label: string): string {
  const result = boundedText(value, label, 1, 256);
  if (!TOOL_ID.test(result)) fail(`${label} is not a valid tool identity`);
  return result;
}

function legacyToolId(value: unknown, label: string): string {
  return boundedText(value, label, 1, 256);
}

function frameSecurity(
  value: unknown,
  label: string,
): DeploymentAppInventoryRecord["resident_frame_security"] {
  if (
    value !== "credentialless_opaque_v1" &&
    value !== "credentialless_ephemeral_dedicated_v1" &&
    value !== "persistent_dedicated_v1"
  ) {
    fail(`${label} is invalid`);
  }
  return value;
}

function canisterId(value: unknown, label: string): string {
  try {
    return normalizeUpdateSourcePrincipal(value, label);
  } catch (cause) {
    throw new Error(
      `${label} must be a canonical non-anonymous canister principal`,
      {
        cause,
      },
    );
  }
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    fail(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function digest32(value: unknown, label: string): string {
  if (typeof value !== "string" || !DEPLOYMENT_ID.test(value)) {
    fail(`${label} must be 16 bytes of lowercase hexadecimal`);
  }
  return value;
}

function appVersion(value: unknown, label: string): number {
  assertAppVersion(value, label);
  return value;
}

function memoryVersion(value: unknown, label: string): number {
  return safeInteger(value, label, 1, Number.MAX_SAFE_INTEGER);
}

function byteLength(
  value: unknown,
  label: string,
  allowZero = false,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  return safeInteger(value, label, allowZero ? 0 : 1, maximum);
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
    fail(`${label} must be a safe integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function nullable<T>(value: unknown, parse: (value: unknown) => T): T | null {
  return value === null ? null : parse(value);
}

function canonicalDigestSet(
  value: unknown,
  label: string,
  maximum: number,
): readonly string[] {
  const values = boundedArray(value, label, 0, maximum)
    .map((item, index) => digest(item, `${label}[${index}]`))
    .sort(compareCanonicalText);
  rejectDuplicateBy(values, (item) => item, label);
  return Object.freeze(values);
}

function canonicalTextSet(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
  maximumBytes: number,
): readonly string[] {
  const values = boundedArray(value, label, minimum, maximum)
    .map((item, index) =>
      boundedText(item, `${label}[${index}]`, 1, maximumBytes),
    )
    .sort(compareCanonicalText);
  rejectDuplicateBy(values, (item) => item, label);
  return Object.freeze(values);
}

function canonicalAppIdSet(
  value: unknown,
  label: string,
  maximum: number,
): readonly string[] {
  const values = boundedArray(value, label, 0, maximum)
    .map((item, index) => appId(item, `${label}[${index}]`))
    .sort(compareCanonicalText);
  rejectDuplicateBy(values, (item) => item, label);
  return Object.freeze(values);
}

function canonicalMemoryIdSet(
  value: unknown,
  label: string,
  maximum: number,
): readonly string[] {
  const values = boundedArray(value, label, 0, maximum)
    .map((item, index) => memoryId(item, `${label}[${index}]`))
    .sort(compareCanonicalText);
  rejectDuplicateBy(values, (item) => item, label);
  return Object.freeze(values);
}

function canonicalEnumSet<const T extends readonly string[]>(
  value: unknown,
  label: string,
  allowed: T,
  minimum: number,
): readonly T[number][] {
  const allowedSet = new Set<string>(allowed);
  const values = boundedArray(value, label, minimum, allowed.length)
    .map((item, index) => {
      if (typeof item !== "string" || !allowedSet.has(item)) {
        fail(`${label}[${index}] is invalid`);
      }
      return item as T[number];
    })
    .sort(compareCanonicalText);
  rejectDuplicateBy(values, (item) => item, label);
  return Object.freeze(values);
}

function rejectDuplicateBy<T>(
  values: readonly T[],
  key: (value: T) => string,
  label: string,
): void {
  const seen = new Set<string>();
  for (const value of values) {
    const identity = key(value);
    if (seen.has(identity)) fail(`${label} repeats '${identity}'`);
    seen.add(identity);
  }
}

function compareDependencies(
  left: DeploymentPackageDependencyRecord,
  right: DeploymentPackageDependencyRecord,
): number {
  return compareCanonicalText(left.alias, right.alias);
}

function compareMemories(
  left: DeploymentMemoryInventoryRecord,
  right: DeploymentMemoryInventoryRecord,
): number {
  return (
    compareCanonicalText(left.owner, right.owner) ||
    compareCanonicalText(left.id, right.id)
  );
}

function compareMemoryResources(
  left: DeploymentMemoryResource,
  right: DeploymentMemoryResource,
): number {
  return (
    compareCanonicalText(left.owner, right.owner) ||
    compareCanonicalText(left.memory_id, right.memory_id)
  );
}

function compareMemoryChanges(
  left: DeploymentMemoryChange,
  right: DeploymentMemoryChange,
): number {
  return (
    compareCanonicalText(left.owner, right.owner) ||
    compareCanonicalText(left.memory_id, right.memory_id) ||
    compareCanonicalText(left.kind, right.kind)
  );
}

function compareDiagnostics(
  left: DeploymentDiagnosticRecord,
  right: DeploymentDiagnosticRecord,
): number {
  return (
    compareCanonicalText(left.source, right.source) ||
    left.range.start.line - right.range.start.line ||
    left.range.start.character - right.range.start.character ||
    left.range.end.line - right.range.end.line ||
    left.range.end.character - right.range.end.character ||
    left.severity - right.severity ||
    compareCanonicalText(left.code, right.code) ||
    compareCanonicalText(left.category, right.category) ||
    compareCanonicalText(left.message, right.message)
  );
}

function memoryKey(value: { owner: string; id: string }): string {
  return `${value.owner.length}:${value.owner}${value.id.length}:${value.id}`;
}

function resourceKey(value: { owner: string; memory_id: string }): string {
  return `${value.owner.length}:${value.owner}${value.memory_id.length}:${value.memory_id}`;
}

function memoryChangeKey(value: DeploymentMemoryChange): string {
  return resourceKey(value);
}

function valueState(value: unknown, field = "state"): unknown {
  if (!isPlainRecord(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, field);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasValidUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((value, index) => value === right[index])
  );
}

function sortJsonKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonKeys);
  if (isPlainRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareCanonicalText(left, right))
        .map(([key, item]) => [key, sortJsonKeys(item)]),
    );
  }
  return value;
}

function assertRecordJsonSize<T extends DeploymentBuildRecord>(record: T): T {
  const text = `${JSON.stringify(sortJsonKeys(record), null, 2)}\n`;
  if (
    textEncoder.encode(text).byteLength > DEPLOYMENT_BUILD_RECORD_MAX_JSON_BYTES
  ) {
    fail("deployment build record JSON exceeds its byte limit");
  }
  return record;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value as Record<string, unknown>)) {
      deepFreeze(item);
    }
    Object.freeze(value);
  }
  return value;
}

/** JSON.parse silently overwrites duplicate names; reject them first. */
function assertNoDuplicateJsonObjectKeys(source: string): void {
  let offset = 0;
  const whitespace = (): void => {
    while (/\s/u.test(source[offset] ?? "")) offset += 1;
  };
  const string = (): string => {
    const start = offset;
    offset += 1;
    while (offset < source.length) {
      const character = source[offset++]!;
      if (character === "\\") {
        offset += source[offset] === "u" ? 5 : 1;
      } else if (character === '"') {
        return JSON.parse(source.slice(start, offset));
      }
    }
    throw new Error("unterminated JSON string");
  };
  const value = (depth = 0): void => {
    if (depth > MAX_JSON_DEPTH) {
      throw new Error(`JSON nesting exceeds ${MAX_JSON_DEPTH} levels`);
    }
    whitespace();
    if (source[offset] === "{") {
      offset += 1;
      const keys = new Set<string>();
      whitespace();
      if (source[offset] === "}") {
        offset += 1;
        return;
      }
      while (true) {
        whitespace();
        const key = string();
        if (keys.has(key)) throw new Error(`duplicate JSON field '${key}'`);
        keys.add(key);
        whitespace();
        if (source[offset++] !== ":") throw new Error("invalid JSON object");
        value(depth + 1);
        whitespace();
        const separator = source[offset++];
        if (separator === "}") return;
        if (separator !== ",") throw new Error("invalid JSON object");
      }
    }
    if (source[offset] === "[") {
      offset += 1;
      whitespace();
      if (source[offset] === "]") {
        offset += 1;
        return;
      }
      while (true) {
        value(depth + 1);
        whitespace();
        const separator = source[offset++];
        if (separator === "]") return;
        if (separator !== ",") throw new Error("invalid JSON array");
      }
    }
    if (source[offset] === '"') {
      string();
      return;
    }
    while (offset < source.length && !/[\s,\]}]/u.test(source[offset]!)) {
      offset += 1;
    }
  };
  value();
  whitespace();
  if (offset !== source.length) throw new Error("trailing JSON data");
}

function fail(message: string): never {
  throw new Error(message);
}
