import { createPublicClient, custom, type PublicClient } from "viem";

export type BrowserEvmChainId = string | number | bigint;
export type BrowserEvmRpcOptions = { signal?: AbortSignal | undefined };
export type BrowserEvmRpcConfig = {
  endpoints?: Readonly<Record<string, string>>;
  fetch?: typeof globalThis.fetch;
  /** Preserve the existing wallet RPC deadline; callers may supply their own. */
  timeoutMs?: number;
};

// Published HTTP endpoints support the app's opaque sandbox origin without an
// extension or private API key. Ethereum uses dRPC's public endpoint because
// PublicNode gates numeric state reads behind an archive token, even at the
// current head. Keep exact block tags for consistent balances and simulations.
// https://drpc.org/docs/ethereum-api
// Hyperliquid lists dRPC in its developer tools:
// https://hyperliquid.gitbook.io/hyperliquid-docs/builder-tools/hyperevm-tools
// Its archive endpoint preserves explicit-block reads. The default HyperEVM
// RPC silently substitutes latest state for numeric block tags.
export const DEFAULT_EVM_RPC_ENDPOINTS: Readonly<Record<string, string>> = Object.freeze({
  "1": "https://eth.drpc.org",
  "42161": "https://arbitrum-one-rpc.publicnode.com",
  "999": "https://hyperliquid.drpc.org",
  "11155111": "https://ethereum-sepolia-rpc.publicnode.com",
});
export const DEFAULT_EVM_RPC_TIMEOUT_MS = 120_000;

export class BrowserEvmRpcError extends Error {
  readonly code: number | undefined;
  readonly data: unknown;

  constructor(message: string, code?: number, data?: unknown) {
    super(message);
    this.name = "BrowserEvmRpcError";
    this.code = code;
    this.data = data;
  }
}

function chainKey(chainId: BrowserEvmChainId): string {
  if (typeof chainId === "number" && !Number.isSafeInteger(chainId)) {
    throw new Error("RPC chain ID must be an exact integer");
  }
  let parsed: bigint;
  try { parsed = BigInt(chainId); } catch { throw new Error("Invalid RPC chain ID"); }
  if (parsed <= 0n) throw new Error("RPC chain ID must be positive");
  return parsed.toString();
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("RPC request cancelled", "AbortError");
}

function withSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // The caller can abort synchronously while work is being started. Its
    // eventual rejection still needs a handler after cancellation wins.
    void work.catch(() => {});
    return Promise.reject(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(abortReason(signal));
    signal.addEventListener("abort", aborted, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

/** One browser-to-server POST for each JSON-RPC call, with no automatic retry. */
export function createBrowserEvmRpc(config: BrowserEvmRpcConfig = {}) {
  const endpoints = { ...DEFAULT_EVM_RPC_ENDPOINTS, ...config.endpoints };
  const timeoutMs = config.timeoutMs ?? DEFAULT_EVM_RPC_TIMEOUT_MS;
  const fetchRpc = config.fetch ?? globalThis.fetch.bind(globalThis);
  const sessions = new Map<string, Promise<string>>();
  const clients = new Map<string, PublicClient>();
  let nextId = 0n;

  function endpoint(chainId: BrowserEvmChainId): string {
    const key = chainKey(chainId);
    const url = endpoints[key];
    if (!url) throw new Error(`No browser RPC endpoint configured for chain ${key}`);
    return url;
  }

  async function deadline<T>(work: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const controller = new AbortController();
    const aborted = () => controller.abort(signal ? abortReason(signal) : undefined);
    if (signal?.aborted) aborted();
    else signal?.addEventListener("abort", aborted, { once: true });
    const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(new DOMException(
      "RPC request timed out. You can retry the read or check the pending transaction before sending again.",
      "TimeoutError",
    )), timeoutMs) : undefined;
    try {
      if (controller.signal.aborted) throw abortReason(controller.signal);
      return await withSignal(work(controller.signal), controller.signal);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
    }
  }

  async function post<T>(key: string, method: string, params: readonly unknown[], signal: AbortSignal): Promise<T> {
    if (signal.aborted) throw abortReason(signal);
    const id = `neutron-evm-${++nextId}`;
    let response: Response;
    try {
      response = await fetchRpc(endpoint(key), {
        method: "POST",
        mode: "cors",
        credentials: "omit",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw abortReason(signal);
      throw new BrowserEvmRpcError(`RPC ${method} on chain ${key} could not reach the provider: ${error instanceof Error ? error.message : String(error)}`);
    }
    let body: unknown;
    try { body = await response.json(); } catch {
      if (signal.aborted) throw abortReason(signal);
      throw new BrowserEvmRpcError(`RPC ${method} on chain ${key} returned ${response.ok ? "a non-JSON response" : `HTTP ${response.status}`}`);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new BrowserEvmRpcError(`RPC ${method} returned an invalid JSON-RPC response`);
    }
    const envelope = body as Record<string, unknown>;
    if (envelope.jsonrpc !== "2.0" || envelope.id !== id) {
      throw new BrowserEvmRpcError(`RPC ${method} response ID or JSON-RPC version does not match the request`);
    }
    const hasResult = Object.hasOwn(envelope, "result");
    const hasError = Object.hasOwn(envelope, "error");
    if (hasError === hasResult) {
      throw new BrowserEvmRpcError(`RPC ${method} response must contain exactly one result or error`);
    }
    if (hasError) {
      const error = envelope.error;
      if (!error || typeof error !== "object" || Array.isArray(error)) {
        throw new BrowserEvmRpcError(`RPC ${method} returned an invalid JSON-RPC error`);
      }
      const detail = error as Record<string, unknown>;
      if (typeof detail.code !== "number" || !Number.isInteger(detail.code) || typeof detail.message !== "string") {
        throw new BrowserEvmRpcError(`RPC ${method} returned an invalid JSON-RPC error`);
      }
      throw new BrowserEvmRpcError(`RPC ${method} on chain ${key}: ${detail.message}`, detail.code, detail.data);
    }
    if (!response.ok) throw new BrowserEvmRpcError(`RPC ${method} on chain ${key} returned HTTP ${response.status}`);
    // JSON-RPC encodes EVM quantities as hex strings. Keep them intact; callers
    // must use BigInt/viem instead of converting balances and nonces to Number.
    return envelope.result as T;
  }

  function validateChain(key: string): Promise<string> {
    const session = `${key}:${endpoint(key)}`;
    const existing = sessions.get(session);
    if (existing) return existing;
    const validation = deadline(async (signal) => {
      const actual = await post<unknown>(key, "eth_chainId", [], signal);
      if (typeof actual !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(actual)) {
        throw new BrowserEvmRpcError("RPC provider returned an invalid chain ID");
      }
      if (BigInt(actual).toString() !== key) {
        throw new BrowserEvmRpcError(`RPC provider chain ID ${BigInt(actual)} does not match requested chain ${key}`);
      }
      return actual;
    });
    sessions.set(session, validation);
    // Failed validation can be tried again by an explicit later user action.
    // Cancellation of one reader must not cancel validation shared by others.
    void validation.catch(() => {
      if (sessions.get(session) === validation) sessions.delete(session);
    });
    return validation;
  }

  async function request<T = unknown>(
    chainId: BrowserEvmChainId,
    method: string,
    params: readonly unknown[] = [],
    options: BrowserEvmRpcOptions = {},
  ): Promise<T> {
    const key = chainKey(chainId);
    return deadline(async (signal) => {
      const actual = await withSignal(validateChain(key), signal);
      if (signal.aborted) throw abortReason(signal);
      if (method === "eth_chainId") return actual as T;
      return post<T>(key, method, params, signal);
    }, options.signal);
  }

  function getClient(chainId: BrowserEvmChainId): PublicClient {
    const key = chainKey(chainId);
    endpoint(key);
    let client = clients.get(key);
    if (!client) {
      client = createPublicClient({
        transport: custom({
          request: ({ method, params }: { method: string; params?: readonly unknown[] }) => request(key, method, params),
        }, { name: "Direct browser RPC", retryCount: 0 }),
      });
      clients.set(key, client);
    }
    return client;
  }

  return { request, getClient, endpoint };
}

export const browserEvmRpc = createBrowserEvmRpc();
export const request = browserEvmRpc.request;
export const getClient = browserEvmRpc.getClient;
