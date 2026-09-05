import { gzipSync } from "fflate";
import { isValidAppId } from "neutron-tools/src/app_ids.js";
import { compareCanonicalText } from "neutron-tools/src/canonical.js";
import { hashContent } from "neutron-tools/src/hash.js";
import { isValidTileId } from "neutron-tools/src/tile_ids.js";
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
  NEUTRON_PACKAGE_ARCHIVE_ONLY_FEATURE,
  normalizeManifestBackground,
  normalizeManifestDependencies,
  normalizeManifestDisplayMetadata,
  normalizeManifestPackageFeatures,
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
  NEUTRON_APP_SOURCE_SNAPSHOT_PATH,
  NEUTRON_PACKAGE_RECORD_PATH,
  isNeutronPackageArchiveOnlyPath,
  neutronPackageRecordArchiveOnlyPaths,
  readNeutronPackageRecord,
  type NeutronPackageRecordV1,
} from "neutron-tools/src/package_record.js";
import {
  NEUTRON_BROWSER_SURFACE_ORIGINS_MARKER_PATH,
  parseBrowserSurfaceOriginsPackageMarker,
} from "neutron-tools/src/package_surface_origins.js";
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
  type NeutronPersistenceMode,
} from "./compile.ts";
import {
  ASSEMBLER_ID,
  assemblerForFreshKernelVersion,
  assertAssemblerSupportsBrowserPermissions,
  BROWSER_SURFACE_ORIGIN_ASSEMBLER_ID,
  LEGACY_V25_ASSEMBLER_ID,
  NEUTRON_INSTALLED_APP_LIMIT,
  normalizeBrowserSurfaceOriginAppIds,
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
  isCanonicalAbsoluteInstallTarget,
  type NeutronPackageDecodeLimits,
  type NeutronPackageDecodeOptions,
} from "./package_decoder.ts";
import {
  assertNeutronAppSourceBuildInputs,
  decodeNeutronAppSourceSnapshot,
} from "./source_snapshot.ts";
import {
  assertResidentFrameSecurity,
  residentFrameSecurity,
  type ResidentFrameSecurity,
} from "./resident_frame_security.ts";
import {
  DEPLOYMENT_BUILD_RECORD_PATH,
  assertWasmRecord,
  createCompleteDeploymentBuildRecord,
  parseDeploymentBuildRecord,
  prepareDeterministicWasmTransport,
  serializeDeploymentBuildRecord,
  snapshotWasmForDeployment,
  type CompleteDeploymentBuildRecord,
  type DeploymentBuildRecord,
  type DeploymentPackageArchiveRecord,
  type PackageInformationRecordIdentity,
  type PreparedCompleteDeploymentBuild,
} from "./deployment_record.ts";

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
// One unit is one browser-facing file projected onto one ordinary surface.
// Each unit expands to at most ten Host+destination response owners. Keeping
// this actor-wide install input bounded prevents a valid package shape from
// exhausting the certified forest during its atomic copy transaction.
export const KERNEL_BROWSER_SURFACE_CERTIFICATION_UNITS_MAX = 1_024;
const KERNEL_INSTALL_STAGED_WRITE_CONCURRENCY = 10;
/** Must match backend/install/Limits.mo's atomic asset-clear ceiling. */
export const KERNEL_INSTALL_MAX_CLEAR_PREFIXES_PER_COMMIT = 128;
/** Must match backend/install/Limits.mo's measured atomic removal ceiling. */
export const KERNEL_INSTALL_MAX_APP_REMOVALS_PER_COMMIT = 64;
const IC_INGRESS_MESSAGE_LIMIT_BYTES = 2 * 1024 * 1024;
const INSTALL_CODE_INGRESS_RESERVE_BYTES = 96 * 1024;
const INSTALL_CODE_CANDID_OVERHEAD_BYTES = 512;
const INSTALL_WASM_CHUNK_BYTES = 1024 * 1024;
const INSTALL_WASM_MAX_CHUNKS = 100;
/** First Kernel release whose backend admits the reserved legal clear prefix. */
const KERNEL_LEGAL_CLEAR_BASELINE_VERSION = 307;
/** Large whole-actor upgrades can spend several minutes compiling on the IC. */
export const DEFAULT_DEPLOYMENT_ACTIVATION_TIMEOUT_MS = 10 * 60_000;
const REMOVED_PACKAGE_BUILD_METADATA_PATH = ".neutron-build.json";
export const KERNEL_CONNECTION_PROVIDER_SUPPORT_PATH =
  "/pkg/connection-providers.json";
export const BROWSER_SURFACE_ORIGINS_PATH =
  "/system/browser-surface-origins.json";
export const KERNEL_CONNECTION_PROVIDER_SUPPORT_ARCHIVE_PATH =
  "connection-providers.json";

export type UnpackedNeutronPackage = Record<string, Uint8Array>;

export type PreparedPackageFile = {
  path: string;
  content: Uint8Array;
};

export type PackageArchiveIdentity = Readonly<{
  /** SHA-256 of the exact outer `.neutron` bytes. */
  sha256: string;
  /** Exact outer `.neutron` byte length. */
  size: number;
}>;

export type PreparedPackageInstall = {
  manifest: PackagedNeutronManifest;
  /**
   * Package generation proved this ordinary app is safe on v26 origins.
   * Always present on authenticated preparation results; optional only to
   * keep review-only structural consumers source-compatible.
   */
  browserSurfaceOriginsReady?: boolean;
  /** Present only when the archive supplied a verified v1 legal record. */
  packageRecord?: NeutronPackageRecordV1;
  /**
   * Exact user-supplied archive retained for review/export. This is the
   * caller's Uint8Array, not a second copy; consumers must not mutate it.
   */
  archiveBytes?: Uint8Array;
  /** Present together with archiveBytes and rechecked at batch boundaries. */
  archiveIdentity?: PackageArchiveIdentity;
  capabilityPlan: CapabilityPlanWireV1;
  capabilityPlanFingerprint: string;
  files: PreparedPackageFile[];
  appPrefix: string;
  isKernel: boolean;
  connectionProviderSupport?: ConnectionProviderSupportCatalog;
};

type PreparedPackageArchiveSeal = Readonly<{
  archiveSha256: string;
  archiveSize: number;
  preparedStateSha256: string;
}>;

// A raw archive's decoded install state must remain bound to the bytes the
// user reviewed. Keeping the seal out-of-band prevents a mutable/spread copy
// from rewriting both the prepared fields and its claimed fingerprint.
const preparedPackageArchiveSeals = new WeakMap<
  PreparedPackageInstall,
  PreparedPackageArchiveSeal
>();

type PreparedDeploymentBuildRecordSeal = Readonly<{
  recordBytes: Uint8Array;
  candid: string;
  stable: string;
  browserSurfaceOriginAppIds: readonly string[];
}>;

// Retained-package identities and compiler companion artifacts cannot be
// independently re-derived at dispatch: they come from the checked deployment
// preparation. Keep their exact review identities out-of-band so only the
// preparation result can authorize an install, and recheck them before I/O.
const preparedDeploymentBuildRecordSeals = new WeakMap<
  CompleteDeploymentBuildRecord,
  PreparedDeploymentBuildRecordSeal
>();

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
  wasm_memory_persistence: CandidWasmMemoryPersistence;
};

export type CandidWasmMemoryPersistence =
  | { keep: null }
  | { replace: null };

export function wasmMemoryPersistenceForMode(
  mode: NeutronPersistenceMode,
): "keep" | "replace" {
  return mode === "enhanced" ? "keep" : "replace";
}

function candidWasmMemoryPersistence(
  mode: NeutronPersistenceMode,
): CandidWasmMemoryPersistence {
  return mode === "enhanced" ? { keep: null } : { replace: null };
}

export type KernelInstallWasmChunkRequest = {
  deployment_id: string;
  chunk: Uint8Array;
  sha256: Uint8Array;
};

export type KernelInstallCodeChunkedRequest = {
  deployment_id: string;
  chunk_hashes: Uint8Array[];
  wasm_module_hash: Uint8Array;
  wasm_memory_persistence: CandidWasmMemoryPersistence;
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
  capability_authority_revision?: [] | [bigint | number];
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
  existingApps: AppRegistry;
  /** Checked sidecar IDs whose retained adoption authority is preserved. */
  existingBrowserSurfaceOriginAppIds: readonly string[];
  existingStable?: string | null;
  connectionProviderSupport?: ConnectionProviderSupportCatalog;
  preparedPackage: PreparedPackageInstall;
  deploymentNonce?: string;
  vetKeysEnvironment?: VetKeysEnvironment;
  persistenceMode?: NeutronPersistenceMode;
  versionPolicy?: AppVersionTransitionPolicy;
};

export type AppVersionTransitionPolicy =
  | "strict-upgrade"
  | "allow-same-version";

export type PackageInstallAssets = {
  apps: AppRegistry;
  browserSurfaceOriginAppIds: string[];
  appRegistryAsset: StaticFileOperation;
  browserSurfaceOriginsAsset: StaticFileOperation;
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
  existingBrowserSurfaceOriginAppIds: readonly string[];
  /** Module paths observed in the checked pre-deployment baseline. */
  previousModulePaths?: readonly string[];
  removedApps?: string[];
  /** Additional mutable assets committed atomically with registry metadata. */
  stagedAssets?: InstallStagedAsset[];
  /**
   * Exact complete record approved before dispatch. When present it is
   * revalidated, staged, and committed atomically with this deployment.
   */
  deploymentBuildRecord?: CompleteDeploymentBuildRecord;
  /** Exact running deployment checked atomically when the journal is recorded. */
  expectedDeploymentId: string;
  /** Maximum wait for the IC to compile and activate the dispatched actor. */
  verifyTimeoutMs?: number;
  onStep?: (step: DeployPackageStep) => void;
  onProgress?: (progress: UploadProgress) => void;
};

export type CompileAndDeployPackagesInput = Omit<
  DeployPreparedPackagesInput,
  | "compiled"
  | "existingApps"
  | "existingBrowserSurfaceOriginAppIds"
  | "removedApps"
  | "deploymentBuildRecord"
> & {
  state: KernelPackageState;
  vetKeysEnvironment?: VetKeysEnvironment;
  versionPolicy?: AppVersionTransitionPolicy;
};

export type DeployPreparedPackagesResult = {
  apps: AppRegistry;
  compiled: CompileResult;
};

export type RetainedDeploymentPackageEvidence = Readonly<{
  version: number;
  archive: DeploymentPackageArchiveRecord;
  package_information: PackageInformationRecordIdentity;
}>;

export type PrepareCompleteDeploymentBuildRecordInput = Readonly<{
  targetCanisterId: string;
  packages: readonly PreparedPackageInstall[];
  state: KernelPackageState;
  compiled: CompileResult;
  expectedDeploymentId: string;
  removedApps?: readonly string[];
  /** Verified identities carried from the installed deployment record. */
  retainedPackageEvidence?: Readonly<
    Record<string, RetainedDeploymentPackageEvidence>
  >;
}>;

export type CompilePackagesInput = {
  packages: PreparedPackageInstall[];
  existingModules?: MotokoFile[];
  existingConfigs?: CompileConfig;
  existingApps: AppRegistry;
  /** Checked sidecar IDs whose retained adoption authority is preserved. */
  existingBrowserSurfaceOriginAppIds: readonly string[];
  existingStable?: string | null;
  connectionProviderSupport?: ConnectionProviderSupportCatalog;
  deploymentNonce?: string;
  vetKeysEnvironment?: VetKeysEnvironment;
  persistenceMode?: NeutronPersistenceMode;
  /** Provisioner-only input for a fresh local whole-canister installation. */
  freshInstallationContext?: TrustedInstallationContextV1;
  /** Offline qualification-only binding to the exact assembled actor source. */
  includeGeneratedSource?: boolean;
  versionPolicy?: AppVersionTransitionPolicy;
};

export type FreshCompilePackagesInput = {
  packages: PreparedPackageInstall[];
  deploymentNonce?: string;
  vetKeysEnvironment?: VetKeysEnvironment;
  persistenceMode?: NeutronPersistenceMode;
  freshInstallationContext?: TrustedInstallationContextV1;
  includeGeneratedSource?: boolean;
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
  /** Strict canonical contents of the v26 browser-origin authority sidecar. */
  browserSurfaceOriginAppIds: string[];
  /** Whether the v26 authority sidecar exists, distinct from an empty list. */
  browserSurfaceOriginsSidecarPresent: boolean;
  existingConfigs: CompileConfig;
  existingModules: MotokoFile[];
  previousStable: string | null;
  connectionProviderSupport: ConnectionProviderSupportCatalog;
};

export type KernelPackageStateReader = {
  listStatic(prefix: string): Promise<string[]>;
  fetchText(path: string): Promise<string>;
  fetchJson<T>(path: string, fallback: T): Promise<T>;
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
  const archiveBytes = pkg instanceof Uint8Array ? pkg : undefined;
  let archiveIdentity: PackageArchiveIdentity | undefined;
  if (options.expectedIdentity) {
    assertPackageIdentityExpectation(options.expectedIdentity);
    if (archiveBytes === undefined && (
      options.expectedIdentity.sha256 !== undefined ||
      options.expectedIdentity.size !== undefined
    )) {
      throw new Error(
        "Outer package digest and size reconciliation require raw .neutron bytes",
      );
    }
  }
  if (archiveBytes !== undefined) {
    assertOuterPackageRawLimit(archiveBytes, options.limits);
    archiveIdentity = Object.freeze({
      sha256: hashContent(archiveBytes),
      size: archiveBytes.byteLength,
    });
    if (options.expectedIdentity) {
      assertOuterPackageIdentity(archiveIdentity, options.expectedIdentity);
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
  const isKernel = manifest.id === "kernel";
  const hasBrowserSurfaceOriginsMarker =
    parseBrowserSurfaceOriginsPackageMarker(
      Object.hasOwn(unpacked, NEUTRON_BROWSER_SURFACE_ORIGINS_MARKER_PATH)
        ? unpacked[NEUTRON_BROWSER_SURFACE_ORIGINS_MARKER_PATH]
        : undefined,
    );
  if (isKernel && hasBrowserSurfaceOriginsMarker) {
    throw new Error(
      `${NEUTRON_BROWSER_SURFACE_ORIGINS_MARKER_PATH} is reserved for ordinary app packages`,
    );
  }
  const browserSurfaceOriginsReady =
    !isKernel &&
    (hasBrowserSurfaceOriginsMarker ||
      manifest.capabilities?.browser_permissions !== undefined);
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
  const packageRecord = readNeutronPackageRecord({
    files: unpacked,
    manifest,
  });
  const archiveOnlyPaths = Object.keys(unpacked).filter(
    isNeutronPackageArchiveOnlyPath,
  );
  const manifestFeatures = normalizeManifestPackageFeatures(manifest);
  const manifestDeclaresArchiveOnly = manifestFeatures.includes(
    NEUTRON_PACKAGE_ARCHIVE_ONLY_FEATURE,
  );
  const recordDeclaresArchiveOnly =
    packageRecord?.features?.includes(
      NEUTRON_PACKAGE_ARCHIVE_ONLY_FEATURE,
    ) ?? false;
  if (archiveOnlyPaths.length > 0) {
    if (!manifestDeclaresArchiveOnly || !recordDeclaresArchiveOnly) {
      throw new Error(
        `Archive-only package material requires package_features and package-record features to include ${NEUTRON_PACKAGE_ARCHIVE_ONLY_FEATURE}`,
      );
    }
  } else if (manifestDeclaresArchiveOnly || recordDeclaresArchiveOnly) {
    throw new Error(
      `Package feature ${NEUTRON_PACKAGE_ARCHIVE_ONLY_FEATURE} requires archive-only package material`,
    );
  }
  const hasArchiveOnlySourceSnapshot = Object.hasOwn(
    unpacked,
    NEUTRON_APP_SOURCE_SNAPSHOT_PATH,
  );
  if (
    hasArchiveOnlySourceSnapshot &&
    (packageRecord?.source.kind !== "embedded" ||
      packageRecord.source.path !== NEUTRON_APP_SOURCE_SNAPSHOT_PATH)
  ) {
    throw new Error(
      `Package path ${NEUTRON_APP_SOURCE_SNAPSHOT_PATH} is reserved for the embedded source referenced by ${NEUTRON_PACKAGE_RECORD_PATH}`,
    );
  }
  const declaredArchiveOnlyPaths = new Set(
    packageRecord === undefined
      ? []
      : neutronPackageRecordArchiveOnlyPaths(packageRecord),
  );
  for (const packagePath of Object.keys(unpacked)) {
    if (
      isNeutronPackageArchiveOnlyPath(packagePath) &&
      !declaredArchiveOnlyPaths.has(packagePath)
    ) {
      throw new Error(
        `Package path ${packagePath} is reserved for archive-only material referenced by ${NEUTRON_PACKAGE_RECORD_PATH}`,
      );
    }
  }
  if (packageRecord?.source.kind === "embedded") {
    try {
      const snapshot = decodeNeutronAppSourceSnapshot(
        unpacked[packageRecord.source.path]!,
        { id: manifest.id, version: manifest.version },
      );
      assertNeutronAppSourceBuildInputs(snapshot, packageRecord.build.inputs);
    } catch (error) {
      throw new Error(
        `Invalid Complete App Source snapshot: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
  const connectionProviderSupport = isKernel
    ? readKernelConnectionProviderSupport(unpacked)
    : undefined;
  const appPrefix = isKernel ? "" : `app/${manifest.id}/`;
  const installableFiles = Object.fromEntries(
    Object.entries(unpacked).filter(
      ([packagePath]) => !isNeutronPackageArchiveOnlyPath(packagePath),
    ),
  );
  const files = preparePackageFiles(installableFiles, {
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
  if (
    isKernel &&
    files.some(({ path }) => path === DEPLOYMENT_BUILD_RECORD_PATH.slice(1))
  ) {
    throw new Error(
      `${DEPLOYMENT_BUILD_RECORD_PATH} is reserved for the deployment transaction`,
    );
  }
  assertManifestWebEntrypoints(unpacked, manifest);
  const capabilityPlan = toCapabilityPlanWireV1(buildCapabilityPlan(manifest));
  const prepared: PreparedPackageInstall = {
    manifest,
    browserSurfaceOriginsReady,
    capabilityPlan,
    capabilityPlanFingerprint: fingerprintCapabilityPlanWireV1(capabilityPlan),
    files,
    appPrefix,
    isKernel,
    ...(archiveBytes && archiveIdentity
      ? { archiveBytes, archiveIdentity }
      : {}),
    ...(packageRecord ? { packageRecord } : {}),
    ...(connectionProviderSupport ? { connectionProviderSupport } : {}),
  };
  sealPreparedPackageArchiveState(prepared);
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
  actual: PackageArchiveIdentity,
  expected: PackageIdentityExpectation,
): void {
  if (expected.size !== undefined && actual.size !== expected.size) {
    throw new Error(
      `Package size ${actual.size} does not match expected ${expected.size}`,
    );
  }
  if (
    expected.sha256 !== undefined &&
    actual.sha256 !== expected.sha256
  ) {
    throw new Error(
      `Package SHA-256 ${actual.sha256} does not match expected ${expected.sha256}`,
    );
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
        packagePath.startsWith("web/_route/") ||
        packagePath === "web/pkg" ||
        packagePath.startsWith("web/pkg/"))
    ) {
      throw new Error(
        `Package path ${packagePath} is reserved for Kernel-owned app metadata`,
      );
    }
    if (
      appPrefix === "" &&
      (packagePath === "web/app" || packagePath.startsWith("web/app/"))
    ) {
      throw new Error(
        `Kernel package path ${packagePath} cannot write an app asset subtree`,
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

function preparedPackageBrowserSurfaceOriginsReady(
  preparedPackage: PreparedPackageInstall,
): boolean {
  const marker = preparedPackage.files.find(
    ({ path }) =>
      path ===
      `${preparedPackage.appPrefix}pkg/${NEUTRON_BROWSER_SURFACE_ORIGINS_MARKER_PATH}`,
  );
  const hasMarker = parseBrowserSurfaceOriginsPackageMarker(marker?.content);
  if (preparedPackage.isKernel && hasMarker) {
    throw new Error(
      `${NEUTRON_BROWSER_SURFACE_ORIGINS_MARKER_PATH} is reserved for ordinary app packages`,
    );
  }
  return (
    !preparedPackage.isKernel &&
    (hasMarker ||
      preparedPackage.manifest.capabilities?.browser_permissions !== undefined)
  );
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
    assertPreparedPackageArchiveIdentity(preparedPackage);
    const appId = preparedPackage.manifest.id;
    const isKernel = appId === "kernel";
    const expectedAppPrefix = isKernel ? "" : `app/${appId}/`;
    if (preparedPackage.isKernel !== isKernel) {
      throw new Error(`Prepared package ${appId} has inconsistent Kernel identity`);
    }
    if (preparedPackage.appPrefix !== expectedAppPrefix) {
      throw new Error(
        `Prepared package ${appId} has invalid app prefix ${preparedPackage.appPrefix}`,
      );
    }
    const expectedCapabilityPlan = toCapabilityPlanWireV1(
      buildCapabilityPlan(preparedPackage.manifest),
    );
    if (
      !sameJsonValue(preparedPackage.capabilityPlan, expectedCapabilityPlan) ||
      preparedPackage.capabilityPlanFingerprint !==
        fingerprintCapabilityPlanWireV1(expectedCapabilityPlan)
    ) {
      throw new Error(
        `Prepared package ${appId} capability plan does not match its manifest`,
      );
    }
    const expectedBrowserSurfaceOriginsReady =
      preparedPackageBrowserSurfaceOriginsReady(preparedPackage);
    if (
      preparedPackage.browserSurfaceOriginsReady !==
      expectedBrowserSurfaceOriginsReady
    ) {
      throw new Error(
        `Prepared package ${appId} browser-surface origin readiness does not match its package metadata`,
      );
    }
    if (appIds.has(appId)) {
      throw new Error(`Duplicate prepared app id ${appId}`);
    }
    appIds.add(appId);

    for (const file of preparedPackage.files) {
      assertSafePreparedFilePath(file.path);
      if (
        appId === "kernel" &&
        (file.path === "app" || file.path.startsWith("app/"))
      ) {
        throw new Error(
          `Prepared Kernel package path ${file.path} cannot write an app asset subtree`,
        );
      }
      if (appId !== "kernel" && isSharedAppRouteStaticTarget(file.path)) {
        throw new Error(
          `Prepared package path ${file.path} is reserved for shared app routes`,
        );
      }
      if (file.path.startsWith("mo/")) {
        const match = HASHED_MOTOKO_PACKAGE_PATH.exec(file.path);
        if (!match) {
          throw new Error(`Invalid prepared Motoko module path ${file.path}`);
        }
        const actualSha256 = hashContent(file.content);
        if (actualSha256 !== match[1]) {
          throw new Error(
            `Prepared Motoko module ${file.path} content SHA-256 is ${actualSha256}`,
          );
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
      if (appId !== "kernel" && !file.path.startsWith(expectedAppPrefix)) {
        throw new Error(
          `Prepared package ${appId} path ${file.path} is outside ${expectedAppPrefix}`,
        );
      }

      const target = staticKey(file.path);
      if (
        appId === "kernel" &&
        (target === "/system/apps.json" ||
          target === BROWSER_SURFACE_ORIGINS_PATH)
      ) {
        throw new Error(`Reserved package asset target ${target}`);
      }
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

/**
 * Apply the certification fanout ceiling only once the target assembler and
 * exact v26 adoption set are known. Pre-v26 actors create no installation
 * surface response variants, so applying this during archive preparation
 * would reject packages that remain valid on the released v25 path.
 */
export function assertPreparedPackageBrowserSurfaceFanout(
  packages: PreparedPackageInstall[],
  assemblerId: typeof ASSEMBLER_ID | typeof LEGACY_V25_ASSEMBLER_ID,
  browserSurfaceOriginAppIds: readonly string[],
): void {
  assertPreparedPackageBatch(packages);
  if (assemblerId === LEGACY_V25_ASSEMBLER_ID) return;
  if (assemblerId !== BROWSER_SURFACE_ORIGIN_ASSEMBLER_ID) {
    throw new Error(`Unsupported assembler ${assemblerId}`);
  }

  const adopted = new Set(browserSurfaceOriginAppIds);
  let units = 0;
  for (const preparedPackage of packages) {
    const appId = preparedPackage.manifest.id;
    if (appId === "kernel" || !adopted.has(appId)) continue;
    const ordinarySurfaces =
      (preparedPackage.manifest.tiles?.length ?? 0) +
      (preparedPackage.manifest.tray ? 1 : 0) +
      (preparedPackage.manifest.background &&
      residentFrameSecurity(preparedPackage.capabilityPlan) ===
        "credentialless_opaque_v1"
        ? 1
        : 0);
    const packagePrefix = `${preparedPackage.appPrefix}pkg/`;
    const browserAssets = preparedPackage.files.filter(
      ({ path }) =>
        path.startsWith(preparedPackage.appPrefix) &&
        !path.startsWith(packagePrefix),
    ).length;
    units += ordinarySurfaces * browserAssets;
    if (units > KERNEL_BROWSER_SURFACE_CERTIFICATION_UNITS_MAX) {
      throw new Error(
        `Selected packages require ${units} browser-surface certification units; ` +
          `kernel limit is ${KERNEL_BROWSER_SURFACE_CERTIFICATION_UNITS_MAX}`,
      );
    }
  }
}

/**
 * Reconcile retained raw bytes at each compile/install boundary. This detects
 * accidental mutation between package review, user export, and dispatch.
 */
export function assertPreparedPackageArchiveIdentity(
  preparedPackage: PreparedPackageInstall,
): void {
  const { archiveBytes, archiveIdentity } = preparedPackage;
  if (archiveBytes === undefined && archiveIdentity === undefined) return;
  if (archiveBytes === undefined || archiveIdentity === undefined) {
    throw new Error(
      "Prepared package archive bytes and identity must be present together",
    );
  }
  if (!(archiveBytes instanceof Uint8Array)) {
    throw new Error("Prepared package archive bytes are invalid");
  }
  if (
    !Number.isSafeInteger(archiveIdentity.size) ||
    archiveIdentity.size < 0 ||
    !/^[a-f0-9]{64}$/u.test(archiveIdentity.sha256)
  ) {
    throw new Error("Prepared package archive identity is invalid");
  }
  const seal = preparedPackageArchiveSeals.get(preparedPackage);
  if (!seal) {
    throw new Error(
      "Prepared package with archive bytes is not the authenticated preparation result",
    );
  }
  if (
    archiveIdentity.size !== seal.archiveSize ||
    archiveIdentity.sha256 !== seal.archiveSha256
  ) {
    throw new Error("Prepared package archive identity changed after review");
  }
  if (archiveBytes.byteLength !== archiveIdentity.size) {
    throw new Error(
      `Prepared package archive size ${archiveBytes.byteLength} does not match reviewed size ${archiveIdentity.size}`,
    );
  }
  const actualSha256 = hashContent(archiveBytes);
  if (actualSha256 !== archiveIdentity.sha256) {
    throw new Error(
      `Prepared package archive SHA-256 ${actualSha256} does not match reviewed ${archiveIdentity.sha256}`,
    );
  }
  const preparedStateSha256 = preparedPackageStateSha256(preparedPackage);
  if (preparedStateSha256 !== seal.preparedStateSha256) {
    throw new Error(
      `Prepared package ${preparedPackage.manifest.id} contents changed after archive review`,
    );
  }
}

function sealPreparedPackageArchiveState(
  preparedPackage: PreparedPackageInstall,
): void {
  const { archiveBytes, archiveIdentity } = preparedPackage;
  if (archiveBytes === undefined && archiveIdentity === undefined) return;
  if (archiveBytes === undefined || archiveIdentity === undefined) {
    throw new Error(
      "Prepared package archive bytes and identity must be present together",
    );
  }
  preparedPackageArchiveSeals.set(
    preparedPackage,
    Object.freeze({
      archiveSha256: archiveIdentity.sha256,
      archiveSize: archiveIdentity.size,
      preparedStateSha256: preparedPackageStateSha256(preparedPackage),
    }),
  );
}

function preparedPackageStateSha256(
  preparedPackage: PreparedPackageInstall,
): string {
  const files = preparedPackage.files
    .map(({ path, content }) => ({
      path,
      sha256: hashContent(content),
      bytes: content.byteLength,
    }))
    .sort((left, right) => compareCanonicalText(left.path, right.path));
  return hashContent(
    canonicalJson({
      manifest: preparedPackage.manifest,
      package_record: preparedPackage.packageRecord ?? null,
      capability_plan: preparedPackage.capabilityPlan,
      capability_plan_fingerprint:
        preparedPackage.capabilityPlanFingerprint,
      browser_surface_origins_ready:
        preparedPackage.browserSurfaceOriginsReady,
      files,
      app_prefix: preparedPackage.appPrefix,
      is_kernel: preparedPackage.isKernel,
      connection_provider_support:
        preparedPackage.connectionProviderSupport ?? null,
    }),
  );
}

function mergeMotokoFiles(...groups: MotokoFile[][]): MotokoFile[] {
  const modules = new Map<string, MotokoFile>();
  for (const file of groups.flat()) {
    assertMotokoFileContentAddress(file, false);
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

function assertMotokoFileContentAddress(
  file: MotokoFile,
  requireContentAddress: boolean,
): void {
  const match = /^([a-f0-9]{64})\.mo$/u.exec(file.path);
  if (!match) {
    if (requireContentAddress) {
      throw new Error(`Invalid installed Motoko module path ${file.path}`);
    }
    return;
  }
  const actualSha256 = hashContent(file.content);
  if (actualSha256 !== match[1]) {
    throw new Error(
      `Motoko module ${file.path} content SHA-256 is ${actualSha256}`,
    );
  }
}

function uniquePreparedModuleFiles(
  packages: PreparedPackageInstall[],
  previousModulePaths: readonly string[] = [],
): PreparedPackageFile[] {
  const installed = new Set(previousModulePaths);
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
  // Both the checked baseline and incoming package modules have already had
  // their content-addressed paths verified. Retain matching installed bytes,
  // just as we retain modules belonging to packages outside this update.
  return [...modules.values()]
    .filter(({ path }) => !installed.has(path.slice("mo/".length)))
    .map(({ path, content }) => ({
      path,
      content: content.slice(),
    }));
}

export function buildPackageCompileInput({
  existingModules,
  existingConfigs,
  existingApps,
  existingBrowserSurfaceOriginAppIds,
  existingStable,
  connectionProviderSupport: baselineConnectionProviderSupport,
  preparedPackage,
  deploymentNonce,
  vetKeysEnvironment,
  persistenceMode,
  versionPolicy = "strict-upgrade",
}: PackageCompileInput): CompileInput {
  assertPreparedPackageBatch([preparedPackage]);
  assertAppVersionTransitions(existingConfigs, [preparedPackage], versionPolicy);
  const configs = {
    ...existingConfigs,
    [preparedPackage.manifest.id]: preparedPackage.manifest,
  };
  const browserSurfaceOriginAppIds = compileBrowserSurfaceOriginAppIds({
    configs,
    packages: [preparedPackage],
    existingApps,
    existingBrowserSurfaceOriginAppIds,
  });
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
    browserSurfaceOriginAppIds,
    previousConfigs: existingConfigs,
    previousStable: existingStable ?? null,
    ...(connectionProviderSupport ? { connectionProviderSupport } : {}),
    ...(deploymentNonce ? { deploymentNonce } : {}),
    ...(vetKeysEnvironment ? { vetKeysEnvironment } : {}),
    ...(persistenceMode ? { persistenceMode } : {}),
  };
}

export async function compilePackageInstall(
  input: PackageCompileInput,
): Promise<CompileResult> {
  const compileInput = buildPackageCompileInput(input);
  assertPreparedPackageBrowserSurfaceFanout(
    [input.preparedPackage],
    ASSEMBLER_ID,
    compileInput.browserSurfaceOriginAppIds ?? [],
  );
  const { compile } = await import("./compile.ts");
  return compile(compileInput);
}

export function buildPackagesCompileInput({
  packages,
  existingModules = [],
  existingConfigs = {},
  existingApps,
  existingBrowserSurfaceOriginAppIds,
  existingStable = null,
  connectionProviderSupport: baselineConnectionProviderSupport,
  deploymentNonce,
  vetKeysEnvironment,
  persistenceMode,
  freshInstallationContext,
  includeGeneratedSource,
  versionPolicy = "strict-upgrade",
}: CompilePackagesInput): CompileInput {
  assertPreparedPackageBatch([...packages]);
  assertAppVersionTransitions(existingConfigs, packages, versionPolicy);
  // Validate each supplied module occurrence once, preserving first-seen order
  // and duplicate/conflict checks without rehashing every accumulated prefix.
  const mofiles = mergeMotokoFiles(
    existingModules,
    ...packages.map((preparedPackage) =>
      motokoFilesFromPreparedFiles(preparedPackage.files),
    ),
  );
  const configs: CompileConfig = { ...existingConfigs };

  for (const preparedPackage of packages) {
    configs[preparedPackage.manifest.id] = preparedPackage.manifest;
  }
  const connectionProviderSupport = selectedConnectionProviderSupport(
    packages,
    baselineConnectionProviderSupport,
  );
  assertCompileConnectionProviderSupport(configs, connectionProviderSupport);
  assertStableStoreSchemaTransitions(existingConfigs, configs);
  assertCertifiedAssetsTransitions(existingConfigs, configs);
  const browserSurfaceOriginAppIds = compileBrowserSurfaceOriginAppIds({
    configs,
    packages,
    existingApps,
    existingBrowserSurfaceOriginAppIds,
  });

  return {
    mofiles,
    configs,
    browserSurfaceOriginAppIds,
    previousConfigs: existingConfigs,
    previousStable: existingStable,
    ...(connectionProviderSupport ? { connectionProviderSupport } : {}),
    ...(deploymentNonce ? { deploymentNonce } : {}),
    ...(vetKeysEnvironment ? { vetKeysEnvironment } : {}),
    ...(persistenceMode ? { persistenceMode } : {}),
    ...(freshInstallationContext
      ? { freshInstallationContext }
      : {}),
    ...(includeGeneratedSource ? { includeGeneratedSource: true } : {}),
  };
}

function compileBrowserSurfaceOriginAppIds({
  configs,
  packages,
  existingApps,
  existingBrowserSurfaceOriginAppIds,
}: {
  configs: CompileConfig;
  packages: readonly PreparedPackageInstall[];
  existingApps: AppRegistry;
  existingBrowserSurfaceOriginAppIds: readonly string[];
}): string[] {
  const priorApps = normalizeAppRegistry(existingApps);
  const priorBrowserSurfaceOriginAppIds =
    normalizeBrowserSurfaceOriginAppIds(
      existingBrowserSurfaceOriginAppIds,
      Object.keys(priorApps),
    );
  return deriveBrowserSurfaceOriginAppIds({
    existingBrowserSurfaceOriginAppIds: priorBrowserSurfaceOriginAppIds,
    selectedAppIds: selectedBrowserSurfaceOriginAppIds(packages),
    targetAppIds: Object.keys(configs),
  });
}

function selectedBrowserSurfaceOriginAppIds(
  packages: readonly PreparedPackageInstall[],
): string[] {
  return packages
    .filter(({ browserSurfaceOriginsReady }) =>
      browserSurfaceOriginsReady === true
    )
    .map(({ manifest }) => manifest.id);
}

/**
 * Derive the exact fresh-deployment origin cohort from authenticated package
 * preparation. V25 remains empty; v26 adopts only selected ordinary packages
 * that carry the canonical generation marker or declare browser permissions.
 */
export function browserSurfaceOriginAppIdsForSelectedPackages(
  packages: readonly PreparedPackageInstall[],
  assemblerId: typeof ASSEMBLER_ID | typeof LEGACY_V25_ASSEMBLER_ID,
): string[] {
  assertPreparedPackageBatch([...packages]);
  assertAssemblerSupportsBrowserPermissions(
    assemblerId,
    packages.map(({ manifest }) => manifest),
  );
  if (assemblerId === LEGACY_V25_ASSEMBLER_ID) return [];
  if (assemblerId !== BROWSER_SURFACE_ORIGIN_ASSEMBLER_ID) {
    throw new Error(`Unsupported assembler ${String(assemblerId)}`);
  }
  return selectedBrowserSurfaceOriginAppIds(packages).sort(
    compareCanonicalText,
  );
}

function deriveBrowserSurfaceOriginAppIds({
  existingBrowserSurfaceOriginAppIds,
  selectedAppIds,
  targetAppIds,
}: {
  existingBrowserSurfaceOriginAppIds: readonly string[];
  selectedAppIds: readonly string[];
  targetAppIds: Iterable<string>;
}): string[] {
  const available = new Set(targetAppIds);
  const targets = new Set(
    existingBrowserSurfaceOriginAppIds.filter((appId) => available.has(appId)),
  );
  for (const appId of selectedAppIds) {
    if (appId !== "kernel") targets.add(appId);
  }
  return normalizeBrowserSurfaceOriginAppIds([...targets], available);
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
  const compileInput = buildPackagesCompileInput(input);
  assertPreparedPackageBrowserSurfaceFanout(
    input.packages,
    ASSEMBLER_ID,
    compileInput.browserSurfaceOriginAppIds ?? [],
  );
  const { compile } = await import("./compile.ts");
  return compile(compileInput);
}

/** Compile one fresh package set with the generation required by its Kernel. */
export async function compileFreshPackages({
  packages,
  deploymentNonce,
  vetKeysEnvironment,
  persistenceMode,
  freshInstallationContext,
  includeGeneratedSource,
}: FreshCompilePackagesInput): Promise<CompileResult> {
  const kernels = packages.filter(({ isKernel }) => isKernel);
  if (kernels.length !== 1) {
    throw new Error(
      `Fresh compilation requires exactly one kernel package; found ${kernels.length}`,
    );
  }
  if (!packages[0]?.isKernel) {
    throw new Error(
      "Fresh compilation requires the kernel package to be first",
    );
  }
  const assemblerId = assemblerForFreshKernelVersion(
    packages[0].manifest.version,
  );
  assertAssemblerSupportsBrowserPermissions(
    assemblerId,
    packages.map(({ manifest }) => manifest),
  );
  const input = buildPackagesCompileInput({
    packages,
    existingApps: {},
    existingBrowserSurfaceOriginAppIds: [],
    versionPolicy: "allow-same-version",
    ...(deploymentNonce ? { deploymentNonce } : {}),
    ...(vetKeysEnvironment ? { vetKeysEnvironment } : {}),
    ...(persistenceMode ? { persistenceMode } : {}),
    ...(freshInstallationContext ? { freshInstallationContext } : {}),
    ...(includeGeneratedSource ? { includeGeneratedSource: true } : {}),
  });
  assertPreparedPackageBrowserSurfaceFanout(
    packages,
    assemblerId,
    input.browserSurfaceOriginAppIds ?? [],
  );
  const { compile, compileLegacyV25Compatibility } = await import(
    "./compile.ts"
  );
  const compiled =
    assemblerId === BROWSER_SURFACE_ORIGIN_ASSEMBLER_ID
      ? await compile(input)
      : await compileLegacyV25Compatibility(
          withoutBrowserSurfaceOriginSelection(input),
        );
  if (compiled.assemblerId !== assemblerId) {
    throw new Error(
      `Fresh compiler emitted ${compiled.assemblerId}; expected ${assemblerId}`,
    );
  }
  return compiled;
}

function withoutBrowserSurfaceOriginSelection(
  input: CompileInput,
): Omit<CompileInput, "browserSurfaceOriginAppIds"> {
  const { browserSurfaceOriginAppIds: _v26Selection, ...legacyInput } = input;
  return legacyInput;
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
    assertPreparedPackageArchiveIdentity(preparedPackage);
    preparedPackage.files = [
      ...preparedPackage.files.filter(({ path }) => path !== runtimePath),
      { path: runtimePath, content: content.slice() },
    ];
    sealPreparedPackageArchiveState(preparedPackage);
  }
}

type AppsUninstallCompileInput = {
  state: KernelPackageState;
  appIds: readonly string[];
  deploymentNonce?: string;
  vetKeysEnvironment?: VetKeysEnvironment;
  persistenceMode?: NeutronPersistenceMode;
};

type AppUninstallCompileInput = Omit<AppsUninstallCompileInput, "appIds"> & {
  appId: string;
};

export function buildAppUninstallCompileInput({
  state,
  appId,
  ...options
}: AppUninstallCompileInput): CompileInput {
  return buildAppsUninstallCompileInput({
    state,
    appIds: [appId],
    ...options,
  });
}

export function buildAppsUninstallCompileInput({
  state,
  appIds,
  deploymentNonce,
  vetKeysEnvironment,
  persistenceMode,
}: AppsUninstallCompileInput): CompileInput {
  const normalizedAppIds = normalizeRemovedApps(appIds, []);
  if (normalizedAppIds.length === 0) {
    throw new Error("Select at least one app to uninstall");
  }
  for (const appId of normalizedAppIds) {
    if (!state.existingConfigs[appId]) {
      throw new Error(`App ${appId} is not installed`);
    }
  }
  const removed = new Set(normalizedAppIds);
  const dependencyPlan = planAppDependencies(state.existingConfigs);
  for (const appId of normalizedAppIds) {
    const impact = appDependencyImpact(dependencyPlan, appId);
    const dependents = impact.direct.filter(
      ({ consumer }) => !removed.has(consumer),
    );
    if (dependents.length === 0) continue;
    const provider = state.existingConfigs[appId]!;
    const direct = dependents
      .map((dependent) => {
        const consumer = state.existingConfigs[dependent.consumer];
        return `${consumer?.name ?? dependent.consumer} (${dependent.functions.join(", ")})`;
      })
      .join(", ");
    const transitive = impact.transitiveConsumers
      .filter((consumer) => !removed.has(consumer))
      .map((consumer) => state.existingConfigs[consumer]?.name ?? consumer)
      .join(", ");
    throw new Error(
      `${provider.name} cannot be uninstalled; required by ${direct}${
        transitive ? `; transitively used by ${transitive}` : ""
      }`,
    );
  }
  const configs = Object.fromEntries(
    Object.entries(state.existingConfigs).filter(([id]) => !removed.has(id)),
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
    browserSurfaceOriginAppIds: compileBrowserSurfaceOriginAppIds({
      configs,
      packages: [],
      existingApps: state.apps,
      existingBrowserSurfaceOriginAppIds: state.browserSurfaceOriginAppIds,
    }),
    previousConfigs: state.existingConfigs,
    previousStable: state.previousStable,
    connectionProviderSupport: state.connectionProviderSupport,
    ...(deploymentNonce ? { deploymentNonce } : {}),
    ...(vetKeysEnvironment ? { vetKeysEnvironment } : {}),
    ...(persistenceMode ? { persistenceMode } : {}),
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

export async function compileAppUninstall(
  input: AppUninstallCompileInput,
): Promise<CompileResult> {
  const { appId, ...options } = input;
  return compileAppsUninstall({
    ...options,
    appIds: [appId],
  });
}

export async function compileAppsUninstall(
  input: AppsUninstallCompileInput,
): Promise<CompileResult> {
  const { compile } = await import("./compile.ts");
  return compile(buildAppsUninstallCompileInput(input));
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
  const preparedBuild = prepareCompleteDeploymentBuildRecord({
    targetCanisterId,
    packages: [],
    state,
    compiled,
    expectedDeploymentId,
    removedApps: [appId],
  });
  return deployPreparedPackages({
    actor,
    targetCanisterId,
    packages: [],
    compiled,
    existingApps: state.apps,
    existingBrowserSurfaceOriginAppIds: state.browserSurfaceOriginAppIds,
    previousModulePaths: state.existingModules.map(({ path }) => path),
    removedApps: [appId],
    deploymentBuildRecord: preparedBuild.record,
    ...(stagedAssets ? { stagedAssets } : {}),
    expectedDeploymentId,
    ...(onStep ? { onStep } : {}),
  });
}

export async function readKernelPackageState({
  listStatic,
  fetchText,
  fetchJson,
}: KernelPackageStateReader): Promise<KernelPackageState> {
  const moduleReads = Promise.resolve().then(async () => {
    const modulePaths = await listStatic("/mo/");
    return mapWithConcurrency(modulePaths, 10, async (path) => ({
      path: path.replace(/^\/mo\//, ""),
      content: await fetchText(path),
    }));
  });
  const registryRead = Promise.resolve().then(async () => {
    const registry = normalizeAppRegistry(
      await fetchJson<PartialAppRegistry>("/system/apps.json", {}),
    );
    if (!registry.kernel) {
      throw new Error(
        "Installed app registry is missing the kernel package manifest entry",
      );
    }
    return registry;
  });
  const configReads = registryRead.then((registry) =>
    mapWithConcurrency(
      Object.keys(registry).sort(compareCanonicalText),
      10,
      async (id) => {
        const path =
          id === "kernel" ? "/pkg/neutron.json" : `/app/${id}/pkg/neutron.json`;
        return {
          id,
          path,
          value: await fetchJson<unknown | undefined>(path, undefined),
        };
      },
    ),
  );
  // Only manifests depend on the registry. Start the other baseline reads
  // together so module downloads do not delay unrelated metadata requests.
  const [
    existingModules,
    registry,
    rawBrowserSurfaceOrigins,
    configs,
    rawConnectionProviderSupport,
    previousStable,
  ] = await Promise.all([
    moduleReads,
    registryRead,
    Promise.resolve().then(() =>
      fetchJson<unknown | undefined>(BROWSER_SURFACE_ORIGINS_PATH, undefined),
    ),
    configReads,
    Promise.resolve().then(() =>
      fetchJson<unknown | undefined>(
        KERNEL_CONNECTION_PROVIDER_SUPPORT_PATH,
        undefined,
      ),
    ),
    Promise.resolve().then(() => fetchText("/pkg/neutron.most")),
  ]);
  for (const module of existingModules) {
    assertMotokoFileContentAddress(module, true);
  }
  const browserSurfaceOriginAppIds = parseBrowserSurfaceOriginsSidecar(
    rawBrowserSurfaceOrigins,
    Object.keys(registry),
  );
  const configEntries = configs.map(({ id, path, value }) => {
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

  if (previousStable.trim().length === 0) {
    throw new Error("Installed stable signature /pkg/neutron.most is empty");
  }

  return {
    registry,
    apps: registry,
    browserSurfaceOriginAppIds,
    browserSurfaceOriginsSidecarPresent:
      rawBrowserSurfaceOrigins !== undefined,
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
  assertKernelPackageStateMatchesRuntimeGeneration(state, runtime, false);
}

/**
 * Bind the pre-compile package baseline to the current assembler or its one
 * explicit bridge predecessor. A v25-built Kernel can install the frontend
 * that carries v26; the next checked install must then activate v26.
 */
export function assertKernelPackageBaselineMatchesRuntime(
  state: KernelPackageState,
  runtime: KernelRuntimeInfo,
): void {
  assertKernelPackageStateMatchesRuntimeGeneration(state, runtime, true);
}

function assertKernelPackageStateMatchesRuntimeGeneration(
  state: KernelPackageState,
  runtime: KernelRuntimeInfo,
  allowV26BaselineBridge: boolean,
): void {
  if (
    runtime.assembler_id !== ASSEMBLER_ID &&
    !(allowV26BaselineBridge && isExactV25Bridge(runtime.assembler_id))
  ) {
    throw new Error(
      `Runtime assembler generation ${runtime.assembler_id} does not match ${ASSEMBLER_ID}`,
    );
  }

  const registry = normalizeAppRegistry(state.registry);
  if (!sameJsonValue(registry, normalizeAppRegistry(state.apps))) {
    throw new Error("Kernel package state registries do not match");
  }
  const browserSurfaceOriginAppIds = normalizeBrowserSurfaceOriginAppIds(
    state.browserSurfaceOriginAppIds,
    Object.keys(registry),
  );
  const expectsBrowserSurfaceOriginsSidecar =
    runtime.assembler_id === BROWSER_SURFACE_ORIGIN_ASSEMBLER_ID;
  if (
    state.browserSurfaceOriginsSidecarPresent !==
    expectsBrowserSurfaceOriginsSidecar
  ) {
    throw new Error(
      expectsBrowserSurfaceOriginsSidecar
        ? "The current runtime is missing its browser-surface origins sidecar"
        : `Assembler ${runtime.assembler_id} cannot contain a browser-surface origins sidecar`,
    );
  }
  if (
    !expectsBrowserSurfaceOriginsSidecar &&
    browserSurfaceOriginAppIds.length !== 0
  ) {
    throw new Error(
      `Assembler ${runtime.assembler_id} cannot own v26 browser-surface origin authority`,
    );
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

export type BrowserSurfaceOriginsSidecarV1 = Readonly<{
  format: 1;
  app_ids: readonly string[];
}>;

/** Absence is the exact pre-v26 state; present files are closed and canonical. */
export function parseBrowserSurfaceOriginsSidecar(
  value: unknown,
  installedAppIds: Iterable<string>,
): string[] {
  if (value === undefined) return [];
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    value.format !== 1 ||
    !Object.prototype.hasOwnProperty.call(value, "app_ids") ||
    !Array.isArray(value.app_ids) ||
    value.app_ids.length > NEUTRON_INSTALLED_APP_LIMIT
  ) {
    throw new Error("Invalid browser-surface origins sidecar");
  }
  const normalized = normalizeBrowserSurfaceOriginAppIds(
    value.app_ids as string[],
    installedAppIds,
  );
  if (JSON.stringify(value.app_ids) !== JSON.stringify(normalized)) {
    throw new Error("Browser-surface origins sidecar is not canonical");
  }
  return normalized;
}

export function browserSurfaceOriginsSidecar(
  appIds: readonly string[],
  installedAppIds: Iterable<string>,
): BrowserSurfaceOriginsSidecarV1 {
  return Object.freeze({
    format: 1 as const,
    app_ids: Object.freeze(
      normalizeBrowserSurfaceOriginAppIds(appIds, installedAppIds),
    ),
  });
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
    if (!isValidTileId(id)) {
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
  existingBrowserSurfaceOriginAppIds,
  preparedPackage,
  candid,
}: {
  existingApps: AppRegistry;
  existingBrowserSurfaceOriginAppIds: readonly string[];
  preparedPackage: PreparedPackageInstall;
  candid: string;
}): PackageInstallAssets {
  return buildPackagesInstallAssets({
    existingApps,
    existingBrowserSurfaceOriginAppIds,
    packages: [preparedPackage],
    candid,
  });
}

export function buildPackagesInstallAssets({
  existingApps,
  existingBrowserSurfaceOriginAppIds,
  packages,
  candid,
  removedApps = [],
}: {
  existingApps: AppRegistry;
  existingBrowserSurfaceOriginAppIds: readonly string[];
  packages: PreparedPackageInstall[];
  candid: string;
  removedApps?: string[];
}): PackageInstallAssets {
  assertPreparedPackageBatch([...packages]);
  const priorBrowserSurfaceOriginAppIds =
    normalizeBrowserSurfaceOriginAppIds(
      existingBrowserSurfaceOriginAppIds,
      Object.keys(normalizeAppRegistry(existingApps)),
    );
  const normalizedRemovedApps = normalizeRemovedApps(removedApps, packages);
  const apps = buildTargetAppRegistry({
    existingApps,
    manifests: packages.map(({ manifest }) => manifest),
    removedApps: normalizedRemovedApps,
  });
  const browserSurfaceOriginAppIds = deriveBrowserSurfaceOriginAppIds({
    existingBrowserSurfaceOriginAppIds: priorBrowserSurfaceOriginAppIds,
    selectedAppIds: selectedBrowserSurfaceOriginAppIds(packages),
    targetAppIds: Object.keys(apps),
  });
  return {
    apps,
    browserSurfaceOriginAppIds,
    appRegistryAsset: createJsonAsset(
      "/system/apps.json",
      apps,
      "application/json",
    ),
    browserSurfaceOriginsAsset: createJsonAsset(
      BROWSER_SURFACE_ORIGINS_PATH,
      browserSurfaceOriginsSidecar(
        browserSurfaceOriginAppIds,
        Object.keys(apps),
      ),
      "application/json",
    ),
    candidAsset: createTextAsset("/pkg/neutron.did", candid, "text/plain"),
  };
}

function buildTargetAppRegistry({
  existingApps,
  manifests,
  removedApps = [],
}: {
  existingApps: AppRegistry;
  manifests: readonly PackagedNeutronManifest[];
  removedApps?: readonly string[];
}): AppRegistry {
  const removed = new Set(removedApps);
  let apps: AppRegistry = Object.fromEntries(
    Object.entries(normalizeAppRegistry(existingApps)).filter(
      ([appId]) => !removed.has(appId),
    ),
  );
  for (const manifest of manifests) {
    apps = updateAppRegistry(apps, manifest);
  }
  return apps;
}

/**
 * Build the exact review artifact for the state-preserving Kernel upgrade
 * path. No canister write occurs here; callers can inspect/export the returned
 * bytes before passing `record` to `deployPreparedPackages`.
 */
export function prepareCompleteDeploymentBuildRecord({
  targetCanisterId,
  packages,
  state,
  compiled,
  expectedDeploymentId,
  removedApps = [],
  retainedPackageEvidence = {},
}: PrepareCompleteDeploymentBuildRecordInput): PreparedCompleteDeploymentBuild {
  assertCurrentAssemblerCompileResult(compiled);
  assertExpectedDeploymentId(expectedDeploymentId);
  assertCompiledManagedMemoryPlan(compiled);
  assertPreparedPackageBrowserSurfaceFanout(
    [...packages],
    compiled.assemblerId,
    compiled.browserSurfaceOriginAppIds,
  );
  const normalizedRemovedApps = normalizeRemovedApps(removedApps, packages);
  if (
    JSON.stringify(normalizedRemovedApps) !==
    JSON.stringify([...compiled.migrationPlan.removedApps].sort(compareCanonicalText))
  ) {
    throw new Error(
      "Deployment record removed apps do not match the compiler migration plan",
    );
  }

  const { apps, browserSurfaceOriginAppIds } = buildPackagesInstallAssets({
    existingApps: state.apps,
    existingBrowserSurfaceOriginAppIds: state.browserSurfaceOriginAppIds,
    packages: [...packages],
    candid: compiled.candid,
    removedApps: normalizedRemovedApps,
  });
  assertInstallRegistryMatchesCompile(
    apps,
    browserSurfaceOriginAppIds,
    compiled,
  );

  const supplied = new Map(
    packages.map((preparedPackage) => [
      preparedPackage.manifest.id,
      preparedPackage,
    ]),
  );
  const targetIds = new Set(compiled.dependencyPlan.order);
  for (const appId of Object.keys(retainedPackageEvidence)) {
    validateInstallAppId(appId);
    if (!targetIds.has(appId)) {
      throw new Error(`Retained package evidence names non-target app ${appId}`);
    }
    if (supplied.has(appId)) {
      throw new Error(`Retained package evidence cannot replace supplied app ${appId}`);
    }
  }

  const packageIdentities = compiled.dependencyPlan.order.map((appId) => {
    const target = apps[appId];
    if (!target) {
      throw new Error(`Compiler package order names missing target app ${appId}`);
    }
    const preparedPackage = supplied.get(appId);
    if (preparedPackage) {
      return preparedDeploymentPackageIdentity(preparedPackage);
    }
    const evidence = retainedPackageEvidence[appId] ?? {
      version: target.version,
      archive: { state: "legacy_unavailable" as const },
      package_information: { state: "legacy_unavailable" as const },
    };
    if (evidence.version !== target.version) {
      throw new Error(
        `Retained package evidence for ${appId} is version ${evidence.version}, expected ${target.version}`,
      );
    }
    return {
      app_id: appId,
      version: target.version,
      archive: evidence.archive,
      package_information: evidence.package_information,
    };
  });

  const previousApps = deploymentAppInventoryFromRegistry(state.apps);
  const previousMemories = compileManagedMemoryInventory(state.existingConfigs);
  const previousStableSignatureSha256 =
    state.previousStable === null ? null : hashContent(state.previousStable);
  if (
    !sameJsonValue(
      compiled.previousManagedMemoryInventory,
      previousMemories,
    ) ||
    compiled.previousStableSignatureSha256 !== previousStableSignatureSha256
  ) {
    throw new Error(
      "Deployment build predecessor does not match the compiler baseline",
    );
  }

  const prepared = createCompleteDeploymentBuildRecord({
    compiled,
    assembler_id: ASSEMBLER_ID,
    previous: {
      deployment_id: expectedDeploymentId,
      stable_signature: state.previousStable,
      apps: previousApps,
      memories: previousMemories,
    },
    packages: packageIdentities,
    installation: {
      target_canister: targetCanisterId,
      mode: "upgrade",
      argument: new Uint8Array(),
      wasm_memory_persistence: wasmMemoryPersistenceForMode(
        compiled.persistenceMode,
      ),
    },
  });
  const canonicalRecordBytes = serializeDeploymentBuildRecord(prepared.record);
  if (!equalBytes(canonicalRecordBytes, prepared.recordBytes)) {
    throw new Error(
      "Prepared deployment build record bytes are not canonical",
    );
  }
  preparedDeploymentBuildRecordSeals.set(
    prepared.record,
    Object.freeze({
      recordBytes: canonicalRecordBytes.slice(),
      candid: compiled.candid,
      stable: compiled.stable,
      browserSurfaceOriginAppIds: Object.freeze([
        ...compiled.browserSurfaceOriginAppIds,
      ]),
    }),
  );
  return prepared;
}

/** Carry bounded package identities from an installed record into a rebuild. */
export function retainedDeploymentPackageEvidenceFromRecord(
  value: DeploymentBuildRecord,
  {
    targetCanisterId,
    deploymentId,
    apps,
  }: {
    targetCanisterId: string;
    deploymentId: string;
    apps: AppRegistry;
  },
): Readonly<Record<string, RetainedDeploymentPackageEvidence>> {
  const record = parseDeploymentBuildRecord(value);
  const observedTarget =
    record.state === "complete"
      ? record.installation.target_canister
      : record.observation.target_canister;
  const observedDeployment =
    record.state === "complete"
      ? record.deployment_id
      : record.observation.deployment_id;
  const observedApps =
    record.state === "complete" ? record.target.apps : record.observation.apps;
  if (
    observedTarget !==
      normalizeUpdateSourcePrincipal(
        targetCanisterId,
        "installed deployment target canister",
      ) ||
    observedDeployment !== deploymentId ||
    !sameJsonValue(observedApps, deploymentAppInventoryFromRegistry(apps))
  ) {
    throw new Error(
      "Installed deployment record does not match the checked runtime and app registry",
    );
  }
  if (record.state === "complete") {
    return Object.freeze(
      Object.fromEntries(
        record.packages.map(
          ({ app_id, version, archive, package_information }) => [
            app_id,
            { version, archive, package_information },
          ],
        ),
      ),
    );
  }
  return Object.freeze(
    Object.fromEntries(
      record.packages.map(
        ({
          app_id,
          version,
          outer_archive_sha256,
          package_information_sha256,
        }) => [
          app_id,
          {
            version,
            archive:
              outer_archive_sha256 === null
                ? { state: "legacy_unavailable" as const }
                : {
                    state: "outer_archive_digest_only" as const,
                    sha256: outer_archive_sha256,
                  },
            package_information:
              package_information_sha256 === null
                ? { state: "legacy_unavailable" as const }
                : {
                    state: "verified" as const,
                    sha256: package_information_sha256,
                  },
          },
        ],
      ),
    ),
  );
}

function deploymentAppInventoryFromRegistry(
  apps: AppRegistry,
) {
  return Object.entries(normalizeAppRegistry(apps))
    .map(([app_id, entry]) => ({
      app_id,
      version: entry.version,
      capability_plan_fingerprint: entry.capability_plan_fingerprint,
      resident_frame_security: residentFrameSecurity(entry.capability_plan),
    }))
    .sort((left, right) => compareCanonicalText(left.app_id, right.app_id));
}

function preparedDeploymentPackageIdentity(
  preparedPackage: PreparedPackageInstall,
) {
  assertPreparedPackageArchiveIdentity(preparedPackage);
  const archive: DeploymentPackageArchiveRecord = preparedPackage.archiveIdentity
    ? {
        state: "verified",
        sha256: preparedPackage.archiveIdentity.sha256,
        bytes: preparedPackage.archiveIdentity.size,
      }
    : { state: "legacy_unavailable" };
  const recordPath = `${preparedPackage.appPrefix}pkg/${NEUTRON_PACKAGE_RECORD_PATH}`;
  const recordFile = preparedPackage.files.find(({ path }) => path === recordPath);
  if ((recordFile !== undefined) !== (preparedPackage.packageRecord !== undefined)) {
    throw new Error(
      `Prepared package ${preparedPackage.manifest.id} has inconsistent package-information record state`,
    );
  }
  const packageInformation: PackageInformationRecordIdentity = recordFile
    ? { state: "verified", sha256: hashContent(recordFile.content) }
    : archive.state === "verified"
      ? { state: "not_supplied" }
      : { state: "legacy_unavailable" };
  return {
    app_id: preparedPackage.manifest.id,
    version: preparedPackage.manifest.version,
    archive,
    package_information: packageInformation,
  };
}

function assertDeploymentBuildRecordMatchesInstall({
  value,
  compiled,
  packages,
  existingApps,
  targetCanisterId,
  expectedDeploymentId,
  transportWasm,
}: {
  value: CompleteDeploymentBuildRecord;
  compiled: CompileResult;
  packages: readonly PreparedPackageInstall[];
  existingApps: AppRegistry;
  targetCanisterId: string;
  expectedDeploymentId: string;
  transportWasm: Uint8Array;
}): CompleteDeploymentBuildRecord {
  const reviewed = preparedDeploymentBuildRecordSeals.get(value);
  if (!reviewed) {
    throw new Error(
      "Deployment build record is not the authenticated reviewed preparation result",
    );
  }
  if (compiled.candid !== reviewed.candid) {
    throw new Error("Compiled Candid changed after deployment review");
  }
  if (compiled.stable !== reviewed.stable) {
    throw new Error("Compiled stable signature changed after deployment review");
  }
  if (
    !sameJsonValue(
      compiled.browserSurfaceOriginAppIds,
      reviewed.browserSurfaceOriginAppIds,
    )
  ) {
    throw new Error(
      "Compiled browser-surface origin authority changed after deployment review",
    );
  }
  const record = parseDeploymentBuildRecord(value);
  if (record.state !== "complete") {
    throw new Error("Deployment install requires a complete build record");
  }
  const currentBytes = serializeDeploymentBuildRecord(record);
  if (!equalBytes(currentBytes, reviewed.recordBytes)) {
    throw new Error("Deployment build record changed after review");
  }
  if (record.previous.deployment_id !== expectedDeploymentId) {
    throw new Error(
      "Deployment build record does not match the checked predecessor deployment",
    );
  }

  const previousApps = deploymentAppInventoryFromRegistry(existingApps);
  if (!sameJsonValue(record.previous.apps, previousApps)) {
    throw new Error(
      "Deployment build record predecessor apps do not match the checked registry",
    );
  }
  if (
    record.previous.stable_signature_sha256 !==
      compiled.previousStableSignatureSha256 ||
    !sameJsonValue(
      record.previous.memories,
      compiled.previousManagedMemoryInventory,
    )
  ) {
    throw new Error(
      "Deployment build record predecessor memory baseline does not match the compiler",
    );
  }

  assertWasmRecord(compiled.wasm, transportWasm, record.wasm);
  const expected = createCompleteDeploymentBuildRecord({
    compiled,
    assembler_id: ASSEMBLER_ID,
    previous: {
      deployment_id: expectedDeploymentId,
      // The deploy surface does not retain the predecessor signature bytes.
      // Its hash was checked against CompileResult above, so omit `previous`
      // from the independently re-derived field comparison below.
      stable_signature: null,
      apps: record.previous.apps,
      memories: record.previous.memories,
    },
    packages: record.packages.map(
      ({ app_id, version, archive, package_information }) => ({
        app_id,
        version,
        archive,
        package_information,
      }),
    ),
    installation: {
      target_canister: targetCanisterId,
      mode: "upgrade",
      argument: new Uint8Array(),
      wasm_memory_persistence: wasmMemoryPersistenceForMode(
        compiled.persistenceMode,
      ),
    },
  }).record;
  for (const field of [
    "deployment_id",
    "build",
    "packages",
    "target",
    "warnings",
    "installation",
    "wasm",
  ] as const) {
    if (!sameJsonValue(record[field], expected[field])) {
      throw new Error(
        `Deployment build record ${field} does not match the exact install`,
      );
    }
  }

  const recordedPackages = new Map(
    record.packages.map((candidate) => [candidate.app_id, candidate]),
  );
  for (const preparedPackage of packages) {
    const identity = preparedDeploymentPackageIdentity(preparedPackage);
    const recorded = recordedPackages.get(identity.app_id);
    if (
      !recorded ||
      recorded.version !== identity.version ||
      !sameJsonValue(recorded.archive, identity.archive) ||
      !sameJsonValue(
        recorded.package_information,
        identity.package_information,
      )
    ) {
      throw new Error(
        `Deployment build record package identity does not match supplied app ${identity.app_id}`,
      );
    }
  }
  return record;
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
  installClearPrefixes(packages, [], state.apps);
  const compiled = await compilePackages({
    packages,
    existingModules: state.existingModules,
    existingConfigs: state.existingConfigs,
    existingApps: state.apps,
    existingBrowserSurfaceOriginAppIds: state.browserSurfaceOriginAppIds,
    existingStable: state.previousStable,
    connectionProviderSupport: state.connectionProviderSupport,
    deploymentNonce: createDeploymentNonce(),
    ...(vetKeysEnvironment ? { vetKeysEnvironment } : {}),
    versionPolicy,
  });
  const preparedBuild = prepareCompleteDeploymentBuildRecord({
    targetCanisterId,
    packages,
    state,
    compiled,
    expectedDeploymentId,
  });

  return deployPreparedPackages({
    actor,
    targetCanisterId,
    packages,
    compiled,
    existingApps: state.apps,
    existingBrowserSurfaceOriginAppIds: state.browserSurfaceOriginAppIds,
    previousModulePaths: state.existingModules.map(({ path }) => path),
    deploymentBuildRecord: preparedBuild.record,
    ...(stagedAssets ? { stagedAssets } : {}),
    expectedDeploymentId,
    ...(verifyTimeoutMs !== undefined ? { verifyTimeoutMs } : {}),
    ...(onStep ? { onStep } : {}),
    ...(onProgress ? { onProgress } : {}),
  });
}

/**
 * Detach the deployment transaction from caller-owned compile output before
 * the first canister call can yield control. Typed-array views cannot be
 * frozen in every supported runtime, so the Wasm receives an explicit
 * ordinary-buffer copy; the surrounding compile result is recursively sealed
 * against accidental internal mutation.
 */
function snapshotCompileResultForDeployment(
  compiled: CompileResult,
): CompileResult {
  const { wasm, ...metadata } = compiled;
  const snapshot: CompileResult = {
    ...structuredClone(metadata),
    wasm: snapshotWasmForDeployment(wasm),
  };
  const seen = new WeakSet<object>();

  const seal = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    if (ArrayBuffer.isView(value) || seen.has(value)) return;
    seen.add(value);
    for (const child of Object.values(value)) seal(child);
    Object.freeze(value);
  };

  seal(snapshot);
  return snapshot;
}

function assertCurrentAssemblerCompileResult(
  compiled: Pick<CompileResult, "assemblerId">,
): void {
  if (compiled.assemblerId !== ASSEMBLER_ID) {
    throw new Error(
      `State-preserving deployment requires current assembler ${ASSEMBLER_ID}`,
    );
  }
}

export async function deployPreparedPackages({
  actor,
  targetCanisterId,
  packages,
  compiled,
  existingApps,
  existingBrowserSurfaceOriginAppIds,
  previousModulePaths = [],
  removedApps = [],
  stagedAssets = [],
  deploymentBuildRecord,
  expectedDeploymentId,
  verifyTimeoutMs = DEFAULT_DEPLOYMENT_ACTIVATION_TIMEOUT_MS,
  onStep,
  onProgress,
}: DeployPreparedPackagesInput): Promise<DeployPreparedPackagesResult> {
  const deploymentCompiled = snapshotCompileResultForDeployment(compiled);
  assertCurrentAssemblerCompileResult(deploymentCompiled);
  assertBackendCallInstallReservationsTarget(
    Object.fromEntries(
      packages.map((preparedPackage) => [
        preparedPackage.manifest.id,
        preparedPackage.manifest,
      ]),
    ),
    targetCanisterId,
  );
  assertCompiledManagedMemoryPlan(deploymentCompiled);
  assertPreparedPackageBrowserSurfaceFanout(
    packages,
    deploymentCompiled.assemblerId,
    deploymentCompiled.browserSurfaceOriginAppIds,
  );
  if (
    deploymentBuildRecord !== undefined &&
    (deploymentBuildRecord === null ||
      typeof deploymentBuildRecord !== "object")
  ) {
    throw new Error(
      "Deployment install requires a complete reviewed deployment build record",
    );
  }
  if (
    deploymentBuildRecord === undefined &&
    requiresCompleteDeploymentBuildRecord(existingApps)
  ) {
    throw new Error(
      `Kernel ${formatAppVersionLabel(existingApps.kernel!.version)} requires a complete reviewed deployment build record`,
    );
  }
  const normalizedRemovedApps = normalizeRemovedApps(removedApps, packages);
  const clearPrefixes = installClearPrefixes(
    packages,
    normalizedRemovedApps,
    existingApps,
  );
  assertExpectedDeploymentId(expectedDeploymentId);
  try {
    assertInstallCommitBinding(deploymentCompiled.candid);
  } catch (error) {
    throw new Error(
      `Compiled target must expose the current kernel_install_commit contract: ${errorMessage(error)}`,
    );
  }
  const {
    apps,
    browserSurfaceOriginAppIds,
    appRegistryAsset,
    browserSurfaceOriginsAsset,
    candidAsset,
  } = buildPackagesInstallAssets({
    existingApps,
    existingBrowserSurfaceOriginAppIds,
    packages,
    candid: deploymentCompiled.candid,
    removedApps: normalizedRemovedApps,
  });
  assertInstallRegistryMatchesCompile(
    apps,
    browserSurfaceOriginAppIds,
    deploymentCompiled,
  );
  const preparedTransport = prepareDeterministicWasmTransport(
    deploymentCompiled.wasm,
  );
  const normalizedDeploymentBuildRecord = deploymentBuildRecord
    ? assertDeploymentBuildRecordMatchesInstall({
        value: deploymentBuildRecord,
        compiled: deploymentCompiled,
        packages,
        existingApps,
        targetCanisterId,
        expectedDeploymentId,
        transportWasm: preparedTransport.transportWasm,
      })
    : undefined;
  const installReservations = installReservationsPrepareRequest(
    packages,
    deploymentCompiled.deploymentId,
  );
  const installCodeDispatch = prepareInstallCodeDispatch({
    transportWasm: preparedTransport.transportWasm,
    candid: deploymentCompiled.candid,
    deploymentId: deploymentCompiled.deploymentId,
    persistenceMode: deploymentCompiled.persistenceMode,
  });
  const stableAsset = createTextAsset(
    "/pkg/neutron.most",
    deploymentCompiled.stable,
    "text/plain",
  );
  const moduleFiles = uniquePreparedModuleFiles(packages, previousModulePaths);
  const moduleGcOperation = createModuleGcOperation({
    deploymentId: deploymentCompiled.deploymentId,
    previousModulePaths,
    retainedModulePaths: deploymentCompiled.modulePaths,
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

  for (const file of mutableFiles) {
    const target = staticKey(file.path);
    if (target === DEPLOYMENT_BUILD_RECORD_PATH) {
      throw new Error(`Reserved package asset target ${target}`);
    }
  }

  for (const asset of stagedAssets) {
    assertSafeStagedAsset(asset);
    if (asset.target === DEPLOYMENT_BUILD_RECORD_PATH) {
      throw new Error(`Reserved staged asset target ${asset.target}`);
    }
  }

  const staged = createStagedAssets(deploymentCompiled.deploymentId, [
    ...mutableFiles.map(({ path, content }) => ({
      target: staticKey(path),
      content,
      // Preserve the source extension when a kernel entrypoint is rewritten
      // from index.html to the extensionless root key `/`.
      contentType: mime(path),
    })),
    {
      target: candidAsset.key,
      content: new TextEncoder().encode(deploymentCompiled.candid),
      contentType: candidAsset.val.content_type,
    },
    {
      target: appRegistryAsset.key,
      content: new TextEncoder().encode(JSON.stringify(apps)),
      contentType: appRegistryAsset.val.content_type,
    },
    {
      target: browserSurfaceOriginsAsset.key,
      content: browserSurfaceOriginsAsset.val.content,
      contentType: browserSurfaceOriginsAsset.val.content_type,
    },
    {
      target: stableAsset.key,
      content: new TextEncoder().encode(deploymentCompiled.stable),
      contentType: stableAsset.val.content_type,
    },
    ...(normalizedDeploymentBuildRecord
      ? [
          {
            target: DEPLOYMENT_BUILD_RECORD_PATH,
            content: serializeDeploymentBuildRecord(
              normalizedDeploymentBuildRecord,
            ),
            contentType: "application/json",
          },
        ]
      : []),
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
    await mapWithConcurrency(
      staged,
      KERNEL_INSTALL_STAGED_WRITE_CONCURRENCY,
      async (asset) =>
        uploadStaticFileOperation(
          actor,
          createStaticFileOperation(
            asset.source,
            asset.content,
            asset.contentType ?? mime(asset.target),
          ),
        ),
    );
    if (moduleGcOperation) {
      await uploadStaticFileOperation(actor, moduleGcOperation);
    }
  } catch (error) {
    await cleanupUnjournaledStaging(actor, deploymentCompiled.deploymentId);
    throw error;
  }

  const journal: InstallJournal = {
    deployment_id: deploymentCompiled.deploymentId,
    copies: staged.map(({ source, target }) => ({ source, target })),
    clear_prefixes: clearPrefixes,
    target_app_inventory: deploymentCompiled.appInstanceInventory.map(
      (entry) => ({
        app_id: entry.app_id,
        version: entry.version,
        capability_plan_fingerprint: entry.capability_plan_fingerprint,
        resident_frame_security: encodeResidentFrameSecurity(
          entry.resident_frame_security,
        ),
      }),
    ),
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
        `Checked install journal could not be causally confirmed for ${deploymentCompiled.deploymentId}; ` +
          `staging was retained: ${errorMessage(replayFailure)}`,
      );
    }
  }

  if (installReservations !== null) {
    try {
      await prepareInstallReservations(actor, installReservations);
    } catch (error) {
      notifyDeployStep(onStep, "abort");
      try {
        await abortUndispatchedInstall(actor, deploymentCompiled.deploymentId);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `Install reservation preparation failed and cleanup could not be ` +
            `confirmed for ${deploymentCompiled.deploymentId}`,
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
      deploymentCompiled.deploymentId,
      verifyTimeoutMs,
      dispatchFailure,
    );
    assertCompiledRuntime(runtime, deploymentCompiled);

    if (installCodeDispatch.kind === "chunked") {
      await clearInstallWasmChunks(actor, deploymentCompiled.deploymentId);
    }

    notifyDeployStep(onStep, "commit-assets");
    await commitPreparedDeployment(actor, deploymentCompiled.deploymentId);
    notifyDeployStep(onStep, "complete");
    return { apps, compiled: deploymentCompiled };
  } catch (error) {
    if (error instanceof InstallCommitPendingError) {
      throw error;
    }
    const runtime = await readRuntimeInfo(actor);
    if (runtime?.deployment_id === deploymentCompiled.deploymentId) {
      assertCompiledRuntime(runtime, deploymentCompiled);
      if (installCodeDispatch.kind === "chunked") {
        await clearInstallWasmChunks(actor, deploymentCompiled.deploymentId);
      }
      await commitPreparedDeployment(actor, deploymentCompiled.deploymentId);
      notifyDeployStep(onStep, "complete");
      return { apps, compiled: deploymentCompiled };
    }
    if (runtime) {
      if (installCodeDispatch.kind === "chunked") {
        await clearInstallWasmChunks(actor, deploymentCompiled.deploymentId);
      }
      notifyDeployStep(onStep, "abort");
      await actor
        .kernel_install_abort({
          deployment_id: deploymentCompiled.deploymentId,
        })
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
  existingApps: AppRegistry,
): string[] {
  // v0.3.6 and earlier reject every non-/app clear prefix. They also predate
  // the reserved legal subtree, so the first bridge safely copies its files
  // without clearing. Once v0.3.7 is the running baseline, clear/copy is one
  // atomic journal operation and a recordless replacement cannot inherit it.
  const runningKernelVersion = existingApps.kernel?.version;
  const supportsBridgeMetadataClears =
    typeof runningKernelVersion === "number" &&
    Number.isSafeInteger(runningKernelVersion) &&
    runningKernelVersion >= KERNEL_LEGAL_CLEAR_BASELINE_VERSION;
  const clearsKernelLegal =
    packages.some((preparedPackage) => preparedPackage.isKernel) &&
    supportsBridgeMetadataClears;
  const prefixes = [
    ...new Set([
      ...(clearsKernelLegal ? ["/pkg/legal/"] : []),
      ...(supportsBridgeMetadataClears
        ? [DEPLOYMENT_BUILD_RECORD_PATH]
        : []),
      ...packages
        .filter((preparedPackage) => !preparedPackage.isKernel)
        .map((preparedPackage) => `/app/${preparedPackage.manifest.id}/`),
      ...removedApps.map((appId) => `/app/${appId}/`),
    ]),
  ].sort(compareCanonicalText);
  if (prefixes.length > KERNEL_INSTALL_MAX_CLEAR_PREFIXES_PER_COMMIT) {
    throw new Error(
      `Install clears ${prefixes.length} asset prefixes; kernel limit is ${KERNEL_INSTALL_MAX_CLEAR_PREFIXES_PER_COMMIT} per deployment. Install or remove apps across successive deployments`,
    );
  }
  return prefixes;
}

function requiresCompleteDeploymentBuildRecord(
  existingApps: AppRegistry,
): boolean {
  const version = existingApps.kernel?.version;
  return (
    typeof version === "number" &&
    Number.isSafeInteger(version) &&
    version >= KERNEL_LEGAL_CLEAR_BASELINE_VERSION
  );
}

function assertInstallRegistryMatchesCompile(
  apps: AppRegistry,
  browserSurfaceOriginAppIds: readonly string[],
  compiled: CompileResult,
): void {
  assertBrowserSurfaceOriginAppIdsMatch(
    apps,
    browserSurfaceOriginAppIds,
    compiled.browserSurfaceOriginAppIds,
  );
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

export function assertBrowserSurfaceOriginAppIdsMatch(
  apps: AppRegistry,
  actual: readonly string[],
  expected: readonly string[],
): void {
  const actualIds = normalizeBrowserSurfaceOriginAppIds(
    actual,
    Object.keys(apps),
  );
  const expectedIds = normalizeBrowserSurfaceOriginAppIds(
    expected,
    Object.keys(apps),
  );
  if (
    JSON.stringify(actualIds) !== JSON.stringify(expectedIds)
  ) {
    throw new Error(
      "Browser-surface origin sidecar does not match compile output",
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
  transportWasm,
  candid,
  deploymentId,
  persistenceMode,
}: {
  /** Exact deterministic gzip bytes already bound into the build record. */
  transportWasm: Uint8Array;
  candid: string;
  deploymentId: string;
  persistenceMode: NeutronPersistenceMode;
}): InstallCodeDispatch {
  const request = installCodeRequestWithTransport({
    transportWasm,
    candid,
    deploymentId,
    persistenceMode,
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
      wasm_memory_persistence: candidWasmMemoryPersistence(persistenceMode),
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
  persistenceMode = "classical",
}: {
  wasm: Uint8Array;
  candid: string;
  deploymentId: string;
  persistenceMode?: NeutronPersistenceMode;
}): KernelInstallCodeRequest {
  const { transportWasm } = prepareDeterministicWasmTransport(wasm);
  const request = installCodeRequestWithTransport({
    transportWasm,
    candid,
    deploymentId,
    persistenceMode,
  });
  if (!installCodeRequestFitsIngress(request)) {
    throw installCodeIngressError(request);
  }
  return request;
}

function installCodeRequestWithTransport({
  transportWasm,
  candid,
  deploymentId,
  persistenceMode,
}: {
  transportWasm: Uint8Array;
  candid: string;
  deploymentId: string;
  persistenceMode: NeutronPersistenceMode;
}): KernelInstallCodeRequest {
  return {
    wasm: transportWasm,
    candid,
    deployment_id: deploymentId,
    wasm_memory_persistence: candidWasmMemoryPersistence(persistenceMode),
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
    assertValidStagedAsset(input);
    if (byTarget.has(input.target)) {
      throw new Error(`Duplicate mutable install target ${input.target}`);
    }
    byTarget.set(input.target, input);
  }
  return [...byTarget.values()]
    .sort((a, b) => compareCanonicalText(a.target, b.target))
    .map((input, index) => ({
      ...input,
      // Take one immutable transaction snapshot before the first upload
      // awaits. Callers retain their package/archive byte arrays and may
      // otherwise mutate a later staged asset through an aliased reference.
      content: input.content.slice(),
      source: `/system/staging/${deploymentId}/assets/${index}`,
    }));
}

function assertSafeStagedAsset(input: StagedAssetInput): void {
  assertValidStagedAsset(input);
  if (
    input.target === "/mo" ||
    input.target.startsWith("/mo/") ||
    input.target === "/app" ||
    input.target.startsWith("/app/") ||
    input.target === "/system/staging" ||
    input.target.startsWith("/system/staging/")
  ) {
    throw new Error(`Reserved staged asset target ${input.target}`);
  }
}

function assertValidStagedAsset(input: StagedAssetInput): void {
  if (!(input.content instanceof Uint8Array)) {
    throw new Error(`Invalid staged asset content for ${input.target}`);
  }
  assertSafeAbsoluteInstallTarget(input.target);
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
  if (!isCanonicalAbsoluteInstallTarget(target)) {
    throw new Error(`Invalid staged asset target ${String(target)}`);
  }
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
  const target = path.startsWith("/")
    ? path
    : `/${path === "index.html" ? "" : path}`;
  assertSafeAbsoluteInstallTarget(target);
  return target;
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
    if (!isRecoverablePendingInstallAssembler(runtime.assembler_id)) {
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

function isRecoverablePendingInstallAssembler(assemblerId: string): boolean {
  // Recovery only commits an already-dispatched journal after the deployment
  // and complete app-instance inventory match. This one-generation bridge
  // finishes v25 work; it does not compile or adopt v26 browser origins.
  return assemblerId === ASSEMBLER_ID || isExactV25Bridge(assemblerId);
}

function isExactV25Bridge(assemblerId: string): boolean {
  return (
    ASSEMBLER_ID === "neutron_actor_v26" &&
    assemblerId === LEGACY_V25_ASSEMBLER_ID
  );
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
  const key = staticKey(keyOrPath);
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
  assertSafeAbsoluteInstallTarget(operation.key);
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
  let firstError: unknown;
  let hasError = false;
  let stopped = false;

  async function worker(): Promise<void> {
    while (!stopped && nextIndex < items.length) {
      const index = nextIndex++;
      const item = items[index];
      if (item === undefined) throw new Error(`Missing item at index ${index}`);
      try {
        results[index] = await mapper(item, index);
      } catch (error) {
        if (!hasError) firstError = error;
        hasError = true;
        stopped = true;
      }
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (hasError) throw firstError;
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
    avif: "image/avif",
    ico: "image/x-icon",
    svg: "image/svg+xml",
    html: "text/html",
    css: "text/css",
    js: "application/javascript",
    mjs: "application/javascript",
    json: "application/json",
    webmanifest: "application/manifest+json",
    wasm: "application/wasm",
    xml: "application/xml",
    txt: "text/plain",
    md: "text/markdown",
    vtt: "text/vtt",
    woff: "font/woff",
    woff2: "font/woff2",
    ttf: "font/ttf",
    otf: "font/otf",
    mp4: "video/mp4",
    webm: "video/webm",
    ogg: "video/ogg",
    ogv: "video/ogg",
    mov: "video/quicktime",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    m4a: "audio/mp4",
    aac: "audio/aac",
    flac: "audio/flac",
    oga: "audio/ogg",
    opus: "audio/ogg",
    weba: "audio/webm",
    eot: "application/vnd.ms-fontobject",
  };

  return types[extension] ?? "application/octet-stream";
}

function shouldGzip(contentType: string): boolean {
  return !contentType.startsWith("image/");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
