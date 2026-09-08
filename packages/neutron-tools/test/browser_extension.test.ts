import { describe, expect, test } from "bun:test";
import { createBrowserExtensionClient, type BrowserExtensionTransport } from "../src/browser_extension.ts";
import { isJsonObject, type JsonValue } from "../src/app.ts";
import { assertBoundedJson } from "../src/protocol.ts";

function fixture(options: { chunks?: string[]; status?: number; onFetch?: () => Promise<void> } = {}) {
  const calls: { action: string; payload: JsonValue }[] = [];
  const chunks = [...(options.chunks ?? [btoa("hello"), btoa(" world")])];
  const transport: BrowserExtensionTransport = async (action, payload) => {
    assertBoundedJson(payload);
    calls.push({ action, payload });
    if (action === "browser_extension.status" || action === "browser_extension.request") {
      return { available: true, paired: true, granted: true, extensionVersion: "1.0.0" };
    }
    if (action === "browser_extension.fetch") {
      await options.onFetch?.();
      if (!isJsonObject(payload)) throw new Error("Bad test payload");
      return {
        requestId: payload.requestId!, status: options.status ?? 200, statusText: "OK",
        url: "https://example.com/response", headers: [["content-type", "text/plain"]],
      };
    }
    if (action === "browser_extension.read") {
      const chunkBase64 = chunks.shift();
      return chunkBase64 === undefined ? { done: true } : { done: false, chunkBase64 };
    }
    return {};
  };
  return { client: createBrowserExtensionClient(transport), calls };
}

describe("optional browser extension SDK", () => {
  test("reports availability and requests permission independently from network use", async () => {
    const { client, calls } = fixture();
    expect((await client.status()).granted).toBe(true);
    await client.request({ reason: "Connect a subscription" });
    expect(calls[1]).toEqual({ action: "browser_extension.request", payload: { reason: "Connect a subscription" } });
  });

  test("returns a native streaming Response and does not read ahead", async () => {
    const { client, calls } = fixture();
    const response = await client.fetch("https://example.com/input");
    expect(response.status).toBe(200);
    expect(response.url).toBe("https://example.com/response");
    expect(response.redirected).toBe(true);
    expect(response.headers.get("content-type")).toBe("text/plain");
    expect(calls.map((call) => call.action)).toEqual(["browser_extension.fetch"]);
    expect(await response.text()).toBe("hello world");
    expect(calls.some((call) => call.action === "browser_extension.request")).toBe(false);
  });

  test("cloning keeps remote response metadata and independently readable bodies", async () => {
    const { client } = fixture();
    const response = await client.fetch("https://example.com/input");
    const cloned = response.clone();
    expect(cloned.url).toBe(response.url);
    expect(cloned.redirected).toBe(true);
    expect(await cloned.text()).toBe("hello world");
    expect(await response.text()).toBe("hello world");
  });

  test("transfers prompts larger than the existing message-bus envelope losslessly", async () => {
    const { client, calls } = fixture();
    const body = "large context 🦊".repeat(100_000);
    const response = await client.fetch("https://example.com", { method: "POST", body });
    const uploads = calls.filter((call) => call.action === "browser_extension.upload");
    expect(uploads.length).toBeGreaterThan(1);
    const bytes = uploads.map((call) => {
      const payload = call.payload as { chunkBase64: string };
      return Buffer.from(payload.chunkBase64, "base64");
    });
    expect(Buffer.concat(bytes).toString()).toBe(body);
    await response.body?.cancel();
  });

  test("preserves binary request bytes and explicit authorization headers", async () => {
    const { client, calls } = fixture();
    const response = await client.fetch(new Request("https://example.com", {
      method: "POST", body: new Uint8Array([0, 255, 10, 128]),
      headers: { authorization: "Bearer test-token" },
    }));
    expect(calls[0]!.payload).toMatchObject({ chunkBase64: "AP8KgA==" });
    expect(calls[1]!.payload).toMatchObject({ request: { method: "POST", hasBody: true, headers: [["authorization", "Bearer test-token"]] } });
    await response.body?.cancel();
  });

  test("an already-aborted request never reaches the route", async () => {
    const { client, calls } = fixture();
    await expect(client.fetch("https://example.com", { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  test("aborts immediately while waiting for response headers and cancels the same remote request", async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const { client, calls } = fixture({ onFetch: () => waiting });
    const abort = new AbortController();
    const pending = client.fetch("https://example.com", { signal: abort.signal });
    abort.abort(new Error("Stopped by owner"));
    await expect(pending).rejects.toThrow("Stopped by owner");
    const start = calls.find((call) => call.action === "browser_extension.fetch")!;
    const cancel = calls.find((call) => call.action === "browser_extension.cancel")!;
    expect(cancel.payload).toMatchObject({ requestId: (start.payload as { requestId: string }).requestId });
    release();
  });

  test("aborting after headers errors the body and cancels its network request", async () => {
    const { client, calls } = fixture();
    const abort = new AbortController();
    const response = await client.fetch("https://example.com", { signal: abort.signal });
    abort.abort(new Error("Stopped stream"));
    await expect(response.text()).rejects.toThrow("Stopped stream");
    expect(calls.filter((call) => call.action === "browser_extension.cancel")).toHaveLength(1);
  });

  test("reader cancellation releases remote resources", async () => {
    const { client, calls } = fixture();
    const response = await client.fetch("https://example.com");
    await response.body!.cancel();
    expect(calls.filter((call) => call.action === "browser_extension.cancel")).toHaveLength(1);
  });

  test("bodyless status produces a valid native Response and releases the remote request", async () => {
    const { client, calls } = fixture({ status: 204 });
    const response = await client.fetch("https://example.com");
    expect(response.body).toBeNull();
    expect(await response.text()).toBe("");
    expect(calls.at(-1)!.action).toBe("browser_extension.cancel");
  });

  test("invalid response chunks fail the stream and release the remote request", async () => {
    const { client, calls } = fixture({ chunks: ["invalid base64 !!!"] });
    const response = await client.fetch("https://example.com");
    await expect(response.text()).rejects.toThrow();
    expect(calls.at(-1)!.action).toBe("browser_extension.cancel");
  });

  test("preserves opaque manual redirects without constructing an invalid status-zero Response", async () => {
    const actions: string[] = [];
    const client = createBrowserExtensionClient(async (action, payload) => {
      actions.push(action);
      if (action !== "browser_extension.fetch") return {};
      return {
        requestId: (payload as { requestId: string }).requestId,
        status: 0, statusText: "", url: "", headers: [], type: "opaqueredirect", redirected: false,
      };
    });
    const response = await client.fetch("https://example.com/redirect", { redirect: "manual" });
    expect(response.status).toBe(0);
    expect(response.ok).toBe(false);
    expect(response.type).toBe("opaqueredirect");
    expect(response.redirected).toBe(false);
    expect(response.url).toBe("");
    expect(response.body).toBeNull();
    expect(response.clone().type).toBe("opaqueredirect");
    expect(actions.at(-1)).toBe("browser_extension.cancel");
  });
});
