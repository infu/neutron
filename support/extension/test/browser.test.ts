import { expect, test } from "bun:test";
import { chromium, expect as browserExpect, type BrowserContext, type Frame, type Page } from "@playwright/test";
import { constants } from "node:fs";
import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const channel = "neutron.extension.v1";

interface WireReply<T = Record<string, unknown>> {
  id: string;
  ok: boolean;
  result?: T;
  error?: { code: string; message: string };
}

interface HarnessWindow extends Window {
  __extensionQualification?: {
    invoke(request: Record<string, unknown>, timeoutMs: number): Promise<WireReply>;
    messages: unknown[];
  };
}

test("the installed extension pairs once, routes real HTTP streams, and retains pairing until Settings revokes it", async () => {
  await access(join(extensionRoot, "dist", "manifest.json"));
  const profile = await mkdtemp(join(await temporaryRoot(), "neutron-extension-browser-"));
  const fixture = createFixture();
  let context: BrowserContext | undefined;
  try {
    const launch = async () => chromium.launchPersistentContext(profile, {
      headless: true,
      executablePath: await chromiumExecutable(),
      args: [
        "--no-sandbox",
        `--disable-extensions-except=${join(extensionRoot, "dist")}`,
        `--load-extension=${join(extensionRoot, "dist")}`,
      ],
    });
    context = await launch();
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
    const extensionId = new URL(worker.url()).hostname;
    const page = await context.newPage();
    await page.goto(fixture.kernelOrigin);
    expect(await connect(page)).toMatchObject({ type: "ready", version: 1 });
    expect(await invoke(page, { op: "status" })).toMatchObject({
      ok: true,
      result: { paired: false, origin: fixture.kernelOrigin },
    });

    // An actual ordinary-page fetch fails CORS; the route below uses the same URL.
    expect(await page.evaluate(async (url) => {
      try { await fetch(url); return "unexpectedly allowed"; }
      catch (error) { return error instanceof Error ? error.name : String(error); }
    }, `${fixture.apiOrigin}/plain`)).toBe("TypeError");
    const unpaired = await invoke(page, {
      op: "fetch", requestId: "unpaired", request: { url: `${fixture.apiOrigin}/plain` },
    });
    expect(unpaired.ok).toBe(false);
    expect(unpaired.error?.message.toLowerCase()).toMatch(/connect|pair/);

    const approvalOpened = context.waitForEvent("page", {
      predicate: candidate => candidate.url().includes("pair.html"),
    });
    const pairing = invoke(page, { op: "pair" });
    const approval = await approvalOpened;
    await browserExpect(approval.locator("#origin")).toHaveText(fixture.kernelOrigin);
    await approval.locator("#approve").click();
    expect((await pairing).ok).toBe(true);
    expect(await invoke(page, { op: "status" })).toMatchObject({ ok: true, result: { paired: true } });
    expect((await invoke(page, { op: "pair" })).ok).toBe(true);
    await browserExpect.poll(() => context!.pages().filter(candidate => candidate.url().includes("pair.html")).length).toBe(0);

    const plain = await invoke(page, {
      op: "fetch", requestId: "plain", request: { url: `${fixture.apiOrigin}/plain` },
    });
    expect(plain).toMatchObject({ ok: true, result: { status: 200 } });
    expect(new TextDecoder().decode(await readAll(page, "plain"))).toBe("Cross-origin response ✓");

    expect(await invoke(page, {
      op: "fetch", requestId: "manual-redirect", request: { url: `${fixture.apiOrigin}/redirect`, redirect: "manual" },
    })).toMatchObject({ ok: true, result: { status: 0, type: "opaqueredirect", redirected: false } });
    expect((await readAll(page, "manual-redirect")).byteLength).toBe(0);
    expect(await invoke(page, {
      op: "fetch", requestId: "follow-redirect", request: { url: `${fixture.apiOrigin}/redirect`, redirect: "follow" },
    })).toMatchObject({ ok: true, result: { status: 200, redirected: true, url: `${fixture.apiOrigin}/data` } });
    expect(new TextDecoder().decode(await readAll(page, "follow-redirect"))).toBe("Redirect target ✓");

    // Upload chunks cross the real JSON extension transport and preserve binary bytes.
    const body = Uint8Array.from({ length: 131_079 }, (_, index) => index % 251);
    for (let offset = 0; offset < body.length; offset += 32_768) {
      expect((await invoke(page, {
        op: "upload", requestId: "echo", chunkBase64: Buffer.from(body.subarray(offset, offset + 32_768)).toString("base64"),
      })).ok).toBe(true);
    }
    expect(await invoke(page, {
      op: "fetch", requestId: "echo", request: {
        url: `${fixture.apiOrigin}/echo`, method: "POST", headers: [["content-type", "application/octet-stream"]],
      },
    })).toMatchObject({ ok: true, result: { status: 200 } });
    expect(await readAll(page, "echo")).toEqual(body);

    expect(await invoke(page, {
      op: "fetch", requestId: "stream", request: { url: `${fixture.apiOrigin}/stream/ordered` },
    })).toMatchObject({ ok: true, result: { status: 200 } });
    const first = await invoke<{ done: boolean; chunkBase64?: string }>(page, { op: "read", requestId: "stream" });
    expect(first.ok).toBe(true);
    expect(Buffer.from(first.result?.chunkBase64 ?? "", "base64").toString()).toBe("first");
    fixture.finishStream("ordered", "second");
    expect(new TextDecoder().decode(await readAll(page, "stream"))).toBe("second");

    expect(await invoke(page, {
      op: "fetch", requestId: "cancel", request: { url: `${fixture.apiOrigin}/stream/cancel` },
    })).toMatchObject({ ok: true, result: { status: 200 } });
    await invoke(page, { op: "read", requestId: "cancel" });
    const pendingRead = invoke(page, { op: "read", requestId: "cancel" });
    expect((await invoke(page, { op: "cancel", requestId: "cancel" })).ok).toBe(true);
    await pendingRead;
    await browserExpect.poll(() => fixture.cancelled.has("cancel")).toBe(true);

    // An iframe cannot borrow the paired top page's content-script transport.
    const attached = page.waitForEvent("framenavigated", { predicate: frame => frame !== page.mainFrame() });
    await page.evaluate(() => {
      const frame = document.createElement("iframe");
      frame.src = "/child";
      document.body.append(frame);
    });
    const child = await attached;
    expect(await probeUntrustedFrame(child, false)).toBe(false);
    expect(await probeUntrustedFrame(child, true)).toBe(false);

    // Pairing is exact-origin, including the port, and cannot be inherited by another site.
    const foreign = await context.newPage();
    await foreign.goto(fixture.apiOrigin);
    await connect(foreign);
    expect(await invoke(foreign, { op: "status" })).toMatchObject({ ok: true, result: { paired: false } });
    expect((await invoke(foreign, {
      op: "fetch", requestId: "foreign", request: { url: `${fixture.apiOrigin}/plain` },
    })).ok).toBe(false);
    await foreign.close();

    const closing = await context.newPage();
    await closing.goto(fixture.kernelOrigin);
    await connect(closing);
    expect(await invoke(closing, {
      op: "fetch", requestId: "disconnect", request: { url: `${fixture.apiOrigin}/stream/disconnect` },
    })).toMatchObject({ ok: true, result: { status: 200 } });
    await closing.close();
    await browserExpect.poll(() => fixture.cancelled.has("disconnect")).toBe(true);

    // Relaunch the real browser with the same profile, without touching extension storage.
    await context.close();
    context = await launch();
    const resumed = await context.newPage();
    await resumed.goto(fixture.kernelOrigin);
    await connect(resumed);
    expect(await invoke(resumed, { op: "status" })).toMatchObject({ ok: true, result: { paired: true } });
    expect((await invoke(resumed, { op: "pair" })).ok).toBe(true);
    await browserExpect.poll(() => context!.pages().filter(candidate => candidate.url().includes("pair.html")).length).toBe(0);

    expect(await invoke(resumed, {
      op: "fetch", requestId: "revoked", request: { url: `${fixture.apiOrigin}/stream/revoked` },
    })).toMatchObject({ ok: true, result: { status: 200 } });
    const settings = await context.newPage();
    await settings.goto(`chrome-extension://${extensionId}/settings.html`);
    await browserExpect(settings.getByText(fixture.kernelOrigin, { exact: true })).toBeVisible();
    await settings.getByRole("button", { name: /disconnect|revoke/i }).click();
    await browserExpect.poll(() => fixture.cancelled.has("revoked")).toBe(true);
    expect(await invoke(resumed, { op: "status" })).toMatchObject({ ok: true, result: { paired: false } });
    expect((await invoke(resumed, {
      op: "fetch", requestId: "after-revoke", request: { url: `${fixture.apiOrigin}/plain` },
    })).ok).toBe(false);
  } finally {
    await context?.close();
    fixture.stop();
    await rm(profile, { recursive: true, force: true });
  }
}, 90_000);

test("a routed fetch survives headers arriving after the Chrome service-worker fetch deadline", async () => {
  const profile = await mkdtemp(join(await temporaryRoot(), "neutron-extension-slow-"));
  const fixture = createFixture();
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(profile, {
      executablePath: await chromiumExecutable(), headless: true,
      args: ["--no-sandbox", `--disable-extensions-except=${join(extensionRoot, "dist")}`, `--load-extension=${join(extensionRoot, "dist")}`],
    });
    const page = await context.newPage();
    await page.goto(fixture.kernelOrigin);
    await connect(page);
    const approvalOpened = context.waitForEvent("page", { predicate: candidate => candidate.url().includes("pair.html") });
    const pairing = invoke(page, { op: "pair" });
    const approval = await approvalOpened;
    await approval.locator("#approve").click();
    expect((await pairing).ok).toBe(true);
    const started = performance.now();
    expect(await invoke(page, {
      op: "fetch", requestId: "slow", request: { url: `${fixture.apiOrigin}/slow` },
    }, 45_000)).toMatchObject({ ok: true, result: { status: 200 } });
    expect(performance.now() - started).toBeGreaterThanOrEqual(31_000);
    expect(new TextDecoder().decode(await readAll(page, "slow"))).toBe("Delayed headers survived");
  } finally {
    await context?.close();
    fixture.stop();
    await rm(profile, { recursive: true, force: true });
  }
}, 60_000);

async function connect(page: Page): Promise<unknown> {
  return page.evaluate(({ channel }) => new Promise((resolve, reject) => {
    const messageChannel = new MessageChannel();
    const pending = new Map<string, { resolve: (reply: WireReply) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
    const messages: unknown[] = [];
    const readyTimeout = setTimeout(() => reject(new Error("The extension did not answer the connection handshake.")), 10_000);
    messageChannel.port1.onmessage = event => {
      const reply = event.data;
      messages.push(reply);
      if (reply?.type === "ready") { clearTimeout(readyTimeout); resolve(reply); }
      if (typeof reply?.id === "string") {
        const waiting = pending.get(reply.id);
        if (waiting) { clearTimeout(waiting.timer); pending.delete(reply.id); waiting.resolve(reply); }
      }
    };
    (window as HarnessWindow).__extensionQualification = {
      messages,
      invoke(request, timeoutMs) {
        const id = crypto.randomUUID();
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Extension operation ${request.op} timed out.`)); }, timeoutMs);
          pending.set(id, { resolve, reject, timer });
          messageChannel.port1.postMessage({ ...request, id });
        });
      },
    };
    window.postMessage({ channel, type: "connect" }, location.origin, [messageChannel.port2]);
  }), { channel });
}

function invoke<T = Record<string, unknown>>(page: Page, request: Record<string, unknown>, timeoutMs = 10_000): Promise<WireReply<T>> {
  return page.evaluate(async ({ request, timeoutMs }) => {
    const bridge = (window as HarnessWindow).__extensionQualification;
    if (!bridge) throw new Error("The extension qualification bridge is not connected.");
    return bridge.invoke(request, timeoutMs);
  }, { request, timeoutMs }) as Promise<WireReply<T>>;
}

async function readAll(page: Page, requestId: string): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for (;;) {
    const reply = await invoke<{ done: boolean; chunkBase64?: string }>(page, { op: "read", requestId });
    expect(reply.ok).toBe(true);
    if (!reply.ok || !reply.result) throw new Error(reply.error?.message ?? "A stream read did not return a result.");
    if (reply.result.chunkBase64) chunks.push(Buffer.from(reply.result.chunkBase64, "base64"));
    if (reply.result.done) return new Uint8Array(Buffer.concat(chunks));
  }
}

function probeUntrustedFrame(frame: Frame, targetParent: boolean): Promise<boolean> {
  return frame.evaluate(({ channel, targetParent }) => new Promise(resolve => {
    const ports = new MessageChannel();
    const timeout = setTimeout(() => { ports.port1.close(); resolve(false); }, 500);
    ports.port1.onmessage = event => {
      if (event.data?.type === "ready") { clearTimeout(timeout); ports.port1.close(); resolve(true); }
    };
    (targetParent ? parent : window).postMessage({ channel, type: "connect" }, location.origin, [ports.port2]);
  }), { channel, targetParent });
}

function createFixture() {
  const cancelled = new Set<string>();
  const streams = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
  const encoder = new TextEncoder();
  const html = () => new Response("<!doctype html><html><head><title>Neutron extension qualification</title></head><body>Neutron extension qualification</body></html>", { headers: { "content-type": "text/html" } });
  const kernel = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: html });
  const api = Bun.serve({
    hostname: "127.0.0.1", port: 0, idleTimeout: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/plain") return new Response("Cross-origin response ✓");
      if (path === "/redirect") return new Response(null, { status: 302, headers: { location: "/data" } });
      if (path === "/data") return new Response("Redirect target ✓");
      if (path === "/echo") return new Response(await request.arrayBuffer());
      if (path === "/slow") {
        await Bun.sleep(31_500);
        return new Response("Delayed headers survived");
      }
      if (path.startsWith("/stream/")) {
        const id = path.slice("/stream/".length);
        request.signal.addEventListener("abort", () => cancelled.add(id), { once: true });
        const stream = new ReadableStream<Uint8Array>({
          start(controller) { streams.set(id, controller); controller.enqueue(encoder.encode("first")); },
          cancel() { streams.delete(id); cancelled.add(id); },
        });
        return new Response(stream, { headers: { "content-type": "application/octet-stream" } });
      }
      return html();
    },
  });
  return {
    kernelOrigin: `http://127.0.0.1:${kernel.port}`,
    apiOrigin: `http://127.0.0.1:${api.port}`,
    cancelled,
    finishStream(id: string, tail: string) {
      const stream = streams.get(id);
      if (!stream) throw new Error(`Missing fixture stream ${id}`);
      stream.enqueue(encoder.encode(tail));
      stream.close();
      streams.delete(id);
    },
    stop() { kernel.stop(true); api.stop(true); },
  };
}

async function temporaryRoot(): Promise<string> {
  try { await access("/dev/shm", constants.W_OK); return "/dev/shm"; }
  catch { return tmpdir(); }
}

async function chromiumExecutable(): Promise<string> {
  const candidates = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, process.env.CHROMIUM_PATH];
  if (process.platform === "linux") {
    try {
      for (const entry of (await readdir("/nix/store")).filter(name => /-chromium-\d/.test(name)).sort()) {
        candidates.push(join("/nix/store", entry, "bin", "chromium"));
      }
    } catch { /* Use the usual installed Playwright browser below. */ }
  }
  candidates.push(chromium.executablePath());
  for (const candidate of candidates) {
    if (!candidate) continue;
    try { await access(candidate, constants.X_OK); return candidate; }
    catch { /* Try another installed executable. */ }
  }
  throw new Error("Install Playwright Chromium or set PLAYWRIGHT_CHROMIUM_EXECUTABLE to a Chromium executable that supports loading unpacked extensions.");
}
