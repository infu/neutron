import { beforeAll, expect, test } from "bun:test";
import { Principal } from "@dfinity/principal";
import {
  repositoryReleasePath,
  type RepositoryManifest,
  type RepositoryReleaseRecord,
} from "neutron-tools/repository";
import {
  repositoryBetaReleasePath,
  repositoryChannelHeadsPath,
  repositoryChannelSelectionPath,
  repositoryChannelsPath,
  type RepositoryChannelHeads,
  type RepositoryChannelSelection,
  type RepositorySetupManifest,
} from "neutron-tools/src/release_channels.js";
import { hashContent } from "neutron-tools/src/hash.js";
import {
  fetchEligibleUpdateRelease,
  repositorySupportsReleaseChannels,
  markRepositoryReleaseChannelsSupported,
  rememberRepositoryChannelSources,
  revalidateRepositoryReleaseSelection,
  verifyRepositoryReleaseSelection,
} from "../src/repository/channels.ts";
import { loadIcRuntimeFixture } from "./runtime_fixture.ts";

beforeAll(loadIcRuntimeFixture);

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
let nextSource = 1;
function fixture(betaEnabled = false) {
  const source = Principal.fromUint8Array(new Uint8Array([222, nextSource++, 1])).toText();
  const stable: RepositoryReleaseRecord = { protocol: "neutron-repo-v1", id: "hello", version: 101, sha256: "a".repeat(64), size: 12 };
  const beta: RepositoryReleaseRecord = { ...stable, version: 102, sha256: "b".repeat(64) };
  const release = betaEnabled ? beta : stable;
  const stableManifest: RepositoryManifest = {
    protocol: "neutron-repo-v1", id: "setup", revision: 1, name: "Setup",
    packages: [{ id: release.id, version: release.version, sha256: release.sha256, size: release.size }],
  };
  const manifest: RepositorySetupManifest = betaEnabled
    ? { ...stableManifest, protocol: "neutron-repo-channel-manifest-v1", channel: "beta" }
    : stableManifest;
  const manifestDigest = hashContent(encode(manifest));
  const heads: RepositoryChannelHeads = {
    protocol: "neutron-repo-channel-heads-v1", source, id: "hello",
    stable: { revision: "4", candidate_id: "9", release: stable },
    beta: { revision: "7", candidate_id: "12", release: beta },
  };
  const selected = betaEnabled ? heads.beta : heads.stable;
  const selection: RepositoryChannelSelection = {
    protocol: "neutron-repo-channel-selection-v1", source, mode: betaEnabled ? "beta" : "stable",
    manifest_id: manifest.id, manifest_sha256: manifestDigest,
    packages: [{ ...manifest.packages[0]!, candidate_id: selected.candidate_id!, revision: selected.revision, channel: betaEnabled ? "beta" : "stable" }],
  };
  const metadata = new Map<string, Uint8Array>();
  const refresh = () => {
    metadata.set(repositoryChannelsPath(), encode({ protocol: "neutron-repo-channels-v1", source }));
    metadata.set(repositoryChannelHeadsPath("hello"), encode(heads));
    metadata.set(repositoryChannelSelectionPath(manifest.id), encode(selection));
    metadata.set(repositoryReleasePath("hello"), encode(stable));
    metadata.set(repositoryBetaReleasePath("hello"), encode(beta));
  };
  refresh();
  const reads: string[] = [];
  const readMetadata = async (path: string) => { reads.push(path); return metadata.get(path); };
  const fetch = (async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    reads.push(path);
    const bytes = metadata.get(path);
    return new Response(bytes as unknown as BodyInit ?? null, { status: bytes ? 200 : 404, headers: { "content-type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
  return { source, stable, beta, manifest, manifestDigest, heads, selection, metadata, refresh, reads, fetch,
    options: { source, manifest, manifestDigest, betaEnabled, readMetadata } };
}

test("repository selections bind the complete manifest to independently certified current heads", async () => {
  const value = fixture(true);
  const verified = await verifyRepositoryReleaseSelection(value.options);
  expect(verified.mode).toBe("beta");
  expect(verified.selection?.packages[0]?.channel).toBe("beta");
  expect(verified.selectionDigest).toBe(hashContent(value.metadata.get(repositoryChannelSelectionPath("setup"))!));
});

test("a malicious manifest cannot relabel beta package bytes as stable", async () => {
  const value = fixture(true);
  value.selection.mode = "stable";
  value.selection.packages[0]!.channel = "stable";
  value.selection.packages[0]!.revision = value.heads.stable.revision;
  value.selection.packages[0]!.candidate_id = value.heads.stable.candidate_id!;
  const manifest: RepositoryManifest = { protocol: "neutron-repo-v1", id: "setup", revision: 1, name: "Setup", packages: value.manifest.packages };
  const manifestDigest = hashContent(encode(manifest));
  value.selection.manifest_sha256 = manifestDigest;
  value.refresh();
  await expect(verifyRepositoryReleaseSelection({ ...value.options, manifest, manifestDigest, betaEnabled: false })).rejects.toThrow("eligible current head");
});

test("a beta-marked setup cannot bypass its mandatory channel proof through legacy negotiation", async () => {
  const value = fixture(true);
  value.metadata.delete(repositoryChannelsPath());
  await expect(verifyRepositoryReleaseSelection(value.options)).rejects.toThrow("requires certified release-channel support");
});

test("selection source, digest, and current preference mode are binding", async () => {
  for (const field of ["source", "digest", "mode"] as const) {
    const value = fixture();
    if (field === "source") value.selection.source = fixture().source;
    if (field === "digest") value.selection.manifest_sha256 = "f".repeat(64);
    if (field === "mode") value.selection.mode = "beta";
    value.refresh();
    await expect(verifyRepositoryReleaseSelection(value.options)).rejects.toThrow();
  }
});

test("a newer stable head is selected even when beta is enabled", async () => {
  const value = fixture();
  value.beta.version = 100;
  value.selection.mode = "beta";
  value.refresh();
  const verified = await verifyRepositoryReleaseSelection({ ...value.options, betaEnabled: true });
  expect(verified.selection?.packages[0]!.channel).toBe("stable");
});

test("pre-deploy revalidation detects revision drift even when exact archive bytes stay the same", async () => {
  const value = fixture();
  const expected = await verifyRepositoryReleaseSelection(value.options);
  value.heads.stable.revision = "5";
  value.refresh();
  await expect(revalidateRepositoryReleaseSelection(expected, value.options)).rejects.toThrow("eligible current head");
});

test("pre-deploy revalidation detects proof replacement as well as head revocation", async () => {
  for (const revoke of [false, true]) {
    const value = fixture(true);
    const expected = await verifyRepositoryReleaseSelection(value.options);
    value.heads.beta.revision = "8";
    if (revoke) value.heads.beta.release = null;
    else value.selection.packages[0]!.revision = "8";
    value.refresh();
    await expect(revalidateRepositoryReleaseSelection(expected, value.options)).rejects.toThrow();
  }
});

test("authenticated descriptor absence supports legacy but a transport failure never does", async () => {
  const value = fixture();
  expect(await repositorySupportsReleaseChannels(value.source, async () => undefined)).toBe(false);
  const failure = new Error("Invalid certified witness");
  await expect(repositorySupportsReleaseChannels(value.source, async () => { throw failure; })).rejects.toBe(failure);
});

test("a source with confirmed channel support cannot downgrade by dropping descriptor or selection proof", async () => {
  const value = fixture();
  await verifyRepositoryReleaseSelection(value.options);
  value.metadata.delete(repositoryChannelSelectionPath("setup"));
  await expect(verifyRepositoryReleaseSelection(value.options)).rejects.toThrow("selection is missing");
  value.metadata.delete(repositoryChannelsPath());
  await expect(verifyRepositoryReleaseSelection(value.options)).rejects.toThrow("descriptor disappeared");
});

test("stable-only updater uses the v1 stable projection directly", async () => {
  const value = fixture();
  const release = await fetchEligibleUpdateRelease(value.source, "hello", { betaEnabled: false, fetch: value.fetch });
  expect(release?.record).toEqual(value.stable);
  expect(release?.channel).toBe("stable");
  expect(value.reads).toEqual([repositoryReleasePath("hello")]);
});

test("stable-only updater preserves channel verification for a previously known source", async () => {
  const value = fixture();
  markRepositoryReleaseChannelsSupported(value.source);
  const release = await fetchEligibleUpdateRelease(value.source, "hello", { betaEnabled: false, fetch: value.fetch, metadataReader: value.options.readMetadata });
  expect(release).toMatchObject({ record: value.stable, channel: "stable", candidateId: "9", channelRevision: "4" });
  value.metadata.delete(repositoryChannelsPath());
  await expect(fetchEligibleUpdateRelease(value.source, "hello", { betaEnabled: false, fetch: value.fetch, metadataReader: value.options.readMetadata })).rejects.toThrow("descriptor disappeared");
});

test("installed provenance preserves proved channel participation after a fresh source check", async () => {
  const value = fixture();
  rememberRepositoryChannelSources({ format: 2, apps: { hello: {
    kind: "repository", repository: value.source, manifest_id: "setup", manifest_digest: value.manifestDigest,
    package_digest: value.stable.sha256, release_channel: "stable", channel_aware: true,
  } } });
  await expect(repositorySupportsReleaseChannels(value.source, async () => undefined)).rejects.toThrow("descriptor disappeared");
});

test("beta-enabled updater fetches and binds the highest current head", async () => {
  const value = fixture();
  const release = await fetchEligibleUpdateRelease(value.source, "hello", { betaEnabled: true, fetch: value.fetch, metadataReader: value.options.readMetadata });
  expect(release).toMatchObject({ record: value.beta, channel: "beta", candidateId: "12", channelRevision: "7" });
  expect(value.reads).toEqual([repositoryChannelsPath(), repositoryChannelHeadsPath("hello"), repositoryBetaReleasePath("hello")]);
});

test("beta-enabled updater rejects a release response that differs from its channel head", async () => {
  const value = fixture();
  value.metadata.set(repositoryBetaReleasePath("hello"), encode(value.stable));
  await expect(fetchEligibleUpdateRelease(value.source, "hello", { betaEnabled: true, fetch: value.fetch, metadataReader: value.options.readMetadata })).rejects.toThrow("differs from its certified current channel head");
});

test("legacy updater fallback requires authenticated descriptor absence and rejects an invalid proof", async () => {
  const legacy = fixture();
  legacy.metadata.delete(repositoryChannelsPath());
  expect((await fetchEligibleUpdateRelease(legacy.source, "hello", { betaEnabled: true, fetch: legacy.fetch, metadataReader: legacy.options.readMetadata }))?.channel).toBe("stable");
  const broken = fixture();
  const failure = new Error("Invalid certified channel metadata proof");
  await expect(fetchEligibleUpdateRelease(broken.source, "hello", {
    betaEnabled: true, fetch: broken.fetch, metadataReader: async () => { throw failure; },
  })).rejects.toBe(failure);
  expect(broken.reads).toEqual([]);
});

test("channel metadata queries retain the existing updater timeout and abort their network request", async () => {
  const value = fixture();
  let aborted = 0;
  const fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      const abort = () => { aborted += 1; reject(new DOMException("Timed out", "AbortError")); };
      if (init?.signal?.aborted) abort();
      else init?.signal?.addEventListener("abort", abort, { once: true });
    });
  }) as unknown as typeof globalThis.fetch;
  try {
    await fetchEligibleUpdateRelease(value.source, "hello", { betaEnabled: true, fetch, timeoutMs: 10 });
    throw new Error("The metadata request did not time out");
  } catch (error) {
    expect((error as { code?: string }).code).toBe("timed_out");
    expect(aborted).toBeGreaterThan(0);
  }
});
