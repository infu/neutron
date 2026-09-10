import { Principal } from "@dfinity/principal";
import { REPOSITORY_LIMITS } from "neutron-tools/repository";
import {
  REPOSITORY_ACCESS_PATH,
  isRepositoryResourcePath,
  parseRepositoryAccessDescriptor,
  type RepositoryAccessDescriptor,
  type RepositoryAccessReply,
  type RepositoryAccessRequest,
} from "neutron-tools/src/repository_access.js";
import { canisterIdFromUrl, canisterOrigin } from "neutron-tools/src/runtime.js";
import { getRuntimeDeployment } from "../runtime_deployment.ts";

export type RepositoryFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type RepositorySource = Readonly<{ canisterId: string; origin: string }>;
export type RepositoryAccessCharge = Readonly<{
  source: string;
  paths: readonly string[];
  cycles: bigint;
  feeVersion: bigint;
}>;
export type RepositoryAccessApproval = Readonly<{
  source: string;
  descriptor: RepositoryAccessDescriptor;
}>;

export class RepositoryAccessError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "RepositoryAccessError";
  }
}

export type RepositoryAccessOptions = Readonly<{
  fetch?: RepositoryFetch | undefined;
  signal?: AbortSignal | undefined;
  resourcePaths?: readonly string[] | undefined;
  /** Existing caller HTTP timeout; never applied to a signed access update. */
  timeoutMs?: number;
  approvedAccess?: readonly RepositoryAccessApproval[] | undefined;
}>;

export type RepositoryAccessDependencies = Readonly<{
  fetch: RepositoryFetch;
  resolveSource: (url: URL) => RepositorySource | null;
  ownerKey: () => string | Promise<string>;
  authorize: (input: {
    source: string;
    cycles: bigint;
    request: RepositoryAccessRequest;
  }) => Promise<RepositoryAccessReply>;
  reviewCharge?: (charge: RepositoryAccessCharge) => Promise<void>;
  /** Production host requires the descriptor shown by its existing action. */
  requireApprovedAccess?: boolean;
  randomBytes?: (length: number) => Uint8Array;
}>;

// The verified IC gateway verifies this request-bound expression. Requiring it
// prevents an authenticated response from silently using a public cache leaf.
const PRIVATE_EXPRESSION = 'default_certification(ValidationArgs{certification:Certification{request_certification:RequestCertification{certified_request_headers:["authorization"],certified_query_parameters:[]},response_certification:ResponseCertification{response_header_exclusions:ResponseHeaderList{headers:[]}}}})';

type Grant = {
  owner: string;
  source: RepositorySource;
  request: RepositoryAccessRequest;
  descriptor: RepositoryAccessDescriptor;
  ready: boolean;
};

/**
 * Anonymous public acquisition is unchanged. A certified access challenge may
 * acquire an exact-path grant via the owning Neutron; package bytes stay HTTP.
 * Artifact bodies remain streaming, bounded and hash-checked by their callers.
 */
export function createRepositoryAccessFetcher(deps: RepositoryAccessDependencies) {
  const grants = new Map<string, Grant>();
  const acquisitions = new Map<string, Promise<Grant>>();

  return async function fetchResource(
    input: RequestInfo | URL,
    init: RequestInit = {},
    options: Omit<RepositoryAccessOptions, "fetch"> = {},
  ): Promise<Response> {
    const raw = input instanceof Request ? input.url : String(input);
    const url = new URL(raw);
    const method = (init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const source = !url.search && !url.hash && !url.username && !url.password &&
      isRepositoryResourcePath(url.pathname) && (method === "GET" || method === "HEAD")
      ? deps.resolveSource(url) : null;
    if (!source || source.origin !== url.origin) return deps.fetch(input, init);
    const signal = options.signal ?? init.signal ?? undefined;
    const fetch = options.timeoutMs === undefined ? deps.fetch : timedFetch(deps.fetch, options.timeoutMs);
    const paths = [...new Set(options.resourcePaths ?? [url.pathname])].sort();
    if (!paths.includes(url.pathname) || paths.some((path) => !isRepositoryResourcePath(path))) {
      throw new RepositoryAccessError("invalid_paths", "Source access must name the exact canonical resource paths.");
    }
    const read = async (token?: string): Promise<Response> => {
      assertNotAborted(signal);
      const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
      headers.delete("authorization");
      if (token) headers.set("authorization", `Bearer ${token}`);
      const response = await fetch(url.href, {
        ...init, method, headers, body: null, ...(signal ? { signal } : {}),
        credentials: "omit", cache: token ? "no-store" : (init.cache ?? "no-store"), redirect: "error",
        mode: "cors", referrerPolicy: "no-referrer",
      });
      assertExactResponse(response, url);
      if (token && response.ok) assertPrivateResponse(response);
      return response;
    };

    // No session access or backend call is needed for public resources.
    let response = await read();
    if (response.status !== 401 && response.status !== 403) return response;
    assertGatewayProof(response, true);
    await response.body?.cancel();
    assertNotAborted(signal);
    const owner = await deps.ownerKey();
    if (!owner) throw new RepositoryAccessError("owner_required", "Sign in to this Neutron to access this package source.");
    const prefix = JSON.stringify([owner, source.canisterId, source.origin]);
    const group = `${prefix}:${JSON.stringify(paths)}`;

    const assertOwner = async (): Promise<void> => {
      if (await deps.ownerKey() !== owner) {
        for (const [key, grant] of grants) if (grant.owner === owner) grants.delete(key);
        throw new RepositoryAccessError("owner_changed", "The Neutron session changed. Open this download again.");
      }
    };

    const acquire = async (): Promise<Grant> => {
      let grant = grants.get(group) ?? [...grants.values()].find((item) =>
        item.owner === owner && item.source.origin === source.origin &&
        item.source.canisterId === source.canisterId && item.ready &&
        paths.every((path) => item.request.paths.includes(path)),
      );
      if (grant?.ready) return grant;
      const underway = acquisitions.get(group);
      if (underway) return underway;
      const job = (async () => {
        if (!grant) {
          const descriptor = await readDescriptor(fetch, source, signal, options.timeoutMs);
          if (!descriptor) throw new RepositoryAccessError("unsupported_source", "This source does not provide certified repository access.");
          assertNotAborted(signal);
          await assertOwner();
          if (deps.requireApprovedAccess) {
            const approval = options.approvedAccess?.find((item) => item.source === source.canisterId);
            if (!approval || approval.descriptor.protocol !== descriptor.protocol ||
              approval.descriptor.fee_version !== descriptor.fee_version || approval.descriptor.cycles !== descriptor.cycles) {
              throw new RepositoryAccessError("access_review_required", "The package source access cost needs review. Refresh the source cost and use the Install or Upgrade action again.");
            }
          }
          await deps.reviewCharge?.({
            source: source.canisterId, paths,
            cycles: BigInt(descriptor.cycles), feeVersion: BigInt(descriptor.fee_version),
          });
          assertNotAborted(signal);
          await assertOwner();
          const random = deps.randomBytes ?? secureRandom;
          grant = {
            owner, source, descriptor, ready: false,
            request: { request_id: hex(random(16)), token: hex(random(32)), paths, fee_version: BigInt(descriptor.fee_version) },
          };
          grants.set(group, grant);
        }
        const current = grant;
        let reply: RepositoryAccessReply;
        try {
          reply = await deps.authorize({ source: source.canisterId, cycles: BigInt(current.descriptor.cycles), request: current.request });
        } catch {
          // Retain the same request/token for an interrupted update. Never
          // disclose a token, candid args or remote transport text in errors.
          throw new RepositoryAccessError("invocation_unknown", "The source access reply was interrupted. Retry this download to reconcile the same access request.");
        }
        await assertOwner();
        validateReply(reply, current);
        if ("err" in reply.result) {
          if (reply.result.err.code !== "invocation_unknown") grants.delete(group);
          const message = reply.result.err.message.includes(current.request.token)
            ? "The source could not authorize this download."
            : reply.result.err.message;
          throw new RepositoryAccessError(reply.result.err.code.includes(current.request.token) ? "access_error" : reply.result.err.code, message);
        }
        current.ready = true;
        return current;
      })();
      acquisitions.set(group, job);
      try { return await job; }
      finally { if (acquisitions.get(group) === job) acquisitions.delete(group); }
    };

    const first = await acquire();
    await assertOwner();
    response = await read(first.request.token);
    await assertOwner();
    if (response.status !== 401 && response.status !== 403) return response;
    assertGatewayProof(response, true);
    await response.body?.cancel();
    // Revocation can renew an existing cached grant, but a newly issued grant
    // being denied is an error, never an unbounded source-fee retry loop.
    for (const [key, grant] of grants) if (grant === first) grants.delete(key);
    throw new RepositoryAccessError("access_denied", "The source no longer authorizes this download. Start the download again to request current access.");
  };
}

function validateReply(reply: RepositoryAccessReply, grant: Grant): void {
  const fail = () => { throw new RepositoryAccessError("invalid_reply", "The source returned an invalid access receipt."); };
  if (!reply || !Array.isArray(reply.charged_cycles) || reply.charged_cycles.length > 1) fail();
  const charged = reply.charged_cycles[0];
  if (charged !== undefined && (typeof charged !== "bigint" || charged < 0n || charged > BigInt(grant.descriptor.cycles))) fail();
  const result = reply.result;
  if (!result || typeof result !== "object" || Object.keys(result).length !== 1) fail();
  if ("err" in result) {
    if (typeof result.err?.code !== "string" || typeof result.err?.message !== "string") fail();
    return;
  }
  if (!("ok" in result)) fail();
  const ok = (result as Extract<RepositoryAccessReply["result"], { ok: unknown }>).ok;
  if (ok?.request_id !== grant.request.request_id || !Array.isArray(ok.paths) ||
    ok.paths.length !== grant.request.paths.length ||
    [...ok.paths].sort().some((path, i) => path !== grant.request.paths[i]) ||
    charged === undefined || typeof ok.accepted_cycles !== "bigint" || ok.accepted_cycles < 0n || ok.accepted_cycles > charged) fail();
}

async function readDescriptor(fetch: RepositoryFetch, source: RepositorySource, signal?: AbortSignal, timeoutMs?: number, publicAbsence = false): Promise<RepositoryAccessDescriptor | null> {
  const url = new URL(REPOSITORY_ACCESS_PATH, source.origin);
  const response = await fetch(url.href, {
    method: "GET", headers: { accept: "application/json" }, ...(signal ? { signal } : {}),
    credentials: "omit", cache: "no-store", redirect: "error", mode: "cors", referrerPolicy: "no-referrer",
  });
  assertExactResponse(response, url);
  assertGatewayProof(response, !(publicAbsence && response.status === 404));
  if (publicAbsence && response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  if (!response.ok || response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new RepositoryAccessError("unsupported_source", "This source does not provide certified repository access.");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new RepositoryAccessError("invalid_descriptor", "The source access description is empty.");
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timedOut = false;
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener("abort", cancel, { once: true });
  const timer = timeoutMs === undefined ? undefined : setTimeout(() => { timedOut = true; cancel(); }, timeoutMs);
  const check = () => {
    assertNotAborted(signal);
    if (timedOut) throw new RepositoryAccessError("timed_out", "The source access description took too long to download.");
  };
  try {
    for (;;) {
      check();
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > REPOSITORY_LIMITS.releaseJsonBytes) {
        await reader.cancel();
        throw new RepositoryAccessError("invalid_descriptor", "The source access description exceeds the repository metadata limit.");
      }
      chunks.push(value);
    }
    check();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return parseRepositoryAccessDescriptor(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))); }
  catch { throw new RepositoryAccessError("invalid_descriptor", "The source access description is invalid."); }
}

function assertExactResponse(response: Response, url: URL): void {
  if (response.redirected || (response.url && response.url !== url.href)) {
    throw new RepositoryAccessError("wrong_source", "The package source redirected the download or returned a different resource.");
  }
}

function assertGatewayProof(response: Response, required: boolean): void {
  const certificate = response.headers.get("ic-certificate");
  const expression = response.headers.get("ic-certificateexpression");
  if (!required && !certificate && !expression) return;
  if (!certificate || !/(?:^|[,;]\s*)certificate\s*=\s*:[A-Za-z0-9+/=_-]+:/iu.test(certificate) ||
    !/(?:^|[,;]\s*)tree\s*=\s*:[A-Za-z0-9+/=_-]+:/iu.test(certificate) ||
    !/(?:^|[,;]\s*)expr_path\s*=\s*:[A-Za-z0-9+/=_-]+:/iu.test(certificate) ||
    !/(?:^|[,;]\s*)version\s*=\s*2(?:\s*[,;]|\s*$)/iu.test(certificate) ||
    !expression?.trim() || /\bno_certification\b/iu.test(expression)) {
    throw new RepositoryAccessError("uncertified", "The package source response is not certified.");
  }
}

function assertPrivateResponse(response: Response): void {
  assertGatewayProof(response, true);
  const expression = response.headers.get("ic-certificateexpression")!;
  const cache = response.headers.get("cache-control")?.toLowerCase().split(",").map((item) => item.trim());
  const vary = response.headers.get("vary")?.toLowerCase().split(",").map((item) => item.trim());
  if (expression.replace(/\s+/gu, "") !== PRIVATE_EXPRESSION ||
    !cache?.includes("private") || !cache.includes("no-store") ||
    cache.some((item) => item === "public" || item.startsWith("s-maxage") || item.startsWith("max-age")) ||
    !vary?.includes("authorization")) {
    throw new RepositoryAccessError("uncertified_access", "The source did not certify this private download's authorization and cache policy.");
  }
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("The download was canceled.", "AbortError");
}
function timedFetch(fetch: RepositoryFetch, timeoutMs: number): RepositoryFetch {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("Repository HTTP timeout is invalid.");
  return async (input, init) => {
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort(init?.signal?.reason);
    if (init?.signal?.aborted) abort();
    else init?.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try { return await fetch(input, { ...init, signal: controller.signal }); }
    catch (error) {
      if (init?.signal?.aborted) throw new DOMException("The download was canceled.", "AbortError");
      if (timedOut) throw new RepositoryAccessError("timed_out", "The package source took too long to respond.");
      throw error;
    } finally {
      clearTimeout(timer);
      init?.signal?.removeEventListener("abort", abort);
    }
  };
}
function secureRandom(length: number): Uint8Array { return crypto.getRandomValues(new Uint8Array(length)); }
function hex(bytes: Uint8Array): string { return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join(""); }

function resolveSource(url: URL): RepositorySource | null {
  const canisterId = canisterIdFromUrl(url);
  if (!canisterId) return null;
  try { if (Principal.fromText(canisterId).toText() !== canisterId) return null; } catch { return null; }
  if (url.origin === canisterOrigin({ canisterId })) return { canisterId, origin: url.origin };
  try {
    const runtime = getRuntimeDeployment();
    if (runtime.local && url.origin === canisterOrigin({ canisterId, local: true, ...(runtime.localHost ? { localHost: runtime.localHost } : {}) })) {
      return { canisterId, origin: url.origin };
    }
  } catch { /* Public downloads do not require an initialized owner session. */ }
  return null;
}

/** Only canonical resources on the verified canister gateway use this route. */
export function resolveRepositoryAccessSource(input: string | URL): RepositorySource | null {
  let url: URL;
  try { url = new URL(input); } catch { return null; }
  if (url.search || url.hash || url.username || url.password || !isRepositoryResourcePath(url.pathname)) return null;
  return resolveSource(url);
}

const defaultFetchers = new WeakMap<RepositoryFetch, ReturnType<typeof createRepositoryAccessFetcher>>();

export async function fetchWithRepositoryAccess(input: RequestInfo | URL, init?: RequestInit, options: RepositoryAccessOptions = {}): Promise<Response> {
  const fetch = options.fetch ?? globalThis.fetch;
  let access = defaultFetchers.get(fetch);
  if (!access) {
    access = createRepositoryAccessFetcher({
      fetch, resolveSource, requireApprovedAccess: true,
      ownerKey: async () => {
        const { useAuthStore } = await import("../reducer/auth.ts");
        const auth = useAuthStore.getState();
        return auth.logged && auth.authorized && !auth.loading
          ? `${getRuntimeDeployment().canisterId}:${auth.principal}:${auth.sessionGeneration}` : "";
      },
      authorize: async ({ source, cycles, request }) => {
        const { getNeutronCan } = await import("../reducer/auth.ts");
        return (await getNeutronCan()).kernel_repository_access_v1({ source: Principal.fromText(source), cycles, request: { ...request, paths: [...request.paths] } });
      },
    });
    defaultFetchers.set(fetch, access);
  }
  return access(input, init, options);
}

/** Public metadata only; never authenticates, creates a grant, or pays cycles. */
export async function fetchRepositoryAccessApproval(
  source: string,
  options: Pick<RepositoryAccessOptions, "fetch" | "signal" | "timeoutMs"> = {},
): Promise<RepositoryAccessApproval | null> {
  assertNotAborted(options.signal);
  const id = Principal.fromText(source).toText();
  let origin = canisterOrigin({ canisterId: id });
  try {
    const runtime = getRuntimeDeployment();
    if (runtime.local) origin = canisterOrigin({ canisterId: id, local: true, ...(runtime.localHost ? { localHost: runtime.localHost } : {}) });
  } catch { /* Production canonical sources also work before owner sign-in. */ }
  const base = options.fetch ?? globalThis.fetch;
  const fetch = options.timeoutMs === undefined ? base : timedFetch(base, options.timeoutMs);
  const descriptor = await readDescriptor(fetch, { canisterId: id, origin }, options.signal, options.timeoutMs, true);
  return descriptor ? Object.freeze({ source: id, descriptor }) : null;
}
