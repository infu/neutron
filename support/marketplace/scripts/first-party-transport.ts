// All rights reserved. See ../LICENSE.
import { Actor, HttpAgent, type HttpAgentOptions } from "@dfinity/agent";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { verifyRequestResponsePair } from "@dfinity/response-verification";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { loadExistingBlastIdentity } from "../../../packages/neutron-provision/src/identity.ts";
import { AccessRequest, AccessReply, blob, result, unwrap, type Target } from "./operator-wire.ts";
import { Listing, ListingReply, UploadBegin, UploadChunk, UploadFinish, UploadReply, Submit, SubmitReply, publish, type Transport } from "./publisher.ts";
import { TRUSTED_PUBLISHER_CALLER, type BatchReceipt, type TrustedPublishTransport } from "./first-party-publish.ts";
import { reader, type HttpReader } from "./audit-download.ts";
import { updateSourceOrigin, type CertifiedFetch } from "../../update-source/src/http.ts";
import { SOURCE_COMPRESSED_MAX_BYTES } from "../../update-source/src/model.ts";
import { REPOSITORY_LIMITS } from "neutron-tools/src/repository.ts";

const operation = IDL.Record({ requestId: IDL.Text });
const TrustedInfo = IDL.Record({ canister: IDL.Principal, fees: IDL.Record({ version: IDL.Nat }), trustedPublishingPrincipal: IDL.Opt(IDL.Principal) });
export const TrustedBatchRequest = IDL.Record({
  requestId: IDL.Text,
  candidates: IDL.Vec(IDL.Record({ candidateId: IDL.Nat64, expectedDigest: blob, expectedSourceDigest: IDL.Opt(blob) })),
  analysis: IDL.Text,
});
export const TrustedBatch = IDL.Record({
  id: IDL.Nat64, owner: IDL.Principal, publisher: IDL.Principal, requestId: IDL.Text,
  entries: IDL.Vec(IDL.Record({ candidateId: IDL.Nat64, appId: IDL.Text, version: IDL.Nat, digest: blob, sourceDigest: IDL.Opt(blob), auditId: IDL.Nat64 })),
  analysis: IDL.Text, createdAtNs: IDL.Int,
});
type Method = { args: [] | [IDL.Type]; reply: IDL.Type; query: boolean };
const methods: Record<string, Method> = {
  marketplace_info: { args: [], reply: TrustedInfo, query: true },
  listing_save: { args: [Listing], reply: ListingReply, query: false },
  upload_begin: { args: [UploadBegin], reply: UploadReply, query: false },
  upload_chunk: { args: [UploadChunk], reply: UploadReply, query: false },
  upload_finish: { args: [UploadFinish], reply: UploadReply, query: false },
  candidate_submit: { args: [Submit], reply: SubmitReply, query: false },
  trusted_publish_batch: { args: [TrustedBatchRequest], reply: result(TrustedBatch), query: false },
  trusted_publish_status: { args: [operation], reply: result(IDL.Opt(TrustedBatch)), query: true },
  repo_access_v1: { args: [AccessRequest], reply: AccessReply, query: false },
};
export const firstPartyService = () => IDL.Service(Object.fromEntries(Object.entries(methods).map(([name, method]) => [name, IDL.Func(method.args, [method.reply], method.query ? ["query"] : [])])));
export type FirstPartyActor = Record<string, (...args: unknown[]) => Promise<unknown>>;
export type FirstPartyTransportOptions = { canister: string; host: string; rootKeyFile?: string };
type Dependencies = {
  loadIdentity?: typeof loadExistingBlastIdentity;
  createAgent?: (options: HttpAgentOptions) => Promise<HttpAgent>;
  createActor?: (agent: HttpAgent, canister: string) => FirstPartyActor;
  httpReader?: typeof reader;
};

/** Typed Candid translation keeps large archive chunks out of process arguments.
 * This wire is intentionally only the trusted publication route. */
export function publisherActorTransport(target: Target, caller: Principal, actor: FirstPartyActor): Transport {
  const assertTarget = (other: Target) => {
    if (other.canister !== target.canister || other.identity !== target.identity || other.network !== target.network || other.rootKeyFile !== target.rootKeyFile) throw new Error("Publication transport target changed after identity verification.");
    if (caller.toText() !== TRUSTED_PUBLISHER_CALLER) throw new Error("Trusted publication requires the assigned Blast identity 0 principal.");
  };
  const invoke = async (method: string, args: Uint8Array, query: boolean) => {
    const spec = methods[method];
    if (!spec || spec.query !== query || method.startsWith("trusted_publish_") || method === "repo_access_v1") throw new Error("This is not a supported trusted staging method.");
    const value = await actor[method]!(...IDL.decode(spec.args, args));
    return new Uint8Array(IDL.encode([spec.reply], [value]));
  };
  return {
    callerPrincipal: async () => { assertTarget(target); return caller.toText(); },
    query: async (other, method, args) => { assertTarget(other); return invoke(method, args, true); },
    update: async (other, requestedCaller, method, args, cycles) => {
      assertTarget(other);
      if (requestedCaller !== caller.toText() || cycles !== 0n) throw new Error("Trusted staging must use the verified caller directly with zero attached cycles.");
      return invoke(method, args, false);
    },
  };
}

/** Loads only an existing Blast identity. It never generates a key, accepts a
 * secret override, fetches a replacement root key, or invokes a Neutron relay. */
export async function createFirstPartyTransport(options: FirstPartyTransportOptions, dependencies: Dependencies = {}): Promise<TrustedPublishTransport> {
  return (await createConnection(options, dependencies)).transport;
}

async function createConnection(options: FirstPartyTransportOptions, dependencies: Dependencies) {
  const canister = Principal.fromText(options.canister);
  if (canister.isAnonymous() || canister.toText() !== options.canister) throw new Error("Select a canonical marketplace canister principal.");
  const host = new URL(options.host);
  if (!["http:", "https:"].includes(host.protocol) || host.username || host.password || host.pathname !== "/" || host.search || host.hash) throw new Error("Select a replica origin without credentials, paths or query parameters.");
  const mainnet = host.origin === "https://icp-api.io" || host.origin === "https://ic0.app";
  if (!mainnet && !options.rootKeyFile) throw new Error("A non-mainnet replica requires an explicit trusted root-key file.");
  if (mainnet && options.rootKeyFile) throw new Error("Mainnet publication uses the built-in IC root key.");
  const loaded = await (dependencies.loadIdentity ?? loadExistingBlastIdentity)(0);
  const caller = loaded.identity.getPrincipal();
  if (loaded.id !== 0 || caller.toText() !== TRUSTED_PUBLISHER_CALLER || loaded.principal !== caller.toText()) throw new Error("Trusted first-party publication requires the exact assigned Blast identity 0 principal.");
  const rootKey = options.rootKeyFile ? new Uint8Array(await readFile(options.rootKeyFile)) : undefined;
  if (rootKey?.length === 0) throw new Error("The trusted root-key file is empty.");
  const agent = await (dependencies.createAgent ?? HttpAgent.create)({ host: host.origin, identity: loaded.identity, shouldFetchRootKey: false, shouldSyncTime: false, verifyQuerySignatures: true, ...(rootKey ? { rootKey } : {}) });
  const actor = dependencies.createActor ? dependencies.createActor(agent, canister.toText()) : Actor.createActor(firstPartyService, { agent, canisterId: canister }) as unknown as FirstPartyActor;
  const target: Target = { canister: canister.toText(), identity: "blast:0", network: host.origin, ...(options.rootKeyFile ? { rootKeyFile: options.rootKeyFile } : {}) };
  const staging = publisherActorTransport(target, caller, actor);
  const info = await actor.marketplace_info!() as { canister: Principal; fees: { version: bigint }; trustedPublishingPrincipal: [] | [Principal] };
  if (info.canister.toText() !== canister.toText() || info.trustedPublishingPrincipal[0]?.toText() !== caller.toText()) throw new Error("The selected marketplace has not assigned this principal trusted publication authority.");
  const transport: TrustedPublishTransport = {
    caller,
    stage: async (release, stageOptions) => {
      if (stageOptions.publisher !== caller.toText()) throw new Error("Trusted first-party listings must belong to the assigned caller.");
      const outcome = await publish(release.prepared, { target, requestId: stageOptions.requestId, journal: stageOptions.journal, trustedDirect: { caller: caller.toText() }, execute: true, maxCycles: 0n }, staging);
      const candidate = outcome.candidate;
      if (!candidate) throw new Error("Trusted staging did not return its retained candidate evidence.");
      if (candidate.sourceDigest.length > 1) throw new Error("Staged candidate returned an invalid optional source digest.");
      return { candidateId: candidate.id, appId: candidate.appId, version: candidate.version, publisher: candidate.publisher, digest: candidate.digest, sourceDigest: candidate.sourceDigest[0] ? [candidate.sourceDigest[0]] : [] };
    },
    batchStatus: async requestId => {
      const value = unwrap(await actor.trusted_publish_status!({ requestId }) as { ok: [] | [BatchReceipt] } | { err: { code: string; message: string } });
      return value[0] ?? null;
    },
    publishBatch: async request => unwrap(await actor.trusted_publish_batch!(request) as { ok: BatchReceipt } | { err: { code: string; message: string } }),
  };
  return { transport, actor, feeVersion: info.fees.version };
}

/** The same request-bound verifier works against mainnet and an explicitly
 * trusted local replica. Private proof headers are kept private, never relabeled
 * as public-cacheable gateway output. */
export function certifiedQueryFetch(options: { canister: string; actor: HttpReader; rootKey: Uint8Array; authorize: (path: string) => Promise<string> }): CertifiedFetch {
  const origin = updateSourceOrigin({ canisterId: options.canister });
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (url.origin !== origin || url.search || url.hash || url.username || url.password || method !== "GET" || init?.body) throw new Error("The certified publication reader only accepts same-source repository GET requests.");
    const packageMatch = /^\/repo\/v1\/packages\/([0-9a-f]{64})\.neutron$/.exec(url.pathname);
    const sourceMatch = /^\/repo\/v1\/sources\/([0-9a-f]{64})\.source\.v1\.msgpack\.gz$/.exec(url.pathname);
    const releaseMatch = /^\/repo\/v1\/releases\/[a-z0-9_-]+\.json$/.test(url.pathname);
    if (!packageMatch && !sourceMatch && !releaseMatch) throw new Error("The certified publication reader requires a canonical package, source or release path.");
    const maximum = packageMatch ? REPOSITORY_LIMITS.packageBytes : sourceMatch ? SOURCE_COMPRESSED_MAX_BYTES : REPOSITORY_LIMITS.releaseJsonBytes;
    const expectedDigest = packageMatch?.[1] ?? sourceMatch?.[1];
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const wait = async <T>(promise: Promise<T>): Promise<T> => {
      if (!signal) return promise;
      return new Promise<T>((resolve, reject) => {
        const aborted = () => reject(signal.reason ?? new Error("The repository request was aborted."));
        const finish = () => signal.removeEventListener("abort", aborted);
        // Attaching both handlers also consumes a late rejection after abort.
        promise.then(value => { finish(); resolve(value); }, error => { finish(); reject(error); });
        if (signal.aborted) aborted(); else signal.addEventListener("abort", aborted, { once: true });
      });
    };
    const supplied = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (supplied.has("Authorization")) throw new Error("Publication access credentials are managed by the verified publisher transport.");
    const requestHeaders: [string, string][] = [...supplied.entries()];
    const read = async (credential?: string) => {
      signal?.throwIfAborted();
      const request = { method: "GET", url: url.pathname, headers: [...requestHeaders, ...(credential ? [["Authorization", `Bearer ${credential}`] as [string, string]] : [])], body: new Uint8Array(), certificate_version: [2] as [number] };
      const first = await wait(options.actor.http_request(request));
      signal?.throwIfAborted();
      if (first.upgrade[0]) throw new Error("A repository read unexpectedly requested an update.");
      const chunks = [Uint8Array.from(first.body)];
      let size = first.body.length, next = first.streaming_strategy[0]?.Callback, previous = -1n;
      if (size > maximum) throw new Error("The certified repository response exceeds the supported artifact size.");
      while (next) {
        const token = next.token;
        if (next.callback[0].toText() !== options.canister || next.callback[1] !== "http_streaming_callback" || token.path !== url.pathname || token.index <= previous || token.grant[0] !== credential || !expectedDigest || Buffer.from(token.sha256).toString("hex") !== expectedDigest) throw new Error("Repository streaming changed its artifact, grant, callback or byte progression.");
        previous = token.index;
        const part = await wait(options.actor.http_streaming_callback(token));
        signal?.throwIfAborted();
        if (!part.body.length && part.token.length) throw new Error("Repository streaming made no progress.");
        size += part.body.length;
        if (size > maximum) throw new Error("The certified repository response exceeds the supported artifact size.");
        chunks.push(Uint8Array.from(part.body));
        next = part.token[0] ? { callback: next.callback, token: part.token[0] } : undefined;
      }
      const body = Uint8Array.from(Buffer.concat(chunks));
      const verified = verifyRequestResponsePair(request, { status_code: first.status_code, headers: first.headers, body }, Principal.fromText(options.canister).toUint8Array(), BigInt(Date.now()) * 1_000_000n, 300_000_000_000n, options.rootKey, 2);
      if (verified.verificationVersion !== 2 || !verified.response || verified.response.statusCode !== first.status_code) throw new Error("The repository response has no valid request-bound HTTP v2 proof.");
      const headers = new Headers(verified.response.headers);
      // The verifier returns authenticated application headers. Retain the
      // validated proof envelope for the existing repository reader as well.
      for (const name of ["ic-certificate", "ic-certificateexpression"]) {
        const values = first.headers.filter(([key]) => key.toLowerCase() === name);
        if (values.length !== 1) throw new Error("The repository proof envelope has missing or repeated headers.");
        headers.set(name, values[0]![1]);
      }
      return new Response(Uint8Array.from(verified.response.body), { status: first.status_code, headers });
    };
    const publicResponse = await read();
    if (publicResponse.status !== 403 || releaseMatch) return publicResponse;
    signal?.throwIfAborted();
    const credential = await wait(options.authorize(url.pathname));
    signal?.throwIfAborted();
    return read(credential);
  }) as CertifiedFetch;
}

export async function createFirstPartyEnvironment(options: FirstPartyTransportOptions, dependencies: Dependencies = {}): Promise<{ transport: TrustedPublishTransport; fetch: CertifiedFetch }> {
  const connection = await createConnection(options, dependencies);
  const http = await (dependencies.httpReader ?? reader)(options.canister, options.host, options.rootKeyFile);
  // Credentials exist only in this process. Retain the exact access request if
  // a response is lost; never write bearer tokens to publication journals.
  const grants = new Map<string, { request_id: string; token: string; paths: string[]; fee_version: bigint; confirmed: boolean }>();
  const authorize = async (path: string) => {
    let saved = grants.get(path);
    if (!saved) { saved = { request_id: randomBytes(16).toString("hex"), token: randomBytes(32).toString("hex"), paths: [path], fee_version: connection.feeVersion, confirmed: false }; grants.set(path, saved); }
    if (!saved.confirmed) {
      const reply = unwrap(await connection.actor.repo_access_v1!({ request_id: saved.request_id, token: saved.token, paths: saved.paths, fee_version: saved.fee_version }) as { ok: { request_id: string; paths: string[]; accepted_cycles: bigint } } | { err: { code: string; message: string } });
      if (reply.request_id !== saved.request_id || reply.paths.length !== 1 || reply.paths[0] !== path || reply.accepted_cycles !== 0n) throw new Error("The publisher source-access receipt differs from its exact free request.");
      saved.confirmed = true;
    }
    return saved.token;
  };
  return { transport: connection.transport, fetch: certifiedQueryFetch({ canister: options.canister, actor: http.actor, rootKey: http.rootKey, authorize }) };
}
