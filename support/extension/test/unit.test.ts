import { describe, expect, test } from "bun:test";
import { CHUNK_BYTES, NetworkTransfers } from "../src/network";
import { BridgeError, base64ToBytes, bytesToBase64, parseRequest, topLevelOrigin } from "../src/protocol";

const encode = (value: string) => bytesToBase64(new TextEncoder().encode(value));
const decode = (value: string) => new TextDecoder().decode(base64ToBytes(value));

describe("extension route protocol", () => {
  test("uses the browser-attested exact top-level origin", () => {
    expect(topLevelOrigin({ frameId: 0, origin: "https://one.example", url: "https://one.example/kernel", tab: { id: 1, url: "https://one.example/" } })).toBe("https://one.example");
    for (const sender of [
      { frameId: 1, origin: "https://one.example", url: "https://one.example/", tab: { id: 1 } },
      { frameId: 0, origin: "https://other.example", url: "https://one.example/", tab: { id: 1 } },
      { frameId: 0, origin: "null", url: "https://one.example/", tab: { id: 1 } },
      { frameId: 0, origin: "https://one.example", url: "https://one.example/", tab: { id: 1, url: "https://other.example/" } },
      { frameId: 0, origin: "https://one.example", url: "https://one.example/" },
    ]) expect(() => topLevelOrigin(sender)).toThrow(BridgeError);
  });

  test("rejects malformed network messages before making a request", () => {
    expect(parseRequest({ id: "rpc", op: "fetch", requestId: "stream", request: { url: "https://api.example/", headers: [["Authorization", "Bearer token"]] } }).op).toBe("fetch");
    for (const value of [null, {}, { id: "rpc", op: "run" },
      { id: "rpc", op: "fetch", request: { url: "https://api.example/" } },
      { id: "rpc", op: "fetch", requestId: "stream", request: { url: "file:///etc/passwd" } },
      { id: "rpc", op: "fetch", requestId: "stream", request: { url: "https://api.example/", headers: { Accept: "*/*" } } },
      { id: "rpc", op: "upload", requestId: "stream", chunkBase64: 123 },
    ]) expect(() => parseRequest(value)).toThrow(BridgeError);
  });

  test("preserves arbitrary binary bytes and rejects invalid base64", () => {
    const bytes = Uint8Array.from({ length: 256 * 40 }, (_, index) => index % 256);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    expect(() => base64ToBytes("%%%%")).toThrow("not valid base64");
  });
});

describe("network transfers", () => {
  test("stages multiple body chunks and forwards HTTP status/headers", async () => {
    let captured: RequestInit | undefined;
    const transfers = new NetworkTransfers((async (_input, init) => {
      captured = init;
      return new Response("rejected", { status: 422, headers: { "x-reason": "validation" } });
    }));
    transfers.upload("one", encode("hello "));
    transfers.upload("one", encode("world"));
    const response = await transfers.start("one", { url: "https://api.example/", method: "POST", headers: [["Authorization", "Bearer test"]], redirect: "error" }) as any;
    expect(await new Response(captured!.body).text()).toBe("hello world");
    expect(captured!.credentials).toBe("omit");
    expect(captured!.redirect).toBe("error");
    expect(captured!.headers).toEqual([["Authorization", "Bearer test"]]);
    expect(response.status).toBe(422);
    expect(response.headers).toContainEqual(["x-reason", "validation"]);
    expect(decode((await transfers.read("one")).chunkBase64!)).toBe("rejected");
    expect(await transfers.read("one")).toEqual({ done: true });
    expect(transfers.read("one")).rejects.toThrow("no longer open");
  });

  test("distinguishes an absent body from an explicitly empty body", async () => {
    const bodies: unknown[] = [];
    const transfers = new NetworkTransfers((async (_input, init) => { bodies.push(init?.body); return new Response(null, { status: 204 }); }));
    await transfers.start("none", { url: "https://api.example/", method: "POST" });
    await transfers.start("empty", { url: "https://api.example/", method: "POST", hasBody: true });
    expect(bodies[0]).toBeUndefined();
    expect(bodies[1]).toEqual(new Uint8Array(0));
    expect(await transfers.read("empty")).toEqual({ done: true });
  });

  test("frames large network chunks without truncating response bytes", async () => {
    const bytes = Uint8Array.from({ length: CHUNK_BYTES * 3 + 17 }, (_, index) => index % 253);
    const transfers = new NetworkTransfers((async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }))));
    await transfers.start("large", { url: "https://api.example/" });
    const chunks: Uint8Array[] = [];
    for (;;) {
      const next = await transfers.read("large");
      if (next.done) break;
      const chunk = base64ToBytes(next.chunkBase64!);
      expect(chunk.byteLength).toBeLessThanOrEqual(CHUNK_BYTES);
      chunks.push(chunk);
    }
    expect(chunks.map(chunk => chunk.length)).toEqual([CHUNK_BYTES, CHUNK_BYTES, CHUNK_BYTES, 17]);
    const combined = new Uint8Array(bytes.length);
    let offset = 0;
    for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.length; }
    expect(combined).toEqual(bytes);
  });

  test("cancels a request before response headers and never retries it", async () => {
    let started = 0;
    const transfers = new NetworkTransfers((async (_input, init) => {
      started++;
      return new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError"))));
    }));
    const result = transfers.start("slow", { url: "https://api.example/" });
    transfers.cancel("slow");
    await expect(result).rejects.toThrow("cancelled");
    expect(started).toBe(1);
    expect(transfers.read("slow")).rejects.toThrow("no longer open");
  });

  test("cancels a pending stream read and discards an unfinished upload", async () => {
    let cancelled = false;
    const transfers = new NetworkTransfers((async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }))));
    await transfers.start("stream", { url: "https://api.example/" });
    const reading = transfers.read("stream");
    transfers.cancel("stream");
    await expect(reading).rejects.toThrow("cancelled");
    expect(cancelled).toBe(true);
    transfers.upload("staged", encode("discard me"));
    transfers.cancel("staged");
    expect(transfers.read("staged")).rejects.toThrow("no longer open");
  });

  test("a second concurrent read does not destroy the first read", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const transfers = new NetworkTransfers((async () => new Response(new ReadableStream({ start(value) { controller = value; } }))));
    await transfers.start("one", { url: "https://api.example/" });
    const first = transfers.read("one");
    await expect(transfers.read("one")).rejects.toThrow("still pending");
    controller.enqueue(new TextEncoder().encode("still here"));
    controller.close();
    expect(decode((await first).chunkBase64!)).toBe("still here");
    expect(await transfers.read("one")).toEqual({ done: true });
  });
});
