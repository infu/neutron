import { Principal } from "@dfinity/principal";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import {
  inspectPinnedPackageArchives,
  type PinnedPackageArtifact,
} from "./artifact.ts";
import { canonicalNonAnonymousPrincipal } from "./ic_client.ts";
import { DEPLOYMENT_PRICING_PROFILE_V1 } from "./deployment_evidence.ts";
import {
  IC_MAINNET_ROOT_KEY_SHA256,
  IC_REGISTRY_CANISTER_ID_V1,
  IC_REGISTRY_EVIDENCE_SOURCE_V1,
} from "./ic_registry_evidence.ts";
import {
  parseLocalEnvironment,
  type LocalEnvironment,
} from "./local_environment.ts";

export const NDEPLOY_CONFIG_FORMAT = 3;
export const NDEPLOY_ARTIFACT_SET_FORMAT = 1;
export const NDEPLOY_CONFIG_SUFFIX = ".ndeploy.json";
export const NDEPLOY_SESSION_SUFFIX = ".ndeploy.session.json";
export const NDEPLOY_POCKETIC_GATEWAY_PORT = 8000;
export const NDEPLOY_MAX_LOCAL_NEUTRONS = 16;
const CONFIG_FIELDS = [
  "format",
  "target",
  "artifacts",
] as const;

const IC_TARGET_FIELDS = [
  "kind",
  "host",
  "identity_id",
  "subnet",
  "payment_icp",
  "controllers",
  "deployment_evidence",
] as const;
const IC_DEPLOYMENT_EVIDENCE_FIELDS = [
  "source",
  "registry_canister",
  "root_key_sha256",
  "pricing_profile",
] as const;
const POCKETIC_TARGET_FIELDS = [
  "kind",
  "profile",
  "gateway_port",
  "developer_identity_seed",
  "authorized_principals",
  "nodes",
] as const;
const PINNED_ARCHIVE_FIELDS = [
  "path",
  "sha256",
  "bytes",
  "id",
  "version",
] as const;
const NODE_LABEL_PATTERN = /^[a-z][a-z0-9-]{0,31}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export const NDEPLOY_MAX_CONFIG_BYTES = 1024 * 1024;
export const NDEPLOY_MAX_ARTIFACT_SET_BYTES = 1024 * 1024;
// The kernel consumes one of the compiler/runtime's 256 package slots.
const MAX_PACKAGES = 255;
const MAX_CONTROLLERS = 8;
const MAX_STRING_LENGTH = 4096;

export type NdeployConfig = {
  format: 3;
  target: NdeployTargetConfig;
  artifacts: NdeployArtifactsConfig;
};

export type NdeployTargetConfig = NdeployIcTargetConfig | NdeployPocketIcTargetConfig;

export type NdeployIcTargetConfig = {
  kind: "ic";
  host: string;
  identity_id: number;
  subnet: string;
  payment_icp: string;
  controllers: string[];
  deployment_evidence: NdeployIcDeploymentEvidenceConfig;
};

export type NdeployIcDeploymentEvidenceConfig = {
  source: typeof IC_REGISTRY_EVIDENCE_SOURCE_V1;
  registry_canister: typeof IC_REGISTRY_CANISTER_ID_V1;
  root_key_sha256: typeof IC_MAINNET_ROOT_KEY_SHA256;
  pricing_profile: typeof DEPLOYMENT_PRICING_PROFILE_V1;
};

export type NdeployPocketIcTargetConfig = {
  kind: "pocketic";
  profile: LocalEnvironment;
  gateway_port: number;
  developer_identity_seed: number;
  authorized_principals: string[];
  nodes: string[];
};

export type NdeployPinnedArchiveConfig = {
  path: string;
  sha256: string;
  bytes: number;
  id: string;
  version: number;
};

/** PocketIC archives are intentionally rebuildable developer inputs. */
export type NdeployLocalArchiveConfig = { path: string };

export type NdeployArtifactSet = {
  format: 1;
  kernel: NdeployPinnedArchiveConfig;
  packages: NdeployPinnedArchiveConfig[];
};

type NdeployArchiveDeclarationSet = {
  format: 1;
  kernel: NdeployLocalArchiveConfig;
  packages: NdeployLocalArchiveConfig[];
};

export type NdeployPinnedInlineArtifactsConfig = {
  kind: "inline";
  kernel: NdeployPinnedArchiveConfig;
  packages: NdeployPinnedArchiveConfig[];
};

export type NdeployLocalInlineArtifactsConfig = {
  kind: "inline";
  kernel: NdeployLocalArchiveConfig;
  packages: NdeployLocalArchiveConfig[];
};

export type NdeployExternalArtifactsConfig = {
  kind: "file";
  path: string;
};

export type NdeployArtifactsConfig =
  | NdeployPinnedInlineArtifactsConfig
  | NdeployLocalInlineArtifactsConfig
  | NdeployExternalArtifactsConfig;

export type LoadedNdeployConfig = {
  configPath: string;
  configSha256: string;
  sessionPath: string;
  /**
   * Exact independently declared pins. Empty for a PocketIC path-only inline
   * config, whose archives are intentionally not touched until reinstall.
   */
  packageArtifacts: PinnedPackageArtifact[];
  /** Ordered relative archive paths for a PocketIC path-only inline config. */
  localPackagePaths?: string[];
  target: LoadedNdeployTarget;
};

export type LoadedNdeployTarget = LoadedIcTarget | LoadedPocketIcTarget;

export type LoadedIcTarget = {
  kind: "ic";
  host: string;
  identityId: number;
  targetSubnet: string;
  amountE8s: bigint;
  controllers: string[];
  deploymentEvidence: NdeployIcDeploymentEvidenceConfig;
};

export type LoadedPocketIcTarget = {
  kind: "pocketic";
  profile: LocalEnvironment;
  gatewayPort: number;
  developerIdentitySeed: number;
  authorizedPrincipals: string[];
  nodeLabels: string[];
  stateDirectory: string;
};

export async function loadNdeployConfig(
  filename: string,
): Promise<LoadedNdeployConfig> {
  const configPath = resolveNdeployConfigPath(filename);
  let source: string;
  try {
    source = await readFile(configPath, "utf8");
  } catch (error) {
    throw new Error(`Unable to read deployment config ${configPath}`, {
      cause: error,
    });
  }
  if (Buffer.byteLength(source, "utf8") > NDEPLOY_MAX_CONFIG_BYTES) {
    throw new Error(
      `Deployment config ${configPath} exceeds the ${NDEPLOY_MAX_CONFIG_BYTES}-byte limit`,
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(`Deployment config ${configPath} is not valid JSON`, {
      cause: error,
    });
  }
  const config = parseNdeployConfig(value);
  const configDirectory = path.dirname(configPath);
  const repositoryRoot = await findRepositoryRoot(configDirectory);
  const loadedArtifactSet = await loadArtifactSet(
    config.artifacts,
    configDirectory,
  );
  const archiveDeclarations = [
    loadedArtifactSet.artifactSet.kernel,
    ...loadedArtifactSet.artifactSet.packages,
  ];
  const localPackagePaths =
    config.target.kind === "pocketic" &&
    config.artifacts.kind === "inline"
    ? archiveDeclarations.map(({ path: archivePath }) => archivePath)
    : undefined;
  if (localPackagePaths !== undefined) {
    const lexicalPaths = localPackagePaths.map((archivePath, index) => {
      const resolved = path.resolve(configDirectory, archivePath);
      if (!isContainedPath(path.relative(configDirectory, resolved))) {
        throw new Error(
          `artifacts.${index === 0 ? "kernel.path" : `packages[${index - 1}].path`} must stay within the deployment config directory`,
        );
      }
      return resolved;
    });
    assertUnique(lexicalPaths, "archive paths");
  }
  const inspected =
    localPackagePaths !== undefined
      ? { artifacts: [], packages: [] }
      : await inspectPinnedPackageArchives(
          await Promise.all(
            archiveDeclarations.map(async (artifact, index) => {
              if (!("sha256" in artifact)) {
                throw new Error(
                  `artifacts.${index === 0 ? "kernel" : `packages[${index - 1}]`} must contain complete integrity pins`,
                );
              }
              const pinned = artifact as NdeployPinnedArchiveConfig;
              return {
                ...pinned,
                path: await resolveContainedFile(
                  configDirectory,
                  pinned.path,
                  index === 0
                    ? "artifacts.kernel.path"
                    : `artifacts.packages[${index - 1}].path`,
                ),
              };
            }),
          ),
        );
  assertUnique(inspected.artifacts.map(({ id }) => id), "package IDs");
  const effectiveConfigSha256 = ndeployConfigSha256(
    source,
    loadedArtifactSet.source,
  );

  return {
    configPath,
    configSha256: effectiveConfigSha256,
    sessionPath: deriveNdeploySessionPath(configPath),
    packageArtifacts: inspected.artifacts,
    ...(localPackagePaths === undefined ? {} : { localPackagePaths }),
    target: await loadTarget(config.target, repositoryRoot),
  };
}

export function ndeployConfigSha256(
  configSource: string,
  artifactSetSource?: string,
): string {
  return createHash("sha256")
    .update("neutron-ndeploy-effective-config-v3\0")
    .update(String(Buffer.byteLength(configSource, "utf8")))
    .update("\0")
    .update(configSource)
    .update("\0")
    .update(artifactSetSource ?? "")
    .digest("hex");
}

export function parseNdeployConfig(value: unknown): NdeployConfig {
  if (!isPlainRecord(value)) {
    throw new Error("Deployment config must be a JSON object");
  }
  assertExactFields(value, CONFIG_FIELDS, "Deployment config");
  if (value.format !== NDEPLOY_CONFIG_FORMAT) {
    throw new Error(
      `Deployment config format must be ${NDEPLOY_CONFIG_FORMAT}`,
    );
  }

  const target = requiredTargetConfig(value.target);
  return {
    format: NDEPLOY_CONFIG_FORMAT,
    target,
    artifacts: requiredArtifactsConfig(value.artifacts, target.kind),
  };
}

function requiredTargetConfig(value: unknown): NdeployTargetConfig {
  if (!isPlainRecord(value)) {
    throw new Error("target must be an object");
  }
  if (value.kind === "ic") {
    assertExactFields(value, IC_TARGET_FIELDS, "target");
    return {
      kind: "ic",
      host: requiredString(value.host, "target.host"),
      identity_id: parseIdentityId(
        requiredInteger(value.identity_id, "target.identity_id"),
      ),
      subnet: requiredString(value.subnet, "target.subnet"),
      payment_icp: requiredString(value.payment_icp, "target.payment_icp"),
      controllers: requiredStringArray(
        value.controllers,
        "target.controllers",
        MAX_CONTROLLERS,
      ),
      deployment_evidence: requiredIcDeploymentEvidenceConfig(
        value.deployment_evidence,
      ),
    };
  }
  if (value.kind === "pocketic") {
    assertExactFields(value, POCKETIC_TARGET_FIELDS, "target");
    const gatewayPort = requiredPort(value.gateway_port, "target.gateway_port");
    if (gatewayPort !== NDEPLOY_POCKETIC_GATEWAY_PORT) {
      throw new Error(
        `target.gateway_port must be ${NDEPLOY_POCKETIC_GATEWAY_PORT}`,
      );
    }
    return {
      kind: "pocketic",
      profile: parseLocalEnvironment(
        value.profile,
        "target.profile",
      ),
      gateway_port: gatewayPort,
      developer_identity_seed: requiredIdentitySeed(
        value.developer_identity_seed,
        "target.developer_identity_seed",
      ),
      authorized_principals: requiredStringArray(
        value.authorized_principals,
        "target.authorized_principals",
      ),
      nodes: requiredNodeLabels(value.nodes, "target.nodes"),
    };
  }
  throw new Error("target.kind must be ic or pocketic");
}

async function loadTarget(
  target: NdeployTargetConfig,
  repositoryRoot: string,
): Promise<LoadedNdeployTarget> {
  if (target.kind === "ic") {
    const controllers = target.controllers.map((controller, index) =>
      canonicalPrincipal(controller, `target.controllers[${index}]`),
    );
    assertUnique(controllers, "controllers");
    return {
      kind: "ic",
      host: normalizeHost(target.host),
      identityId: parseIdentityId(target.identity_id),
      targetSubnet: canonicalPrincipal(target.subnet, "target.subnet"),
      amountE8s: parseIcp(target.payment_icp),
      controllers,
      deploymentEvidence: target.deployment_evidence,
    };
  }
  const authorizedPrincipals = target.authorized_principals.map(
    (principal, index) =>
      canonicalPrincipal(principal, `target.authorized_principals[${index}]`),
  );
  assertUnique(authorizedPrincipals, "authorized principals");
  return {
    kind: "pocketic",
    profile: target.profile,
    gatewayPort: target.gateway_port,
    developerIdentitySeed: target.developer_identity_seed,
    authorizedPrincipals,
    nodeLabels: [...target.nodes],
    stateDirectory: path.join(repositoryRoot, ".neutron", "pocketic"),
  };
}

function requiredIcDeploymentEvidenceConfig(
  value: unknown,
): NdeployIcDeploymentEvidenceConfig {
  const label = "target.deployment_evidence";
  if (!isPlainRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  assertExactFields(value, IC_DEPLOYMENT_EVIDENCE_FIELDS, label);
  if (value.source !== IC_REGISTRY_EVIDENCE_SOURCE_V1) {
    throw new Error(
      `${label}.source must be ${IC_REGISTRY_EVIDENCE_SOURCE_V1}`,
    );
  }
  if (value.registry_canister !== IC_REGISTRY_CANISTER_ID_V1) {
    throw new Error(
      `${label}.registry_canister must be ${IC_REGISTRY_CANISTER_ID_V1}`,
    );
  }
  if (value.root_key_sha256 !== IC_MAINNET_ROOT_KEY_SHA256) {
    throw new Error(
      `${label}.root_key_sha256 must be ${IC_MAINNET_ROOT_KEY_SHA256}`,
    );
  }
  if (value.pricing_profile !== DEPLOYMENT_PRICING_PROFILE_V1) {
    throw new Error(
      `${label}.pricing_profile must be ${DEPLOYMENT_PRICING_PROFILE_V1}`,
    );
  }
  return {
    source: IC_REGISTRY_EVIDENCE_SOURCE_V1,
    registry_canister: IC_REGISTRY_CANISTER_ID_V1,
    root_key_sha256: IC_MAINNET_ROOT_KEY_SHA256,
    pricing_profile: DEPLOYMENT_PRICING_PROFILE_V1,
  };
}

async function findRepositoryRoot(start: string): Promise<string> {
  let directory = path.resolve(start);
  for (;;) {
    try {
      const source = await readFile(path.join(directory, "package.json"), "utf8");
      const manifest = JSON.parse(source) as unknown;
      if (
        typeof manifest === "object" &&
        manifest !== null &&
        "workspaces" in manifest
      ) {
        return directory;
      }
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return path.resolve(start);
    directory = parent;
  }
}

export function resolveNdeployConfigPath(filename: string): string {
  if (!filename.endsWith(NDEPLOY_CONFIG_SUFFIX)) {
    throw new Error(
      `Deployment config path must end with ${NDEPLOY_CONFIG_SUFFIX}`,
    );
  }
  return path.resolve(filename);
}

export function deriveNdeploySessionPath(configPath: string): string {
  const resolved = resolveNdeployConfigPath(configPath);
  return `${resolved.slice(0, -NDEPLOY_CONFIG_SUFFIX.length)}${NDEPLOY_SESSION_SUFFIX}`;
}

/**
 * Resolve PocketIC archives at the reinstall boundary. Inline local inputs are
 * path-only; an external release set remains independently pinned.
 */
export async function resolveLocalPackagePaths(
  config: LoadedNdeployConfig,
): Promise<string[]> {
  if (config.target.kind !== "pocketic") {
    throw new Error("Local package paths require a PocketIC deployment config");
  }
  if (config.localPackagePaths === undefined) {
    return config.packageArtifacts.map(({ path: artifactPath }) => artifactPath);
  }
  if (
    config.packageArtifacts.length !== 0 ||
    config.localPackagePaths.length < 1
  ) {
    throw new Error("Malformed PocketIC path-only archive selection");
  }
  const configDirectory = path.dirname(config.configPath);
  const declarations = [...config.localPackagePaths];
  const resolved = await Promise.all(
    declarations.map((archivePath, index) =>
      resolveContainedFile(
        configDirectory,
        archivePath,
        index === 0
          ? "artifacts.kernel.path"
          : `artifacts.packages[${index - 1}].path`,
      ),
    ),
  );
  assertUnique(resolved, "archive paths");
  return resolved;
}

export function parseIcp(value: string): bigint {
  const match = value.match(/^(0|[1-9]\d*)(?:\.(\d{1,8}))?$/);
  if (!match) {
    throw new Error(
      "payment_icp must be a plain positive ICP decimal with at most eight fractional digits",
    );
  }
  const whole = BigInt(match[1]!);
  const fraction = BigInt((match[2] ?? "").padEnd(8, "0") || "0");
  const e8s = whole * 100_000_000n + fraction;
  if (e8s <= 0n) throw new Error("payment_icp must be greater than zero");
  return e8s;
}

export function normalizeHost(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error("host must be a valid HTTPS IC API origin", { cause: error });
  }
  if (url.protocol !== "https:") {
    throw new Error("host must be an HTTPS IC API origin");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error(
      "host must be a bare HTTPS origin without credentials or a path",
    );
  }
  return url.origin;
}

function parseIdentityId(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 65_535) {
    throw new Error("identity_id must be an integer from 0 through 65535");
  }
  return value;
}

function canonicalPrincipal(value: string, label: string): string {
  try {
    return canonicalNonAnonymousPrincipal(value, label);
  } catch {
    const principal = (() => {
      try {
        return Principal.fromText(value);
      } catch {
        return null;
      }
    })();
    if (principal?.isAnonymous()) {
      throw new Error(`${label} must not be the anonymous principal`);
    }
    throw new Error(`${label} must be a valid principal`);
  }
}

function isContainedPath(relative: string): boolean {
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function requiredArtifactsConfig(
  value: unknown,
  targetKind: NdeployTargetConfig["kind"],
): NdeployArtifactsConfig {
  const label = "artifacts";
  if (!isPlainRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  if (value.kind === "inline") {
    assertExactFields(value, ["kind", "kernel", "packages"], label);
    if (targetKind === "pocketic") {
      const kernel = requiredLocalArchive(
        value.kernel,
        `${label}.kernel`,
      );
      const packages = requiredLocalArchiveArray(
        value.packages,
        `${label}.packages`,
      );
      return {
        kind: "inline",
        kernel,
        packages,
      };
    }
    return {
      kind: "inline",
      kernel: requiredPinnedArchive(value.kernel, `${label}.kernel`),
      packages: requiredPinnedArchiveArray(
        value.packages,
        `${label}.packages`,
      ),
    };
  }
  if (value.kind === "file") {
    assertExactFields(value, ["kind", "path"], label);
    return {
      kind: "file",
      path: requiredRelativePath(value.path, `${label}.path`),
    };
  }
  throw new Error(`${label}.kind must be inline or file`);
}

function requiredLocalArchive(
  value: unknown,
  label: string,
): NdeployLocalArchiveConfig {
  if (!isPlainRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  assertExactFields(value, ["path"], label);
  return {
    path: requiredRelativePath(value.path, `${label}.path`),
  };
}

function requiredLocalArchiveArray(
  value: unknown,
  label: string,
): NdeployLocalArchiveConfig[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array of local archives`);
  }
  if (value.length > MAX_PACKAGES) {
    throw new Error(`${label} must contain at most ${MAX_PACKAGES} entries`);
  }
  return value.map((entry, index) =>
    requiredLocalArchive(entry, `${label}[${index}]`),
  );
}

function requiredArtifactSet(value: unknown, label: string): NdeployArtifactSet {
  if (!isPlainRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  assertExactFields(value, ["format", "kernel", "packages"], label);
  if (value.format !== NDEPLOY_ARTIFACT_SET_FORMAT) {
    throw new Error(
      `${label}.format must be ${NDEPLOY_ARTIFACT_SET_FORMAT}`,
    );
  }
  return {
    format: NDEPLOY_ARTIFACT_SET_FORMAT,
    kernel: requiredPinnedArchive(value.kernel, `${label}.kernel`),
    packages: requiredPinnedArchiveArray(
      value.packages,
      `${label}.packages`,
    ),
  };
}

function requiredPinnedArchive(
  value: unknown,
  label: string,
): NdeployPinnedArchiveConfig {
  if (!isPlainRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  assertExactFields(value, PINNED_ARCHIVE_FIELDS, label);
  const digest = requiredString(value.sha256, `${label}.sha256`);
  if (!SHA256_PATTERN.test(digest)) {
    throw new Error(`${label}.sha256 must be a lowercase SHA-256 digest`);
  }
  const bytes = requiredInteger(value.bytes, `${label}.bytes`);
  if (!Number.isSafeInteger(bytes) || bytes < 1) {
    throw new Error(`${label}.bytes must be a positive safe integer`);
  }
  const version = requiredInteger(value.version, `${label}.version`);
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new Error(`${label}.version must be a non-negative safe integer`);
  }
  return {
    path: requiredRelativePath(value.path, `${label}.path`),
    sha256: digest,
    bytes,
    id: requiredString(value.id, `${label}.id`),
    version,
  };
}

function requiredPinnedArchiveArray(
  value: unknown,
  label: string,
): NdeployPinnedArchiveConfig[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array of pinned archives`);
  }
  if (value.length > MAX_PACKAGES) {
    throw new Error(`${label} must contain at most ${MAX_PACKAGES} entries`);
  }
  return value.map((entry, index) =>
    requiredPinnedArchive(entry, `${label}[${index}]`),
  );
}

async function loadArtifactSet(
  config: NdeployArtifactsConfig,
  configDirectory: string,
): Promise<{ artifactSet: NdeployArchiveDeclarationSet; source?: string }> {
  if (config.kind === "inline") {
    return {
      artifactSet: {
        format: NDEPLOY_ARTIFACT_SET_FORMAT,
        kernel: config.kernel,
        packages: config.packages,
      },
    };
  }
  const artifactSetPath = await resolveContainedFile(
    configDirectory,
    config.path,
    "artifacts.path",
  );
  let source: string;
  try {
    source = await readFile(artifactSetPath, "utf8");
  } catch (error) {
    throw new Error(
      `Unable to read external artifact set ${artifactSetPath}. Publish it in the trusted packaging phase before provisioning.`,
      { cause: error },
    );
  }
  if (Buffer.byteLength(source, "utf8") > NDEPLOY_MAX_ARTIFACT_SET_BYTES) {
    throw new Error(
      `External artifact set ${artifactSetPath} exceeds the ${NDEPLOY_MAX_ARTIFACT_SET_BYTES}-byte limit`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(`External artifact set ${artifactSetPath} is not valid JSON`, {
      cause: error,
    });
  }
  return {
    artifactSet: requiredArtifactSet(
      value,
      `external artifact set ${artifactSetPath}`,
    ),
    source,
  };
}

async function resolveContainedFile(
  configDirectory: string,
  relativePath: string,
  label: string,
): Promise<string> {
  const resolved = path.resolve(configDirectory, relativePath);
  const lexicalRelative = path.relative(configDirectory, resolved);
  if (!isContainedPath(lexicalRelative)) {
    throw new Error(`${label} must stay within the deployment config directory`);
  }
  let canonicalDirectory: string;
  let canonicalFile: string;
  try {
    [canonicalDirectory, canonicalFile] = await Promise.all([
      realpath(configDirectory),
      realpath(resolved),
    ]);
  } catch (error) {
    if (isMissingFileError(error)) {
      throw new Error(
        `${label} does not exist. Produce the pinned archive or publish the external artifact set before provisioning.`,
        { cause: error },
      );
    }
    throw error;
  }
  if (!isContainedPath(path.relative(canonicalDirectory, canonicalFile))) {
    throw new Error(`${label} escapes the deployment config directory`);
  }
  const metadata = await lstat(canonicalFile);
  if (!metadata.isFile()) {
    throw new Error(`${label} must resolve to a regular file`);
  }
  return canonicalFile;
}

function requiredRelativePath(value: unknown, label: string): string {
  const relative = requiredString(value, label);
  if (relative.includes("\0")) {
    throw new Error(`${label} must not contain a NUL byte`);
  }
  if (path.isAbsolute(relative)) {
    throw new Error(`${label} must be relative to the deployment config`);
  }
  return relative;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (value.length > MAX_STRING_LENGTH) {
    throw new Error(`${label} must be at most ${MAX_STRING_LENGTH} characters`);
  }
  return value;
}

function requiredInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${label} must be an integer`);
  }
  return value;
}

function requiredPort(value: unknown, label: string): number {
  const port = requiredInteger(value, label);
  if (port < 1 || port > 65_535) {
    throw new Error(`${label} must be an integer from 1 through 65535`);
  }
  return port;
}

function requiredIdentitySeed(value: unknown, label: string): number {
  const seed = requiredInteger(value, label);
  if (seed < 0 || seed > 255) {
    throw new Error(`${label} must be an integer from 0 through 255`);
  }
  return seed;
}

function requiredStringArray(
  value: unknown,
  label: string,
  maximum = MAX_PACKAGES,
): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array of strings`);
  }
  if (value.length > maximum) {
    throw new Error(`${label} must contain at most ${maximum} entries`);
  }
  return value.map((entry, index) => requiredString(entry, `${label}[${index}]`));
}

function requiredNodeLabels(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > NDEPLOY_MAX_LOCAL_NEUTRONS
  ) {
    throw new Error(
      `${label} must contain 1 through ${NDEPLOY_MAX_LOCAL_NEUTRONS} labels`,
    );
  }
  const labels = value.map((entry, index) => {
    const nodeLabel = requiredString(entry, `${label}[${index}]`);
    if (!NODE_LABEL_PATTERN.test(nodeLabel)) {
      throw new Error(
        `${label}[${index}] must start with a lowercase letter and contain only lowercase letters, digits, or hyphens`,
      );
    }
    return nodeLabel;
  });
  if (new Set(labels).size !== labels.length) {
    throw new Error(`${label} must not contain duplicate labels`);
  }
  return labels;
}

function assertExactFields(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
  optional: readonly string[] = [],
): void {
  const expectedSet = new Set([...expected, ...optional]);
  const unknown = Object.keys(value).filter((key) => !expectedSet.has(key));
  const missing = expected.filter(
    (key) => !Object.prototype.hasOwnProperty.call(value, key),
  );
  if (unknown.length > 0) {
    throw new Error(`${label} has unknown field(s): ${unknown.join(", ")}`);
  }
  if (missing.length > 0) {
    throw new Error(`${label} is missing field(s): ${missing.join(", ")}`);
  }
}

function assertUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`Deployment config contains duplicate ${label}`);
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
