import { exec, isJsonObject, type JsonValue } from "./app.ts";

/** Browser-local availability and the requesting app's durable route grant. */
export type BrowserExtensionStatus = {
  available: boolean;
  paired: boolean;
  granted: boolean;
  extensionVersion?: string;
  incompatible?: boolean;
};

export type BrowserExtensionClient = {
  status(): Promise<BrowserExtensionStatus>;
  /** Ask once; an existing grant is returned without another approval. */
  request(options?: { reason?: string }): Promise<BrowserExtensionStatus>;
  /** HTTP through the extension, using explicit headers rather than browser cookies. */
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
};

export type BrowserExtensionTransport = (
  action: string,
  payload: JsonValue,
  signal?: AbortSignal,
) => Promise<JsonValue>;

// Split bodies to fit the existing message-bus envelope. This is a transport
// chunk size, not a limit on request or response size.
const BODY_CHUNK_BYTES = 256 * 1024;

function encodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

function decodeBytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function readStatus(value: JsonValue): BrowserExtensionStatus {
  if (!isJsonObject(value) || typeof value.available !== "boolean" ||
      typeof value.paired !== "boolean" || typeof value.granted !== "boolean" ||
      (value.extensionVersion !== undefined && typeof value.extensionVersion !== "string") ||
      (value.incompatible !== undefined && typeof value.incompatible !== "boolean")) {
    throw new Error("Invalid browser extension status");
  }
  return value as BrowserExtensionStatus;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The request was aborted", "AbortError");
}

function withSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const finish = (callback: () => void) => {
      signal.removeEventListener("abort", abort);
      callback();
    };
    const abort = () => finish(() => reject(abortReason(signal)));
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
    if (signal.aborted) abort();
  });
}

function responseMetadata(
  response: Response,
  metadata: { url: string; redirected: boolean; type?: string; opaque: boolean },
): Response {
  Object.defineProperties(response, {
    url: { value: metadata.url },
    redirected: { value: metadata.redirected },
    ...(metadata.type === undefined ? {} : { type: { value: metadata.type } }),
    ...(metadata.opaque ? { body: { value: null } } : {}),
    clone: { value: function (this: Response) {
      return responseMetadata(Response.prototype.clone.call(this), metadata);
    } },
  });
  return response;
}

/** The injected transport also lets hosts test streaming without a browser extension. */
export function createBrowserExtensionClient(transport: BrowserExtensionTransport): BrowserExtensionClient {
  return {
    status: async () => readStatus(await transport("browser_extension.status", {})),
    request: async (options = {}) => readStatus(await transport(
      "browser_extension.request", options.reason === undefined ? {} : { reason: options.reason },
    )),
    async fetch(input, init) {
      const request = new Request(input, init);
      request.signal.throwIfAborted();
      const requestId = crypto.randomUUID();
      const payload = { requestId };
      let finished = false;
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
      const cleanup = () => request.signal.removeEventListener("abort", abort);
      const cancelRemote = () => {
        void Promise.resolve().then(() => transport("browser_extension.cancel", payload)).catch(() => {});
      };
      const abort = () => {
        if (finished) return;
        finished = true;
        cleanup();
        controller?.error(abortReason(request.signal));
        cancelRemote();
      };
      const call = (action: string, value: JsonValue) => withSignal(
        transport(action, value, request.signal), request.signal,
      );
      request.signal.addEventListener("abort", abort, { once: true });
      try {
        const hasBody = request.body !== null;
        if (hasBody) {
          const bytes = new Uint8Array(await withSignal(request.arrayBuffer(), request.signal));
          for (let offset = 0; offset < bytes.length; offset += BODY_CHUNK_BYTES) {
            request.signal.throwIfAborted();
            await call("browser_extension.upload", {
              requestId, chunkBase64: encodeBytes(bytes.subarray(offset, offset + BODY_CHUNK_BYTES)),
            });
          }
        }
        request.signal.throwIfAborted();
        const head = await call("browser_extension.fetch", {
          requestId,
          request: {
            url: request.url,
            method: request.method,
            headers: Array.from(request.headers.entries()),
            ...(hasBody ? { hasBody: true } : {}),
            redirect: request.redirect,
          },
        });
        if (!isJsonObject(head) || head.requestId !== requestId ||
            typeof head.status !== "number" || typeof head.statusText !== "string" ||
            typeof head.url !== "string" || !Array.isArray(head.headers) ||
            (head.type !== undefined && typeof head.type !== "string") ||
            (head.redirected !== undefined && typeof head.redirected !== "boolean") ||
            !head.headers.every((header) => Array.isArray(header) && header.length === 2 &&
              header.every((part) => typeof part === "string"))) {
          throw new Error("Invalid browser extension response");
        }
        request.signal.throwIfAborted();
        const opaque = head.status === 0 && (head.type === "opaque" || head.type === "opaqueredirect");
        const bodyless = opaque || request.method === "HEAD" || [204, 205, 304].includes(head.status);
        const body = bodyless ? null : new ReadableStream<Uint8Array>({
          start(value) { controller = value; },
          async pull(value) {
            try {
              const chunk = await call("browser_extension.read", payload);
              if (finished) return;
              if (!isJsonObject(chunk) || typeof chunk.done !== "boolean" ||
                  (chunk.chunkBase64 !== undefined && typeof chunk.chunkBase64 !== "string") ||
                  (!chunk.done && typeof chunk.chunkBase64 !== "string")) {
                throw new Error("Invalid browser extension response chunk");
              }
              if (typeof chunk.chunkBase64 === "string" && chunk.chunkBase64.length > 0) {
                value.enqueue(decodeBytes(chunk.chunkBase64));
              }
              if (chunk.done) {
                finished = true;
                cleanup();
                value.close();
              }
            } catch (error) {
              if (finished) return;
              finished = true;
              cleanup();
              value.error(error);
              cancelRemote();
            }
          },
          cancel() {
            if (finished) return;
            finished = true;
            cleanup();
            cancelRemote();
          },
        }, { highWaterMark: 0 });
        // Fetch's manual redirect response has status 0, which the public
        // Response constructor cannot create. An error response supplies its
        // native empty body/headers and false `ok`; preserve the actual type.
        const response = opaque ? Response.error() : new Response(body, {
          status: head.status,
          statusText: head.statusText,
          headers: head.headers as [string, string][],
        });
        responseMetadata(response, {
          url: head.url,
          redirected: head.redirected ?? (!opaque && head.url !== request.url),
          ...(head.type === undefined ? {} : { type: head.type }),
          opaque,
        });
        if (bodyless) {
          finished = true;
          cleanup();
          cancelRemote();
        }
        return response;
      } catch (error) {
        if (!finished) {
          finished = true;
          cleanup();
          cancelRemote();
        }
        throw error;
      }
    },
  };
}

export const browserExtension: BrowserExtensionClient = createBrowserExtensionClient(
  (action, payload, signal) => exec(action, payload, signal ? { signal } : {}),
);
