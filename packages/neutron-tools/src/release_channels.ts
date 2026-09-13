import { Principal } from "@icp-sdk/core/principal";
import {
  NEUTRON_REPOSITORY_PROTOCOL,
  REPOSITORY_LIMITS,
  RepositoryProtocolError,
  parseRepositoryManifest,
  parseRepositoryReleaseRecord,
  repositoryReleasePath,
  validateDigest,
  validateManifestId,
  type RepositoryManifest,
  type RepositoryReleaseRecord,
} from "./repository.ts";
import { assertNoDuplicateJsonObjectKeys } from "./strict_json.ts";

export const REPOSITORY_CHANNELS_PROTOCOL = "neutron-repo-channels-v1" as const;
export const REPOSITORY_CHANNEL_HEADS_PROTOCOL = "neutron-repo-channel-heads-v1" as const;
export const REPOSITORY_CHANNEL_SELECTION_PROTOCOL = "neutron-repo-channel-selection-v1" as const;
export const REPOSITORY_CHANNEL_MANIFEST_PROTOCOL = "neutron-repo-channel-manifest-v1" as const;

export type RepositoryReleaseChannel = "stable" | "beta";
export type RepositoryChannelManifest = Omit<RepositoryManifest, "protocol"> & {
  protocol: typeof REPOSITORY_CHANNEL_MANIFEST_PROTOCOL;
  channel: "beta";
};
export type RepositorySetupManifest = RepositoryManifest | RepositoryChannelManifest;
export type RepositoryChannelsDescriptor = {
  protocol: typeof REPOSITORY_CHANNELS_PROTOCOL;
  source: string;
};
export type RepositoryChannelHead = {
  revision: string;
  candidate_id: string | null;
  release: RepositoryReleaseRecord | null;
};
export type RepositoryChannelHeads = {
  protocol: typeof REPOSITORY_CHANNEL_HEADS_PROTOCOL;
  source: string;
  id: string;
  stable: RepositoryChannelHead;
  beta: RepositoryChannelHead;
};
export type RepositoryChannelSelectionPackage = {
  id: string;
  candidate_id: string;
  version: number;
  sha256: string;
  size: number;
  channel: RepositoryReleaseChannel;
  revision: string;
};
export type RepositoryChannelSelection = {
  protocol: typeof REPOSITORY_CHANNEL_SELECTION_PROTOCOL;
  source: string;
  mode: RepositoryReleaseChannel;
  manifest_id: string;
  manifest_sha256: string;
  packages: RepositoryChannelSelectionPackage[];
};
export type SelectedRepositoryChannelRelease = {
  channel: RepositoryReleaseChannel;
  head: RepositoryChannelHead & { candidate_id: string; release: RepositoryReleaseRecord };
};

export function repositoryChannelsPath(): string {
  return "/repo/v1/channels.json";
}
export function repositoryBetaReleasePath(id: string): string {
  return `/repo/v1/channels/beta/releases/${appId(id)}.json`;
}
export function repositoryChannelHeadsPath(id: string): string {
  return `/repo/v1/channels/apps/${appId(id)}.json`;
}
export function repositoryChannelSelectionPath(id: string): string {
  return `/repo/v1/channels/manifests/${validateManifestId(id)}.json`;
}

/** Parsing validates structure. Callers must separately verify the source's proof. */
export function parseRepositoryChannelsDescriptor(value: unknown): RepositoryChannelsDescriptor {
  const record = exact(json(value), ["protocol", "source"]);
  protocol(record.protocol, REPOSITORY_CHANNELS_PROTOCOL);
  return { protocol: REPOSITORY_CHANNELS_PROTOCOL, source: sourcePrincipal(record.source) };
}

export function parseRepositoryChannelHeads(value: unknown): RepositoryChannelHeads {
  const record = exact(json(value), ["protocol", "source", "id", "stable", "beta"]);
  protocol(record.protocol, REPOSITORY_CHANNEL_HEADS_PROTOCOL);
  const id = appId(record.id);
  const heads: RepositoryChannelHeads = {
    protocol: REPOSITORY_CHANNEL_HEADS_PROTOCOL,
    source: sourcePrincipal(record.source),
    id,
    stable: parseHead(record.stable, id),
    beta: parseHead(record.beta, id),
  };
  const stable = heads.stable.release, beta = heads.beta.release;
  if (stable && beta && stable.version === beta.version && !sameRelease(stable, beta)) {
    invalid("The channels advertise different bytes for the same app version.");
  }
  return heads;
}

export function parseRepositoryChannelSelection(value: unknown): RepositoryChannelSelection {
  const record = exact(json(value), ["protocol", "source", "mode", "manifest_id", "manifest_sha256", "packages"]);
  protocol(record.protocol, REPOSITORY_CHANNEL_SELECTION_PROTOCOL);
  const mode = channel(record.mode);
  if (!Array.isArray(record.packages) || record.packages.length === 0 || record.packages.length > REPOSITORY_LIMITS.packagesPerManifest) {
    invalid("The channel selection has an invalid package count.");
  }
  const ids = new Set<string>();
  let totalBytes = 0;
  const packages = record.packages.map((value): RepositoryChannelSelectionPackage => {
    const entry = exact(value, ["id", "candidate_id", "version", "sha256", "size", "channel", "revision"]);
    const release = parseRepositoryReleaseRecord({
      protocol: NEUTRON_REPOSITORY_PROTOCOL,
      id: entry.id,
      version: entry.version,
      sha256: entry.sha256,
      size: entry.size,
    });
    if (release.id === "kernel" || ids.has(release.id)) {
      invalid("The setup channel selection repeats an app or contains Kernel.");
    }
    ids.add(release.id);
    totalBytes += release.size;
    if (totalBytes > REPOSITORY_LIMITS.manifestPackageBytes) invalid("The channel selection exceeds the manifest package byte limit.");
    const selectedChannel = channel(entry.channel);
    if (mode === "stable" && selectedChannel !== "stable") invalid("A stable selection cannot contain a beta release.");
    return {
      id: release.id, version: release.version, sha256: release.sha256, size: release.size,
      candidate_id: natural(entry.candidate_id), revision: natural(entry.revision), channel: selectedChannel,
    };
  });
  return {
    protocol: REPOSITORY_CHANNEL_SELECTION_PROTOCOL,
    source: sourcePrincipal(record.source),
    mode,
    manifest_id: validateManifestId(record.manifest_id),
    manifest_sha256: validateDigest(record.manifest_sha256),
    packages,
  };
}

/** The beta marker makes unaware clients reject the manifest before package admission. */
export function parseRepositorySetupManifest(value: unknown): RepositorySetupManifest {
  const parsed = json(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) invalid("The repository setup manifest is invalid.");
  if ((parsed as Record<string, unknown>).protocol === NEUTRON_REPOSITORY_PROTOCOL) {
    return parseRepositoryManifest(parsed);
  }
  const record = exact(parsed, ["protocol", "channel", "id", "revision", "name", "packages"], ["description"]);
  protocol(record.protocol, REPOSITORY_CHANNEL_MANIFEST_PROTOCOL);
  if (record.channel !== "beta") invalid("The channel manifest must explicitly require beta updates.");
  const { channel: _channel, ...fields } = record;
  const manifest = parseRepositoryManifest({ ...fields, protocol: NEUTRON_REPOSITORY_PROTOCOL });
  return { ...manifest, protocol: REPOSITORY_CHANNEL_MANIFEST_PROTOCOL, channel: "beta" };
}

export function isRepositoryChannelManifest(manifest: RepositorySetupManifest): manifest is RepositoryChannelManifest {
  return manifest.protocol === REPOSITORY_CHANNEL_MANIFEST_PROTOCOL;
}

export function selectRepositoryChannelRelease(
  heads: RepositoryChannelHeads,
  mode: RepositoryReleaseChannel,
): SelectedRepositoryChannelRelease | null {
  const selectedMode = channel(mode);
  const stable = heads.stable.release;
  const beta = heads.beta.release;
  if (stable && beta && stable.version === beta.version && !sameRelease(stable, beta)) {
    invalid("The channels advertise different bytes for the same app version.");
  }
  const chosen = selectedMode === "beta" && beta && (!stable || beta.version > stable.version)
    ? "beta" : "stable";
  const head = heads[chosen];
  if (head.release === null || head.candidate_id === null) return null;
  return { channel: chosen, head: { ...head, candidate_id: head.candidate_id, release: head.release } };
}

/** Bind already-certified selection metadata to the exact manifest bytes and contents. */
export function assertRepositoryChannelSelectionManifest(
  selection: RepositoryChannelSelection,
  manifest: RepositorySetupManifest,
  expectedSource: string,
  manifestDigest: string,
): void {
  if (selection.source !== expectedSource || selection.manifest_id !== manifest.id || selection.manifest_sha256 !== manifestDigest) {
    invalid("The channel selection belongs to another source or manifest.");
  }
  if (isRepositoryChannelManifest(manifest) && selection.mode !== "beta") invalid("The beta manifest requires a beta selection proof.");
  if (!isRepositoryChannelManifest(manifest) && selection.packages.some((entry) => entry.channel === "beta")) {
    invalid("A beta release requires a channel-aware manifest.");
  }
  if (selection.packages.length !== manifest.packages.length) invalid("The channel selection does not bind the complete manifest.");
  const entries = new Map(selection.packages.map((entry) => [entry.id, entry]));
  for (const release of manifest.packages) {
    const selected = entries.get(release.id);
    if (!selected || !sameRelease(selected, release)) invalid("The channel selection does not match the manifest's exact packages.");
  }
}

function parseHead(value: unknown, id: string): RepositoryChannelHead {
  const record = exact(value, ["revision", "candidate_id", "release"]);
  const candidate_id = record.candidate_id === null ? null : natural(record.candidate_id);
  const release = record.release === null ? null : parseRepositoryReleaseRecord(
    exact(record.release, ["protocol", "id", "version", "sha256", "size"]),
  );
  if (release && (candidate_id === null || release.id !== id)) invalid("A channel head has an invalid release identity.");
  return { revision: natural(record.revision), candidate_id, release };
}

function sameRelease(a: Pick<RepositoryReleaseRecord, "id" | "version" | "sha256" | "size">, b: Pick<RepositoryReleaseRecord, "id" | "version" | "sha256" | "size">): boolean {
  return a.id === b.id && a.version === b.version && a.sha256 === b.sha256 && a.size === b.size;
}

function appId(value: unknown): string {
  if (typeof value !== "string") invalid("An app ID is required.");
  repositoryReleasePath(value);
  return value;
}
function channel(value: unknown): RepositoryReleaseChannel {
  if (value !== "stable" && value !== "beta") invalid("The release channel is invalid.");
  return value;
}
function natural(value: unknown): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) invalid("Channel revisions and candidate IDs must be canonical unsigned decimal strings.");
  return value;
}
function sourcePrincipal(value: unknown): string {
  if (typeof value !== "string") invalid("A source principal is required.");
  try {
    const principal = Principal.fromText(value);
    if (principal.toText() !== value || value === "aaaaa-aa" || principal.isAnonymous()) invalid("The source must be a canonical repository principal.");
  } catch (cause) {
    invalid("The channel source principal is invalid.", cause);
  }
  return value;
}
function protocol(value: unknown, expected: string): void {
  if (value !== expected) invalid("The release channel protocol is unsupported.");
}
function exact(value: unknown, fields: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("Channel metadata must be an object.");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) invalid("Channel metadata must be a plain object.");
  const keys = Object.keys(value);
  if (keys.some((key) => !fields.includes(key) && !optional.includes(key)) || fields.some((field) => !Object.hasOwn(value, field))) invalid("Channel metadata has missing or unknown fields.");
  return value as Record<string, unknown>;
}
function json(value: unknown): unknown {
  let text: string;
  try {
    if (value instanceof Uint8Array) {
      if (value.byteLength > REPOSITORY_LIMITS.metadataJsonBytes) invalid("Channel metadata exceeds the repository metadata byte limit.");
      text = new TextDecoder("utf-8", { fatal: true }).decode(value);
    } else {
      text = typeof value === "string" ? value : JSON.stringify(value);
    }
    if (text === undefined) invalid("Channel metadata is missing.");
    if (new TextEncoder().encode(text).byteLength > REPOSITORY_LIMITS.metadataJsonBytes) invalid("Channel metadata exceeds the repository metadata byte limit.");
    const parsed: unknown = JSON.parse(text);
    assertNoDuplicateJsonObjectKeys(text);
    return parsed;
  } catch (cause) {
    invalid("Channel metadata is not valid unambiguous UTF-8 JSON.", cause);
  }
}
function invalid(message: string, cause?: unknown): never {
  throw new RepositoryProtocolError("invalid_schema", message, { cause });
}
