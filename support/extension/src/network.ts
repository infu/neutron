import { BridgeError, base64ToBytes, bytesToBase64, validateHttpRequest } from "./protocol";
import type { HttpRequest } from "./protocol";

interface Transfer {
  controller: AbortController;
  chunks: Uint8Array<ArrayBuffer>[];
  started: boolean;
  reader?: ReadableStreamDefaultReader<Uint8Array>;
  reading: boolean;
  remainder?: Uint8Array;
}

// This is a transport frame size, not a request/response size limit.
export const CHUNK_BYTES = 256 * 1024;
export type FetchFunction = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class NetworkTransfers {
  private readonly transfers = new Map<string, Transfer>();
  constructor(private readonly fetcher: FetchFunction = fetch) {}

  upload(key: string, chunkBase64: string): Record<string, never> {
    let transfer = this.transfers.get(key);
    if (!transfer) { transfer = this.create(); this.transfers.set(key, transfer); }
    if (transfer.started) throw new BridgeError("REQUEST_STARTED", "This request has already started.");
    transfer.chunks.push(base64ToBytes(chunkBase64));
    return {};
  }

  async start(key: string, request: HttpRequest): Promise<unknown> {
    validateHttpRequest(request);
    let transfer = this.transfers.get(key);
    if (!transfer) { transfer = this.create(); this.transfers.set(key, transfer); }
    if (transfer.started) throw new BridgeError("DUPLICATE_REQUEST", "This stream ID is already in use.");
    transfer.started = true;
    try {
      if (request.bodyBase64 !== undefined && transfer.chunks.length) throw new BridgeError("INVALID_REQUEST", "Use either an uploaded body or bodyBase64, not both.");
      const init: RequestInit = {
        method: request.method ?? "GET",
        headers: request.headers ?? [],
        credentials: "omit",
        redirect: request.redirect ?? "follow",
        cache: "no-store",
        signal: transfer.controller.signal,
      };
      if (request.bodyBase64 !== undefined) init.body = base64ToBytes(request.bodyBase64);
      else if (transfer.chunks.length) init.body = new Blob(transfer.chunks);
      else if (request.hasBody) init.body = new Uint8Array(0);
      transfer.chunks = [];
      const fetcher = this.fetcher;
      const response = await fetcher(request.url, init);
      if (transfer.controller.signal.aborted) throw new DOMException("The request was cancelled.", "AbortError");
      if (response.body) transfer.reader = response.body.getReader();
      return { status: response.status, statusText: response.statusText, headers: Array.from(response.headers.entries()), url: response.url, type: response.type, redirected: response.redirected };
    } catch (error) {
      this.transfers.delete(key);
      throw error;
    }
  }

  async read(key: string): Promise<{ done: boolean; chunkBase64?: string }> {
    const transfer = this.transfers.get(key);
    if (!transfer) throw new BridgeError("UNKNOWN_REQUEST", "This request is no longer open.");
    if (!transfer.started) throw new BridgeError("REQUEST_NOT_STARTED", "Start the request before reading its response.");
    if (transfer.reading) throw new BridgeError("READ_IN_PROGRESS", "The previous stream read is still pending.");
    transfer.reading = true;
    try {
      let bytes = transfer.remainder;
      delete transfer.remainder;
      if (!bytes) {
        const next = transfer.reader ? await transfer.reader.read() : { done: true, value: undefined };
        if (transfer.controller.signal.aborted) throw new DOMException("The request was cancelled.", "AbortError");
        if (next.done) { this.transfers.delete(key); return { done: true }; }
        bytes = next.value!;
      }
      if (bytes.length > CHUNK_BYTES) transfer.remainder = bytes.subarray(CHUNK_BYTES);
      return { done: false, chunkBase64: bytesToBase64(bytes.subarray(0, CHUNK_BYTES)) };
    } catch (error) {
      this.cancel(key);
      throw error;
    } finally { transfer.reading = false; }
  }

  cancel(key: string): Record<string, never> {
    const transfer = this.transfers.get(key);
    if (transfer) {
      this.transfers.delete(key);
      transfer.controller.abort();
      void transfer.reader?.cancel().catch(() => {});
      transfer.chunks = [];
    }
    return {};
  }

  cancelAll(): void { for (const key of this.transfers.keys()) this.cancel(key); }
  private create(): Transfer { return { controller: new AbortController(), chunks: [], started: false, reading: false }; }
}
