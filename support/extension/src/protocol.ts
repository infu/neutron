export const CHANNEL = "neutron.extension.v1";
export const PROTOCOL_VERSION = 1;
export const BRIDGE_PORT = "neutron-extension-v1";

export interface HttpRequest {
  url: string;
  method?: string;
  headers?: Array<[string, string]>;
  bodyBase64?: string;
  hasBody?: boolean;
  redirect?: "follow" | "error" | "manual";
}

export type Request =
  | { id: string; op: "status" }
  | { id: string; op: "pair" }
  | { id: string; op: "revoke" }
  | { id: string; op: "fetch"; requestId: string; request: HttpRequest }
  | { id: string; op: "upload"; requestId: string; chunkBase64: string }
  | { id: string; op: "read" | "cancel"; requestId: string };

export type Reply =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: { code: string; message: string } };

export class BridgeError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export function errorReply(id: string, error: unknown): Reply {
  return {
    id,
    ok: false,
    error: {
      code: error instanceof BridgeError ? error.code : error instanceof DOMException && error.name === "AbortError" ? "ABORTED" : "REQUEST_FAILED",
      message: error instanceof Error ? error.message : "The extension request failed.",
    },
  };
}

export function parseRequest(value: unknown): Request {
  if (typeof value !== "object" || value === null) throw new BridgeError("INVALID_REQUEST", "Expected a bridge request.");
  const request = value as Record<string, unknown>;
  if (typeof request.id !== "string" || !request.id) throw new BridgeError("INVALID_REQUEST", "A request ID is required.");
  if (request.op === "status" || request.op === "pair" || request.op === "revoke") return request as Request;
  if (request.op !== "fetch" && request.op !== "read" && request.op !== "cancel" && request.op !== "upload") throw new BridgeError("INVALID_REQUEST", "Unknown bridge operation.");
  if (typeof request.requestId !== "string" || !request.requestId) throw new BridgeError("INVALID_REQUEST", "A stream ID is required.");
  if (request.op === "fetch") validateHttpRequest(request.request);
  if (request.op === "upload" && typeof request.chunkBase64 !== "string") throw new BridgeError("INVALID_REQUEST", "An upload chunk is required.");
  return request as Request;
}

export function validateHttpRequest(value: unknown): asserts value is HttpRequest {
  if (typeof value !== "object" || value === null) throw new BridgeError("INVALID_REQUEST", "A HTTP request is required.");
  const request = value as Record<string, unknown>;
  if (typeof request.url !== "string") throw new BridgeError("INVALID_REQUEST", "A request URL is required.");
  let url: URL;
  try { url = new URL(request.url); } catch { throw new BridgeError("INVALID_REQUEST", "The request URL is invalid."); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new BridgeError("INVALID_REQUEST", "The browser route supports HTTP and HTTPS URLs.");
  if (request.method !== undefined && typeof request.method !== "string") throw new BridgeError("INVALID_REQUEST", "The HTTP method must be text.");
  if (request.bodyBase64 !== undefined && typeof request.bodyBase64 !== "string") throw new BridgeError("INVALID_REQUEST", "The body must be base64 text.");
  if (request.hasBody !== undefined && typeof request.hasBody !== "boolean") throw new BridgeError("INVALID_REQUEST", "hasBody must be a boolean.");
  if (request.redirect !== undefined && request.redirect !== "follow" && request.redirect !== "error" && request.redirect !== "manual") throw new BridgeError("INVALID_REQUEST", "Invalid redirect behavior.");
  if (request.headers !== undefined && (!Array.isArray(request.headers) || !request.headers.every((entry: unknown) => Array.isArray(entry) && entry.length === 2 && entry.every((part: unknown) => typeof part === "string")))) {
    throw new BridgeError("INVALID_REQUEST", "Headers must be pairs of strings.");
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  // Chunking avoids the JavaScript function-argument limit, not a response limit.
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  try { return Uint8Array.from(atob(value), character => character.charCodeAt(0)); }
  catch { throw new BridgeError("INVALID_REQUEST", "The request body is not valid base64."); }
}

export interface Pairing { origin: string; connectedAt: number }
export const PAIRING_KEY = "neutron.pairedOrigins.v1";

export function topLevelOrigin(sender: { frameId?: number; origin?: string; url?: string; tab?: { id?: number; url?: string } }): string {
  if (sender.frameId !== 0 || typeof sender.tab?.id !== "number" || !sender.url) throw new BridgeError("INVALID_SENDER", "Only a top-level Neutron page can connect.");
  const url = new URL(sender.url);
  if ((url.protocol !== "https:" && url.protocol !== "http:") || sender.origin !== url.origin) throw new BridgeError("INVALID_SENDER", "The browser did not provide a matching page origin.");
  if (sender.tab.url && new URL(sender.tab.url).origin !== url.origin) throw new BridgeError("INVALID_SENDER", "The connecting page is not the top-level page.");
  return url.origin;
}
