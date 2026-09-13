import {
  REPOSITORY_LIMITS,
  type RepositoryReleaseRecord,
} from "neutron-tools/repository";
import {
  assertRepositoryChannelSelectionManifest,
  isRepositoryChannelManifest,
  parseRepositoryChannelHeads,
  parseRepositoryChannelSelection,
  parseRepositoryChannelsDescriptor,
  repositoryChannelHeadsPath,
  repositoryChannelSelectionPath,
  repositoryChannelsPath,
  selectRepositoryChannelRelease,
  type RepositoryChannelSelection,
  type RepositoryReleaseChannel,
  type RepositorySetupManifest,
} from "neutron-tools/src/release_channels.js";
import { hashContent } from "neutron-tools/src/hash.js";
import {
  fetchUpdateRelease,
  type UpdateHttpClientOptions,
} from "../updates/client.ts";
import { UPDATE_CHECK_TIMEOUT_MS, UpdateCheckError, type FetchedRelease } from "../updates/model.ts";
import { createAnonymousRepositoryChannelReader } from "./channel_metadata.ts";
import type { InstallProvenance } from "./provenance.ts";

/** Absence must already have been authenticated by the metadata transport. */
export type RepositoryChannelMetadataReader = (path: string) => Promise<Uint8Array | null | undefined>;

export type VerifiedRepositoryReleaseSelection = Readonly<{
  mode: RepositoryReleaseChannel;
  selection: RepositoryChannelSelection | null;
  selectionDigest: string | null;
}>;

// A source that has demonstrated channel support cannot become a legacy source
// merely by omitting a proof on a later check in this browser session.
const confirmedChannelSources = new Set<string>();

export function markRepositoryReleaseChannelsSupported(source: string): void {
  confirmedChannelSources.add(source);
}

export function hasRepositoryReleaseChannelsSupport(source: string): boolean {
  return confirmedChannelSources.has(source);
}

export function rememberRepositoryChannelSources(provenance: InstallProvenance | undefined): void {
  for (const entry of Object.values(provenance?.apps ?? {})) {
    if (entry.kind !== "repository" && entry.kind !== "update_source") continue;
    if (entry.channel_aware !== true && entry.release_channel !== "beta") continue;
    if (entry.kind === "repository") markRepositoryReleaseChannelsSupported(entry.repository);
    else markRepositoryReleaseChannelsSupported(entry.source_canister);
  }
}

export async function repositorySupportsReleaseChannels(
  source: string,
  readMetadata: RepositoryChannelMetadataReader,
): Promise<boolean> {
  const bytes = await readMetadata(repositoryChannelsPath());
  if (bytes == null) {
    if (confirmedChannelSources.has(source)) {
      throw new Error("The repository's certified release-channel descriptor disappeared. Reload after the source is repaired.");
    }
    return false;
  }
  const descriptor = parseRepositoryChannelsDescriptor(bytes);
  if (descriptor.source !== source) {
    throw new Error("The release-channel descriptor belongs to another repository.");
  }
  markRepositoryReleaseChannelsSupported(source);
  return true;
}

export async function verifyRepositoryReleaseSelection({
  source,
  manifest,
  manifestDigest,
  betaEnabled,
  readMetadata,
}: {
  source: string;
  manifest: RepositorySetupManifest;
  manifestDigest: string;
  betaEnabled: boolean;
  readMetadata: RepositoryChannelMetadataReader;
}): Promise<VerifiedRepositoryReleaseSelection> {
  const mode = betaEnabled ? "beta" : "stable";
  if (!await repositorySupportsReleaseChannels(source, readMetadata)) {
    if (isRepositoryChannelManifest(manifest)) {
      throw new Error("This beta setup requires certified release-channel support and selection proof.");
    }
    return Object.freeze({ mode, selection: null, selectionDigest: null });
  }
  const bytes = requireMetadata(await readMetadata(repositoryChannelSelectionPath(manifest.id)), "manifest selection");
  const selection = parseRepositoryChannelSelection(bytes);
  assertRepositoryChannelSelectionManifest(selection, manifest, source, manifestDigest);
  if (selection.mode !== mode) {
    throw new Error("The repository selection uses different release preferences. Reload this setup with the current preference.");
  }
  // Read each independently certified head instead of trusting a source's
  // channel labels in a prepared manifest.
  for (let offset = 0; offset < selection.packages.length; offset += REPOSITORY_LIMITS.concurrentReads) {
    await Promise.all(selection.packages.slice(offset, offset + REPOSITORY_LIMITS.concurrentReads).map(async (entry) => {
      const heads = parseRepositoryChannelHeads(requireMetadata(await readMetadata(repositoryChannelHeadsPath(entry.id)), `heads for ${entry.id}`));
      if (heads.source !== source || heads.id !== entry.id) {
        throw new Error(`The release heads for ${entry.id} belong to another source or app.`);
      }
      const current = selectRepositoryChannelRelease(heads, mode);
      if (!current || current.channel !== entry.channel ||
        current.head.revision !== entry.revision ||
        current.head.candidate_id !== entry.candidate_id ||
        !sameRelease(current.head.release, entry)) {
        throw new Error(`The selected release for ${entry.id} is no longer its eligible current head. Reload this setup.`);
      }
    }));
  }
  selection.packages.forEach(Object.freeze);
  Object.freeze(selection.packages);
  Object.freeze(selection);
  return Object.freeze({ mode, selection, selectionDigest: hashContent(bytes) });
}

export async function revalidateRepositoryReleaseSelection(
  expected: VerifiedRepositoryReleaseSelection,
  options: Parameters<typeof verifyRepositoryReleaseSelection>[0],
): Promise<void> {
  const current = await verifyRepositoryReleaseSelection(options);
  if (current.mode !== expected.mode || current.selectionDigest !== expected.selectionDigest) {
    throw new Error("The repository release selection changed after review. Reload this setup.");
  }
}

export async function fetchEligibleUpdateRelease(
  source: string,
  appId: string,
  options: UpdateHttpClientOptions & { betaEnabled?: boolean; metadataReader?: RepositoryChannelMetadataReader } = {},
): Promise<FetchedRelease | null> {
  // v1 is the stable projection, preserving the existing stable-only request
  // path even for sources which predate release channels.
  if (!options.betaEnabled && !hasRepositoryReleaseChannelsSupport(source)) {
    return fetchUpdateRelease(source, appId, { ...options, channel: "stable" });
  }
  const timeoutMs = options.timeoutMs ?? UPDATE_CHECK_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("Update-check timeout is invalid");
  const controller = new AbortController();
  let timedOut = false;
  let rejectInterruption!: (error: Error) => void;
  const interruption = new Promise<never>((_resolve, reject) => { rejectInterruption = reject; });
  const abort = () => {
    controller.abort(options.signal?.reason);
    rejectInterruption(new DOMException("Update check was cancelled", "AbortError"));
  };
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    rejectInterruption(new UpdateCheckError("timed_out", "The update source took too long to respond."));
  }, timeoutMs);
  try {
    // HttpAgent can finish a retry backoff after its fetch has been aborted.
    // Keep the existing owner-visible deadline while that read-only task exits.
    return await Promise.race([
      fetchChannelUpdateRelease(source, appId, { ...options, signal: controller.signal }),
      interruption,
    ]);
  } catch (cause) {
    if (options.signal?.aborted) throw new DOMException("Update check was cancelled", "AbortError");
    if (timedOut) throw new UpdateCheckError("timed_out", "The update source took too long to respond.", { cause });
    throw cause;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}

async function fetchChannelUpdateRelease(
  source: string,
  appId: string,
  options: UpdateHttpClientOptions & { betaEnabled?: boolean; metadataReader?: RepositoryChannelMetadataReader },
): Promise<FetchedRelease | null> {
  const readMetadata = options.metadataReader ?? await createAnonymousRepositoryChannelReader(source, options);
  if (!await repositorySupportsReleaseChannels(source, readMetadata)) {
    return fetchUpdateRelease(source, appId, { ...options, channel: "stable" });
  }
  const heads = parseRepositoryChannelHeads(requireMetadata(await readMetadata(repositoryChannelHeadsPath(appId)), `heads for ${appId}`));
  if (heads.source !== source || heads.id !== appId) {
    throw new Error("The update source returned release heads for another source or app.");
  }
  const selected = selectRepositoryChannelRelease(heads, options.betaEnabled ? "beta" : "stable");
  if (!selected) return null;
  const fetched = await fetchUpdateRelease(source, appId, { ...options, channel: selected.channel });
  if (!fetched || !sameRelease(fetched.record, selected.head.release)) {
    throw new Error("The update release differs from its certified current channel head. Check for updates again.");
  }
  return Object.freeze({ ...fetched, channel: selected.channel,
    channelRevision: selected.head.revision, candidateId: selected.head.candidate_id });
}

function requireMetadata(bytes: Uint8Array | null | undefined, label: string): Uint8Array {
  if (bytes == null) throw new Error(`The repository's certified ${label} is missing.`);
  return bytes;
}

function sameRelease(
  left: Pick<RepositoryReleaseRecord, "id" | "version" | "sha256" | "size">,
  right: Pick<RepositoryReleaseRecord, "id" | "version" | "sha256" | "size">,
): boolean {
  return left.id === right.id && left.version === right.version && left.sha256 === right.sha256 && left.size === right.size;
}
