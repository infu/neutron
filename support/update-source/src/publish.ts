import type {
  AssetCanisterPort,
  AssetMetadata,
  BatchOperation,
} from "./asset_canister.ts";
import {
  readPackageAsset,
  readReleaseAsset,
  readSourceAsset,
  type CertifiedFetch,
} from "./http.ts";
import {
  MAX_PACKAGES_PER_PUBLICATION,
  PACKAGE_CONTENT_TYPE,
  PACKAGE_MAX_AGE_SECONDS,
  RELEASE_CONTENT_TYPE,
  RELEASE_MAX_AGE_SECONDS,
  SOURCE_CONTENT_TYPE,
  SOURCE_MAX_AGE_SECONDS,
  UPDATE_SOURCE_RECEIPT_PROTOCOL,
  UPLOAD_CHUNK_BYTES,
  UPLOAD_CONCURRENCY,
  hexBytes,
  inspectPackageFiles,
  packageHeaders,
  releaseHeaders,
  sha256Hex,
  sourceHeaders,
  type InspectedUpdatePackage,
  type PackageInspector,
} from "./model.ts";

export type PublicationOutcome = {
  id: string;
  version: number;
  sha256: string;
  size: number;
  package_path: string;
  release_path: string;
  release_digest: string;
  status: "published" | "unchanged";
  source: SourcePublicationOutcome | null;
};

export type SourcePublicationOutcome = {
  url: string;
  path: string;
  sha256: string;
  size: number;
  status: "published" | "unchanged";
};

export type PublicationReceipt = {
  protocol: typeof UPDATE_SOURCE_RECEIPT_PROTOCOL;
  canister_id: string;
  origin: string;
  batch_id: string | null;
  atomic: true;
  published_at: string;
  packages: PublicationOutcome[];
};

export type PublishOptions = {
  canisterId: string;
  origin: string;
  port: AssetCanisterPort;
  fetch?: CertifiedFetch;
  read?: (file: string) => Promise<Uint8Array>;
  readSource?: (file: string) => Promise<Uint8Array>;
  inspect?: PackageInspector;
  now?: () => Date;
  progress?: (message: string) => void;
};

type PlannedPackage = {
  package: InspectedUpdatePackage;
  releaseExists: boolean;
  packageExists: boolean;
  sourceExists: boolean | null;
  unchanged: boolean;
};

export async function publishPackageFiles(
  files: readonly string[],
  options: PublishOptions,
): Promise<PublicationReceipt> {
  if (files.length > MAX_PACKAGES_PER_PUBLICATION) {
    throw new Error(
      `One publication may contain at most ${MAX_PACKAGES_PER_PUBLICATION} packages`,
    );
  }
  const inspected = await inspectPackageFiles(files, {
    ...(options.read ? { read: options.read } : {}),
    ...(options.readSource ? { readSource: options.readSource } : {}),
    ...(options.inspect ? { inspect: options.inspect } : {}),
  });
  for (const candidate of inspected) {
    assertHostedSourceTarget(candidate, options.origin);
  }
  const existingAssets = options.port.listAssets
    ? indexAssets(await options.port.listAssets())
    : null;
  const plans: PlannedPackage[] = [];
  for (const candidate of inspected) {
    options.progress?.(`Checking ${candidate.record.id}`);
    plans.push(await planPackage(candidate, options, existingAssets));
  }

  const changed = plans.filter((plan) => !plan.unchanged);
  let committedBatch: bigint | null = null;
  if (changed.length > 0) {
    committedBatch = await commitPublication(changed, options);
  }

  for (const plan of plans) {
    options.progress?.(`Verifying ${plan.package.record.id}`);
    await verifyPublishedPackage(plan.package, options);
  }

  return {
    protocol: UPDATE_SOURCE_RECEIPT_PROTOCOL,
    canister_id: options.canisterId,
    origin: new URL(options.origin).origin,
    batch_id: committedBatch?.toString() ?? null,
    atomic: true,
    published_at: (options.now ?? (() => new Date()))().toISOString(),
    packages: plans.map(({ package: candidate, sourceExists, unchanged }) => ({
      id: candidate.record.id,
      version: candidate.record.version,
      sha256: candidate.record.sha256,
      size: candidate.record.size,
      package_path: candidate.packagePath,
      release_path: candidate.releasePath,
      release_digest: sha256Hex(candidate.releaseBytes),
      status: unchanged ? "unchanged" : "published",
      source: candidate.hostedSource
        ? {
            url: candidate.hostedSource.url,
            path: candidate.hostedSource.path,
            sha256: candidate.hostedSource.sha256,
            size: candidate.hostedSource.size,
            status: sourceExists ? "unchanged" : "published",
          }
        : null,
    })),
  };
}

async function planPackage(
  candidate: InspectedUpdatePackage,
  options: PublishOptions,
  existingAssets: ReadonlyMap<string, AssetMetadata> | null,
): Promise<PlannedPackage> {
  const current =
    existingAssets && !existingAssets.has(candidate.releasePath)
      ? ({ status: "missing" } as const)
      : await readReleaseAsset({
          origin: options.origin,
          path: candidate.releasePath,
          ...(options.fetch ? { fetch: options.fetch } : {}),
        });
  if (current.status === "found") {
    if (current.record.id !== candidate.record.id) {
      throw new Error(
        `Release path for '${candidate.record.id}' advertises '${current.record.id}'`,
      );
    }
    if (current.record.version > candidate.record.version) {
      throw new Error(
        `Refusing to downgrade '${candidate.record.id}' from ${current.record.version} to ${candidate.record.version}`,
      );
    }
    if (
      current.record.version === candidate.record.version &&
      current.record.sha256 !== candidate.record.sha256
    ) {
      throw new Error(
        `Release '${candidate.record.id}' version ${candidate.record.version} already has a different digest`,
      );
    }
    if (
      current.record.version === candidate.record.version &&
      current.record.size !== candidate.record.size
    ) {
      throw new Error(
        `Release '${candidate.record.id}' version ${candidate.record.version} already has a different size`,
      );
    }
  }

  const packageAsset =
    existingAssets && !existingAssets.has(candidate.packagePath)
      ? ({ status: "missing" } as const)
      : await readPackageAsset({
          origin: options.origin,
          path: candidate.packagePath,
          expectedDigest: candidate.record.sha256,
          expectedSize: candidate.record.size,
          ...(options.fetch ? { fetch: options.fetch } : {}),
        });
  const unchanged =
    current.status === "found" &&
    current.record.version === candidate.record.version &&
    current.record.sha256 === candidate.record.sha256 &&
    current.record.size === candidate.record.size;
  if (unchanged && packageAsset.status !== "found") {
    throw new Error(
      `Release '${candidate.record.id}' points to a missing immutable package`,
    );
  }
  const sourceAsset = candidate.hostedSource
    ? existingAssets && !existingAssets.has(candidate.hostedSource.path)
      ? ({ status: "missing" } as const)
      : await readSourceAsset({
          origin: options.origin,
          path: candidate.hostedSource.path,
          expectedDigest: candidate.hostedSource.sha256,
          expectedSize: candidate.hostedSource.size,
          ...(options.fetch ? { fetch: options.fetch } : {}),
        })
    : null;
  if (unchanged && sourceAsset?.status === "missing") {
    throw new Error(
      `Release '${candidate.record.id}' points to a missing immutable Complete App Source`,
    );
  }
  return {
    package: candidate,
    releaseExists: current.status === "found",
    packageExists: packageAsset.status === "found",
    sourceExists:
      sourceAsset === null ? null : sourceAsset.status === "found",
    unchanged,
  };
}

function indexAssets(
  assets: readonly AssetMetadata[],
): Map<string, AssetMetadata> {
  const result = new Map<string, AssetMetadata>();
  for (const asset of assets) {
    if (result.has(asset.key)) {
      throw new Error(`Asset canister repeated key '${asset.key}'`);
    }
    result.set(asset.key, asset);
  }
  return result;
}

async function commitPublication(
  plans: readonly PlannedPackage[],
  options: PublishOptions,
): Promise<bigint> {
  const batchId = await options.port.createBatch();
  let committed = false;
  try {
    const operations: BatchOperation[] = [];
    const uploadedSourcePaths = new Set<string>();
    for (const plan of plans) {
      const candidate = plan.package;
      if (
        candidate.hostedSource &&
        !plan.sourceExists &&
        !uploadedSourcePaths.has(candidate.hostedSource.path)
      ) {
        uploadedSourcePaths.add(candidate.hostedSource.path);
        options.progress?.(`Uploading source ${candidate.record.id}`);
        const sourceChunks = await uploadChunks(
          options.port,
          batchId,
          candidate.hostedSource.bytes,
        );
        operations.push(
          createAsset(
            candidate.hostedSource.path,
            SOURCE_CONTENT_TYPE,
            sourceHeaders(candidate.hostedSource.sha256),
            SOURCE_MAX_AGE_SECONDS,
          ),
          setAssetContent(
            candidate.hostedSource.path,
            candidate.hostedSource.sha256,
            sourceChunks,
          ),
        );
      }
      if (!plan.packageExists) {
        options.progress?.(`Uploading package ${candidate.record.id}`);
        const packageChunks = await uploadChunks(
          options.port,
          batchId,
          candidate.bytes,
        );
        operations.push(
          createAsset(
            candidate.packagePath,
            PACKAGE_CONTENT_TYPE,
            packageHeaders(candidate.record.sha256),
            PACKAGE_MAX_AGE_SECONDS,
          ),
          setAssetContent(
            candidate.packagePath,
            candidate.record.sha256,
            packageChunks,
          ),
        );
      }

      options.progress?.(`Uploading release ${candidate.record.id}`);
      const releaseChunks = await uploadChunks(
        options.port,
        batchId,
        candidate.releaseBytes,
      );
      const releaseDigest = sha256Hex(candidate.releaseBytes);
      operations.push(
        plan.releaseExists
          ? setAssetProperties(
              candidate.releasePath,
              releaseHeaders(releaseDigest),
              RELEASE_MAX_AGE_SECONDS,
            )
          : createAsset(
              candidate.releasePath,
              RELEASE_CONTENT_TYPE,
              releaseHeaders(releaseDigest),
              RELEASE_MAX_AGE_SECONDS,
            ),
        setAssetContent(
          candidate.releasePath,
          releaseDigest,
          releaseChunks,
        ),
      );
    }
    options.progress?.(`Committing atomic batch ${batchId}`);
    await options.port.commitBatch(batchId, operations);
    committed = true;
    return batchId;
  } finally {
    if (!committed) {
      try {
        await options.port.deleteBatch(batchId);
      } catch {
        // Preserve the publication failure. Asset batches expire, and rerunning
        // never exposes a release pointer because commit_batch is atomic.
      }
    }
  }
}

async function uploadChunks(
  port: AssetCanisterPort,
  batchId: bigint,
  bytes: Uint8Array,
): Promise<bigint[]> {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += UPLOAD_CHUNK_BYTES) {
    chunks.push(bytes.slice(offset, offset + UPLOAD_CHUNK_BYTES));
  }
  if (chunks.length === 0) chunks.push(new Uint8Array());
  const ids: bigint[] = [];
  for (let index = 0; index < chunks.length; index += UPLOAD_CONCURRENCY) {
    const wave = chunks.slice(index, index + UPLOAD_CONCURRENCY);
    ids.push(
      ...(await Promise.all(
        wave.map((chunk) => port.createChunk(batchId, chunk)),
      )),
    );
  }
  return ids;
}

async function verifyPublishedPackage(
  candidate: InspectedUpdatePackage,
  options: PublishOptions,
): Promise<void> {
  const release = await readReleaseAsset({
    origin: options.origin,
    path: candidate.releasePath,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  if (release.status !== "found" || !sameRecord(release.record, candidate.record)) {
    throw new Error(
      `Published release verification failed for '${candidate.record.id}'`,
    );
  }
  const packageAsset = await readPackageAsset({
    origin: options.origin,
    path: candidate.packagePath,
    expectedDigest: candidate.record.sha256,
    expectedSize: candidate.record.size,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  if (packageAsset.status !== "found") {
    throw new Error(
      `Published package verification failed for '${candidate.record.id}'`,
    );
  }
  if (candidate.hostedSource) {
    const sourceAsset = await readSourceAsset({
      origin: options.origin,
      path: candidate.hostedSource.path,
      expectedDigest: candidate.hostedSource.sha256,
      expectedSize: candidate.hostedSource.size,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    if (sourceAsset.status !== "found") {
      throw new Error(
        `Published Complete App Source verification failed for '${candidate.record.id}'`,
      );
    }
  }
}

function sameRecord(
  left: InspectedUpdatePackage["record"],
  right: InspectedUpdatePackage["record"],
): boolean {
  return (
    left.protocol === right.protocol &&
    left.id === right.id &&
    left.version === right.version &&
    left.sha256 === right.sha256 &&
    left.size === right.size
  );
}

function assertHostedSourceTarget(
  candidate: InspectedUpdatePackage,
  configuredOrigin: string,
): void {
  const source = candidate.hostedSource;
  if (!source) return;
  const origin = new URL(configuredOrigin).origin;
  const expected = `${origin}${source.path}`;
  if (source.url !== expected) {
    throw new Error(
      `Package '${candidate.record.id}' Complete App Source URL must be ${expected}`,
    );
  }
}

function createAsset(
  key: string,
  contentType: string,
  headers: ReturnType<typeof packageHeaders>,
  maxAge: bigint,
): BatchOperation {
  return {
    CreateAsset: {
      key,
      content_type: contentType,
      headers: [headers],
      allow_raw_access: [false],
      max_age: [maxAge],
      enable_aliasing: [false],
    },
  };
}

function setAssetProperties(
  key: string,
  headers: ReturnType<typeof releaseHeaders>,
  maxAge: bigint,
): BatchOperation {
  return {
    SetAssetProperties: {
      key,
      headers: [[headers]],
      is_aliased: [[false]],
      allow_raw_access: [[false]],
      max_age: [[maxAge]],
    },
  };
}

function setAssetContent(
  key: string,
  digest: string,
  chunkIds: bigint[],
): BatchOperation {
  return {
    SetAssetContent: {
      key,
      sha256: [hexBytes(digest)],
      chunk_ids: chunkIds,
      content_encoding: "identity",
      last_chunk: [],
    },
  };
}
