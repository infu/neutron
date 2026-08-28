import { loadNeutronCanisterId } from "neutron-tools/app";
import {
  KERNEL_RUNTIME_CONFIG_PATH,
  parseKernelRuntimeConfig,
  type KernelRuntimeConfig,
} from "neutron-tools/src/runtime_config.js";
import {
  scheduleDeadline,
  type DeadlineScheduler,
} from "./deadline.ts";

const MAX_RUNTIME_CONFIG_BYTES = 4_096;
const TRUSTED_RUNTIME_STARTUP_TIMEOUT_MS = 10_000;

export type BlastTrustedRuntime = Readonly<{
  config: KernelRuntimeConfig;
  canisterId: string;
  pageOrigin: string;
  agentHost: string;
  local: boolean;
}>;

export type BlastRuntimeLoaderOptions = Readonly<{
  fetchImpl?: typeof fetch;
  href?: string;
  loadCanisterId?: (
    path: string,
    fetcher: typeof fetch,
    href: string,
    signal: AbortSignal,
  ) => Promise<string>;
  /** Test seam; production always uses the fixed startup timeout above. */
  scheduleDeadline?: DeadlineScheduler;
}>;

/**
 * Load the Kernel-authored deployment policy from the resident's certified
 * origin. No caller-supplied gateway is accepted. Canister traffic uses the
 * trusted gateway because the resident hostname is bound to the Neutron
 * canister and cannot route requests for arbitrary target canisters.
 */
export async function loadBlastTrustedRuntime(
  options: BlastRuntimeLoaderOptions = {},
): Promise<BlastTrustedRuntime> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const href = options.href ?? globalThis.location?.href;
  if (typeof href !== "string" || href.length === 0) {
    throw new Error("Blast runtime requires a resident document URL");
  }
  const pageUrl = new URL(href);
  return await runWithTrustedRuntimeDeadline(
    options.scheduleDeadline ?? scheduleDeadline,
    async (signal) => {
      const boundedFetch = bindAbortSignal(fetchImpl, signal);
      const configUrl = new URL(KERNEL_RUNTIME_CONFIG_PATH, pageUrl);
      const response = await boundedFetch(configUrl.href, {
        cache: "no-store",
        credentials: "omit",
        headers: { accept: "application/json" },
        method: "GET",
        redirect: "error",
        referrerPolicy: "no-referrer",
      });
      signal.throwIfAborted();
      if (
        !response.ok ||
        response.redirected ||
        response.type === "opaque" ||
        response.type === "opaqueredirect"
      ) {
        throw new Error(
          `Trusted runtime configuration is unavailable (HTTP ${response.status})`,
        );
      }
      if (response.url !== configUrl.href) {
        throw new Error("Trusted runtime configuration changed origin");
      }
      const contentType = response.headers
        .get("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase();
      if (contentType !== "application/json") {
        throw new Error("Trusted runtime configuration has the wrong content type");
      }

      const config = parseKernelRuntimeConfig(
        await readBoundedResponse(
          response,
          MAX_RUNTIME_CONFIG_BYTES,
          signal,
        ),
      );
      signal.throwIfAborted();
      const canisterId = await (
        options.loadCanisterId ??
        ((path, fetcher, currentHref) =>
          loadNeutronCanisterId(path, fetcher, currentHref))
      )("/pkg/id.json", boundedFetch, pageUrl.href, signal);
      signal.throwIfAborted();
      if (config.canister_id !== canisterId) {
        throw new Error("Trusted runtime configuration belongs to another Neutron");
      }

      const pageOrigin = pageUrl.origin;
      return trustedRuntimeSnapshot(config, pageOrigin);
    },
  );
}

/** Revalidate a structurally supplied runtime before creating an IC actor. */
export function assertBlastTrustedRuntime(
  runtime: BlastTrustedRuntime,
): BlastTrustedRuntime {
  const config = parseKernelRuntimeConfig(JSON.stringify(runtime.config));
  const pageUrl = new URL(runtime.pageOrigin);
  if (pageUrl.href !== `${pageUrl.origin}/`) {
    throw new Error("Blast runtime page origin is invalid");
  }
  const snapshot = trustedRuntimeSnapshot(config, pageUrl.origin);
  if (runtime.canisterId !== snapshot.canisterId) {
    throw new Error("Blast runtime canister binding is invalid");
  }
  if (
    runtime.agentHost !== snapshot.agentHost ||
    runtime.local !== snapshot.local
  ) {
    throw new Error("Blast runtime network policy is inconsistent");
  }
  return snapshot;
}

function trustedRuntimeSnapshot(
  config: KernelRuntimeConfig,
  pageOrigin: string,
): BlastTrustedRuntime {
  assertResidentOrigin(config, pageOrigin);
  return Object.freeze({
    config,
    canisterId: config.canister_id,
    pageOrigin,
    agentHost: config.gateway,
    local: config.root_key_policy === "fetch",
  });
}

function assertResidentOrigin(
  config: KernelRuntimeConfig,
  pageOrigin: string,
): void {
  const origin = new URL(pageOrigin);
  if (origin.href !== `${origin.origin}/`) {
    throw new Error("Blast resident origin is invalid");
  }

  const suffix =
    config.target === "ic"
      ? `--${config.canister_id}.icp0.io`
      : `--${config.canister_id}.localhost`;
  const expectedProtocol = config.target === "ic" ? "https:" : "http:";
  const expectedPort = config.target === "ic" ? "" : "8000";
  const prefixed = origin.hostname.endsWith(suffix);
  const prefix = prefixed
    ? origin.hostname.slice(0, origin.hostname.length - suffix.length)
    : "";
  if (
    origin.protocol !== expectedProtocol ||
    origin.port !== expectedPort ||
    !prefixed ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(prefix)
  ) {
    throw new Error("Blast resident origin is outside the trusted deployment");
  }
}

async function readBoundedResponse(
  response: Response,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(declared)) {
      throw new Error("Trusted runtime configuration has an invalid size");
    }
    const length = Number(declared);
    if (
      !Number.isSafeInteger(length) ||
      length === 0 ||
      length > maximumBytes
    ) {
      throw new Error("Trusted runtime configuration has an invalid size");
    }
  }
  if (!response.body) {
    throw new Error("Trusted runtime configuration returned no body");
  }

  const reader = response.body.getReader();
  const cancelReader = (): void => {
    try {
      void reader.cancel(signal.reason).catch(() => undefined);
    } catch {
      // Some response-body implementations can throw synchronously on cancel.
    }
  };
  if (signal.aborted) cancelReader();
  else signal.addEventListener("abort", cancelReader, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumBytes) {
        cancelReader();
        throw new Error("Trusted runtime configuration is too large");
      }
      chunks.push(next.value);
    }
  } finally {
    signal.removeEventListener("abort", cancelReader);
    reader.releaseLock();
  }
  if (total === 0) {
    throw new Error("Trusted runtime configuration has an invalid size");
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function runWithTrustedRuntimeDeadline<T>(
  schedule: DeadlineScheduler,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const cancelDeadline = schedule(() => {
    controller.abort(
      new Error(
        `Blast trusted runtime startup exceeded its ${TRUSTED_RUNTIME_STARTUP_TIMEOUT_MS}ms deadline`,
      ),
    );
  }, TRUSTED_RUNTIME_STARTUP_TIMEOUT_MS);
  try {
    controller.signal.throwIfAborted();
    return await awaitAbortable(operation(controller.signal), controller.signal);
  } finally {
    cancelDeadline();
  }
}

function bindAbortSignal(
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    fetchImpl.call(globalThis, input, { ...init, signal })) as typeof fetch;
}

async function awaitAbortable<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => undefined);
    throw signal.reason;
  }
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      callback();
    };
    const abort = (): void => finish(() => reject(signal.reason));
    signal.addEventListener("abort", abort, { once: true });
    void operation.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}
