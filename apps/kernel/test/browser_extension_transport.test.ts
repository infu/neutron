import { afterEach, expect, test } from "bun:test";
import {
  BrowserExtensionTransport,
  BrowserExtensionTransportError,
} from "../src/browser_extension/transport.ts";

const ORIGIN = "https://neutron.example";
const transports: BrowserExtensionTransport[] = [];

afterEach(() => {
  for (const transport of transports.splice(0)) transport.disconnect();
});

test("extension discovery is limited to the top browser window", async () => {
  const missing = new BrowserExtensionTransport({ window: null });
  expect(await missing.status()).toEqual({ available: false, paired: false });
  const { transport, connectionAttempts } = setup({ topFrame: false });
  expect(await transport.status()).toEqual({ available: false, paired: false });
  expect(connectionAttempts()).toBe(0);
});

test("handshake timeout only detects absence and subsequent requests can reconnect", async () => {
  const harness = setup({ ready: false });
  expect(await harness.transport.status()).toEqual({ available: false, paired: false });
  harness.setReady(true);
  harness.onRequest((request, port) => {
    expect(request.op).toBe("status");
    reply(port, request.id, status(false));
  });
  expect(await harness.transport.status()).toEqual({
    available: true,
    paired: false,
    extensionVersion: "0.1.0",
  });
  expect(harness.connectionAttempts()).toBe(2);
});

test("concurrent requests share one handshake and resolve out of order by unique IDs", async () => {
  const harness = setup();
  const requests: Array<{ request: Request; port: FakePort }> = [];
  harness.onRequest((request, port) => requests.push({ request, port }));
  const first = harness.transport.request("fetch", { requestId: "stream-a", id: "injected", op: "injected" });
  const second = harness.transport.request("read", { requestId: "stream-b" });
  await settleMessages();
  expect(harness.connectionAttempts()).toBe(1);
  expect(requests).toHaveLength(2);
  const one = requests[0]!;
  const two = requests[1]!;
  expect(one.request.op).toBe("fetch");
  expect(one.request.requestId).toBe("stream-a");
  expect(one.request.id).not.toBe("injected");
  expect(one.request.id).not.toBe(two.request.id);
  reply(two.port, "unsolicited", "ignored");
  reply(two.port, two.request.id, "second");
  reply(one.port, one.request.id, "first");
  expect(await first).toBe("first");
  expect(await second).toBe("second");
});

test("pairing and long-running reads do not inherit the discovery timeout", async () => {
  const harness = setup();
  harness.onRequest((request, port) => {
    setTimeout(() => reply(port, request.id, request.op), 35);
  });
  expect(await harness.transport.request("pair")).toBe("pair");
  expect(await harness.transport.request("read", { requestId: "stream" })).toBe("read");
  expect(harness.connectionAttempts()).toBe(1);
});

test("disconnect rejects every pending RPC and later requests reconnect without replay", async () => {
  const harness = setup();
  const seen: Request[] = [];
  harness.onRequest((request) => seen.push(request));
  const first = harness.transport.request("fetch");
  const second = harness.transport.request("read");
  const outcomes = Promise.allSettled([first, second]);
  await settleMessages();
  const originalPort = harness.latestPort();
  originalPort.postMessage({ type: "disconnected", error: { code: "EXTENSION_DISCONNECTED", message: "Extension restarted" } });
  expect(await outcomes).toMatchObject([
    { status: "rejected", reason: { code: "EXTENSION_DISCONNECTED" } },
    { status: "rejected", reason: { code: "EXTENSION_DISCONNECTED" } },
  ]);

  harness.onRequest((request, port) => {
    seen.push(request);
    reply(port, request.id, status(true));
  });
  expect(await harness.transport.status()).toEqual({ available: true, paired: true, extensionVersion: "0.1.0" });
  expect(harness.connectionAttempts()).toBe(2);
  expect(seen.map((request) => request.op)).toEqual(["fetch", "read", "status"]);
  expect(new Set(seen.map((request) => request.id)).size).toBe(3);
});

test("message decoding failure rejects pending RPCs and notifies all listeners", async () => {
  const harness = setup();
  let notifications = 0;
  harness.transport.subscribeDisconnect(() => { throw new Error("broken consumer"); });
  const unsubscribe = harness.transport.subscribeDisconnect(() => notifications++);
  const pending = harness.transport.request("read");
  const outcome = pending.catch((error: unknown) => error);
  await settleMessages();
  harness.latestPort().peer!.onmessageerror?.({} as MessageEvent);
  expect(await outcome).toMatchObject({ code: "EXTENSION_DISCONNECTED" });
  expect(notifications).toBe(1);
  unsubscribe();
  harness.onRequest((request, port) => reply(port, request.id, status(true)));
  await harness.transport.status();
  harness.transport.disconnect();
  expect(notifications).toBe(1);
});

test("disconnect while discovering rejects requests and allows a new handshake", async () => {
  const harness = setup({ ready: false });
  const pending = harness.transport.request("pair");
  const outcome = pending.catch((error: unknown) => error);
  harness.transport.disconnect();
  expect(await outcome).toMatchObject({ code: "EXTENSION_DISCONNECTED" });
  harness.setReady(true);
  harness.onRequest((request, port) => reply(port, request.id, "connected"));
  expect(await harness.transport.request("pair")).toBe("connected");
});

test("local disconnect tells the remote bridge to release its port and active requests", async () => {
  const harness = setup();
  const pending = harness.transport.request("fetch", { requestId: "active-request" });
  const outcome = pending.catch((error: unknown) => error);
  await settleMessages();
  harness.transport.disconnect();
  expect(await outcome).toMatchObject({ code: "EXTENSION_DISCONNECTED" });
  await settleMessages();
  expect(harness.controlMessages()).toEqual([{ type: "disconnect" }]);
});

test("revocation notifies subscribers before a pending revoke RPC succeeds", async () => {
  const harness = setup();
  let revoked = 0;
  let disconnected = 0;
  harness.transport.subscribeRevoked(() => { throw new Error("broken consumer"); });
  const unsubscribe = harness.transport.subscribeRevoked(() => revoked++);
  harness.transport.subscribeDisconnect(() => disconnected++);
  harness.onRequest((request, port) => {
    if (request.op === "revoke") {
      port.postMessage({ type: "revoked" });
      reply(port, request.id, status(false));
    } else {
      reply(port, request.id, status(false));
    }
  });
  expect(await harness.transport.request("revoke")).toEqual(status(false));
  expect(revoked).toBe(1);
  expect(disconnected).toBe(0);
  expect(await harness.transport.status()).toEqual({ available: true, paired: false, extensionVersion: "0.1.0" });
  expect(harness.connectionAttempts()).toBe(1);
  unsubscribe();
  harness.latestPort().postMessage({ type: "revoked" });
  await settleMessages();
  expect(revoked).toBe(1);
});

test("status rejects a response identifying a different paired origin", async () => {
  const harness = setup();
  harness.onRequest((request, port) => reply(port, request.id, { ...status(true), origin: "https://another-neutron.example" }));
  await expect(harness.transport.status()).rejects.toMatchObject({ code: "EXTENSION_PROTOCOL_ERROR" });
});

test("incompatible protocol is distinguishable from a missing extension", async () => {
  const harness = setup({ version: 2 });
  expect(await harness.transport.status()).toEqual({ available: false, paired: false, incompatible: true });
  await expect(harness.transport.request("pair")).rejects.toMatchObject({ code: "EXTENSION_INCOMPATIBLE" });
});

test("remote errors retain their code and malformed responses fail descriptively", async () => {
  const harness = setup();
  harness.onRequest((request, port) => {
    port.postMessage({ id: request.id, ok: false, error: { code: "PAIRING_DECLINED", message: "Connection declined" } });
  });
  await expect(harness.transport.request("pair")).rejects.toMatchObject({ code: "PAIRING_DECLINED", message: "Connection declined" });
  harness.onRequest((request, port) => port.postMessage({ id: request.id, ok: "yes" }));
  await expect(harness.transport.request("read")).rejects.toMatchObject({ code: "EXTENSION_PROTOCOL_ERROR" });
  harness.onRequest((request, port) => reply(port, request.id, { version: 1, paired: true }));
  await expect(harness.transport.status()).rejects.toBeInstanceOf(BrowserExtensionTransportError);
  harness.onRequest((request, port) => reply(port, request.id, { ...status(true), version: 2 }));
  expect(await harness.transport.status()).toEqual({ available: false, paired: false, incompatible: true });
});

type Request = Record<string, unknown> & { id: string; op: string };

class FakePort {
  peer: FakePort | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  closed = false;

  start(): void {}
  close(): void { this.closed = true; }
  postMessage(data: unknown): void {
    const peer = this.peer;
    if (this.closed || !peer) return;
    queueMicrotask(() => {
      if (!peer.closed) peer.onmessage?.({ data } as MessageEvent);
    });
  }
}

function setup(options: { ready?: boolean; version?: number; topFrame?: boolean } = {}) {
  let ready = options.ready ?? true;
  let attempts = 0;
  let port: FakePort | null = null;
  const controls: unknown[] = [];
  let requestHandler: (request: Request, port: FakePort) => void = () => {};
  const browserWindow = {
    top: null as unknown,
    location: { origin: ORIGIN },
    postMessage(message: unknown, origin: string, transferred: FakePort[]) {
      expect(message).toEqual({ channel: "neutron.extension.v1", type: "connect" });
      expect(origin).toBe(ORIGIN);
      attempts++;
      // Transfer detaches the sender's port object while the receiving context
      // obtains a new object. Closing that detached sender cannot close the peer.
      const transferredPort = transferred[0]!;
      port = new FakePort();
      port.peer = transferredPort.peer;
      port.peer!.peer = port;
      transferredPort.peer = null;
      transferredPort.closed = true;
      const connectedPort = port;
      connectedPort.onmessage = (event) => {
        if (typeof event.data?.type === "string") {
          controls.push(event.data);
        } else {
          requestHandler(event.data as Request, connectedPort);
        }
      };
      if (ready) connectedPort.postMessage({ type: "ready", version: options.version ?? 1, extensionVersion: "0.1.0" });
    },
  };
  browserWindow.top = options.topFrame === false ? {} : browserWindow;
  class FakeChannel {
    port1 = new FakePort();
    port2 = new FakePort();
    constructor() {
      this.port1.peer = this.port2;
      this.port2.peer = this.port1;
    }
  }
  const transport = new BrowserExtensionTransport({
    window: browserWindow as unknown as Window,
    MessageChannel: FakeChannel as unknown as typeof MessageChannel,
    handshakeMs: 10,
  });
  transports.push(transport);
  return {
    transport,
    setReady(value: boolean) { ready = value; },
    connectionAttempts: () => attempts,
    latestPort: () => port!,
    controlMessages: () => controls,
    onRequest(handler: typeof requestHandler) { requestHandler = handler; },
  };
}

function status(paired: boolean) {
  return { version: 1, extensionVersion: "0.1.0", paired, origin: ORIGIN };
}

function reply(port: FakePort, id: string, result: unknown): void {
  port.postMessage({ id, ok: true, result });
}

async function settleMessages(): Promise<void> {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}
