import { gzipSync } from "fflate";
import { isValidAppId } from "neutron-tools/src/app_ids.js";
import { compareCanonicalText } from "neutron-tools/src/canonical.js";
import { hashContent } from "neutron-tools/src/hash.js";
import { assertNeutronManifest } from "neutron-tools/src/memory.js";
import {
  LOCAL_SYMBOL_MAX_LENGTH,
  physicalAppMethodName,
} from "neutron-tools/src/physical_names.js";
import {
  assertManifestFunctionExports,
  assertSafeRelativeAssetPath,
  MANIFEST_MAX_FUNCTION_ARGS,
  MANIFEST_MAX_FUNCTIONS,
  MANIFEST_MAX_TILES,
  normalizeManifestBackground,
  normalizeManifestDependencies,
  normalizeManifestDisplayMetadata,
  normalizeManifestUpdateSource,
  normalizeManifestTray,
  normalizeManifestTiles,
  normalizeUpdateSourcePrincipal,
  normalizeUntrustedText,
  type NeutronManifest,
  type PackagedNeutronManifest,
  type NormalizedNeutronBackgroundConfig,
  type NormalizedNeutronAppDependencyConfig,
  type NormalizedNeutronTrayConfig,
  type NormalizedNeutronTileConfig,
} from "neutron-tools/src/schema.js";
import { buildCapabilityPlan } from "neutron-tools/src/capabilities/plan.js";
import {
  assertCapabilityPlanFingerprint,
  fingerprintCapabilityPlanWireV1,
  parseCapabilityPlanWireV1,
  toCapabilityPlanWireV1,
  type CapabilityPlanWireV1,
} from "neutron-tools/src/capabilities/wire.js";
import {
  backendCallReservationActionToCandid,
  installBackendCallReservationActions,
} from "neutron-tools/src/capabilities/backend_calls.js";
import {
  parseConnectionProviderSupportCatalog,
  type ConnectionProviderSupportCatalog,
} from "neutron-tools/src/capabilities/catalog.js";
import { validate_neutron_conf } from "neutron-tools/src/validate_schema.js";
import {
  assertAppVersion,
  formatAppVersionLabel,
} from "neutron-tools/src/version.js";
import {
  encodeKernelRuntimeConfig,
  KERNEL_RUNTIME_CONFIG_PATH,
  type KernelRuntimeConfig,
} from "neutron-tools/src/runtime_config.js";
import {
  assertBackendCallInstallReservationsTarget,
  assertCertifiedAssetsTransitions,
  assertCompileConnectionProviderSupport,
  assertStableStoreSchemaTransitions,
  compileManagedMemoryInventory,
  type CompiledManagedMemory,
  type CompileConfig,
  type CompileInput,
  type CompileResult,
  type CompiledAppInstance,
  type MotokoFile,
} from "./compile.ts";
import {
  ASSEMBLER_ID,
  NEUTRON_INSTALLED_APP_LIMIT,
  type VetKeysEnvironment,
} from "./assemble.ts";
import type { TrustedInstallationContextV1 } from "./installation_context.ts";
import {
  planAppDependencies,
  type AppDependencyPlan,
  type AppDependent,
} from "./app_dependencies.ts";
import { assertInstallCommitBinding } from "./candid_signatures.ts";
import { assertMemoryMigrationPlan } from "./memory_migrations.ts";
import {
  normalizeManagedMemoryRetirements,
  plannedManagedMemoryRetirements,
  readManagedMemoryRetirements,
} from "./memory_retirements.ts";
import {
  DEFAULT_NEUTRON_PACKAGE_DECODE_LIMITS,
  REMOTE_NEUTRON_PACKAGE_DECODE_LIMITS,
  assertSafeArchivePath,
  decodeNeutronPackageArchive,
  type NeutronPackageDecodeLimits,
  type NeutronPackageDecodeOptions,
} from "./package_decoder.ts";
import {
  assertResidentFrameSecurity,
  residentFrameSecurity,
  type ResidentFrameSecurity,
} from "./resident_frame_security.ts";

export type {
  CompileConfig,
  CompileInput,
  CompileResult,
  CompiledAppInstance,
  MotokoFile,
} from "./compile.ts";
export type { VetKeysEnvironment } from "./assemble.ts";
export { NEUTRON_INSTALLED_APP_LIMIT } from "./assemble.ts";
export type { ResidentFrameSecurity } from "./resident_frame_security.ts";
export {
  DEFAULT_NEUTRON_PACKAGE_DECODE_LIMITS,
  REMOTE_NEUTRON_PACKAGE_DECODE_LIMITS,
};
export type { NeutronPackageDecodeLimits, NeutronPackageDecodeOptions };

const HASHED_MOTOKO_PACKAGE_PATH = /^mo\/([a-f0-9]{64})\.mo$/;
const RESERVED_APP_IDS = new Set(["__proto__", "constructor", "prototype"]);
const DEFAULT_CHUNK_SIZE = 1024 * 1024;
/** Must match backend/install/Service.mo's fixed journal validation ceiling. */
export const KERNEL_INSTALL_MAX_COPIES = 4_000;
/** Must match backend/install/Limits.mo's atomic asset-clear ceiling. */
export const KERNEL_INSTALL_MAX_CLEAR_PREFIXES_PER_COMMIT = 128;
/** Must match backend/install/Limits.mo's measured atomic removal ceiling. */
export const KERNEL_INSTALL_MAX_APP_REMOVALS_PER_COMMIT = 64;
const IC_INGRESS_MESSAGE_LIMIT_BYTES = 2 * 1024 * 1024;
const INSTALL_CODE_INGRESS_RESERVE_BYTES = 96 * 1024;
const INSTALL_CODE_CANDID_OVERHEAD_BYTES = 512;
const INSTALL_WASM_CHUNK_BYTES = 1024 * 1024;
const INSTALL_WASM_MAX_CHUNKS = 100;
/** Large whole-actor upgrades can spend several minutes compiling on the IC. */
export const DEFAULT_DEPLOYMENT_ACTIVATION_TIMEOUT_MS = 10 * 60_000;
const REMOVED_PACKAGE_BUILD_METADATA_PATH = ".neutron-build.json";
export const KERNEL_CONNECTION_PROVIDER_SUPPORT_PATH =
  "/pkg/connection-providers.json";
export const KERNEL_CONNECTION_PROVIDER_SUPPORT_ARCHIVE_PATH =
  "connection-providers.json";

export type UnpackedNeutronPackage = Record<string, Uint8Array>;

export type PreparedPackageFile = {
  path: string;
  content: Uint8Array;
};

export type PreparedPackageInstall = {
  manifest: PackagedNeutronManifest;
  capabilityPlan: CapabilityPlanWireV1;
  capabilityPlanFingerprint: string;
  files: PreparedPackageFile[];
  appPrefix: string;
  isKernel: boolean;
  connectionProviderSupport?: ConnectionProviderSupportCatalog;
};

export type PackageIdentityExpectation = {
  id: string;
  version: number;
  /** SHA-256 of the exact outer `.neutron` bytes. */
  sha256?: string;
  /** Exact outer `.neutron` byte length. */
  size?: number;
};

export type PreparePackageInstallOptions = NeutronPackageDecodeOptions & {
  expectedIdentity?: PackageIdentityExpectation;
};

export type AppRegistryEntry = {
  link: string;
  name: string;
  version: number;
  format: 3;
  update_source?: string;
  description?: string;
  icon: string;
  tiles: NormalizedNeutronTileConfig[];
  background?: NormalizedNeutronBackgroundConfig;
  tray?: NormalizedNeutronTrayConfig;
  capability_plan: CapabilityPlanWireV1;
  capability_plan_fingerprint: string;
  dependencies?: Record<string, NormalizedNeutronAppDependencyConfig>;
  functions: AppRegistryFunction[];
};

export type AppRegistryFunction = {
  name: string;
  /**
   * Exact generated Candid method; absent for private internal functions and
   * paid public-ingress handlers with invocation-scoped cycle access.
   */
  candid_name?: string;
  type: "update" | "query" | "internal";
  access: "authorized" | "public" | "internal";
  async: "sync" | "async" | "async*";
  args: string[];
  expose?: "apps";
};

export type AppRegistry = Record<string, AppRegistryEntry>;

export type KernelStaticFile = {
  content: Uint8Array;
  content_type: string;
  content_encoding: "gzip" | "identity";
  chunks: number;
};

export type KernelStaticRequest =
  | {
      store: {
        key: string;
        val: KernelStaticFile;
      };
    }
  | {
      store_chunk: {
        key: string;
        chunk_id: number;
        content: Uint8Array;
      };
    }
  | {
      clear: {
        prefix: string;
      };
    }
  | {
      delete: {
        key: string;
      };
    };

export type KernelStaticWriter = {
  kernel_static(req: KernelStaticRequest): Promise<unknown>;
};

export type KernelInstallCodeRequest = {
  wasm: Uint8Array;
  candid: string;
  deployment_id: string;
};

export type KernelInstallWasmChunkRequest = {
  deployment_id: string;
  chunk: Uint8Array;
  sha256: Uint8Array;
};

export type KernelInstallCodeChunkedRequest = {
  deployment_id: string;
  chunk_hashes: Uint8Array[];
  wasm_module_hash: Uint8Array;
};

export type CheckedInstallJournalRequest = {
  journal: InstallJournal;
  expected_deployment_id: string;
};

export type KernelInstallReservationsPrepareRequest = {
  deployment_id: string;
  apps: {
    app_id: string;
    reservations: unknown[];
  }[];
};

export type KernelInstallCommitResult =
  | { committed: null }
  | { blocked: null };

export type KernelPackageInstaller = KernelStaticWriter & {
  kernel_static_query(req: { list: { prefix: string } }): Promise<string[]>;
  kernel_install_begin_checked(
    req: CheckedInstallJournalRequest,
  ): Promise<unknown>;
  kernel_install_reservations_prepare(
    req: KernelInstallReservationsPrepareRequest,
  ): Promise<unknown>;
  kernel_install_status(
    req: null,
  ): Promise<[] | [InstallJournalStatus]>;
  kernel_install_commit(
    req: DeploymentReference,
  ): Promise<KernelInstallCommitResult>;
  kernel_install_abort(req: DeploymentReference): Promise<unknown>;
  kernel_install_code(req: KernelInstallCodeRequest): Promise<unknown>;
  kernel_install_wasm_chunks_clear(
    req: DeploymentReference,
  ): Promise<unknown>;
  kernel_install_wasm_chunk(
    req: KernelInstallWasmChunkRequest,
  ): Promise<unknown>;
  kernel_install_code_chunked(
    req: KernelInstallCodeChunkedRequest,
  ): Promise<unknown>;
  kernel_runtime_info(): Promise<KernelRuntimeInfo>;
};

export type InstallAssetCopy = {
  source: string;
  target: string;
};

export type InstallJournal = {
  deployment_id: string;
  copies: InstallAssetCopy[];
  clear_prefixes: string[];
  target_app_inventory: RuntimeApp[];
};

export type CandidResidentFrameSecurity =
  | { credentialless_opaque_v1: null }
  | { credentialless_ephemeral_dedicated_v1: null }
  | { persistent_dedicated_v1: null };

export type RuntimeApp = {
  app_id: string;
  version: bigint | number;
  capability_plan_fingerprint: string;
  resident_frame_security: CandidResidentFrameSecurity;
};

export type AppScope = {
  app_id: string;
  installation_uid: bigint | number;
};

export type AppInstance = {
  scope: AppScope;
  version: bigint | number;
  deployment_id: string;
  capability_plan_fingerprint: string;
  browser_origin_nonce: string;
  browser_origin_authority_epoch: bigint | number;
  resident_frame_security: CandidResidentFrameSecurity;
};

type NormalizedRuntimeApp = Omit<RuntimeApp, "resident_frame_security"> & {
  resident_frame_security: ResidentFrameSecurity;
};

type NormalizedAppInstance = Omit<AppInstance, "resident_frame_security"> & {
  resident_frame_security: ResidentFrameSecurity;
};

export type DeploymentReference = {
  deployment_id: string;
};

export type InstallJournalStatus = {
  deployment_id: string;
  copy_count: bigint | number;
  clear_count: bigint | number;
  removed_apps: string[];
  committed_app_instances: AppInstance[];
  target_app_instances: AppInstance[];
};

export type KernelRuntimeInfo = {
  deployment_id: string;
  assembler_id: string;
  compiler_id: string;
  apps: AppInstance[];
  memories: {
    id: string;
    owner: string;
    version: bigint | number;
    schema: string;
  }[];
};

export type StaticFileOperation = {
  key: string;
  val: KernelStaticFile;
  chunks: {
    chunk_id: number;
    content: Uint8Array;
  }[];
};

export type UploadProgress =
  | {
      type: "file";
      path: string;
      key: string;
      chunks: number;
    }
  | {
      type: "chunk";
      path: string;
      key: string;
      chunk_id: number;
    };

export type UploadPreparedFilesOptions = {
  concurrency?: number;
  chunkSize?: number;
  onProgress?: (progress: UploadProgress) => void;
};

export type InstallStagedAsset = {
  /** Exact absolute private/certified asset target committed by the journal. */
  target: string;
  content: Uint8Array;
  contentType?: string;
};

export type PackageCompileInput = {
  existingModules: MotokoFile[];
  existingConfigs: CompileConfig;
  existingStable?: string | null;
  connectionProviderSupport?: ConnectionProviderSupportCatalog;
  preparedPackage: PreparedPackageInstall;
  deploymentNonce?: string;
  vetKeysEnvironment?: VetKeysEnvironment;
  versionPolicy?: AppVersionTransitionPolicy;
};

export type AppVersionTransitionPolicy =
  | "strict-upgrade"
  | "allow-same-version";

export type PackageInstallAssets = {
  apps: AppRegistry;
  appRegistryAsset: StaticFileOperation;
  candidAsset: StaticFileOperation;
};

export type DeployPackageStep =
  | "upload-modules"
  | "stage-assets"
  | "record-journal"
  | "install-code"
  | "verify-runtime"
  | "commit-assets"
  | "complete"
  | "abort";

export type DeployPreparedPackagesInput = {
  actor: KernelPackageInstaller;
  /** Canonical principal of the actor receiving this deployment. */
  targetCanisterId: string;
  packages: PreparedPackageInstall[];
  compiled: CompileResult;
  existingApps: AppRegistry;
  /** Module paths observed in the checked pre-deployment baseline. */
  previousModulePaths?: readonly string[];
  removedApps?: string[];
  /** Additional mutable assets committed atomically with registry metadata. */
  stagedAssets?: InstallStagedAsset[];
  /** Exact running deployment checked atomically when the journal is recorded. */
  expectedDeploymentId: string;
  /** Maximum wait for the IC to compile and activate the dispatched actor. */
  verifyTimeoutMs?: number;
  onStep?: (step: DeployPackageStep) => void;
  onProgress?: (progress: UploadProgress) => void;
};

export type CompileAndDeployPackagesInput = Omit<
  DeployPreparedPackagesInput,
  "compiled" | "existingApps" | "removedApps"
> & {
  state: KernelPackageState;
  vetKeysEnvironment?: VetKeysEnvironment;
  versionPolicy?: AppVersionTransitionPolicy;
};

export type DeployPreparedPackagesResult = {
  apps: AppRegistry;
  compiled: CompileResult;
};

export type CompilePackagesInput = {
  packages: PreparedPackageInstall[];
  existingModules?: MotokoFile[];
  existingConfigs?: CompileConfig;
  existingStable?: string | null;
  connectionProviderSupport?: ConnectionProviderSupportCatalog;
  deploymentNonce?: string;
  vetKeysEnvironment?: VetKeysEnvironment;
  /** Provisioner-only input for a fresh local whole-canister installation. */
  freshInstallationContext?: TrustedInstallationContextV1;
  /** Offline qualification-only binding to the exact assembled actor source. */
  includeGeneratedSource?: boolean;
  versionPolicy?: AppVersionTransitionPolicy;
};

type RandomByteSource = {
  getRandomValues<T extends ArrayBufferView>(value: T): T;
};

/** Create a collision-resistant identity for one compile/deploy transaction. */
export function createDeploymentNonce(
  random: RandomByteSource = globalThis.crypto,
): string {
  const bytes = random.getRandomValues(new Uint8Array(16));
  if (bytes.byteLength !== 16) {
    throw new Error("Random source did not produce a 16-byte deployment nonce");
  }
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type KernelPackageState = {
  /** Normalized contents read directly from `/system/apps.json`. */
  registry: AppRegistry;
  /** The same strict registry; retained as the deployment-facing field. */
  apps: AppRegistry;
  existingConfigs: CompileConfig;
  existingModules: MotokoFile[];
  previousStable: string | null;
  connectionProviderSupport: ConnectionProviderSupportCatalog;
};

export type KernelPackageStateReader = {
  listStatic(prefix: string): Promise<string[]>;
  fetchText(path: string): Promise<string>;
  fetchJson<T>(path: string, fallback: T): Promise<T>;
  apps?: AppRegistry;
};

export function unpackNeutronPackage(
  pkg: Uint8Array,
  options: NeutronPackageDecodeOptions = {},
): UnpackedNeutronPackage {
  return decodeNeutronPackageArchive(pkg, options);
}

export function readPackageManifest(
  unpacked: UnpackedNeutronPackage,
): PackagedNeutronManifest {
  const manifestBytes = unpacked["neutron.json"];
  if (!manifestBytes) throw new Error("Package is missing neutron.json");

  let manifest: unknown;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
  } catch (error) {
    throw new Error("Package neutron.json is not valid JSON", { cause: error });
  }

  return validatePackagedManifest(manifest);
}

function readKernelConnectionProviderSupport(
  unpacked: UnpackedNeutronPackage,
): ConnectionProviderSupportCatalog {
  const packagePath = KERNEL_CONNECTION_PROVIDER_SUPPORT_ARCHIVE_PATH;
  const bytes = unpacked[packagePath];
  if (!bytes) {
    throw new Error(
      `Kernel package is missing ${packagePath}`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw new Error(`Kernel package ${packagePath} is not valid JSON`, {
      cause: error,
    });
  }
  try {
    return parseConnectionProviderSupportCatalog(value);
  } catch (error) {
    throw new Error(`Invalid Kernel package ${packagePath}`, { cause: error });
  }
}

function validatePackagedManifest(value: unknown): PackagedNeutronManifest {
  if (
    isRecord(value) &&
    Object.prototype.hasOwnProperty.call(value, "memory_requires")
  ) {
    throw new Error(
      "Invalid neutron.json: memory_requires is unsupported; app memory cannot be shared",
    );
  }

  const result = validate_neutron_conf(value);
  if (result.errors.length > 0) {
    throw new Error(
      `Invalid neutron.json: ${result.errors.map((x) => x.stack).join("; ")}`,
    );
  }

  if (!isRecord(value)) throw new Error("Invalid neutron.json");
  if (typeof value.entry !== "string" || value.entry.length === 0) {
    throw new Error("Packaged neutron.json must include entry");
  }
  validateInstallAppId(value.id);
  const manifest = value as PackagedNeutronManifest;
  assertNeutronManifest(manifest, "package");
  assertManifestFunctionExports(manifest);
  normalizeManifestDisplayMetadata(manifest);
  normalizeManifestDependencies(manifest);
  normalizeManifestTiles(manifest);
  normalizeManifestBackground(manifest);
  normalizeManifestTray(manifest);
  buildCapabilityPlan(manifest);
  return manifest;
}

export function preparePackageInstall(
  pkg: Uint8Array | UnpackedNeutronPackage,
  options: PreparePackageInstallOptions = {},
): PreparedPackageInstall {
  if (options.expectedIdentity) {
    assertPackageIdentityExpectation(options.expectedIdentity);
    if (pkg instanceof Uint8Array) {
      assertOuterPackageRawLimit(pkg, options.limits);
      assertOuterPackageIdentity(pkg, options.expectedIdentity);
    } else if (
      options.expectedIdentity.sha256 !== undefined ||
      options.expectedIdentity.size !== undefined
    ) {
      throw new Error(
        "Outer package digest and size reconciliation require raw .neutron bytes",
      );
    }
  }
  const unpacked =
    pkg instanceof Uint8Array ? unpackNeutronPackage(pkg, options) : pkg;
  if (Object.hasOwn(unpacked, REMOVED_PACKAGE_BUILD_METADATA_PATH)) {
    throw new Error(
      `${REMOVED_PACKAGE_BUILD_METADATA_PATH} is no longer supported; rebuild this deployment-target-neutral package`,
    );
  }
  const manifest = readPackageManifest(unpacked);
  if (options.expectedIdentity) {
    if (manifest.id !== options.expectedIdentity.id) {
      throw new Error(
        `Package id ${manifest.id} does not match expected ${options.expectedIdentity.id}`,
      );
    }
    if (manifest.version !== options.expectedIdentity.version) {
      throw new Error(
        `Package ${manifest.id} ${formatAppVersionLabel(manifest.version)} does not match expected ${formatAppVersionLabel(options.expectedIdentity.version)}`,
      );
    }
  }
  const isKernel = manifest.id === "kernel";
  const connectionProviderSupport = isKernel
    ? readKernelConnectionProviderSupport(unpacked)
    : undefined;
  const appPrefix = isKernel ? "" : `app/${manifest.id}/`;
  const files = preparePackageFiles(unpacked, {
    moPrefix: "mo/",
    appPrefix,
  });
  if (
    isKernel &&
    files.some(({ path }) => path === KERNEL_RUNTIME_CONFIG_PATH.slice(1))
  ) {
    throw new Error(
      `${KERNEL_RUNTIME_CONFIG_PATH} is reserved for final deployment configuration`,
    );
  }
  assertManifestWebEntrypoints(unpacked, manifest);
  const capabilityPlan = toCapabilityPlanWireV1(buildCapabilityPlan(manifest));
  const prepared = {
    manifest,
    capabilityPlan,
    capabilityPlanFingerprint: fingerprintCapabilityPlanWireV1(capabilityPlan),
    files,
    appPrefix,
    isKernel,
    ...(connectionProviderSupport ? { connectionProviderSupport } : {}),
  };
  assertPreparedPackageBatch([prepared]);
  return prepared;
}

function assertOuterPackageRawLimit(
  pkg: Uint8Array,
  limits: Partial<NeutronPackageDecodeLimits> | undefined,
): void {
  const maxRawBytes =
    limits?.maxRawBytes ?? DEFAULT_NEUTRON_PACKAGE_DECODE_LIMITS.maxRawBytes;
  if (!Number.isSafeInteger(maxRawBytes) || maxRawBytes < 1) {
    throw new Error("maxRawBytes must be a positive safe integer");
  }
  if (pkg.byteLength > maxRawBytes) {
    throw new Error(
      `.neutron package exceeds the ${maxRawBytes}-byte raw limit`,
    );
  }
}

function assertPackageIdentityExpectation(
  expected: PackageIdentityExpectation,
): void {
  validateInstallAppId(expected.id);
  assertAppVersion(expected.version, "Expected package version");
  if (
    expected.sha256 !== undefined &&
    !/^[a-f0-9]{64}$/.test(expected.sha256)
  ) {
    throw new Error("Expected package SHA-256 must be lowercase hexadecimal");
  }
  if (
    expected.size !== undefined &&
    (!Number.isSafeInteger(expected.size) || expected.size < 0)
  ) {
    throw new Error(
      "Expected package size must be a non-negative safe integer",
    );
  }
}

function assertOuterPackageIdentity(
  pkg: Uint8Array,
  expected: PackageIdentityExpectation,
): void {
  if (expected.size !== undefined && pkg.byteLength !== expected.size) {
    throw new Error(
      `Package size ${pkg.byteLength} does not match expected ${expected.size}`,
    );
  }
  if (expected.sha256 !== undefined) {
    const actual = hashContent(pkg);
    if (actual !== expected.sha256) {
      throw new Error(
        `Package SHA-256 ${actual} does not match expected ${expected.sha256}`,
      );
    }
  }
}

function assertManifestWebEntrypoints(
  unpacked: UnpackedNeutronPackage,
  manifest: PackagedNeutronManifest,
): void {
  for (const tile of normalizeManifestTiles(manifest)) {
    const entrypoint = `web/${tile.path}`;
    if (!unpacked[entrypoint]) {
      throw new Error(`Package is missing tile entrypoint ${entrypoint}`);
    }
    const icon = `web/${tile.icon}`;
    if (!unpacked[icon]) {
      throw new Error(`Package is missing tile icon ${icon}`);
    }
  }
  const background = normalizeManifestBackground(manifest);
  if (background) {
    const path = `web/${background.path}`;
    if (!unpacked[path]) {
      throw new Error(`Package is missing background entrypoint ${path}`);
    }
  }
  const tray = normalizeManifestTray(manifest);
  if (tray) {
    const entrypoint = `web/${tray.path}`;
    if (!unpacked[entrypoint]) {
      throw new Error(`Package is missing tray entrypoint ${entrypoint}`);
    }
    const icon = `web/${tray.icon}`;
    if (!unpacked[icon]) {
      throw new Error(`Package is missing tray icon ${icon}`);
    }
  }
}

export function preparePackageFiles(
  pkg: UnpackedNeutronPackage,
  {
    moPrefix,
    appPrefix,
  }: {
    moPrefix: string;
    appPrefix: string;
  },
): PreparedPackageFile[] {
  return Object.entries(pkg).map(([packagePath, content]) => {
    assertSafePackagePath(packagePath);

    if (
      appPrefix !== "" &&
      (packagePath === "web/_route" ||
        packagePath.startsWith("web/_route/"))
    ) {
      throw new Error(
        `Package path ${packagePath} is reserved for shared app routes`,
      );
    }

    if (packagePath.startsWith("web/")) {
      return {
        path: packagePath.replace("web/", appPrefix),
        content,
      };
    }

    if (packagePath.startsWith("mo/")) {
      const match = HASHED_MOTOKO_PACKAGE_PATH.exec(packagePath);
      if (!match) throw new Error(`Invalid mo package path ${packagePath}`);

      const hash = hashContent(content);
      const expected = `mo/${hash}.mo`;
      if (packagePath !== expected) {
        throw new Error(`Invalid mo hash ${expected} != ${packagePath}`);
      }

      return {
        path: packagePath.replace("mo/", moPrefix),
        content,
      };
    }

    return {
      path: `${appPrefix}pkg/${packagePath}`,
      content,
    };
  });
}

export function assertSafePackagePath(packagePath: string): void {
  assertSafeArchivePath(packagePath);
}

function assertSafePreparedFilePath(path: string): void {
  assertSafeArchivePath(path);
}

function decodeMotokoModule(content: Uint8Array, path: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch (error) {
    throw new Error(`Motoko module ${path} is not valid UTF-8`, {
      cause: error,
    });
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export function validateInstallAppId(id: unknown): asserts id is string {
  if (!isValidAppId(id)) {
    throw new Error("Invalid app name");
  }
  if (RESERVED_APP_IDS.has(id)) {
    throw new Error(`Reserved app name ${id}`);
  }
}

function isSharedAppRouteStaticTarget(path: string): boolean {
  const match = /^app\/([^/]+)\/_route(?:\/|$)/.exec(path);
  return match !== null && isValidAppId(match[1]);
}

export function motokoFilesFromPreparedFiles(
  files: PreparedPackageFile[],
  moPrefix = "mo/",
): MotokoFile[] {
  const modules = files
    .filter((file) => file.path.startsWith(moPrefix))
    .map(({ path, content }) => ({
      path: path.slice(moPrefix.length),
      content: decodeMotokoModule(content, path),
    }));
  return mergeMotokoFiles(modules);
}

/**
 * Validate the invariants shared by every package batch entry point. Mutable
 * targets may occur only once. Content-addressed Motoko modules may be shared
 * by packages only when their bytes are identical.
 */
export function assertPreparedPackageBatch(
  packages: PreparedPackageInstall[],
): void {
  const appIds = new Set<string>();
  const mutableTargets = new Map<string, string>();
  const modules = new Map<string, { content: Uint8Array; owner: string }>();

  for (const preparedPackage of packages) {
    const appId = preparedPackage.manifest.id;
    if (appIds.has(appId)) {
      throw new Error(`Duplicate prepared app id ${appId}`);
    }
    appIds.add(appId);

    for (const file of preparedPackage.files) {
      assertSafePreparedFilePath(file.path);
      if (appId !== "kernel" && isSharedAppRouteStaticTarget(file.path)) {
        throw new Error(
          `Prepared package path ${file.path} is reserved for shared app routes`,
        );
      }
      if (file.path.startsWith("mo/")) {
        if (!HASHED_MOTOKO_PACKAGE_PATH.test(file.path)) {
          throw new Error(`Invalid prepared Motoko module path ${file.path}`);
        }
        const previous = modules.get(file.path);
        if (previous && !equalBytes(previous.content, file.content)) {
          throw new Error(
            `Conflicting Motoko module ${file.path} in ${previous.owner} and ${appId}`,
          );
        }
        modules.set(
          file.path,
          previous ?? { content: file.content, owner: appId },
        );
        continue;
      }

      const target = staticKey(file.path);
      const previous = mutableTargets.get(target);
      if (previous) {
        throw new Error(
          `Duplicate mutable install target ${target} in ${previous} and ${appId}`,
        );
      }
      mutableTargets.set(target, appId);
    }
  }
}

function mergeMotokoFiles(...groups: MotokoFile[][]): MotokoFile[] {
  const modules = new Map<string, MotokoFile>();
  for (const file of groups.flat()) {
    const previous = modules.get(file.path);
    if (previous) {
      if (previous.content !== file.content) {
        throw new Error(`Conflicting Motoko module ${file.path}`);
      }
      continue;
    }
    modules.set(file.path, file);
  }
  return [...modules.values()];
}

function uniquePreparedModuleFiles(
  packages: PreparedPackageInstall[],
): PreparedPackageFile[] {
  const modules = new Map<string, PreparedPackageFile>();
  for (const preparedPackage of packages) {
    for (const file of preparedPackage.files) {
      if (!file.path.startsWith("mo/")) continue;
      const previous = modules.get(file.path);
      if (previous) {
        if (!equalBytes(previous.content, file.content)) {
          throw new Error(`Conflicting Motoko module ${file.path}`);
        }
        continue;
      }
      modules.set(file.path, file);
    }
  }
  return [...modules.values()];
}

export function buildPackageCompileInput({
  existingModules,
  existingConfigs,
  existingStable,
  connectionProviderSupport: baselineConnectionProviderSupport,
  preparedPackage,
  deploymentNonce,
  vetKeysEnvironment,
  versionPolicy = "strict-upgrade",
}: PackageCompileInput): CompileInput {
  assertPreparedPackageBatch([preparedPackage]);
  assertAppVersionTransitions(existingConfigs, [preparedPackage], versionPolicy);
  const configs = {
    ...existingConfigs,
    [preparedPackage.manifest.id]: preparedPackage.manifest,
  };
  const connectionProviderSupport = selectedConnectionProviderSupport(
    [preparedPackage],
    baselineConnectionProviderSupport,
  );
  assertCompileConnectionProviderSupport(configs, connectionProviderSupport);
  assertStableStoreSchemaTransitions(existingConfigs, configs);
  assertCertifiedAssetsTransitions(existingConfigs, configs);
  return {
    mofiles: mergeMotokoFiles(
      existingModules,
      motokoFilesFromPreparedFiles(preparedPackage.files),
    ),
    configs,
    previousConfigs: existingConfigs,
    previousStable: existingStable ?? null,
    ...(connectionProviderSupport ? { connectionProviderSupport } : {}),
    ...(deploymentNonce ? { deploymentNonce } : {}),
    ...(vetKeysEnvironment ? { vetKeysEnvironment } : {}),
  };
}

export async function compilePackageInstall(
  input: PackageCompileInput,
): Promise<CompileResult> {
  const { compile } = await import("./compile.ts");
  return compile(buildPackageCompileInput(input));
}

export function buildPackagesCompileInput({
  packages,
  existingModules = [],
  existingConfigs = {},
  existingStable = null,
  connectionProviderSupport: baselineConnectionProviderSupport,
  deploymentNonce,
  vetKeysEnvironment,
  freshInstallationContext,
  includeGeneratedSource,
  versionPolicy = "strict-upgrade",
}: CompilePackagesInput): CompileInput {
  assertPreparedPackageBatch(packages);
  assertAppVersionTransitions(existingConfigs, packages, versionPolicy);
  let mofiles = mergeMotokoFiles(existingModules);
  const configs: CompileConfig = { ...existingConfigs };

  for (const preparedPackage of packages) {
    mofiles = mergeMotokoFiles(
      mofiles,
      motokoFilesFromPreparedFiles(preparedPackage.files),
    );
    configs[preparedPackage.manifest.id] = preparedPackage.manifest;
  }
  const connectionProviderSupport = selectedConnectionProviderSupport(
    packages,
    baselineConnectionProviderSupport,
  );
  assertCompileConnectionProviderSupport(configs, connectionProviderSupport);
  assertStableStoreSchemaTransitions(existingConfigs, configs);
  assertCertifiedAssetsTransitions(existingConfigs, configs);

  return {
    mofiles,
    configs,
    previousConfigs: existingConfigs,
    previousStable: existingStable,
    ...(connectionProviderSupport ? { connectionProviderSupport } : {}),
    ...(deploymentNonce ? { deploymentNonce } : {}),
    ...(vetKeysEnvironment ? { vetKeysEnvironment } : {}),
    ...(freshInstallationContext
      ? { freshInstallationContext }
      : {}),
    ...(includeGeneratedSource ? { includeGeneratedSource: true } : {}),
  };
}

function selectedConnectionProviderSupport(
  packages: readonly PreparedPackageInstall[],
  baseline?: ConnectionProviderSupportCatalog,
): ConnectionProviderSupportCatalog | undefined {
  const incomingKernel = packages.find(
    (preparedPackage) => preparedPackage.isKernel,
  );
  if (!incomingKernel) return baseline;
  if (!incomingKernel.connectionProviderSupport) {
    throw new Error(
      `Kernel package is missing ${KERNEL_CONNECTION_PROVIDER_SUPPORT_ARCHIVE_PATH}`,
    );
  }
  return incomingKernel.connectionProviderSupport;
}

export function assertAppVersionTransitions(
  existingConfigs: CompileConfig,
  packages: PreparedPackageInstall[],
  policy: AppVersionTransitionPolicy = "strict-upgrade",
): void {
  if (policy !== "strict-upgrade" && policy !== "allow-same-version") {
    throw new Error(`Unknown app version transition policy ${String(policy)}`);
  }
  for (const preparedPackage of packages) {
    const appId = preparedPackage.manifest.id;
    const installedVersion = existingConfigs[appId]?.version;
    const requestedVersion = preparedPackage.manifest.version;
    assertAppVersion(requestedVersion, `${appId} requested package version`);
    if (installedVersion === undefined) continue;
    assertAppVersion(installedVersion, `${appId} installed package version`);
    if (requestedVersion < installedVersion) {
      throw new Error(
        `Refusing to downgrade ${appId} from ${formatAppVersionLabel(installedVersion)} to ${formatAppVersionLabel(requestedVersion)}; use an explicit reinstall to discard the installed app set`,
      );
    }
    if (requestedVersion === installedVersion && policy === "strict-upgrade") {
      throw new Error(
        `${appId} ${formatAppVersionLabel(installedVersion)} is already installed; choose a package with a higher version`,
      );
    }
  }
}

export async function compilePackages(
  input: CompilePackagesInput,
): Promise<CompileResult> {
  const { compile } = await import("./compile.ts");
  return compile(buildPackagesCompileInput(input));
}

/** Bind a universal Kernel archive immediately before its assets are seeded. */
export function applyRuntimeDeploymentConfig(
  packages: PreparedPackageInstall[],
  config: KernelRuntimeConfig,
): void {
  const runtimePath = KERNEL_RUNTIME_CONFIG_PATH.slice(1);
  const content = encodeKernelRuntimeConfig(config);
  for (const preparedPackage of packages) {
    if (!preparedPackage.isKernel) continue;
    preparedPackage.files = [
      ...preparedPackage.files.filter(({ path }) => path !== runtimePath),
      { path: runtimePath, content: content.slice() },
    ];
  }
}

export function buildAppUninstallCompileInput({
  state,
  appId,
  deploymentNonce,
  vetKeysEnvironment,
}: {
  state: KernelPackageState;
  appId: string;
  deploymentNonce?: string;
  vetKeysEnvironment?: VetKeysEnvironment;
}): CompileInput {
  validateInstallAppId(appId);
  if (appId === "kernel")
    throw new Error("The kernel app cannot be uninstalled");
  if (!state.existingConfigs[appId]) {
    throw new Error(`App ${appId} is not installed`);
  }
  const dependencyPlan = planAppDependencies(state.existingConfigs);
  const impact = appDependencyImpact(dependencyPlan, appId);
  const dependents = impact.direct;
  if (dependents.length > 0) {
    const provider = state.existingConfigs[appId]!;
    const direct = dependents
      .map((dependent) => {
        const consumer = state.existingConfigs[dependent.consumer];
        return `${consumer?.name ?? dependent.consumer} (${dependent.functions.join(", ")})`;
      })
      .join(", ");
    const transitive = impact.transitiveConsumers
      .map((consumer) => state.existingConfigs[consumer]?.name ?? consumer)
      .join(", ");
    throw new Error(
      `${provider.name} cannot be uninstalled; required by ${direct}${
        transitive ? `; transitively used by ${transitive}` : ""
      }`,
    );
  }
  const configs = Object.fromEntries(
    Object.entries(state.existingConfigs).filter(([id]) => id !== appId),
  );
  assertCompileConnectionProviderSupport(
    configs,
    state.connectionProviderSupport,
  );
  assertStableStoreSchemaTransitions(state.existingConfigs, configs);
  assertCertifiedAssetsTransitions(state.existingConfigs, configs);
  return {
    mofiles: state.existingModules,
    configs,
    previousConfigs: state.existingConfigs,
    previousStable: state.previousStable,
    connectionProviderSupport: state.connectionProviderSupport,
    ...(deploymentNonce ? { deploymentNonce } : {}),
    ...(vetKeysEnvironment ? { vetKeysEnvironment } : {}),
  };
}

export function appUninstallDependents(
  configs: CompileConfig,
  appId: string,
): AppDependent[] {
  return planAppDependencies(configs).dependentsByProvider[appId] ?? [];
}

export function planAppRegistryDependencies(
  registry: AppRegistry,
): AppDependencyPlan {
  const configs: CompileConfig = Object.fromEntries(
    Object.entries(registry).map(([id, entry]) => [
      id,
      {
        format: 3,
        id,
        name: entry.name,
        version: entry.version,
        entry: id,
        ...(entry.dependencies ? { dependencies: entry.dependencies } : {}),
        func: Object.fromEntries(
          (entry.functions ?? []).map((method) => [
            method.name,
            {
              type: method.type,
              ...(method.expose ? { expose: method.expose } : {}),
            },
          ]),
        ),
      },
    ]),
  );
  return planAppDependencies(configs);
}

export type AppDependencyImpact = {
  direct: AppDependent[];
  transitiveConsumers: string[];
};

export function appDependencyImpact(
  plan: AppDependencyPlan,
  providerId: string,
): AppDependencyImpact {
  const direct = plan.dependentsByProvider[providerId] ?? [];
  const directConsumers = new Set(direct.map(({ consumer }) => consumer));
  const visited = new Set<string>([providerId, ...directConsumers]);
  const queue = [...directConsumers].sort(compareCanonicalText);
  const transitiveConsumers = new Set<string>();
  while (queue.length > 0) {
    const provider = queue.shift()!;
    for (const dependent of plan.dependentsByProvider[provider] ?? []) {
      if (visited.has(dependent.consumer)) continue;
      visited.add(dependent.consumer);
      transitiveConsumers.add(dependent.consumer);
      queue.push(dependent.consumer);
      queue.sort(compareCanonicalText);
    }
  }
  return {
    direct,
    transitiveConsumers: [...transitiveConsumers].sort(compareCanonicalText),
  };
}

export async function compileAppUninstall(input: {
  state: KernelPackageState;
  appId: string;
  deploymentNonce?: string;
  vetKeysEnvironment?: VetKeysEnvironment;
}): Promise<CompileResult> {
  const { compile } = await import("./compile.ts");
  return compile(buildAppUninstallCompileInput(input));
}

export async function uninstallApp({
  actor,
  targetCanisterId,
  state,
  appId,
  vetKeysEnvironment,
  stagedAssets,
  expectedDeploymentId,
  onStep,
}: {
  actor: KernelPackageInstaller;
  targetCanisterId: string;
  state: KernelPackageState;
  appId: string;
  vetKeysEnvironment?: VetKeysEnvironment;
  stagedAssets?: InstallStagedAsset[];
  expectedDeploymentId: string;
  onStep?: (step: DeployPackageStep) => void;
}): Promise<DeployPreparedPackagesResult> {
  const compiled = await compileAppUninstall({
    state,
    appId,
    deploymentNonce: createDeploymentNonce(),
    ...(vetKeysEnvironment ? { vetKeysEnvironment } : {}),
  });
  return deployPreparedPackages({
    actor,
    targetCanisterId,
    packages: [],
    compiled,
    existingApps: state.apps,
    previousModulePaths: state.existingModules.map(({ path }) => path),
    removedApps: [appId],
    ...(stagedAssets ? { stagedAssets } : {}),
    expectedDeploymentId,
    ...(onStep ? { onStep } : {}),
  });
}

export async function readKernelPackageState({
  listStatic,
  fetchText,
  fetchJson,
  apps,
}: KernelPackageStateReader): Promise<KernelPackageState> {
  const modulePaths = await listStatic("/mo/");
  const existingModules = await mapWithConcurrency(
    modulePaths,
    10,
    async (path) => ({
      path: path.replace(/^\/mo\//, ""),
      content: await fetchText(path),
    }),
  );

  const registry = normalizeAppRegistry(
    apps ?? (await fetchJson<PartialAppRegistry>("/system/apps.json", {})),
  );
  if (!registry.kernel) {
    throw new Error(
      "Installed app registry is missing the kernel package manifest entry",
    );
  }
  const appIds = Object.keys(registry).sort(compareCanonicalText);
  const configEntries = await mapWithConcurrency(appIds, 10, async (id) => {
    const path =
      id === "kernel" ? "/pkg/neutron.json" : `/app/${id}/pkg/neutron.json`;
    const value = await fetchJson<unknown | undefined>(path, undefined);
    if (value === undefined) {
      throw new Error(`Installed package manifest ${path} is missing`);
    }
    let config: PackagedNeutronManifest;
    try {
      config = validatePackagedManifest(value);
    } catch (error) {
      throw new Error(`Invalid installed package manifest ${path}`, {
        cause: error,
      });
    }
    if (config.id !== id) {
      throw new Error(
        `Installed package manifest ${path} declares app ${config.id}, expected ${id}`,
      );
    }
    if (config.version !== registry[id]!.version) {
      throw new Error(
        `Installed package manifest ${path} ${formatAppVersionLabel(config.version)} does not match registry ${formatAppVersionLabel(registry[id]!.version)}`,
      );
    }
    const expectedEntry = appRegistryEntry(config);
    if (!sameJsonValue(expectedEntry, registry[id])) {
      throw new Error(
        `Installed package manifest ${path} does not exactly match its registry entry`,
      );
    }
    return [id, config] as const;
  });

  const existingConfigs: CompileConfig = Object.fromEntries(configEntries);

  const rawConnectionProviderSupport = await fetchJson<unknown | undefined>(
    KERNEL_CONNECTION_PROVIDER_SUPPORT_PATH,
    undefined,
  );
  if (rawConnectionProviderSupport === undefined) {
    throw new Error(
      `Installed Kernel package metadata ${KERNEL_CONNECTION_PROVIDER_SUPPORT_PATH} is missing`,
    );
  }
  let connectionProviderSupport: ConnectionProviderSupportCatalog;
  try {
    connectionProviderSupport = parseConnectionProviderSupportCatalog(
      rawConnectionProviderSupport,
    );
  } catch (error) {
    throw new Error(
      `Invalid installed Kernel package metadata ${KERNEL_CONNECTION_PROVIDER_SUPPORT_PATH}`,
      { cause: error },
    );
  }
  assertCompileConnectionProviderSupport(
    existingConfigs,
    connectionProviderSupport,
  );

  const previousStable = await fetchText("/pkg/neutron.most");
  if (previousStable.trim().length === 0) {
    throw new Error("Installed stable signature /pkg/neutron.most is empty");
  }

  return {
    registry,
    apps: registry,
    existingConfigs,
    existingModules,
    previousStable,
    connectionProviderSupport,
  };
}

/**
 * Bind certified installed package metadata to the actor that is actually
 * running before using either as a compile/deploy baseline.
 */
export function assertKernelPackageStateMatchesRuntime(
  state: KernelPackageState,
  runtime: KernelRuntimeInfo,
): void {
  assertKernelPackageStateMatchesRuntimeGeneration(state, runtime);
}

/**
 * Bind the pre-compile package baseline to the exact current assembler.
 */
export function assertKernelPackageBaselineMatchesRuntime(
  state: KernelPackageState,
  runtime: KernelRuntimeInfo,
): void {
  assertKernelPackageStateMatchesRuntimeGeneration(state, runtime);
}

function assertKernelPackageStateMatchesRuntimeGeneration(
  state: KernelPackageState,
  runtime: KernelRuntimeInfo,
): void {
  if (runtime.assembler_id !== ASSEMBLER_ID) {
    throw new Error(
      `Runtime assembler generation ${runtime.assembler_id} does not match ${ASSEMBLER_ID}`,
    );
  }

  const registry = normalizeAppRegistry(state.registry);
  if (!sameJsonValue(registry, normalizeAppRegistry(state.apps))) {
    throw new Error("Kernel package state registries do not match");
  }
  const expected = Object.entries(registry)
    .map(([app_id, entry]) => ({
      app_id,
      version: entry.version,
      capability_plan_fingerprint: entry.capability_plan_fingerprint,
      resident_frame_security: residentFrameSecurity(entry.capability_plan),
    }))
    .sort((left, right) => compareCanonicalText(left.app_id, right.app_id));
  if (expected.length > NEUTRON_INSTALLED_APP_LIMIT) {
    throw new Error("Kernel package state app inventory exceeds kernel limit");
  }

  const actual = parseAppInstanceInventory(
    runtime.apps,
    runtime.deployment_id,
    "runtime",
  ).map(appInstanceDeclaration);
  if (actual.length > NEUTRON_INSTALLED_APP_LIMIT) {
    throw new Error("Runtime app inventory exceeds kernel limit");
  }
  if (!sameJsonValue(expected, actual)) {
    throw new Error(
      "Installed package registry does not match the active runtime app inventory",
    );
  }
  assertRuntimeMemoryInventory(
    runtime.memories,
    compileManagedMemoryInventory(state.existingConfigs),
  );
}

function runtimeAppVersion(value: unknown, appId: string): number {
  if (typeof value === "number") {
    assertAppVersion(value, `Runtime app version for ${appId}`);
    return value;
  }
  if (
    typeof value === "bigint" &&
    value <= BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    const version = Number(value);
    assertAppVersion(version, `Runtime app version for ${appId}`);
    return version;
  }
  throw new Error(
    `Runtime app inventory contains an invalid version for ${appId}`,
  );
}

function runtimeMemoryVersion(value: unknown, memoryId: string): number {
  const normalized =
    typeof value === "bigint" && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value;
  if (
    typeof normalized !== "number" ||
    !Number.isSafeInteger(normalized) ||
    normalized < 1
  ) {
    throw new Error(
      `Runtime managed-memory inventory contains an invalid version for ${memoryId}`,
    );
  }
  return normalized;
}

function assertRuntimeMemoryInventory(
  value: unknown,
  expected: readonly CompiledManagedMemory[],
): void {
  if (!Array.isArray(value) || value.length > 16_384) {
    throw new Error("Runtime managed-memory inventory is invalid");
  }
  const actual = value.map((candidate, index) => {
    if (
      !isRecord(candidate) ||
      Object.keys(candidate).length !== 4 ||
      typeof candidate.owner !== "string" ||
      !isValidAppId(candidate.owner) ||
      typeof candidate.id !== "string" ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(candidate.id) ||
      typeof candidate.schema !== "string" ||
      !/^[a-f0-9]{64}$/.test(candidate.schema)
    ) {
      throw new Error(
        `Runtime managed-memory inventory contains an invalid entry at ${index}`,
      );
    }
    return {
      owner: candidate.owner,
      id: candidate.id,
      version: runtimeMemoryVersion(
        candidate.version,
        `${candidate.owner}.${candidate.id}`,
      ),
      schema: candidate.schema,
    };
  });
  for (let index = 1; index < actual.length; index += 1) {
    const previous = actual[index - 1]!;
    const current = actual[index]!;
    const order =
      compareCanonicalText(previous.owner, current.owner) ||
      compareCanonicalText(previous.id, current.id);
    if (order >= 0) {
      throw new Error(
        order === 0
          ? `Runtime managed-memory inventory duplicates ${current.owner}.${current.id}`
          : "Runtime managed-memory inventory is not canonically ordered",
      );
    }
  }
  if (!sameJsonValue(expected, actual)) {
    throw new Error(
      "Runtime managed-memory inventory does not match compile output",
    );
  }
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort(compareCanonicalText)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Value is not canonical JSON");
  return encoded;
}

export function appRegistryEntry(manifest: NeutronManifest): AppRegistryEntry {
  const capabilityPlan = toCapabilityPlanWireV1(buildCapabilityPlan(manifest));
  const capabilityPlanFingerprint =
    fingerprintCapabilityPlanWireV1(capabilityPlan);
  const displayMetadata = normalizeManifestDisplayMetadata(manifest);
  const updateSource = normalizeManifestUpdateSource(manifest);
  assertManifestFunctionExports(manifest);
  const functions = appRegistryFunctions(manifest.id, manifest.func);
  const dependencies = normalizeManifestDependencies(manifest);
  if (manifest.id === "kernel") {
    return {
      link: "/",
      name: displayMetadata.name,
      version: manifest.version,
      format: 3,
      ...(updateSource ? { update_source: updateSource } : {}),
      ...(displayMetadata.description
        ? { description: displayMetadata.description }
        : {}),
      icon: "/static/icon.png",
      tiles: [],
      capability_plan: capabilityPlan,
      capability_plan_fingerprint: capabilityPlanFingerprint,
      ...(Object.keys(dependencies).length > 0 ? { dependencies } : {}),
      functions,
    };
  }

  const tiles = normalizeManifestTiles(manifest).map((tile) => ({
    ...tile,
    icon: `/app/${manifest.id}/${tile.icon}`,
  }));
  const background = normalizeManifestBackground(manifest);
  const declaredTray = normalizeManifestTray(manifest);
  const tray = declaredTray
    ? {
        ...declaredTray,
        icon: `/app/${manifest.id}/${declaredTray.icon}`,
      }
    : null;
  return {
    link: `/${manifest.id}`,
    name: displayMetadata.name,
    version: manifest.version,
    format: 3,
    ...(updateSource ? { update_source: updateSource } : {}),
    ...(displayMetadata.description
      ? { description: displayMetadata.description }
      : {}),
    icon: tiles[0]?.icon ?? `/app/${manifest.id}/static/icon.png`,
    tiles,
    capability_plan: capabilityPlan,
    capability_plan_fingerprint: capabilityPlanFingerprint,
    ...(Object.keys(dependencies).length > 0 ? { dependencies } : {}),
    functions,
    ...(background ? { background } : {}),
    ...(tray ? { tray } : {}),
  };
}

export function updateAppRegistry(
  existingApps: AppRegistry,
  manifest: PackagedNeutronManifest,
): AppRegistry {
  return {
    ...existingApps,
    [manifest.id]: appRegistryEntry(manifest),
  };
}

type PartialAppRegistry = Record<string, unknown>;

function normalizeOptionalRegistryText(
  value: unknown,
  label: string,
  maximumLength: number,
): string | undefined {
  if (value === undefined) return undefined;
  return normalizeUntrustedText(value, label, {
    minimumLength: 1,
    maximumLength,
  });
}

export function normalizeAppRegistry(
  registry: PartialAppRegistry,
): AppRegistry {
  if (!isRecord(registry)) throw new Error("Invalid app registry");
  const entries = Object.entries(registry);
  if (entries.length > NEUTRON_INSTALLED_APP_LIMIT) {
    throw new Error("App registry exceeds the installed app limit");
  }
  const normalized: AppRegistry = {};
  for (const [appId, entry] of entries) {
    if (appId !== "kernel") validateInstallAppId(appId);
    if (!isRecord(entry)) throw new Error(`Invalid registry entry ${appId}`);
    normalized[appId] = normalizeAppRegistryEntry(appId, entry);
  }
  return normalized;
}

export function normalizeAppRegistryEntry(
  appId: string,
  entry: Record<string, unknown>,
): AppRegistryEntry {
  assertClosedRegistryEntry(entry, appId);
  const name = normalizeUntrustedText(
    entry.name,
    `registry name for ${appId}`,
    {
      maximumLength: 20,
    },
  );
  assertAppVersion(entry.version, `Registry version for ${appId}`);
  const version = entry.version;
  const description = normalizeOptionalRegistryText(
    entry.description,
    `registry description for ${appId}`,
    280,
  );
  const updateSource =
    entry.update_source === undefined
      ? undefined
      : normalizeUpdateSourcePrincipal(
          entry.update_source,
          `registry update_source for ${appId}`,
        );
  if (entry.format !== 3) {
    throw new Error(`Unsupported registry manifest format for ${appId}`);
  }
  const functions = normalizeRegistryFunctions(appId, entry.functions);
  const dependencies = normalizeManifestDependencies({
    id: appId,
    ...(entry.dependencies !== undefined
      ? {
          dependencies: entry.dependencies as Record<
            string,
            NormalizedNeutronAppDependencyConfig
          >,
        }
      : {}),
  });
  const link = appId === "kernel" ? "/" : `/${appId}`;
  if (entry.link !== link)
    throw new Error(`Invalid registry link for ${appId}`);
  if (typeof entry.icon !== "string") {
    throw new Error(`Invalid registry icon for ${appId}`);
  }
  const icon = normalizeRegistryEntryIcon(appId, entry.icon);
  const capabilityPlan = parseCapabilityPlanWireV1(entry.capability_plan);
  if (
    capabilityPlan.app.id !== appId ||
    capabilityPlan.app.version !== version
  ) {
    throw new Error(`Capability plan identity mismatch for ${appId}`);
  }
  if (typeof entry.capability_plan_fingerprint !== "string") {
    throw new Error(`Missing capability plan fingerprint for ${appId}`);
  }
  assertCapabilityPlanFingerprint(
    capabilityPlan,
    entry.capability_plan_fingerprint,
  );

  if (appId === "kernel") {
    if (
      !Array.isArray(entry.tiles) ||
      entry.tiles.length !== 0 ||
      entry.background !== undefined ||
      entry.tray !== undefined
    ) {
      throw new Error("Kernel registry surfaces must be empty");
    }
    assertRegistryCapabilityProjection({
      appId,
      plan: capabilityPlan,
      tiles: [],
      background: null,
      tray: null,
      dependencies,
      functions,
    });
    return {
      link,
      name,
      version,
      format: 3,
      ...(updateSource ? { update_source: updateSource } : {}),
      ...(description ? { description } : {}),
      icon,
      tiles: [],
      capability_plan: capabilityPlan,
      capability_plan_fingerprint: entry.capability_plan_fingerprint,
      ...(Object.keys(dependencies).length > 0 ? { dependencies } : {}),
      functions,
    };
  }

  const background = normalizeRegistryBackground(appId, entry.background);
  const tray = normalizeRegistryTray(appId, entry.tray, background);
  if (!Array.isArray(entry.tiles)) {
    throw new Error(`Registry app ${appId} has invalid tiles`);
  }
  const tiles = normalizeRegistryTiles(appId, entry.tiles);
  assertRegistryCapabilityProjection({
    appId,
    plan: capabilityPlan,
    tiles,
    background,
    tray,
    dependencies,
    functions,
  });

  return {
    link,
    name,
    version,
    format: 3,
    ...(updateSource ? { update_source: updateSource } : {}),
    ...(description ? { description } : {}),
    icon,
    tiles,
    capability_plan: capabilityPlan,
    capability_plan_fingerprint: entry.capability_plan_fingerprint,
    ...(Object.keys(dependencies).length > 0 ? { dependencies } : {}),
    functions,
    ...(background ? { background } : {}),
    ...(tray ? { tray } : {}),
  };
}

const REGISTRY_ENTRY_FIELDS = new Set([
  "link",
  "name",
  "version",
  "format",
  "update_source",
  "description",
  "icon",
  "tiles",
  "background",
  "tray",
  "capability_plan",
  "capability_plan_fingerprint",
  "dependencies",
  "functions",
]);

function assertClosedRegistryEntry(
  entry: Record<string, unknown>,
  appId: string,
): void {
  const unknown = Object.keys(entry).find(
    (field) => !REGISTRY_ENTRY_FIELDS.has(field),
  );
  if (unknown !== undefined) {
    throw new Error(`Unknown registry field ${unknown} for ${appId}`);
  }
}

function assertRegistryCapabilityProjection({
  appId,
  plan,
  tiles,
  background,
  tray,
  dependencies,
  functions,
}: {
  appId: string;
  plan: CapabilityPlanWireV1;
  tiles: NormalizedNeutronTileConfig[];
  background: NormalizedNeutronBackgroundConfig | null;
  tray: NormalizedNeutronTrayConfig | null;
  dependencies: Record<string, NormalizedNeutronAppDependencyConfig>;
  functions: AppRegistryFunction[];
}): void {
  const config = (id: string): unknown =>
    plan.entries.find((entry) => entry.id === id)?.config;
  const expectedTiles = tiles
    .map(({ id, path }) => ({ id, path }))
    .sort((left, right) => compareCanonicalText(left.id, right.id));
  const expectedDependencies = Object.entries(dependencies)
    .map(([alias, dependency]) => ({
      alias,
      app: dependency.app,
      min_version: dependency.min_version,
      methods: [...dependency.functions],
    }))
    .sort((left, right) => compareCanonicalText(left.alias, right.alias));
  const expectedAppExports = functions
    .filter((method) => method.expose === "apps")
    .map((method) => ({
      method: method.name,
      mode: method.type === "query" ? "query" : "update",
    }))
    .sort((left, right) => compareCanonicalText(left.method, right.method));
  const expectedFunctionResources = functions
    .filter((method) => method.args.length > 0)
    .map((method) => ({
      method: method.name,
      mode: method.type,
      resources: method.args.map((resource) => {
        if (resource === "caller") return { kind: "caller" as const };
        if (resource === "canister_principal") {
          return { kind: "canister_principal" as const };
        }
        if (resource === "public_ingress_cycles") {
          return { kind: "public_ingress_cycles" as const };
        }
        if (resource === "this" && appId === "kernel") {
          return { kind: "actor_self" as const };
        }
        if (resource === "task_capabilities") {
          return {
            kind: "task_capabilities" as const,
            interfaces: [{ id: "backend_calls" as const, api: 1 as const }],
          };
        }
        if (resource.startsWith("memory_") && resource.length > 7) {
          return {
            kind: "stable_memory" as const,
            id: resource.slice("memory_".length),
          };
        }
        throw new Error(
          `Invalid registry function resource ${resource} for ${appId}.${method.name}`,
        );
      }),
    }))
    .sort((left, right) => compareCanonicalText(left.method, right.method));

  const preapproved = plan.entries.find(
    (entry) => entry.id === "preapproved_self_calls",
  );
  if (preapproved?.id === "preapproved_self_calls") {
    for (const registration of preapproved.config.methods) {
      const target = functions.find(
        (candidate) => candidate.name === registration.method,
      );
      if (
        !target ||
        target.type === "internal" ||
        target.access !== "authorized" ||
        target.type !== registration.mode ||
        target.candid_name === undefined
      ) {
        throw new Error(
          `Capability plan preapproved self-call ${registration.method}:${registration.mode} is invalid for ${appId}`,
        );
      }
    }
  }
  const scheduled = plan.entries.find(
    (entry) => entry.id === "scheduled_tasks",
  );
  if (scheduled?.id === "scheduled_tasks") {
    for (const task of scheduled.config.tasks) {
      const target = functions.find(
        (candidate) => candidate.name === task.method,
      );
      if (!target || target.type !== "internal") {
        throw new Error(
          `Capability plan scheduled task ${task.id} is invalid for ${appId}`,
        );
      }
    }
  }
  const publicIngress = plan.entries.find(
    (entry) => entry.id === "public_ingress",
  );
  if (publicIngress?.id === "public_ingress") {
    for (const route of publicIngress.config.routes) {
      const target = functions.find(
        (candidate) => candidate.name === route.handler,
      );
      if (
        !target ||
        target.type !== route.mode ||
        target.access !== "authorized" ||
        target.async !== "sync" ||
        target.expose !== undefined
      ) {
        throw new Error(
          `Capability plan public ingress route ${route.protocol}:${route.id} has invalid handler ${route.handler} for ${appId}`,
        );
      }
    }
  }
  if (
    appId !== "kernel" &&
    functions.some((method) => method.access === "public")
  ) {
    throw new Error(
      `Ordinary app ${appId} cannot expose direct public Candid methods`,
    );
  }

  const projections: Array<[string, unknown, unknown]> = [
    [
      "tile_endpoints",
      config("tile_endpoints"),
      expectedTiles.length > 0 ? { endpoints: expectedTiles } : undefined,
    ],
    [
      "background_endpoint",
      config("background_endpoint"),
      background
        ? {
            path: background.path,
            frame_security: residentFrameSecurity(plan),
          }
        : undefined,
    ],
    [
      "tray_endpoint",
      config("tray_endpoint"),
      tray ? { path: tray.path } : undefined,
    ],
    [
      "app_calls",
      config("app_calls"),
      expectedDependencies.length > 0
        ? { dependencies: expectedDependencies }
        : undefined,
    ],
    [
      "app_exports",
      config("app_exports"),
      expectedAppExports.length > 0
        ? { methods: expectedAppExports }
        : undefined,
    ],
    [
      "function_resources",
      config("function_resources"),
      expectedFunctionResources.length > 0
        ? { functions: expectedFunctionResources }
        : undefined,
    ],
  ];
  for (const [id, actual, expected] of projections) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`Capability plan ${id} projection mismatch for ${appId}`);
    }
  }
}

function appRegistryFunctions(
  appId: string,
  functions: PackagedNeutronManifest["func"],
): AppRegistryFunction[] {
  return Object.entries(functions ?? {})
    .map(([name, config]) => {
      const type = config.type ?? "update";
      const routeOnly = config.arg?.includes("public_ingress_cycles");
      return {
        name,
        ...(type === "internal" || routeOnly
          ? {}
          : {
              candid_name:
                appId === "kernel" ? name : physicalAppMethodName(appId, name),
            }),
        type,
        access:
          type === "internal"
            ? ("internal" as const)
            : config.allow === "unauthorized"
              ? ("public" as const)
              : ("authorized" as const),
        async:
          config.async === "async*"
            ? ("async*" as const)
            : config.async === true
              ? ("async" as const)
              : ("sync" as const),
        args: [...(config.arg ?? [])],
        ...(config.expose === "apps" ? { expose: "apps" as const } : {}),
      };
    })
    .sort((left, right) => compareCanonicalText(left.name, right.name));
}

function normalizeRegistryFunctions(
  appId: string,
  value: unknown,
): AppRegistryFunction[] {
  if (!Array.isArray(value) || value.length > MANIFEST_MAX_FUNCTIONS) {
    throw new Error("Invalid registry functions");
  }

  const names = new Set<string>();
  const functions = value.map((candidate) => {
    if (!isRecord(candidate)) throw new Error("Invalid registry function");
    const allowedFields = new Set([
      "name",
      "candid_name",
      "type",
      "access",
      "async",
      "args",
      "expose",
    ]);
    const unknown = Object.keys(candidate).find(
      (field) => !allowedFields.has(field),
    );
    if (unknown !== undefined) {
      throw new Error(`Unknown registry function field ${unknown}`);
    }
    const { name, candid_name, type, access, async, args, expose } = candidate;
    if (
      typeof name !== "string" ||
      name.length > LOCAL_SYMBOL_MAX_LENGTH ||
      !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name) ||
      names.has(name)
    ) {
      throw new Error("Invalid registry function name");
    }
    names.add(name);
    if (type !== "update" && type !== "query" && type !== "internal") {
      throw new Error(`Invalid registry function type for ${name}`);
    }
    if (
      access !== "authorized" &&
      access !== "public" &&
      access !== "internal"
    ) {
      throw new Error(`Invalid registry function access for ${name}`);
    }
    if ((type === "internal") !== (access === "internal")) {
      throw new Error(`Invalid registry function type/access for ${name}`);
    }
    if (async !== "sync" && async !== "async" && async !== "async*") {
      throw new Error(`Invalid registry function async mode for ${name}`);
    }
    if (
      !Array.isArray(args) ||
      args.length > MANIFEST_MAX_FUNCTION_ARGS ||
      new Set(args).size !== args.length ||
      args.some(
        (arg) => typeof arg !== "string" || !/^[a-zA-Z_0-9.]+$/.test(arg),
      )
    ) {
      throw new Error(`Invalid registry function arguments for ${name}`);
    }
    if (expose !== undefined && expose !== "apps") {
      throw new Error(`Invalid registry function exposure for ${name}`);
    }
    if (expose === "apps" && type !== "internal") {
      throw new Error(`Only internal registry functions can be exposed`);
    }
    const expectedCandidName =
      type === "internal" || args.includes("public_ingress_cycles")
        ? undefined
        : appId === "kernel"
          ? name
          : physicalAppMethodName(appId, name);
    if (candid_name !== expectedCandidName) {
      throw new Error(`Invalid registry Candid name for ${appId}.${name}`);
    }
    const normalized: AppRegistryFunction = {
      name,
      ...(expectedCandidName === undefined
        ? {}
        : { candid_name: expectedCandidName }),
      type,
      access,
      async,
      args: [...args] as string[],
      ...(expose === "apps" ? { expose } : {}),
    };
    return normalized;
  });

  return functions.sort((left, right) =>
    compareCanonicalText(left.name, right.name),
  );
}

function normalizeRegistryEntryIcon(appId: string, icon: string): string {
  if (appId === "kernel") {
    if (icon !== "/static/icon.png") {
      throw new Error(`Invalid registry icon for kernel`);
    }
    return icon;
  }
  return toRegistryIconPath(appId, icon, `registry icon for ${appId}`);
}

function toRegistryIconPath(
  appId: string,
  icon: string,
  label = `registry tile icon for ${appId}`,
): string {
  if (icon.startsWith("/")) {
    assertSafeAbsoluteAssetPath(icon, label);
    if (!icon.startsWith(`/app/${appId}/`)) {
      throw new Error(`Unsafe ${label} ${icon}`);
    }
    return icon;
  }
  assertSafeRelativeAssetPath(icon, label);
  return `/app/${appId}/${icon}`;
}

function normalizeRegistryBackground(
  appId: string,
  background: unknown,
): NormalizedNeutronBackgroundConfig | null {
  if (background === undefined) return null;
  if (!isRecord(background)) {
    throw new Error(`Invalid registry background for ${appId}`);
  }
  const unknown = Object.keys(background).find(
    (field) => field !== "path" && field !== "description",
  );
  if (unknown !== undefined) {
    throw new Error(
      `Unknown registry background field ${unknown} for ${appId}`,
    );
  }
  const path = background.path;
  assertSafeRelativeAssetPath(path, `registry background path for ${appId}`);
  const description = normalizeOptionalRegistryText(
    background.description,
    `registry background description for ${appId}`,
    280,
  );
  return {
    path,
    ...(description === undefined ? {} : { description }),
  };
}

function normalizeRegistryTray(
  appId: string,
  tray: unknown,
  background: NormalizedNeutronBackgroundConfig | null,
): NormalizedNeutronTrayConfig | null {
  if (tray === undefined) return null;
  if (!background) {
    throw new Error(`Registry tray for ${appId} requires a background process`);
  }
  if (!isRecord(tray)) {
    throw new Error(`Invalid registry tray for ${appId}`);
  }
  const unknown = Object.keys(tray).find(
    (field) => field !== "title" && field !== "path" && field !== "icon",
  );
  if (unknown !== undefined) {
    throw new Error(`Unknown registry tray field ${unknown} for ${appId}`);
  }

  const title = normalizeUntrustedText(
    tray.title,
    `registry tray title for ${appId}`,
    { maximumLength: 40 },
  );
  const path = tray.path;
  assertSafeRelativeAssetPath(path, `registry tray path for ${appId}`);
  const icon = tray.icon;
  if (typeof icon !== "string" || icon.length === 0) {
    throw new Error(`Invalid registry tray icon for ${appId}`);
  }

  return {
    title,
    path,
    icon: toRegistryTrayIconPath(appId, icon),
  };
}

function toRegistryTrayIconPath(appId: string, icon: string): string {
  const label = `registry tray icon for ${appId}`;
  if (!icon.startsWith("/")) {
    assertSafeRelativeAssetPath(icon, label);
    return `/app/${appId}/${icon}`;
  }

  assertSafeAbsoluteAssetPath(icon, label);
  if (!icon.startsWith(`/app/${appId}/`)) {
    throw new Error(`Unsafe ${label} ${icon}`);
  }
  return icon;
}

function assertSafeAbsoluteAssetPath(value: string, label: string): void {
  if (value.length === 1 || value.includes("\\")) {
    throw new Error(`Unsafe ${label} ${value}`);
  }
  const segments = value.slice(1).split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw new Error(`Unsafe ${label} ${value}`);
  }
}

function normalizeRegistryTiles(
  appId: string,
  tiles: unknown[],
): NormalizedNeutronTileConfig[] {
  if (tiles.length > MANIFEST_MAX_TILES) {
    throw new Error(`Registry app ${appId} declares too many tiles`);
  }
  const ids = new Set<string>();
  return tiles.map((tile) => {
    if (!isRecord(tile)) throw new Error(`Invalid registry tile for ${appId}`);
    const unknown = Object.keys(tile).find(
      (field) =>
        field !== "id" &&
        field !== "title" &&
        field !== "path" &&
        field !== "icon" &&
        field !== "description",
    );
    if (unknown !== undefined) {
      throw new Error(`Unknown registry tile field ${unknown} for ${appId}`);
    }

    const id = tile.id;
    if (
      typeof id !== "string" ||
      id.length < 1 ||
      id.length > 30 ||
      !/^[a-z_0-9]+$/.test(id)
    ) {
      throw new Error(`Invalid registry tile id for ${appId}`);
    }
    if (ids.has(id))
      throw new Error(`Duplicate registry tile id ${appId}/${id}`);
    ids.add(id);

    const title = normalizeUntrustedText(
      tile.title,
      `registry tile title for ${appId}/${id}`,
      { maximumLength: 40 },
    );
    const description = normalizeOptionalRegistryText(
      tile.description,
      `registry tile description for ${appId}/${id}`,
      280,
    );

    const path = tile.path;
    assertSafeRelativeAssetPath(path, `registry tile path for ${appId}/${id}`);

    const icon = tile.icon;
    if (typeof icon !== "string" || icon.length === 0) {
      throw new Error(`Invalid registry tile icon for ${appId}/${id}`);
    }

    return {
      id,
      title,
      path,
      icon: toRegistryIconPath(appId, icon),
      ...(description === undefined ? {} : { description }),
    };
  });
}

export function buildPackageInstallAssets({
  existingApps,
  manifest,
  candid,
}: {
  existingApps: AppRegistry;
  manifest: PackagedNeutronManifest;
  candid: string;
}): PackageInstallAssets {
  const apps = updateAppRegistry(normalizeAppRegistry(existingApps), manifest);
  return {
    apps,
    appRegistryAsset: createJsonAsset(
      "/system/apps.json",
      apps,
      "application/json",
    ),
    candidAsset: createTextAsset("/pkg/neutron.did", candid, "text/plain"),
  };
}

export function buildPackagesInstallAssets({
  existingApps,
  packages,
  candid,
  removedApps = [],
}: {
  existingApps: AppRegistry;
  packages: PreparedPackageInstall[];
  candid: string;
  removedApps?: string[];
}): PackageInstallAssets {
  assertPreparedPackageBatch(packages);
  const normalizedRemovedApps = normalizeRemovedApps(removedApps, packages);
  let apps = Object.fromEntries(
    Object.entries(normalizeAppRegistry(existingApps)).filter(
      ([id]) => !normalizedRemovedApps.includes(id),
    ),
  );
  for (const preparedPackage of packages) {
    apps = updateAppRegistry(apps, preparedPackage.manifest);
  }
  return {
    apps,
    appRegistryAsset: createJsonAsset(
      "/system/apps.json",
      apps,
      "application/json",
    ),
    candidAsset: createTextAsset("/pkg/neutron.did", candid, "text/plain"),
  };
}

export async function compileAndDeployPreparedPackages({
  actor,
  targetCanisterId,
  packages,
  state,
  vetKeysEnvironment,
  stagedAssets,
  expectedDeploymentId,
  verifyTimeoutMs,
  onStep,
  onProgress,
  versionPolicy = "strict-upgrade",
}: CompileAndDeployPackagesInput): Promise<DeployPreparedPackagesResult> {
  installClearPrefixes(packages, []);
  const compiled = await compilePackages({
    packages,
    existingModules: state.existingModules,
    existingConfigs: state.existingConfigs,
    existingStable: state.previousStable,
    connectionProviderSupport: state.connectionProviderSupport,
    deploymentNonce: createDeploymentNonce(),
    ...(vetKeysEnvironment ? { vetKeysEnvironment } : {}),
    versionPolicy,
  });

  return deployPreparedPackages({
    actor,
    targetCanisterId,
    packages,
    compiled,
    existingApps: state.apps,
    previousModulePaths: state.existingModules.map(({ path }) => path),
    ...(stagedAssets ? { stagedAssets } : {}),
    expectedDeploymentId,
    ...(verifyTimeoutMs !== undefined ? { verifyTimeoutMs } : {}),
    ...(onStep ? { onStep } : {}),
    ...(onProgress ? { onProgress } : {}),
  });
}

export async function deployPreparedPackages({
  actor,
  targetCanisterId,
  packages,
  compiled,
  existingApps,
  previousModulePaths = [],
  removedApps = [],
  stagedAssets = [],
  expectedDeploymentId,
  verifyTimeoutMs = DEFAULT_DEPLOYMENT_ACTIVATION_TIMEOUT_MS,
  onStep,
  onProgress,
}: DeployPreparedPackagesInput): Promise<DeployPreparedPackagesResult> {
  assertBackendCallInstallReservationsTarget(
    Object.fromEntries(
      packages.map((preparedPackage) => [
        preparedPackage.manifest.id,
        preparedPackage.manifest,
      ]),
    ),
    targetCanisterId,
  );
  assertCompiledManagedMemoryPlan(compiled);
  assertPreparedPackageBatch(packages);
  const normalizedRemovedApps = normalizeRemovedApps(removedApps, packages);
  const clearPrefixes = installClearPrefixes(packages, normalizedRemovedApps);
  assertExpectedDeploymentId(expectedDeploymentId);
  try {
    assertInstallCommitBinding(compiled.candid);
  } catch (error) {
    throw new Error(
      `Compiled target must expose the current kernel_install_commit contract: ${errorMessage(error)}`,
    );
  }
  const installReservations = installReservationsPrepareRequest(
    packages,
    compiled.deploymentId,
  );
  const installCodeDispatch = prepareInstallCodeDispatch({
    wasm: compiled.wasm,
    candid: compiled.candid,
    deploymentId: compiled.deploymentId,
  });
  const { apps, appRegistryAsset, candidAsset } = buildPackagesInstallAssets({
    existingApps,
    packages,
    candid: compiled.candid,
    removedApps: normalizedRemovedApps,
  });
  assertInstallRegistryMatchesCompile(apps, compiled);
  const stableAsset = createTextAsset(
    "/pkg/neutron.most",
    compiled.stable,
    "text/plain",
  );
  const moduleFiles = uniquePreparedModuleFiles(packages);
  const moduleGcOperation = createModuleGcOperation({
    deploymentId: compiled.deploymentId,
    previousModulePaths,
    retainedModulePaths: compiled.modulePaths,
  });
  const mutableFiles = packages.flatMap((preparedPackage) =>
    preparedPackage.files.filter(
      (file) =>
        !file.path.startsWith("mo/") &&
        // Existing kernel packages contain the package-build Candid at this
        // path. It has always been superseded by the newly compiled actor's
        // Candid during deployment, so omit that non-authoritative copy before
        // collision validation rather than removing kernel replacement.
        !(preparedPackage.isKernel && file.path === "pkg/neutron.did"),
    ),
  );

  const staged = createStagedAssets(compiled.deploymentId, [
    ...mutableFiles.map(({ path, content }) => ({
      target: staticKey(path),
      content,
      // Preserve the source extension when a kernel entrypoint is rewritten
      // from index.html to the extensionless root key `/`.
      contentType: mime(path),
    })),
    {
      target: candidAsset.key,
      content: new TextEncoder().encode(compiled.candid),
      contentType: candidAsset.val.content_type,
    },
    {
      target: appRegistryAsset.key,
      content: new TextEncoder().encode(JSON.stringify(apps)),
      contentType: appRegistryAsset.val.content_type,
    },
    {
      target: stableAsset.key,
      content: new TextEncoder().encode(compiled.stable),
      contentType: stableAsset.val.content_type,
    },
    ...stagedAssets,
  ]);
  if (staged.length > KERNEL_INSTALL_MAX_COPIES) {
    throw new Error(
      `Install requires ${staged.length} asset copies; kernel limit is ${KERNEL_INSTALL_MAX_COPIES}`,
    );
  }

  notifyDeployStep(onStep, "upload-modules");
  await uploadPreparedFiles(actor, moduleFiles, {
    ...(onProgress
      ? {
          onProgress: (progress) => notifyUploadProgress(onProgress, progress),
        }
      : {}),
  });

  notifyDeployStep(onStep, "stage-assets");
  try {
    for (const asset of staged) {
      await uploadStaticFileOperation(
        actor,
        createStaticFileOperation(
          asset.source,
          asset.content,
          asset.contentType ?? mime(asset.target),
        ),
      );
    }
    if (moduleGcOperation) {
      await uploadStaticFileOperation(actor, moduleGcOperation);
    }
  } catch (error) {
    await cleanupUnjournaledStaging(actor, compiled.deploymentId);
    throw error;
  }

  const journal: InstallJournal = {
    deployment_id: compiled.deploymentId,
    copies: staged.map(({ source, target }) => ({ source, target })),
    clear_prefixes: clearPrefixes,
    target_app_inventory: compiled.appInstanceInventory.map((entry) => ({
      app_id: entry.app_id,
      version: entry.version,
      capability_plan_fingerprint: entry.capability_plan_fingerprint,
      resident_frame_security: encodeResidentFrameSecurity(
        entry.resident_frame_security,
      ),
    })),
  };

  notifyDeployStep(onStep, "record-journal");
  const beginRequest = {
    journal,
    expected_deployment_id: expectedDeploymentId,
  };
  try {
    await actor.kernel_install_begin_checked(beginRequest);
  } catch (firstFailure) {
    try {
      // Journal creation is idempotent for the exact deployment-bound
      // request. A successful replay is the only causal proof that staging is
      // journal-owned after the first update reply is lost.
      await actor.kernel_install_begin_checked(beginRequest);
    } catch (replayFailure) {
      // An ordinary status query can lag the replicated update. Never use a
      // stale empty query to clear staging after an unacknowledged begin.
      throw new AggregateError(
        [firstFailure, replayFailure],
        `Checked install journal could not be causally confirmed for ${compiled.deploymentId}; staging was retained: ${errorMessage(replayFailure)}`,
      );
    }
  }

  if (installReservations !== null) {
    try {
      await prepareInstallReservations(actor, installReservations);
    } catch (error) {
      notifyDeployStep(onStep, "abort");
      try {
        await abortUndispatchedInstall(actor, compiled.deploymentId);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `Install reservation preparation failed and cleanup could not be confirmed for ${compiled.deploymentId}`,
        );
      }
      throw error;
    }
  }

  try {
    notifyDeployStep(onStep, "install-code");
    let dispatchFailure: InstallDispatchFailure | undefined;
    try {
      await dispatchInstallCode(actor, installCodeDispatch);
    } catch (error) {
      if (error instanceof InstallCodePreparationError) throw error;
      // A self-upgrade may replace the callback before it reaches the caller.
      dispatchFailure = { error };
    }

    notifyDeployStep(onStep, "verify-runtime");
    const runtime = await waitForRuntime(
      actor,
      compiled.deploymentId,
      verifyTimeoutMs,
      dispatchFailure,
    );
    assertCompiledRuntime(runtime, compiled);

    if (installCodeDispatch.kind === "chunked") {
      await clearInstallWasmChunks(actor, compiled.deploymentId);
    }

    notifyDeployStep(onStep, "commit-assets");
    await commitPreparedDeployment(actor, compiled.deploymentId);
    notifyDeployStep(onStep, "complete");
    return { apps, compiled };
  } catch (error) {
    if (error instanceof InstallCommitPendingError) {
      throw error;
    }
    const runtime = await readRuntimeInfo(actor);
    if (runtime?.deployment_id === compiled.deploymentId) {
      assertCompiledRuntime(runtime, compiled);
      if (installCodeDispatch.kind === "chunked") {
        await clearInstallWasmChunks(actor, compiled.deploymentId);
      }
      await commitPreparedDeployment(actor, compiled.deploymentId);
      notifyDeployStep(onStep, "complete");
      return { apps, compiled };
    }
    if (runtime) {
      if (installCodeDispatch.kind === "chunked") {
        await clearInstallWasmChunks(actor, compiled.deploymentId);
      }
      notifyDeployStep(onStep, "abort");
      await actor
        .kernel_install_abort({ deployment_id: compiled.deploymentId })
        .catch(() => undefined);
    }
    throw error;
  }
}

class InstallCommitPendingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstallCommitPendingError";
  }
}

async function commitPreparedDeployment(
  actor: KernelPackageInstaller,
  deploymentId: string,
): Promise<void> {
  const request = { deployment_id: deploymentId };
  let result: unknown;
  try {
    result = await actor.kernel_install_commit(request);
  } catch (firstFailure) {
    try {
      // The current commit is idempotent and keeps a deployment-bound receipt.
      // Replay once when the update may have committed but its reply was lost.
      result = await actor.kernel_install_commit(request);
    } catch (replayFailure) {
      const diagnostic = await installJournalDiagnostic(actor);
      throw new InstallCommitPendingError(
        `Install commit could not be causally confirmed for ${deploymentId} after two failed update attempts: ${errorMessage(firstFailure)}; ${errorMessage(replayFailure)}. ${diagnostic}`,
      );
    }
  }
  if (isInstallCommitBlocked(result)) {
    throw new InstallCommitPendingError(
      `Install commit is blocked and remains pending for ${deploymentId}`,
    );
  }
  if (!isInstallCommitCommitted(result)) {
    throw new InstallCommitPendingError(
      `Invalid install commit result for ${deploymentId}`,
    );
  }
}

function isInstallCommitCommitted(
  value: unknown,
): value is { committed: null } {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.keys(value).length === 1 &&
    "committed" in value &&
    value.committed === null
  );
}

function isInstallCommitBlocked(
  value: unknown,
): value is { blocked: null } {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.keys(value).length === 1 &&
    "blocked" in value &&
    value.blocked === null
  );
}

async function installJournalDiagnostic(
  actor: KernelPackageInstaller,
): Promise<string> {
  try {
    const status = normalizeInstallJournalStatus(
      await actor.kernel_install_status(null),
    );
    return status === null
      ? "The journal query currently reports no pending install, but a query cannot confirm an unacknowledged update."
      : `The journal query currently reports pending deployment ${status.deployment_id}.`;
  } catch (error) {
    return `The journal query also failed: ${errorMessage(error)}.`;
  }
}

function normalizeInstallJournalStatus(
  value: [] | [InstallJournalStatus],
): InstallJournalStatus | null {
  if (!Array.isArray(value) || value.length > 1) {
    throw new Error("Invalid install journal status response");
  }
  return value[0] ?? null;
}

function installReservationsPrepareRequest(
  packages: readonly PreparedPackageInstall[],
  deploymentId: string,
): KernelInstallReservationsPrepareRequest | null {
  const apps = packages
    .map((preparedPackage) => {
      const reservations = installBackendCallReservationActions(
        preparedPackage.capabilityPlan,
      ).map((action) => {
        const encoded = backendCallReservationActionToCandid(action);
        if (
          typeof encoded !== "object" ||
          encoded === null ||
          !("reserve" in encoded)
        ) {
          throw new Error("Invalid install reservation Candid encoding");
        }
        return encoded.reserve;
      });
      return {
        app_id: preparedPackage.manifest.id,
        reservations,
      };
    })
    .filter(({ reservations }) => reservations.length > 0)
    .sort((left, right) => compareCanonicalText(left.app_id, right.app_id));
  return apps.length === 0
    ? null
    : {
        deployment_id: deploymentId,
        apps,
      };
}

async function prepareInstallReservations(
  actor: KernelPackageInstaller,
  request: KernelInstallReservationsPrepareRequest,
): Promise<void> {
  try {
    await actor.kernel_install_reservations_prepare(request);
  } catch {
    // The update is idempotent. Replaying the exact request reconciles the
    // common case where the Kernel committed it but the reply was lost.
    await actor.kernel_install_reservations_prepare(request);
  }
}

async function abortUndispatchedInstall(
  actor: KernelPackageInstaller,
  deploymentId: string,
): Promise<void> {
  const request = { deployment_id: deploymentId };
  try {
    await actor.kernel_install_abort(request);
    return;
  } catch (error) {
    const firstFailure = error;
    try {
      // Abort is idempotent before dispatch. Only an acknowledged replay can
      // causally confirm cleanup after the first reply is lost.
      await actor.kernel_install_abort(request);
      return;
    } catch (replayFailure) {
      const diagnostic = await installJournalDiagnostic(actor);
      throw new Error(
        `Pre-dispatch install cleanup could not be causally confirmed for ${deploymentId} after two failed update attempts: ${errorMessage(firstFailure)}; ${errorMessage(replayFailure)}. ${diagnostic}`,
      );
    }
  }
}

function assertCompiledManagedMemoryPlan(compiled: CompileResult): void {
  assertMemoryMigrationPlan(compiled.migrationPlan);
  const planned = plannedManagedMemoryRetirements(compiled.migrationPlan);
  const declared = normalizeManagedMemoryRetirements(
    compiled.managedMemoryRetirements,
    "compiled managed-memory retirement",
  );
  const stable = readManagedMemoryRetirements(compiled.stable);
  if (
    JSON.stringify(planned) !== JSON.stringify(declared) ||
    JSON.stringify(planned) !== JSON.stringify(stable)
  ) {
    throw new Error(
      "Compiled managed-memory retirement metadata does not match its migration plan",
    );
  }
}

function normalizeRemovedApps(
  removedApps: readonly string[],
  packages: readonly PreparedPackageInstall[],
): string[] {
  const packaged = new Set(packages.map(({ manifest }) => manifest.id));
  const normalized = [...removedApps].sort(compareCanonicalText);
  if (normalized.length > KERNEL_INSTALL_MAX_APP_REMOVALS_PER_COMMIT) {
    throw new Error(
      `Install removes ${normalized.length} apps; kernel limit is ${KERNEL_INSTALL_MAX_APP_REMOVALS_PER_COMMIT} per deployment. Remove apps across successive deployments`,
    );
  }
  for (let index = 0; index < normalized.length; index += 1) {
    const appId = normalized[index];
    validateInstallAppId(appId);
    if (appId === "kernel") {
      throw new Error("The kernel app cannot be removed");
    }
    if (index > 0 && normalized[index - 1] === appId) {
      throw new Error(`Duplicate removed app ${appId}`);
    }
    if (packaged.has(appId)) {
      throw new Error(`App ${appId} cannot be installed and removed together`);
    }
  }
  return normalized;
}

function installClearPrefixes(
  packages: readonly PreparedPackageInstall[],
  removedApps: readonly string[],
): string[] {
  const prefixes = [
    ...new Set([
      ...packages
        .filter((preparedPackage) => !preparedPackage.isKernel)
        .map((preparedPackage) => `/app/${preparedPackage.manifest.id}/`),
      ...removedApps.map((appId) => `/app/${appId}/`),
    ]),
  ].sort(compareCanonicalText);
  if (prefixes.length > KERNEL_INSTALL_MAX_CLEAR_PREFIXES_PER_COMMIT) {
    throw new Error(
      `Install clears ${prefixes.length} app asset prefixes; kernel limit is ${KERNEL_INSTALL_MAX_CLEAR_PREFIXES_PER_COMMIT} per deployment. Install or remove apps across successive deployments`,
    );
  }
  return prefixes;
}

function assertInstallRegistryMatchesCompile(
  apps: AppRegistry,
  compiled: CompileResult,
): void {
  const registryInventory = Object.entries(apps)
    .map(([id, entry]) => ({
      id,
      version: entry.version,
      fingerprint: entry.capability_plan_fingerprint,
      resident_frame_security: residentFrameSecurity(entry.capability_plan),
    }))
    .sort((left, right) => compareCanonicalText(left.id, right.id));
  const compiledInventory = parseRuntimeAppInventory(
    compiled.appInstanceInventory,
    "compiler target",
  ).map((entry) => ({
    id: entry.app_id,
    version: Number(entry.version),
    fingerprint: entry.capability_plan_fingerprint,
    resident_frame_security: entry.resident_frame_security,
  }));
  const capabilityPlanInventory = Object.entries(compiled.capabilityPlans)
    .map(([id, capability]) => ({
      id,
      version: capability.plan.app.version,
      fingerprint: capability.fingerprint,
      resident_frame_security: residentFrameSecurity(capability.plan),
    }))
    .sort((left, right) => compareCanonicalText(left.id, right.id));
  if (
    JSON.stringify(compiledInventory) !== JSON.stringify(capabilityPlanInventory)
  ) {
    throw new Error(
      "Compiler app-instance inventory does not match its capability plans",
    );
  }
  if (JSON.stringify(registryInventory) !== JSON.stringify(compiledInventory)) {
    throw new Error(
      "Install registry capability plans do not match compile output",
    );
  }
}

function parseRuntimeAppInventory(
  value: unknown,
  label: string,
): NormalizedRuntimeApp[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > NEUTRON_INSTALLED_APP_LIMIT
  ) {
    throw new Error(`Invalid ${label} app inventory`);
  }
  const records = value.map((candidate) => {
    if (
      !isRecord(candidate) ||
      Object.keys(candidate).length !== 4 ||
      typeof candidate.app_id !== "string" ||
      typeof candidate.capability_plan_fingerprint !== "string" ||
      !/^[a-f0-9]{64}$/.test(candidate.capability_plan_fingerprint)
    ) {
      throw new Error(`Invalid ${label} app inventory entry`);
    }
    if (candidate.app_id !== "kernel") validateInstallAppId(candidate.app_id);
    assertResidentFrameSecurity(candidate.resident_frame_security);
    return {
      app_id: candidate.app_id,
      version: runtimeAppVersion(candidate.version, candidate.app_id),
      capability_plan_fingerprint: candidate.capability_plan_fingerprint,
      resident_frame_security: candidate.resident_frame_security,
    };
  });
  for (let index = 1; index < records.length; index += 1) {
    if (
      compareCanonicalText(
        records[index - 1]!.app_id,
        records[index]!.app_id,
      ) >= 0
    ) {
      throw new Error(`Non-canonical ${label} app inventory`);
    }
  }
  return records;
}

function parseAppInstanceInventory(
  value: unknown,
  expectedDeploymentId: string | null,
  label: string,
): NormalizedAppInstance[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > NEUTRON_INSTALLED_APP_LIMIT
  ) {
    throw new Error(`Invalid ${label} app-instance inventory`);
  }
  const appIds = new Set<string>();
  const installationUids = new Set<bigint>();
  const browserOriginNonces = new Set<string>();
  let inventoryDeploymentId: string | null = expectedDeploymentId;
  const instances = value.map((candidate) => {
    if (
      !isRecord(candidate) ||
      Object.keys(candidate).length !== 7 ||
      !isRecord(candidate.scope) ||
      Object.keys(candidate.scope).length !== 2 ||
      typeof candidate.scope.app_id !== "string" ||
      typeof candidate.deployment_id !== "string" ||
      typeof candidate.capability_plan_fingerprint !== "string" ||
      !/^[a-f0-9]{64}$/.test(candidate.capability_plan_fingerprint) ||
      typeof candidate.browser_origin_nonce !== "string" ||
      !/^[a-f0-9]{32}$/.test(candidate.browser_origin_nonce)
    ) {
      throw new Error(`Invalid ${label} app instance`);
    }
    const appId = candidate.scope.app_id;
    if (appId !== "kernel") validateInstallAppId(appId);
    if (appIds.has(appId)) {
      throw new Error(`${label} app-instance inventory repeats ${appId}`);
    }
    appIds.add(appId);
    const installationUid = runtimeNat64(
      candidate.scope.installation_uid,
      `${label} installation uid for ${appId}`,
    );
    if (installationUid === 0n || installationUids.has(installationUid)) {
      throw new Error(`Invalid or repeated ${label} installation uid`);
    }
    installationUids.add(installationUid);
    if (browserOriginNonces.has(candidate.browser_origin_nonce)) {
      throw new Error(`Repeated ${label} browser-origin nonce`);
    }
    browserOriginNonces.add(candidate.browser_origin_nonce);
    const residentFrameSecurity = decodeResidentFrameSecurity(
      candidate.resident_frame_security,
      `${label} resident-frame security for ${appId}`,
    );
    if (inventoryDeploymentId === null) {
      inventoryDeploymentId = candidate.deployment_id;
    }
    if (candidate.deployment_id !== inventoryDeploymentId) {
      throw new Error(`${label} app instance is bound to another deployment`);
    }
    return {
      scope: {
        app_id: appId,
        installation_uid: installationUid,
      },
      version: runtimeAppVersion(candidate.version, appId),
      deployment_id: candidate.deployment_id,
      capability_plan_fingerprint: candidate.capability_plan_fingerprint,
      browser_origin_nonce: candidate.browser_origin_nonce,
      browser_origin_authority_epoch: runtimeNat64(
        candidate.browser_origin_authority_epoch,
        `${label} browser-origin authority epoch for ${appId}`,
      ),
      resident_frame_security: residentFrameSecurity,
    };
  });
  for (let index = 1; index < instances.length; index += 1) {
    if (
      compareCanonicalText(
        instances[index - 1]!.scope.app_id,
        instances[index]!.scope.app_id,
      ) >= 0
    ) {
      throw new Error(`Non-canonical ${label} app-instance inventory`);
    }
  }
  return instances;
}

function runtimeNat64(value: unknown, label: string): bigint {
  const normalized =
    typeof value === "bigint"
      ? value
      : typeof value === "number" && Number.isSafeInteger(value)
        ? BigInt(value)
        : null;
  if (normalized === null || normalized < 0n || normalized > 0xffffffffffffffffn) {
    throw new Error(`Invalid ${label}`);
  }
  return normalized;
}

function encodeResidentFrameSecurity(
  value: ResidentFrameSecurity,
): CandidResidentFrameSecurity {
  assertResidentFrameSecurity(value);
  if (value === "credentialless_opaque_v1") {
    return { credentialless_opaque_v1: null };
  }
  if (value === "credentialless_ephemeral_dedicated_v1") {
    return { credentialless_ephemeral_dedicated_v1: null };
  }
  return { persistent_dedicated_v1: null };
}

function decodeResidentFrameSecurity(
  value: unknown,
  label: string,
): ResidentFrameSecurity {
  if (!isRecord(value)) throw new Error(`Invalid ${label}`);
  const tags = Object.keys(value);
  if (tags.length !== 1 || value[tags[0]!] !== null) {
    throw new Error(`Invalid ${label}`);
  }
  const tag = tags[0];
  try {
    assertResidentFrameSecurity(tag);
  } catch {
    throw new Error(`Invalid ${label}`);
  }
  return tag;
}

function appInstanceDeclaration(
  instance: NormalizedAppInstance,
): NormalizedRuntimeApp {
  return {
    app_id: instance.scope.app_id,
    version: runtimeAppVersion(instance.version, instance.scope.app_id),
    capability_plan_fingerprint: instance.capability_plan_fingerprint,
    resident_frame_security: instance.resident_frame_security,
  };
}

function sameAppInstanceInventory(
  left: readonly NormalizedAppInstance[],
  right: readonly NormalizedAppInstance[],
): boolean {
  return (
    left.length === right.length &&
    left.every((instance, index) => {
      const candidate = right[index];
      return (
        candidate !== undefined &&
        instance.scope.app_id === candidate.scope.app_id &&
        runtimeNat64(instance.scope.installation_uid, "installation uid") ===
          runtimeNat64(candidate.scope.installation_uid, "installation uid") &&
        Number(instance.version) === Number(candidate.version) &&
        instance.deployment_id === candidate.deployment_id &&
        instance.capability_plan_fingerprint ===
          candidate.capability_plan_fingerprint &&
        instance.browser_origin_nonce === candidate.browser_origin_nonce &&
        instance.resident_frame_security ===
          candidate.resident_frame_security &&
        runtimeNat64(
          instance.browser_origin_authority_epoch,
          "browser-origin authority epoch",
        ) ===
          runtimeNat64(
            candidate.browser_origin_authority_epoch,
            "browser-origin authority epoch",
          )
      );
    })
  );
}

function assertCompiledRuntime(
  runtime: KernelRuntimeInfo,
  compiled: CompileResult,
): void {
  if (runtime.deployment_id !== compiled.deploymentId) {
    throw new Error(
      `Runtime deployment ${runtime.deployment_id} does not match compile output ${compiled.deploymentId}`,
    );
  }
  if (runtime.assembler_id !== ASSEMBLER_ID) {
    throw new Error(
      `Runtime assembler ${runtime.assembler_id} does not match ${ASSEMBLER_ID}`,
    );
  }
  if (runtime.compiler_id !== compiled.compilerId) {
    throw new Error(
      `Runtime compiler ${runtime.compiler_id} does not match ${compiled.compilerId}`,
    );
  }
  const actual = parseAppInstanceInventory(
    runtime.apps,
    runtime.deployment_id,
    "runtime",
  ).map(appInstanceDeclaration);
  const expected = parseRuntimeAppInventory(
    compiled.appInstanceInventory,
    "compiler target",
  );
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      "Runtime capability plan inventory does not match compile output",
    );
  }
  assertRuntimeMemoryInventory(
    runtime.memories,
    compiled.managedMemoryInventory,
  );
}

const KERNEL_MODULE_GC_MAX_ENTRIES = 20_000;

function createModuleGcOperation({
  deploymentId,
  previousModulePaths,
  retainedModulePaths,
}: {
  deploymentId: string;
  previousModulePaths: readonly string[];
  retainedModulePaths: readonly string[];
}): StaticFileOperation | null {
  const retained = new Set(retainedModulePaths);
  const retired = [...new Set(previousModulePaths)]
    .filter((path) => !retained.has(path))
    .sort(compareCanonicalText);
  if (retired.length === 0) return null;
  if (retired.length > KERNEL_MODULE_GC_MAX_ENTRIES) {
    throw new Error(
      `Module cleanup exceeds ${KERNEL_MODULE_GC_MAX_ENTRIES} entries`,
    );
  }
  for (const path of retired) {
    if (!HASHED_MOTOKO_PACKAGE_PATH.test(`mo/${path}`)) {
      throw new Error(`Invalid previous Motoko module path ${path}`);
    }
  }
  return createStaticFileOperation(
    `/system/staging/${deploymentId}/module-gc`,
    new TextEncoder().encode(`${retired.join("\n")}\n`),
    "text/plain",
    "identity",
  );
}

type StagedAssetInput = {
  target: string;
  content: Uint8Array;
  contentType?: string;
};

type InstallDispatchFailure = { error: unknown };

class InstallCodePreparationError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "InstallCodePreparationError";
  }
}

type InstallCodeDispatch =
  | {
      kind: "inline";
      request: KernelInstallCodeRequest;
    }
  | {
      kind: "chunked";
      chunks: {
        content: Uint8Array;
        sha256: Uint8Array;
      }[];
      request: KernelInstallCodeChunkedRequest;
    };

function prepareInstallCodeDispatch({
  wasm,
  candid,
  deploymentId,
}: {
  wasm: Uint8Array;
  candid: string;
  deploymentId: string;
}): InstallCodeDispatch {
  const request = compressedInstallCodeRequest({
    wasm,
    candid,
    deploymentId,
  });
  if (installCodeRequestFitsIngress(request)) {
    return { kind: "inline", request };
  }
  const contentChunks = chunkBytes(request.wasm, INSTALL_WASM_CHUNK_BYTES);
  if (contentChunks.length > INSTALL_WASM_MAX_CHUNKS) {
    throw new Error(
      `Compressed Wasm requires ${contentChunks.length} chunks; ` +
        `the IC management chunk store permits at most ${INSTALL_WASM_MAX_CHUNKS}`,
    );
  }
  const chunks = contentChunks.map((content) => ({
    content,
    sha256: sha256Bytes(content),
  }));
  return {
    kind: "chunked",
    chunks,
    request: {
      deployment_id: deploymentId,
      chunk_hashes: chunks.map(({ sha256 }) => sha256),
      wasm_module_hash: sha256Bytes(request.wasm),
    },
  };
}

async function dispatchInstallCode(
  actor: KernelPackageInstaller,
  dispatch: InstallCodeDispatch,
): Promise<void> {
  if (dispatch.kind === "inline") {
    await actor.kernel_install_code(dispatch.request);
    return;
  }

  const deployment = {
    deployment_id: dispatch.request.deployment_id,
  };
  try {
    await actor.kernel_install_wasm_chunks_clear(deployment);
    for (const chunk of dispatch.chunks) {
      await actor.kernel_install_wasm_chunk({
        deployment_id: dispatch.request.deployment_id,
        chunk: chunk.content,
        sha256: chunk.sha256,
      });
    }
  } catch (error) {
    throw new InstallCodePreparationError(
      "Chunked Wasm upload failed before activation was dispatched",
      error,
    );
  }
  await actor.kernel_install_code_chunked(dispatch.request);
}

async function clearInstallWasmChunks(
  actor: KernelPackageInstaller,
  deploymentId: string,
): Promise<void> {
  await actor.kernel_install_wasm_chunks_clear({
    deployment_id: deploymentId,
  });
}

export function prepareInstallCodeRequest({
  wasm,
  candid,
  deploymentId,
}: {
  wasm: Uint8Array;
  candid: string;
  deploymentId: string;
}): KernelInstallCodeRequest {
  const request = compressedInstallCodeRequest({
    wasm,
    candid,
    deploymentId,
  });
  if (!installCodeRequestFitsIngress(request)) {
    throw installCodeIngressError(request);
  }
  return request;
}

function compressedInstallCodeRequest({
  wasm,
  candid,
  deploymentId,
}: {
  wasm: Uint8Array;
  candid: string;
  deploymentId: string;
}): KernelInstallCodeRequest {
  return {
    wasm: gzipSync(wasm, { mtime: 0 }),
    candid,
    deployment_id: deploymentId,
  };
}

function installCodeRequestFitsIngress(
  request: KernelInstallCodeRequest,
): boolean {
  return (
    installCodeEstimatedIngressBytes(request) <=
    IC_INGRESS_MESSAGE_LIMIT_BYTES
  );
}

function installCodeEstimatedIngressBytes(
  request: KernelInstallCodeRequest,
): number {
  const textEncoder = new TextEncoder();
  const serializedArgumentBytes =
    request.wasm.byteLength +
    textEncoder.encode(request.candid).byteLength +
    textEncoder.encode(request.deployment_id).byteLength +
    INSTALL_CODE_CANDID_OVERHEAD_BYTES;
  return serializedArgumentBytes + INSTALL_CODE_INGRESS_RESERVE_BYTES;
}

function installCodeIngressError(request: KernelInstallCodeRequest): Error {
  const estimatedIngressBytes = installCodeEstimatedIngressBytes(request);
  return new Error(
    `Compressed Wasm install request is too large for the 2 MiB IC ingress limit ` +
      `(compressed Wasm ${formatByteCount(request.wasm.byteLength)}, ` +
      `estimated serialized ingress ${formatByteCount(estimatedIngressBytes)}). ` +
      `This Kernel does not expose chunked Wasm installation.`,
  );
}

function sha256Bytes(content: Uint8Array): Uint8Array {
  const hex = hashContent(content);
  const result = new Uint8Array(32);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number.parseInt(
      hex.slice(index * 2, index * 2 + 2),
      16,
    );
  }
  return result;
}

function formatByteCount(value: number): string {
  return `${value.toLocaleString("en-US")} bytes`;
}

type StagedAsset = StagedAssetInput & {
  source: string;
};

function createStagedAssets(
  deploymentId: string,
  inputs: StagedAssetInput[],
): StagedAsset[] {
  const byTarget = new Map<string, StagedAssetInput>();
  for (const input of inputs) {
    assertSafeStagedAsset(input);
    if (byTarget.has(input.target)) {
      throw new Error(`Duplicate mutable install target ${input.target}`);
    }
    byTarget.set(input.target, input);
  }
  return [...byTarget.values()]
    .sort((a, b) => compareCanonicalText(a.target, b.target))
    .map((input, index) => ({
      ...input,
      source: `/system/staging/${deploymentId}/assets/${index}`,
    }));
}

function assertSafeStagedAsset(input: StagedAssetInput): void {
  if (!(input.content instanceof Uint8Array)) {
    throw new Error(`Invalid staged asset content for ${input.target}`);
  }
  assertSafeAbsoluteInstallTarget(input.target);
  if (
    input.target === "/mo" ||
    input.target.startsWith("/mo/") ||
    input.target === "/system/staging" ||
    input.target.startsWith("/system/staging/")
  ) {
    throw new Error(`Reserved staged asset target ${input.target}`);
  }
  if (
    input.contentType !== undefined &&
    (input.contentType.length === 0 ||
      input.contentType.length > 256 ||
      /[\u0000-\u001f\u007f-\u009f]/u.test(input.contentType))
  ) {
    throw new Error(`Invalid staged asset content type for ${input.target}`);
  }
}

function assertSafeAbsoluteInstallTarget(target: string): void {
  if (target === "/") return;
  if (typeof target !== "string" || !target.startsWith("/")) {
    throw new Error(`Invalid staged asset target ${String(target)}`);
  }
  assertSafeArchivePath(target.slice(1));
}

function assertExpectedDeploymentId(value: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    throw new Error("Invalid expected deployment id");
  }
}

async function cleanupUnjournaledStaging(
  actor: KernelPackageInstaller,
  deploymentId: string,
): Promise<void> {
  try {
    const status = normalizeInstallJournalStatus(
      await actor.kernel_install_status(null),
    );
    if (status?.deployment_id === deploymentId) return;
  } catch (error) {
    // If status is unavailable for an unexpected reason, the begin call may
    // have succeeded despite its failed response. Keep the staging data so
    // recovery can finish that journal safely.
    return;
  }

  try {
    await actor.kernel_static({
      clear: { prefix: `/system/staging/${deploymentId}/` },
    });
  } catch (error) {
    console.warn(`Failed to clear staging for ${deploymentId}`, error);
  }
}

function staticKey(path: string): string {
  if (path.startsWith("/")) return path;
  return `/${path === "index.html" ? "" : path}`;
}

async function waitForRuntime(
  actor: KernelPackageInstaller,
  deploymentId: string,
  timeoutMs: number,
  dispatchFailure?: InstallDispatchFailure,
): Promise<KernelRuntimeInfo> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const runtime = await actor.kernel_runtime_info();
      if (runtime.deployment_id === deploymentId) return runtime;
    } catch (error) {
      lastError = error;
    }
    await delay(Math.min(250, Math.max(1, deadline - Date.now())));
  }
  const dispatchDetail = dispatchFailure
    ? `; install dispatch failed: ${errorMessage(dispatchFailure.error)}`
    : "";
  const cause = runtimeVerificationCause(dispatchFailure, lastError);
  const message = `Timed out waiting for deployment ${deploymentId}${dispatchDetail}`;
  if (cause === undefined) throw new Error(message);
  throw new Error(message, { cause });
}

function runtimeVerificationCause(
  dispatchFailure: InstallDispatchFailure | undefined,
  runtimeError: unknown,
): unknown {
  if (!dispatchFailure) return runtimeError;
  if (runtimeError === undefined) return dispatchFailure.error;
  return new AggregateError(
    [dispatchFailure.error, runtimeError],
    "Install dispatch and runtime verification both failed",
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readRuntimeInfo(
  actor: KernelPackageInstaller,
): Promise<KernelRuntimeInfo | null> {
  try {
    return await actor.kernel_runtime_info();
  } catch {
    return null;
  }
}

export type InstallRecoveryResult =
  | { status: "none" }
  | { status: "committed"; deploymentId: string }
  | { status: "pending"; deploymentId: string };

export async function recoverPendingInstall(
  actor: KernelPackageInstaller,
  { timeoutMs = 60_000 }: { timeoutMs?: number } = {},
): Promise<InstallRecoveryResult> {
  const status = normalizeInstallJournalStatus(
    await actor.kernel_install_status(null),
  );
  if (!status) return { status: "none" };
  parseAppInstanceInventory(
    status.committed_app_instances,
    null,
    "committed",
  );
  const targetAppInstances = parseAppInstanceInventory(
    status.target_app_instances,
    status.deployment_id,
    "target",
  );
  try {
    const runtime = await waitForRuntime(
      actor,
      status.deployment_id,
      timeoutMs,
    );
    if (runtime.assembler_id !== ASSEMBLER_ID) {
      return { status: "pending", deploymentId: status.deployment_id };
    }
    const runtimeAppInstances = parseAppInstanceInventory(
      runtime.apps,
      runtime.deployment_id,
      "runtime",
    );
    if (!sameAppInstanceInventory(runtimeAppInstances, targetAppInstances)) {
      return { status: "pending", deploymentId: status.deployment_id };
    }
    await actor.kernel_install_wasm_chunks_clear({
      deployment_id: status.deployment_id,
    });
    await commitPreparedDeployment(actor, status.deployment_id);
    return { status: "committed", deploymentId: status.deployment_id };
  } catch {
    const runtime = await readRuntimeInfo(actor);
    if (!runtime || runtime.deployment_id === status.deployment_id) {
      return { status: "pending", deploymentId: status.deployment_id };
    }
  }
  // A different running deployment does not prove that this journal is stale:
  // another tab may have recorded it and still be waiting for the one-way
  // self-upgrade to become observable. Recovery has no lease or owner marker,
  // so timing out must remain non-destructive. The initiating deployment path
  // can still abort its own journal after it has established failure.
  return { status: "pending", deploymentId: status.deployment_id };
}

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function notifyDeployStep(
  onStep: ((step: DeployPackageStep) => void) | undefined,
  step: DeployPackageStep,
): void {
  try {
    onStep?.(step);
  } catch (error) {
    console.warn(`Package deploy step observer failed for ${step}`, error);
  }
}

function notifyUploadProgress(
  onProgress: (progress: UploadProgress) => void,
  progress: UploadProgress,
): void {
  try {
    onProgress(progress);
  } catch (error) {
    console.warn("Package deploy progress observer failed", error);
  }
}

export function createJsonAsset(
  key: string,
  value: unknown,
  contentType = "application/json",
): StaticFileOperation {
  return createStaticFileOperation(
    key,
    new TextEncoder().encode(JSON.stringify(value)),
    contentType,
    "identity",
  );
}

export function createTextAsset(
  key: string,
  value: string,
  contentType = "text/plain",
): StaticFileOperation {
  return createStaticFileOperation(
    key,
    new TextEncoder().encode(value),
    contentType,
    "identity",
  );
}

export function createStaticFileOperation(
  keyOrPath: string,
  content: Uint8Array,
  contentType = mime(keyOrPath),
  contentEncoding: "gzip" | "identity" = shouldGzip(contentType)
    ? "gzip"
    : "identity",
  chunkSize = DEFAULT_CHUNK_SIZE,
): StaticFileOperation {
  const key = keyOrPath.startsWith("/")
    ? keyOrPath
    : `/${keyOrPath === "index.html" ? "" : keyOrPath}`;
  const processedContent =
    contentEncoding === "gzip" ? gzipSync(content, { mtime: 0 }) : content;
  const chunks = chunkBytes(processedContent, chunkSize);
  const first = chunks[0];
  if (!first) throw new Error("Failed to chunk static file");

  return {
    key,
    val: {
      content: first,
      content_type: contentType,
      content_encoding: contentEncoding,
      chunks: chunks.length,
    },
    chunks: chunks.slice(1).map((chunk, index) => ({
      chunk_id: index + 1,
      content: chunk,
    })),
  };
}

export async function uploadPreparedFiles(
  neutron: KernelStaticWriter,
  files: PreparedPackageFile[],
  options: UploadPreparedFilesOptions = {},
): Promise<void> {
  const concurrency = options.concurrency ?? 10;
  await mapWithConcurrency(files, concurrency, async (file) => {
    const normalizedPath = file.path.startsWith("/")
      ? file.path.slice(1)
      : file.path;
    const contentEncoding = HASHED_MOTOKO_PACKAGE_PATH.test(normalizedPath)
      ? "identity"
      : undefined;
    const operation = createStaticFileOperation(
      file.path,
      file.content,
      mime(file.path),
      contentEncoding,
      options.chunkSize,
    );
    await uploadStaticFileOperation(neutron, operation);
    options.onProgress?.({
      type: "file",
      path: file.path,
      key: operation.key,
      chunks: operation.val.chunks,
    });

    for (const chunk of operation.chunks) {
      options.onProgress?.({
        type: "chunk",
        path: file.path,
        key: operation.key,
        chunk_id: chunk.chunk_id,
      });
    }
  });
}

export async function uploadStaticFileOperation(
  neutron: KernelStaticWriter,
  operation: StaticFileOperation,
): Promise<void> {
  await neutron.kernel_static({
    store: {
      key: operation.key,
      val: operation.val,
    },
  });

  for (const chunk of operation.chunks) {
    await neutron.kernel_static({
      store_chunk: {
        key: operation.key,
        content: chunk.content,
        chunk_id: chunk.chunk_id,
      },
    });
  }
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("Concurrency must be a positive integer");
  }

  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      const item = items[index];
      if (item === undefined) throw new Error(`Missing item at index ${index}`);
      results[index] = await mapper(item, index);
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export function chunkBytes(
  content: Uint8Array,
  chunkSize = DEFAULT_CHUNK_SIZE,
): Uint8Array[] {
  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    throw new Error("Chunk size must be a positive integer");
  }

  const chunks = Math.max(1, Math.ceil(content.length / chunkSize));
  const result: Uint8Array[] = [];
  for (let i = 0; i < chunks; i++) {
    result.push(content.slice(i * chunkSize, (i + 1) * chunkSize));
  }
  return result;
}

export function mime(filename: string): string {
  const extension = filename.split(".").pop()?.toLowerCase() ?? "";
  const types: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    bmp: "image/bmp",
    webp: "image/webp",
    ico: "image/x-icon",
    svg: "image/svg+xml",
    html: "text/html",
    css: "text/css",
    js: "application/javascript",
    json: "application/json",
    wasm: "application/wasm",
    xml: "application/xml",
    txt: "text/plain",
    md: "text/markdown",
    mp4: "video/mp4",
    webm: "video/webm",
    ogg: "video/ogg",
    mp3: "audio/mpeg",
    wav: "audio/wav",
  };

  return types[extension] ?? "application/octet-stream";
}

function shouldGzip(contentType: string): boolean {
  return !contentType.startsWith("image/");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
