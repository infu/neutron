import { expect, test } from "bun:test";
import type { HttpAgent } from "@dfinity/agent";
import { Principal } from "@dfinity/principal";
import {
  AgentAssetCanister,
  type AssetCanisterActor,
  type BatchOperation,
} from "../src/asset_canister.ts";

const canisterId = "rrkah-fqaaa-aaaaa-aaaaq-cai";
const admin =
  "pcofx-mj5y3-27jya-3jcsk-jzcy2-2y6yj-bvf32-ousik-tb3ks-uyjkz-rqe";
const publisher =
  "l7put-ak4xb-iq2fx-7zgzw-n57my-5meck-krbld-etgzd-5lnha-zkuff-3ae";
const unusedAgent = {} as HttpAgent;

test("agent adapter passes typed arguments directly to the asset canister", async () => {
  const calls: Array<{ method: string; request: unknown }> = [];
  const actor: AssetCanisterActor = {
    async list(request) {
      calls.push({ method: "list", request });
      return [];
    },
    async create_batch(request) {
      calls.push({ method: "create_batch", request });
      return { batch_id: 7n };
    },
    async create_chunk(request) {
      calls.push({ method: "create_chunk", request });
      return { chunk_id: 9n };
    },
    async commit_batch(request) {
      calls.push({ method: "commit_batch", request });
    },
    async delete_batch(request) {
      calls.push({ method: "delete_batch", request });
    },
    async list_permitted(request) {
      calls.push({ method: "list_permitted", request });
      return [Principal.fromText(publisher)];
    },
    async grant_permission(request) {
      calls.push({ method: "grant_permission", request });
    },
    async revoke_permission(request) {
      calls.push({ method: "revoke_permission", request });
    },
  };
  const controllerRequests: string[] = [];
  const port = new AgentAssetCanister({
    canisterId,
    agent: unusedAgent,
    actor,
    readControllers: async ({ canisterId: requested }) => {
      controllerRequests.push(requested.toText());
      return [Principal.fromText(admin)];
    },
  });
  const operation: BatchOperation = {
    SetAssetContent: {
      key: "/package.neutron",
      sha256: [new Uint8Array([4, 5])],
      chunk_ids: [9n],
      content_encoding: "identity",
      last_chunk: [],
    },
  };

  expect(await port.createBatch()).toBe(7n);
  expect(await port.createChunk(7n, new Uint8Array([1, 2, 3]))).toBe(9n);
  await port.commitBatch(7n, [operation]);
  await port.deleteBatch(7n);
  expect(await port.listPermitted("Commit")).toEqual([publisher]);
  await port.grantPermission("Commit", publisher);
  await port.revokePermission("Commit", publisher);
  expect(await port.controllers()).toEqual([admin]);

  expect(calls).toEqual([
    { method: "create_batch", request: {} },
    {
      method: "create_chunk",
      request: { batch_id: 7n, content: new Uint8Array([1, 2, 3]) },
    },
    {
      method: "commit_batch",
      request: { batch_id: 7n, operations: [operation] },
    },
    { method: "delete_batch", request: { batch_id: 7n } },
    {
      method: "list_permitted",
      request: { permission: { Commit: null } },
    },
    {
      method: "grant_permission",
      request: {
        permission: { Commit: null },
        to_principal: Principal.fromText(publisher),
      },
    },
    {
      method: "revoke_permission",
      request: {
        permission: { Commit: null },
        of_principal: Principal.fromText(publisher),
      },
    },
  ]);
  expect(controllerRequests).toEqual([canisterId]);
});

test("listAssets paginates and maps every asset encoding", async () => {
  const requests: Array<{ start: bigint; length: bigint }> = [];
  const listed = Array.from({ length: 102 }, (_, index) => {
    const assetNumber = 101 - index;
    return {
      key: `/asset-${String(assetNumber).padStart(3, "0")}`,
      content_type:
        assetNumber === 0 ? "application/json" : "application/octet-stream",
      encodings: [
        {
          content_encoding: "identity",
          sha256:
            assetNumber === 0
              ? ([] as [])
              : ([new Uint8Array([assetNumber % 251, 17])] as [Uint8Array]),
          length: BigInt(assetNumber + 1),
        },
        ...(assetNumber === 0
          ? [
              {
                content_encoding: "gzip",
                sha256: [new Uint8Array([99, 42])] as [Uint8Array],
                length: 7n,
              },
            ]
          : []),
      ],
    };
  });
  const actor: AssetCanisterActor = {
    async list(request) {
      const start = request.start[0] ?? 0n;
      const length = request.length[0] ?? BigInt(listed.length);
      requests.push({ start, length });
      return listed.slice(Number(start), Number(start + length));
    },
    async create_batch() {
      throw new Error("unexpected create_batch");
    },
    async create_chunk() {
      throw new Error("unexpected create_chunk");
    },
    async commit_batch() {
      throw new Error("unexpected commit_batch");
    },
    async delete_batch() {
      throw new Error("unexpected delete_batch");
    },
    async list_permitted() {
      throw new Error("unexpected list_permitted");
    },
    async grant_permission() {
      throw new Error("unexpected grant_permission");
    },
    async revoke_permission() {
      throw new Error("unexpected revoke_permission");
    },
  };
  const port = new AgentAssetCanister({
    canisterId,
    agent: unusedAgent,
    actor,
    readControllers: async () => [],
  });

  const assets = await port.listAssets();

  expect(requests).toEqual([
    { start: 0n, length: 100n },
    { start: 100n, length: 100n },
  ]);
  expect(assets).toHaveLength(102);
  expect(assets.map((asset) => asset.key)).toEqual(
    Array.from({ length: 102 }, (_, index) =>
      `/asset-${String(index).padStart(3, "0")}`,
    ),
  );
  expect(assets[0]).toEqual({
    key: "/asset-000",
    contentType: "application/json",
    encodings: [
      { contentEncoding: "identity", sha256: null, length: 1n },
      {
        contentEncoding: "gzip",
        sha256: new Uint8Array([99, 42]),
        length: 7n,
      },
    ],
  });
  expect(assets[101]?.encodings[0]).toEqual({
    contentEncoding: "identity",
    sha256: new Uint8Array([101, 17]),
    length: 102n,
  });
});
