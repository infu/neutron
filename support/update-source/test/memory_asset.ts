import { createHash } from "node:crypto";
import type {
  AssetCanisterPort,
  AssetMetadata,
  BatchOperation,
  PermissionName,
} from "../src/asset_canister.ts";
import type { CertifiedFetch } from "../src/http.ts";
import type { HeaderField } from "../src/model.ts";

export type StoredAsset = {
  contentType: string;
  headers: HeaderField[];
  maxAge: bigint;
  bytes: Uint8Array;
  digest: string;
};

type Batch = { chunks: Map<bigint, Uint8Array> };

export class MemoryAssetState {
  readonly assets = new Map<string, StoredAsset>();
  readonly permissions = new Map<PermissionName, Set<string>>([
    ["Prepare", new Set()],
    ["Commit", new Set()],
    ["ManagePermissions", new Set()],
  ]);
  readonly controllers = new Set<string>();
  readonly calls: string[] = [];
  readonly fetchedPaths: string[] = [];
  readonly batches = new Map<bigint, Batch>();
  nextBatch = 1n;
  nextChunk = 1n;
  commits = 0;
  createChunkCalls = 0;
  failCreateChunkAt: number | null = null;
  failCommit = false;

  actor(caller: string): MemoryAssetPort {
    return new MemoryAssetPort(this, caller);
  }

  seed(key: string, asset: StoredAsset): void {
    this.assets.set(key, cloneAsset(asset));
  }

  fetch(origin: string, streamChunkBytes = Number.MAX_SAFE_INTEGER): CertifiedFetch {
    return (async (input: string | URL | Request) => {
      const url = new URL(
        typeof input === "string" || input instanceof URL ? input : input.url,
      );
      if (url.origin !== new URL(origin).origin) {
        throw new Error("wrong test origin");
      }
      this.fetchedPaths.push(url.pathname);
      const asset = this.assets.get(url.pathname);
      const certification = {
        "IC-Certificate":
          "certificate=:YQ==:, tree=:Yg==:, expr_path=:Yw==:, version=2",
        "IC-CertificateExpression":
          "default_certification(ValidationArgs{no_request_certification: Empty{}})",
      };
      if (!asset) {
        return withUrl(
          new Response("missing", { status: 404, headers: certification }),
          url.href,
        );
      }
      const headers = new Headers(asset.headers);
      headers.set("Content-Type", asset.contentType);
      headers.set("Content-Encoding", "identity");
      headers.set("Content-Length", String(asset.bytes.byteLength));
      headers.set("ETag", `"${asset.digest}"`);
      for (const [name, value] of Object.entries(certification)) {
        headers.set(name, value);
      }
      const chunks: Uint8Array[] = [];
      for (
        let offset = 0;
        offset < asset.bytes.byteLength;
        offset += streamChunkBytes
      ) {
        chunks.push(asset.bytes.slice(offset, offset + streamChunkBytes));
      }
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      });
      return withUrl(new Response(body, { status: 200, headers }), url.href);
    }) as CertifiedFetch;
  }
}

export class MemoryAssetPort implements AssetCanisterPort {
  constructor(
    private readonly state: MemoryAssetState,
    private readonly caller: string,
  ) {}

  async listAssets(): Promise<AssetMetadata[]> {
    this.state.calls.push(`list_assets:${this.caller}`);
    return [...this.state.assets.entries()]
      .map(([key, asset]) => ({
        key,
        contentType: asset.contentType,
        encodings: [
          {
            contentEncoding: "identity",
            sha256: Uint8Array.from(Buffer.from(asset.digest, "hex")),
            length: BigInt(asset.bytes.byteLength),
          },
        ],
      }))
      .sort((left, right) => left.key.localeCompare(right.key));
  }

  async createBatch(): Promise<bigint> {
    this.requirePrepare();
    const id = this.state.nextBatch++;
    this.state.batches.set(id, { chunks: new Map() });
    this.state.calls.push(`create_batch:${this.caller}:${id}`);
    return id;
  }

  async createChunk(batchId: bigint, content: Uint8Array): Promise<bigint> {
    this.requirePrepare();
    const batch = this.requireBatch(batchId);
    this.state.createChunkCalls += 1;
    if (this.state.createChunkCalls === this.state.failCreateChunkAt) {
      throw new Error("injected chunk upload failure");
    }
    const id = this.state.nextChunk++;
    batch.chunks.set(id, content.slice());
    this.state.calls.push(`create_chunk:${this.caller}:${batchId}:${content.byteLength}`);
    return id;
  }

  async commitBatch(
    batchId: bigint,
    operations: readonly BatchOperation[],
  ): Promise<void> {
    this.requireCommit();
    const batch = this.requireBatch(batchId);
    this.state.calls.push(`commit_batch:${this.caller}:${batchId}`);
    if (this.state.failCommit) throw new Error("injected commit failure");
    const next = new Map(
      [...this.state.assets].map(([key, asset]) => [key, cloneAsset(asset)]),
    );
    for (const operation of operations) applyOperation(next, batch, operation);
    this.state.assets.clear();
    for (const [key, asset] of next) this.state.assets.set(key, asset);
    this.state.batches.delete(batchId);
    this.state.commits += 1;
  }

  async deleteBatch(batchId: bigint): Promise<void> {
    this.requirePrepare();
    this.state.calls.push(`delete_batch:${this.caller}:${batchId}`);
    this.state.batches.delete(batchId);
  }

  async listPermitted(permission: PermissionName): Promise<string[]> {
    this.state.calls.push(`list:${permission}:${this.caller}`);
    return [...this.state.permissions.get(permission)!].sort();
  }

  async grantPermission(
    permission: PermissionName,
    principal: string,
  ): Promise<void> {
    this.requireManage();
    this.state.calls.push(`grant:${permission}:${principal}`);
    this.state.permissions.get(permission)!.add(principal);
  }

  async revokePermission(
    permission: PermissionName,
    principal: string,
  ): Promise<void> {
    this.requireManage();
    this.state.calls.push(`revoke:${permission}:${principal}`);
    this.state.permissions.get(permission)!.delete(principal);
  }

  async controllers(): Promise<string[]> {
    return [...this.state.controllers].sort();
  }

  private requireBatch(batchId: bigint): Batch {
    const batch = this.state.batches.get(batchId);
    if (!batch) throw new Error("batch not found");
    return batch;
  }

  private requirePrepare(): void {
    if (
      !this.has("Prepare") &&
      !this.has("Commit") &&
      !this.has("ManagePermissions")
    ) {
      throw new Error("caller has no Prepare permission");
    }
  }

  private requireCommit(): void {
    if (!this.has("Commit") && !this.has("ManagePermissions")) {
      throw new Error("caller has no Commit permission");
    }
  }

  private requireManage(): void {
    if (!this.has("ManagePermissions")) {
      throw new Error("caller has no ManagePermissions permission");
    }
  }

  private has(permission: PermissionName): boolean {
    return this.state.permissions.get(permission)!.has(this.caller);
  }
}

export function storedAsset(options: {
  bytes: Uint8Array;
  contentType: string;
  headers: HeaderField[];
  maxAge: bigint;
}): StoredAsset {
  return {
    ...options,
    bytes: options.bytes.slice(),
    headers: options.headers.map(([name, value]) => [name, value]),
    digest: createHash("sha256").update(options.bytes).digest("hex"),
  };
}

function applyOperation(
  assets: Map<string, StoredAsset>,
  batch: Batch,
  operation: BatchOperation,
): void {
  if ("CreateAsset" in operation) {
    const input = operation.CreateAsset;
    if (assets.has(input.key)) throw new Error(`asset '${input.key}' exists`);
    assets.set(input.key, {
      contentType: input.content_type,
      headers: input.headers[0].map(([name, value]) => [name, value]),
      maxAge: input.max_age[0],
      bytes: new Uint8Array(),
      digest: createHash("sha256").update(new Uint8Array()).digest("hex"),
    });
    return;
  }
  if ("SetAssetProperties" in operation) {
    const input = operation.SetAssetProperties;
    const asset = assets.get(input.key);
    if (!asset) throw new Error(`asset '${input.key}' missing`);
    asset.headers = input.headers[0][0].map(([name, value]) => [name, value]);
    asset.maxAge = input.max_age[0][0];
    return;
  }
  const input = operation.SetAssetContent;
  const asset = assets.get(input.key);
  if (!asset) throw new Error(`asset '${input.key}' missing`);
  const chunks = input.chunk_ids.map((id) => {
    const chunk = batch.chunks.get(id);
    if (!chunk) throw new Error(`chunk '${id}' missing`);
    return chunk;
  });
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  const declared = Buffer.from(input.sha256[0]).toString("hex");
  if (digest !== declared) throw new Error("asset digest mismatch");
  asset.bytes = bytes;
  asset.digest = digest;
}

function cloneAsset(asset: StoredAsset): StoredAsset {
  return {
    ...asset,
    bytes: asset.bytes.slice(),
    headers: asset.headers.map(([name, value]) => [name, value]),
  };
}

function withUrl(response: Response, url: string): Response {
  Object.defineProperty(response, "url", { value: url });
  return response;
}
