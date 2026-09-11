// All rights reserved. See ../LICENSE.
import { expect, test } from "bun:test";
import { AnonymousIdentity, type HttpAgent, type HttpAgentOptions } from "@dfinity/agent";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TRUSTED_PUBLISHER_CALLER, type BatchReceipt } from "./first-party-publish.ts";
import { certifiedQueryFetch, createFirstPartyEnvironment, createFirstPartyTransport, firstPartyService, publisherActorTransport, TrustedBatch, TrustedBatchRequest, type FirstPartyActor } from "./first-party-transport.ts";
import { encode, decode } from "./operator-wire.ts";
import { UploadChunk, UploadReply } from "./publisher.ts";
import type { HttpReader } from "./audit-download.ts";

const canister = "233tv-xiaaa-aaaay-aacta-cai", caller = Principal.fromText(TRUSTED_PUBLISHER_CALLER);
const other = Principal.fromText("3rurp-vyaaa-aaaay-aacua-cai");
const target = { canister, identity: "blast:0", network: "https://icp-api.io" };
const info = () => ({ canister: Principal.fromText(canister), fees: { version: 7n }, trustedPublishingPrincipal: [caller] });
function mocked(p = caller, actor: FirstPartyActor = { marketplace_info: async () => info() }) {
  const ids: number[] = [], agents: HttpAgentOptions[] = [], actorTargets: string[] = [];
  class Identity extends AnonymousIdentity { override getPrincipal() { return p; } }
  return {
    ids, agents, actorTargets,
    dependencies: {
      loadIdentity: async (id: number) => { ids.push(id); return { id, identity: new Identity(), principal: p.toText(), secretPath: "not-inspected-or-printed" }; },
      createAgent: async (options: HttpAgentOptions) => { agents.push(options); return {} as HttpAgent; },
      createActor: (_agent: HttpAgent, id: string) => { actorTargets.push(id); return actor; },
    },
  };
}
function batch(): BatchReceipt {
  return { id: 8n, owner: caller, publisher: caller, requestId: "same-publication-request", entries: [{ candidateId: 17n, appId: "alpha", version: 104n, digest: new Uint8Array(32).fill(1), sourceDigest: [new Uint8Array(32).fill(2)], auditId: 19n }], analysis: "Automated package verification", createdAtNs: 1788990000000000000n };
}

test("uses only existing identity 0 and the built-in IC root without discovery or root-key fetch", async () => {
  const m = mocked();
  const transport = await createFirstPartyTransport({ canister, host: target.network }, m.dependencies);
  expect(m.ids).toEqual([0]); expect(m.actorTargets).toEqual([canister]);
  expect(transport.caller.toText()).toBe(TRUSTED_PUBLISHER_CALLER);
  expect(m.agents).toHaveLength(1);
  expect(m.agents[0]?.shouldFetchRootKey).toBe(false);
  expect(m.agents[0]?.shouldSyncTime).toBe(false);
  expect(m.agents[0]?.verifyQuerySignatures).toBe(true);
  expect(m.agents[0]?.rootKey).toBeUndefined();
  expect(m.agents[0]?.identity).toBeDefined();
});

test("identity mismatch and missing saved identity stop before agent creation or queries", async () => {
  const m = mocked(other);
  await expect(createFirstPartyTransport({ canister, host: target.network }, m.dependencies)).rejects.toThrow("exact assigned Blast identity 0");
  expect(m.agents).toHaveLength(0); expect(m.actorTargets).toHaveLength(0);
  const missing = mocked();
  await expect(createFirstPartyTransport({ canister, host: target.network }, { ...missing.dependencies, loadIdentity: async () => { throw new Error("No saved identity"); } })).rejects.toThrow("No saved identity");
  expect(missing.agents).toHaveLength(0);
});

test("server must explicitly assign the loaded principal before publication writes", async () => {
  let writes = 0;
  for (const trustedPublishingPrincipal of [[], [other]]) {
    const m = mocked(caller, { marketplace_info: async () => ({ ...info(), trustedPublishingPrincipal }), trusted_publish_batch: async () => { writes++; return { ok: batch() }; } });
    await expect(createFirstPartyTransport({ canister, host: target.network }, m.dependencies)).rejects.toThrow("has not assigned this principal");
  }
  expect(writes).toBe(0);
});

test("local replica uses the explicitly supplied raw root key and never trusts fetched key material", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "first-party-root-"));
  try {
    const rootKeyFile = path.join(directory, "root.der"), rootKey = new Uint8Array([48, 2, 1, 7]);
    await writeFile(rootKeyFile, rootKey);
    const m = mocked();
    await createFirstPartyTransport({ canister, host: "http://127.0.0.1:4943", rootKeyFile }, m.dependencies);
    expect(m.agents[0]?.rootKey).toEqual(rootKey); expect(m.agents[0]?.shouldFetchRootKey).toBe(false);
    await expect(createFirstPartyTransport({ canister, host: "http://127.0.0.1:4943" }, m.dependencies)).rejects.toThrow("explicit trusted root-key");
    await expect(createFirstPartyTransport({ canister, host: target.network, rootKeyFile }, m.dependencies)).rejects.toThrow("built-in IC root key");
    await expect(createFirstPartyTransport({ canister, host: "https://user:password@icp-api.io" }, m.dependencies)).rejects.toThrow("without credentials");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("batch Candid includes exact digest bindings, one record argument and a query-only status endpoint", () => {
  const value = batch();
  const request = { requestId: value.requestId, candidates: value.entries.map(entry => ({ candidateId: entry.candidateId, expectedDigest: entry.digest, expectedSourceDigest: entry.sourceDigest })), analysis: value.analysis };
  expect(decode<typeof request>(TrustedBatchRequest, encode(TrustedBatchRequest, request))).toEqual(request);
  expect(decode<BatchReceipt>(TrustedBatch, encode(TrustedBatch, value))).toEqual(value);
  const methods = Object.fromEntries(firstPartyService()._fields);
  expect(methods.marketplace_info!.argTypes).toHaveLength(0);
  expect(methods.trusted_publish_batch!.argTypes).toHaveLength(1);
  expect(methods.trusted_publish_batch!.annotations).toEqual([]);
  expect(methods.trusted_publish_status!.argTypes).toHaveLength(1);
  expect(methods.trusted_publish_status!.annotations).toEqual(["query"]);
});

test("batch API preserves original request and reports protocol errors instead of successful publication", async () => {
  const value = batch(), requests: unknown[] = [];
  let status: { ok: [] | [BatchReceipt] } | { err: { code: string; message: string } } = { ok: [] };
  const m = mocked(caller, {
    marketplace_info: async () => info(),
    trusted_publish_status: async (...args) => { requests.push(args); return status; },
    trusted_publish_batch: async (...args) => { requests.push(args); return { ok: value }; },
  });
  const transport = await createFirstPartyTransport({ canister, host: target.network }, m.dependencies);
  expect(await transport.batchStatus(value.requestId)).toBeNull();
  status = { ok: [value] }; expect(await transport.batchStatus(value.requestId)).toBe(value);
  const request = { requestId: value.requestId, candidates: [], analysis: value.analysis };
  expect(await transport.publishBatch(request)).toBe(value);
  expect(requests).toEqual([[{ requestId: value.requestId }], [{ requestId: value.requestId }], [request]]);
  status = { err: { code: "trusted_publisher_required", message: "Authorization changed" } };
  await expect(transport.batchStatus(value.requestId)).rejects.toThrow("trusted_publisher_required: Authorization changed");
});

test("typed staging passes binary chunks directly and never permits relay or paid updates", async () => {
  const chunk = new Uint8Array(512_000).fill(13), seen: unknown[][] = [];
  const reply = { ok: { requestId: "upload", appId: "alpha", digest: new Uint8Array(32), size: BigInt(chunk.length), uploadedBytes: BigInt(chunk.length), state: { uploading: null }, artifactId: [] } };
  const transport = publisherActorTransport(target, caller, { upload_chunk: async (...args) => { seen.push(args); return reply; } });
  const request = { requestId: "upload", offset: 0n, bytes: chunk, feeVersion: 7n };
  expect(decode<typeof reply>(UploadReply, await transport.update(target, caller.toText(), "upload_chunk", encode(UploadChunk, request), 0n))).toEqual(reply);
  expect(seen).toEqual([[request]]); expect(await transport.callerPrincipal?.()).toBe(caller.toText());
  await expect(transport.update(target, caller.toText(), "upload_chunk", encode(UploadChunk, request), 1n)).rejects.toThrow("zero attached cycles");
  await expect(transport.update(target, other.toText(), "upload_chunk", encode(UploadChunk, request), 0n)).rejects.toThrow("verified caller");
  await expect(transport.update(target, caller.toText(), "marketplace_marketplace_call", new Uint8Array(), 0n)).rejects.toThrow("supported trusted staging");
  await expect(transport.update(target, caller.toText(), "repo_access_v1", new Uint8Array(), 0n)).rejects.toThrow("supported trusted staging");
  await expect(transport.query(target, "upload_chunk", new Uint8Array())).rejects.toThrow("supported trusted staging");
  await expect(transport.query({ ...target, canister: other.toText() }, "marketplace_info", new Uint8Array())).rejects.toThrow("target changed");
  expect(seen).toHaveLength(1);
});

const artifactPath = `/repo/v1/packages/${"1".repeat(64)}.neutron`;
const artifactUrl = `https://${canister}.icp0.io${artifactPath}`;
function emptyHttp(status = 403): HttpReader {
  return { http_request: async () => ({ status_code: status, headers: [], body: new Uint8Array(), streaming_strategy: [], upgrade: [] }), http_streaming_callback: async () => { throw new Error("Unexpected streaming"); } };
}

test("uncertified denial cannot trigger a grant and uncertified 404 cannot become a missing release", async () => {
  for (const status of [403, 404, 200]) {
    let grants = 0;
    const read = certifiedQueryFetch({ canister, actor: emptyHttp(status), rootKey: new Uint8Array(133), authorize: async () => { grants++; return "secret"; } });
    await expect(read(artifactUrl)).rejects.toThrow();
    expect(grants).toBe(0);
  }
});

test("certified reader rejects origin escapes, noncanonical paths, caller credentials and aborted requests before querying", async () => {
  let queries = 0;
  const http = emptyHttp();
  http.http_request = async () => { queries++; throw new Error("Unexpected query"); };
  const read = certifiedQueryFetch({ canister, actor: http, rootKey: new Uint8Array(133), authorize: async () => "secret" });
  await expect(read(`https://elsewhere.invalid${artifactPath}`)).rejects.toThrow("same-source");
  await expect(read(`https://${canister}.icp0.io/repo/v1/unknown`)).rejects.toThrow("canonical");
  await expect(read(artifactUrl, { method: "POST" })).rejects.toThrow("GET");
  await expect(read(artifactUrl, { headers: { Authorization: "Bearer external" } })).rejects.toThrow("managed");
  await expect(read(artifactUrl, { signal: AbortSignal.abort(new Error("already aborted")) })).rejects.toThrow("already aborted");
  expect(queries).toBe(0);
});

test("streaming may not call another canister or switch artifacts before final certificate verification", async () => {
  let callbacks = 0;
  const http = emptyHttp(200);
  http.http_request = async () => ({ status_code: 200, headers: [], body: new Uint8Array([1]), upgrade: [], streaming_strategy: [{ Callback: { callback: [other, "http_streaming_callback"], token: { path: artifactPath, sha256: new Uint8Array(32).fill(17), grant: [], index: 1n } } }] });
  http.http_streaming_callback = async () => { callbacks++; return { body: new Uint8Array(), token: [] }; };
  const read = certifiedQueryFetch({ canister, actor: http, rootKey: new Uint8Array(133), authorize: async () => "secret" });
  await expect(read(artifactUrl)).rejects.toThrow("streaming changed"); expect(callbacks).toBe(0);
});

test("aborting an in-flight query settles promptly even when the replica never replies", async () => {
  let queried!: () => void;
  const dispatched = new Promise<void>(resolve => { queried = resolve; });
  const http = emptyHttp();
  http.http_request = () => { queried(); return new Promise(() => {}); };
  const controller = new AbortController();
  const read = certifiedQueryFetch({ canister, actor: http, rootKey: new Uint8Array(133), authorize: async () => "secret" });
  const pending = read(artifactUrl, { signal: controller.signal });
  await dispatched;
  controller.abort(new Error("repository request timed out"));
  await expect(pending).rejects.toThrow("repository request timed out");
}, 500);

test("environment checks signer assignment before creating its HTTP reader and never grants from forged proof", async () => {
  let grants = 0, readers = 0;
  const m = mocked(caller, { marketplace_info: async () => info(), repo_access_v1: async () => { grants++; throw new Error("Unexpected grant"); } });
  const environment = await createFirstPartyEnvironment({ canister, host: target.network }, { ...m.dependencies, httpReader: async (id, host, rootKeyFile) => { readers++; expect(id).toBe(canister); expect(host).toBe(target.network); expect(rootKeyFile).toBeUndefined(); return { actor: emptyHttp(), rootKey: new Uint8Array(133) }; } });
  expect(readers).toBe(1);
  await expect(environment.fetch(artifactUrl)).rejects.toThrow();
  expect(grants).toBe(0);
});
