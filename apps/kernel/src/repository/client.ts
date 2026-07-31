import {
  Actor,
  AnonymousIdentity,
  HttpAgent,
  type ActorSubclass,
} from "@dfinity/agent";
import { createCertifiedAssetReader } from "neutron-tools/certified_asset";
import {
  REPOSITORY_LIMITS,
  parseRepositoryInfo,
  parseRepositoryManifest,
  repositoryIdlFactory,
  repositoryInfoPath,
  repositoryManifestPath,
  repositoryPackagePath,
  type RepositoryActor,
  type RepositoryInfo,
  type RepositoryManifest,
  type RepositoryManifestPackage,
  type RepositorySetupReference,
} from "neutron-tools/repository";
import { hashContent } from "neutron-tools/src/hash.js";
import { getRuntimeDeployment } from "../runtime_deployment.ts";

export type FetchedRepositoryPackage = {
  metadata: RepositoryManifestPackage;
  bytes: Uint8Array;
};

export type FetchedRepositorySetup = {
  info: RepositoryInfo;
  manifest: RepositoryManifest;
  manifestBytes: Uint8Array;
  packages: readonly FetchedRepositoryPackage[];
};

export type RepositoryByteSource = {
  readInfo(): Promise<Uint8Array | undefined>;
  readManifest(id: string): Promise<Uint8Array | undefined>;
  readPackage(digest: string): Promise<Uint8Array | undefined>;
};

export type RepositoryLoadProgress = {
  label: string;
  current: number;
  total: number;
};

export type RepositoryClientOptions = {
  signal?: AbortSignal;
  fetch?: typeof fetch;
  onProgress?: (progress: RepositoryLoadProgress) => void;
};

const fatalDecoder = new TextDecoder("utf-8", { fatal: true });

export async function loadRepositorySetupBytes(
  reference: RepositorySetupReference,
  options: RepositoryClientOptions = {},
): Promise<FetchedRepositorySetup> {
  const attempt = new AbortController();
  const callerSignal = options.signal;
  const abortFromCaller = (): void => attempt.abort();
  if (callerSignal?.aborted) attempt.abort();
  else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });

  try {
    if (attempt.signal.aborted) throw abortError();
    const source = await createAnonymousRepositorySource(reference.repo, {
      ...options,
      signal: attempt.signal,
    });
    return await verifyRepositorySetupBytes(
      reference,
      source,
      options.onProgress,
      () => attempt.abort(),
    );
  } catch (error) {
    attempt.abort();
    throw error;
  } finally {
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
}

export async function verifyRepositorySetupBytes(
  reference: RepositorySetupReference,
  source: RepositoryByteSource,
  onProgress?: (progress: RepositoryLoadProgress) => void,
  onPackageFailure?: (error: unknown) => void,
): Promise<FetchedRepositorySetup> {
  notifyProgress(onProgress, {
    label: "Verifying repository identity",
    current: 0,
    total: 2,
  });
  const infoBytes = requireResource(
    await source.readInfo(),
    "Repository information was not found",
  );
  assertMaximumBytes(
    infoBytes,
    REPOSITORY_LIMITS.metadataJsonBytes,
    "Repository information",
  );
  const info = parseRepositoryInfo(parseJsonBytes(infoBytes, "repository information"));

  notifyProgress(onProgress, {
    label: "Verifying pinned setup manifest",
    current: 1,
    total: 2,
  });
  const manifestBytes = requireResource(
    await source.readManifest(reference.manifest),
    `Repository manifest '${reference.manifest}' was not found`,
  );
  assertMaximumBytes(
    manifestBytes,
    REPOSITORY_LIMITS.manifestJsonBytes,
    "Repository manifest",
  );
  const actualManifestDigest = hashContent(manifestBytes);
  if (actualManifestDigest !== reference.digest) {
    throw new Error(
      `Pinned manifest digest mismatch: expected ${reference.digest}, received ${actualManifestDigest}`,
    );
  }
  const manifest = parseRepositoryManifest(
    parseJsonBytes(manifestBytes, "repository manifest"),
  );
  if (manifest.id !== reference.manifest) {
    throw new Error(
      `Repository returned manifest '${manifest.id}' for '${reference.manifest}'`,
    );
  }

  const packages = await mapWithConcurrency(
    manifest.packages,
    REPOSITORY_LIMITS.concurrentReads,
    async (metadata, index) => {
      notifyProgress(onProgress, {
        label: `Fetching package ${index + 1} of ${manifest.packages.length}`,
        current: index,
        total: manifest.packages.length,
      });
      const bytes = requireResource(
        await source.readPackage(metadata.sha256),
        `Repository package '${metadata.id}' was not found`,
      );
      if (bytes.byteLength !== metadata.size) {
        throw new Error(
          `Package '${metadata.id}' size mismatch: expected ${metadata.size}, received ${bytes.byteLength}`,
        );
      }
      const digest = hashContent(bytes);
      if (digest !== metadata.sha256) {
        throw new Error(
          `Package '${metadata.id}' digest mismatch: expected ${metadata.sha256}, received ${digest}`,
        );
      }
      return Object.freeze({ metadata, bytes });
    },
    onPackageFailure,
  );
  const totalPackageBytes = packages.reduce(
    (total, { bytes }) => total + bytes.byteLength,
    0,
  );
  if (totalPackageBytes > REPOSITORY_LIMITS.manifestPackageBytes) {
    throw new Error("Repository setup exceeds the aggregate package byte limit");
  }
  notifyProgress(onProgress, {
    label: `Verified ${packages.length} package${packages.length === 1 ? "" : "s"}`,
    current: packages.length,
    total: packages.length,
  });
  return Object.freeze({
    info,
    manifest,
    manifestBytes,
    packages: Object.freeze(packages),
  });
}

export async function createAnonymousRepositorySource(
  canisterId: string,
  options: RepositoryClientOptions = {},
): Promise<RepositoryByteSource> {
  const deployment = getRuntimeDeployment();
  const privacyFetch = createRepositoryFetch(
    options.fetch ?? globalThis.fetch,
    options.signal,
  );
  const agent = await HttpAgent.create({
    fetch: privacyFetch,
    host: deployment.gateway,
    identity: new AnonymousIdentity(),
    ...(deployment.local ? { verifyQuerySignatures: false } : {}),
  });
  if ((await agent.getPrincipal()).toText() !== "2vxsx-fae") {
    throw new Error("Repository agent is not anonymous");
  }
  if (deployment.rootKeyPolicy === "fetch") {
    await agent.fetchRootKey();
  }
  const rootKey = agent.rootKey;
  if (!rootKey) throw new Error("The ICP root key is unavailable");

  const actor = Actor.createActor<RepositoryActor>(
    repositoryIdlFactory as unknown as Parameters<typeof Actor.createActor>[0],
    { agent, canisterId },
  ) as ActorSubclass<RepositoryActor>;

  const read = (
    key: string,
    method: (index: bigint) => ReturnType<RepositoryActor["repo_info"]>,
    limits: { maxChunks: number; maxEncodedBytes: number },
  ): Promise<Uint8Array | undefined> => {
    const reader = createCertifiedAssetReader({
      canisterId,
      rootKey,
      limits: {
        maxChunkBytes: REPOSITORY_LIMITS.queryChunkBytes,
        maxChunks: limits.maxChunks,
        maxEncodedBytes: limits.maxEncodedBytes,
      },
      readChunk: ({ key: requestedKey, index }) => {
        if (requestedKey !== key) {
          throw new Error("Repository certified path changed during read");
        }
        return method(index);
      },
    });
    return reader.readRaw(key);
  };

  return Object.freeze({
    readInfo: () =>
      read(
        repositoryInfoPath(),
        (index) => actor.repo_info({ index }),
        { maxChunks: 1, maxEncodedBytes: REPOSITORY_LIMITS.metadataJsonBytes },
      ),
    readManifest: (id: string) =>
      read(
        repositoryManifestPath(id),
        (index) => actor.repo_manifest({ id, index }),
        { maxChunks: 1, maxEncodedBytes: REPOSITORY_LIMITS.manifestJsonBytes },
      ),
    readPackage: (digest: string) =>
      read(
        repositoryPackagePath(digest),
        (index) => actor.repo_package({ sha256: digest, index }),
        {
          maxChunks: REPOSITORY_LIMITS.packageChunks,
          maxEncodedBytes: REPOSITORY_LIMITS.packageBytes,
        },
      ),
  });
}

export function createRepositoryFetch(
  baseFetch: typeof fetch,
  signal?: AbortSignal,
): typeof fetch {
  return (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    if (signal?.aborted) throw abortError();
    return baseFetch(input, {
      ...init,
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      ...(signal ? { signal } : {}),
    });
  }) as unknown as typeof fetch;
}

function parseJsonBytes(bytes: Uint8Array, label: string): unknown {
  let text: string;
  try {
    text = fatalDecoder.decode(bytes);
  } catch (cause) {
    throw new Error(`${label} is not valid UTF-8`, { cause });
  }
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new Error(`${label} is not valid JSON`, { cause });
  }
}

function requireResource(
  bytes: Uint8Array | undefined,
  message: string,
): Uint8Array {
  if (bytes === undefined) throw new Error(message);
  return bytes;
}

function assertMaximumBytes(
  bytes: Uint8Array,
  maximum: number,
  label: string,
): void {
  if (bytes.byteLength > maximum) {
    throw new Error(`${label} exceeds ${maximum} bytes`);
  }
}

async function mapWithConcurrency<T, U>(
  values: readonly T[],
  maximum: number,
  map: (value: T, index: number) => Promise<U>,
  onFailure?: (error: unknown) => void,
): Promise<U[]> {
  const output = new Array<U>(values.length);
  let next = 0;
  let failed = false;
  let firstFailure: unknown;
  const recordFailure = (error: unknown): void => {
    if (failed) return;
    failed = true;
    firstFailure = error;
    try {
      onFailure?.(error);
    } catch {
      // Preserve the repository failure; cancellation observers are advisory.
    }
  };
  const worker = async (): Promise<void> => {
    while (!failed && next < values.length) {
      const index = next;
      next += 1;
      try {
        output[index] = await map(values[index]!, index);
      } catch (error) {
        recordFailure(error);
      }
    }
  };
  // Workers absorb their own failure so every already-started sibling settles
  // before the caller sees rejection. The first failure stops new work and the
  // production caller aborts the shared fetch signal through `onFailure`.
  await Promise.all(
    Array.from({ length: Math.min(maximum, values.length) }, () => worker()),
  );
  if (failed) throw firstFailure;
  return output;
}

function notifyProgress(
  callback: ((progress: RepositoryLoadProgress) => void) | undefined,
  progress: RepositoryLoadProgress,
): void {
  try {
    callback?.(Object.freeze({ ...progress }));
  } catch (error) {
    console.warn("Repository progress observer failed", error);
  }
}

function abortError(): Error {
  return new DOMException("Repository setup was cancelled", "AbortError");
}
