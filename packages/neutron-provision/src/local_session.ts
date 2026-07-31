import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { Principal } from "@dfinity/principal";
import {
  deriveNdeploySessionPath,
  ndeployConfigSha256,
  NDEPLOY_MAX_ARTIFACT_SET_BYTES,
  NDEPLOY_MAX_CONFIG_BYTES,
  parseNdeployConfig,
  resolveNdeployConfigPath,
} from "./config.ts";
import { localIdentityFromSeed } from "./kernel.ts";
import {
  localDeploymentNodes,
  readSessionSync,
} from "./session.ts";

export type LocalNeutronRuntime = {
  canisterId: string;
  canisterIds: string[];
  nodeLabel: string;
  nodeLabels: string[];
  nodeIndex: number;
  developerIdentityPrincipal: string;
  developerIdentitySeed: number;
  gatewayUrl: string;
  controlUrl: string;
  instanceId: number;
  sessionPath: string;
};

/** Resolve the deployed Neutron and PocketIC runtime from its one config journal. */
export function resolveLocalNeutronRuntime({
  configPath = process.env.NEUTRON_NDEPLOY_CONFIG ?? "local.ndeploy.json",
  nodeIndex = environmentNodeIndex(),
}: {
  configPath?: string;
  nodeIndex?: number;
} = {}): LocalNeutronRuntime {
  const resolvedConfigPath = resolveNdeployConfigPath(configPath);
  let configSource: string;
  try {
    configSource = readFileSync(resolvedConfigPath, "utf8");
  } catch (error) {
    throw new Error(
      `Local Neutron config is unavailable at ${resolvedConfigPath}`,
      { cause: error },
    );
  }
  if (Buffer.byteLength(configSource, "utf8") > NDEPLOY_MAX_CONFIG_BYTES) {
    throw new Error(
      `Local Neutron config ${resolvedConfigPath} exceeds the ${NDEPLOY_MAX_CONFIG_BYTES}-byte limit`,
    );
  }
  let configValue: unknown;
  try {
    configValue = JSON.parse(configSource) as unknown;
  } catch (error) {
    throw new Error(
      `Local Neutron config ${resolvedConfigPath} is not valid JSON`,
      { cause: error },
    );
  }
  const config = parseNdeployConfig(configValue);
  if (config.target.kind !== "pocketic") {
    throw new Error(
      `Local Neutron config ${resolvedConfigPath} must target PocketIC`,
    );
  }
  const developerIdentitySeed = config.target.developer_identity_seed;
  const developerIdentityPrincipal = localIdentityFromSeed(developerIdentitySeed)
    .getPrincipal()
    .toText();
  const artifactSetSource =
    config.artifacts.kind === "file"
      ? readLocalArtifactSetSource(
          resolvedConfigPath,
          config.artifacts.path,
        )
      : undefined;
  const configSha256 = ndeployConfigSha256(configSource, artifactSetSource);
  const sessionPath = deriveNdeploySessionPath(resolvedConfigPath);

  const journal = readSessionSync(sessionPath);
  if (journal === null) {
    throw new Error(
      `Local Neutron session is unavailable at ${sessionPath}; run the provisioner for ${resolvedConfigPath}`,
    );
  }
  if (journal.configSha256 !== configSha256) {
    throw new Error(
      `Local Neutron session ${sessionPath} does not match config ${resolvedConfigPath}; rerun the provisioner for that config`,
    );
  }
  const runtime = journal.runtime;
  if (runtime.kind !== "pocketic") {
    throw new Error(`Local Neutron session ${sessionPath} is not a PocketIC session`);
  }
  if (runtime.profile !== config.target.profile) {
    throw new Error(
      `Local Neutron session ${sessionPath} profile does not match config ${resolvedConfigPath}`,
    );
  }
  const gatewayUrl = canonicalHttpUrl(
    runtime.gateway.url,
    `${sessionPath}.runtime.gateway.url`,
  );
  const controlUrl = canonicalHttpUrl(
    runtime.controlUrl,
    `${sessionPath}.runtime.controlUrl`,
  );
  const current = journal.current;
  if (current?.kind !== "local") {
    throw new Error(
      `Local Neutron session ${sessionPath} has no completed local deployment`,
    );
  }
  const nodes = localDeploymentNodes(journal).map((node, index) => ({
    label: node.label,
    canisterId: canonicalCanisterId(
      node.canisterId,
      `${sessionPath}.localFleet.nodes[${index}].canisterId`,
    ),
  }));
  const canisterIds = nodes.map(({ canisterId }) => canisterId);
  const expectedLabels = config.target.nodes;
  if (nodes.length !== expectedLabels.length) {
    throw new Error(
      `Local Neutron session ${sessionPath} records ${nodes.length} node${nodes.length === 1 ? "" : "s"}, but config ${resolvedConfigPath} requires ${expectedLabels.length}`,
    );
  }
  if (nodes.some((node, index) => node.label !== expectedLabels[index])) {
    throw new Error(
      `Local Neutron session ${sessionPath} node labels do not match config ${resolvedConfigPath}`,
    );
  }
  if (
    !Number.isSafeInteger(nodeIndex) ||
    nodeIndex < 0 ||
    nodeIndex >= canisterIds.length
  ) {
    throw new Error(
      `Local Neutron node index must be from 0 through ${canisterIds.length - 1}`,
    );
  }
  return {
    canisterId: canisterIds[nodeIndex]!,
    canisterIds,
    nodeLabel: expectedLabels[nodeIndex]!,
    nodeLabels: [...expectedLabels],
    nodeIndex,
    developerIdentityPrincipal,
    developerIdentitySeed,
    gatewayUrl,
    controlUrl,
    instanceId: runtime.instanceId,
    sessionPath,
  };
}

export function resolveLocalNeutronCanisterId(options: {
  configPath?: string;
  nodeIndex?: number;
} = {}): string {
  return resolveLocalNeutronRuntime(options).canisterId;
}

function readLocalArtifactSetSource(
  configPath: string,
  relativePath: string,
): string {
  const directory = path.dirname(configPath);
  const resolved = path.resolve(directory, relativePath);
  const lexicalRelative = path.relative(directory, resolved);
  if (!containedRelativePath(lexicalRelative)) {
    throw new Error("Local Neutron artifact-set path escapes its config directory");
  }
  let canonicalDirectory: string;
  let canonicalFile: string;
  try {
    canonicalDirectory = realpathSync(directory);
    canonicalFile = realpathSync(resolved);
  } catch (error) {
    throw new Error(`Local Neutron artifact set is unavailable at ${resolved}`, {
      cause: error,
    });
  }
  if (
    !containedRelativePath(
      path.relative(canonicalDirectory, canonicalFile),
    )
  ) {
    throw new Error("Local Neutron artifact-set path escapes its config directory");
  }
  const source = readFileSync(canonicalFile, "utf8");
  if (Buffer.byteLength(source, "utf8") > NDEPLOY_MAX_ARTIFACT_SET_BYTES) {
    throw new Error(
      `Local Neutron artifact set ${canonicalFile} exceeds the ${NDEPLOY_MAX_ARTIFACT_SET_BYTES}-byte limit`,
    );
  }
  return source;
}

function containedRelativePath(relativePath: string): boolean {
  return (
    relativePath !== ".." &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
  );
}

function environmentNodeIndex(): number {
  const value = process.env.NEUTRON_LOCAL_NODE_INDEX;
  if (value === undefined) return 0;
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error("NEUTRON_LOCAL_NODE_INDEX must be a zero-based integer");
  }
  return Number(value);
}

function canonicalCanisterId(value: string, label: string): string {
  let principal: Principal;
  try {
    principal = Principal.fromText(value);
  } catch (error) {
    throw new Error(`${label} must be a valid canister principal`, { cause: error });
  }
  if (principal.isAnonymous() || principal.toText() === "aaaaa-aa") {
    throw new Error(`${label} must identify a non-management canister`);
  }
  return principal.toText();
}

function canonicalHttpUrl(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be an HTTP URL`);
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error(`${label} must be an HTTP URL`, { cause: error });
  }
  if (url.protocol !== "http:" || url.username || url.password) {
    throw new Error(`${label} must be an unauthenticated HTTP URL`);
  }
  return url.href;
}
