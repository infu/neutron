import { expect, test } from "bun:test";
import { BrowserExtensionBroker, EXTENSION_GRANT_STORAGE_PREFIX } from "../src/browser_extension/broker.ts";
import type { RegisteredEndpoint } from "../src/frame_context.ts";

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function fixture() {
  const storage = new MemoryStorage();
  const owner = { principal: "owner", logged: true, authorized: true, sessionGeneration: 1 };
  const app = { name: "Agent", version: 318, generation: 1, installationUid: "41" };
  const endpoint: RegisteredEndpoint = {
    endpointId: "app:agent:background", source: {} as Window,
    sessionId: "session-1", appScope: { appId: "agent", installationUid: "41" },
    context: { role: "background", appId: "agent" },
  };
  const endpoints = new Map([[endpoint.endpointId, endpoint]]);
  let consentCalls = 0;
  let paired = false;
  let available = true;
  let consent: () => Promise<void> = async () => {};
  let remote: (op: string, payload: Record<string, unknown>) => Promise<unknown> = async (op, payload) => {
    if (op === "pair") { paired = true; return { paired: true }; }
    if (op === "fetch") return head(payload.requestId as string);
    if (op === "read") return { done: true, chunkBase64: btoa("response") };
    return {};
  };
  const calls: Array<{ op: string; payload: Record<string, unknown> }> = [];
  const create = () => new BrowserExtensionBroker({
    transport: {
      status: async () => ({ available, paired, extensionVersion: "0.1.0" }),
      request: async (op, payload = {}) => { calls.push({ op, payload }); return remote(op, payload); },
    },
    storage: () => storage,
    owner: () => owner,
    endpoint: (id) => endpoints.get(id) ?? null,
    app: () => app,
    consent: async () => { consentCalls += 1; await consent(); },
  });
  return {
    storage, owner, app, endpoint, endpoints, calls, create, broker: create(),
    consentCalls: () => consentCalls,
    setConsent: (next: typeof consent) => { consent = next; },
    setRemote: (next: typeof remote) => { remote = next; },
    setPaired: (next: boolean) => { paired = next; },
    setAvailable: (next: boolean) => { available = next; },
  };
}

function head(requestId: string) {
  return { requestId, status: 200, statusText: "OK", headers: [["content-type", "text/event-stream"]], url: "https://example.com/response" };
}

const request = { url: "https://example.com/response", method: "POST", headers: [["authorization", "Bearer explicit"]] };

test("extension pairing and app consent happen once, surviving browser reloads, app releases and arbitrary time", async () => {
  const f = fixture();
  await expect(f.broker.status(f.endpoint)).resolves.toMatchObject({ available: true, paired: false, granted: false });
  await expect(f.broker.request({ reason: "Connect my provider" }, f.endpoint)).resolves.toMatchObject({ paired: true, granted: true });
  expect(f.consentCalls()).toBe(1);
  expect(f.calls.filter(({ op }) => op === "pair")).toHaveLength(1);
  const key = f.storage.key(0)!;
  const saved = JSON.parse(f.storage.getItem(key)!);
  saved.createdAt = 1;
  f.storage.setItem(key, JSON.stringify(saved));
  f.app.version += 1;
  f.app.generation += 1;
  f.owner.sessionGeneration += 1;
  const reloaded = f.create();
  await expect(reloaded.request({}, f.endpoint)).resolves.toMatchObject({ granted: true });
  expect(f.consentCalls()).toBe(1);
  expect(f.calls.filter(({ op }) => op === "pair")).toHaveLength(1);
  expect(reloaded.grants()[0]!.createdAt).toBe(1);
});

test("concurrent requests for the same app share one pending consent", async () => {
  const f = fixture();
  f.setPaired(true);
  const approval = deferred<void>();
  f.setConsent(() => approval.promise);
  const first = f.broker.request({}, f.endpoint);
  const second = f.broker.request({}, f.endpoint);
  await Promise.resolve(); await Promise.resolve();
  expect(f.consentCalls()).toBe(1);
  approval.resolve();
  const results = await Promise.all([first, second]);
  expect(results.every((status) => status.granted === true)).toBe(true);
  expect(f.broker.grants()).toHaveLength(1);
});

test("verified agent authority can grant once without a second owner dialog", async () => {
  const f = fixture();
  f.setPaired(true);
  let authorizations = 0;
  const options = { authorize: async () => { authorizations += 1; return true; } };
  await f.broker.request({}, f.endpoint, options);
  await f.broker.request({}, f.endpoint, options);
  expect(authorizations).toBe(1);
  expect(f.consentCalls()).toBe(0);
});

test("grants do not cross owner, app installation, or app identity boundaries", async () => {
  const f = fixture();
  await f.broker.request({}, f.endpoint);
  f.owner.principal = "another-owner";
  await expect(f.broker.status(f.endpoint)).resolves.toMatchObject({ granted: false });
  f.owner.principal = "owner";
  f.app.installationUid = "42";
  f.endpoint.appScope = { appId: "agent", installationUid: "42" };
  await expect(f.broker.status(f.endpoint)).resolves.toMatchObject({ granted: false });
  f.app.installationUid = "41";
  f.endpoint.context = { role: "background", appId: "other-app" };
  f.endpoint.appScope = { appId: "other-app", installationUid: "41" };
  await expect(f.broker.status(f.endpoint)).resolves.toMatchObject({ granted: false });
});

test("owner logout or endpoint replacement during consent cannot save a grant", async () => {
  for (const change of ["owner", "endpoint"] as const) {
    const f = fixture();
    f.setPaired(true);
    const approval = deferred<void>();
    f.setConsent(() => approval.promise);
    const pending = f.broker.request({}, f.endpoint);
    await Promise.resolve(); await Promise.resolve();
    if (change === "owner") f.owner.logged = false;
    else f.endpoints.set(f.endpoint.endpointId, { ...f.endpoint, source: {} as Window });
    approval.resolve();
    await expect(pending).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
    expect(f.storage.length).toBe(0);
  }
});

test("storage failure never reports an unsaved permanent grant as successful", async () => {
  const f = fixture();
  f.storage.setItem = () => { throw new Error("Browser storage is full"); };
  await expect(f.broker.request({}, f.endpoint)).rejects.toThrow("Browser storage is full");
  await expect(f.broker.status(f.endpoint)).resolves.toMatchObject({ granted: false });
});

test("route access is required before upload or fetch; malformed stored grants do not grant it", async () => {
  const f = fixture();
  f.storage.setItem(`${EXTENSION_GRANT_STORAGE_PREFIX}broken`, "{}");
  await expect(f.broker.fetch({ requestId: "one", request }, f.endpoint)).rejects.toMatchObject({ code: "OWNER_REQUIRED" });
  await expect(f.broker.upload({ requestId: "one", chunkBase64: "YQ==" }, f.endpoint)).rejects.toMatchObject({ code: "OWNER_REQUIRED" });
  expect(f.calls).toHaveLength(0);
});

test("uploads, headers and streamed response are routed through an endpoint-private wire ID", async () => {
  const f = fixture();
  await f.broker.request({}, f.endpoint);
  await f.broker.upload({ requestId: "caller-request", chunkBase64: btoa("first") }, f.endpoint);
  await f.broker.upload({ requestId: "caller-request", chunkBase64: btoa("second") }, f.endpoint);
  await expect(f.broker.fetch({ requestId: "caller-request", request: { ...request, hasBody: true, redirect: "error" } }, f.endpoint)).resolves.toEqual(head("caller-request"));
  await expect(f.broker.read({ requestId: "caller-request" }, f.endpoint)).resolves.toEqual({ done: true, chunkBase64: btoa("response") });
  const routed = f.calls.filter(({ op }) => ["upload", "fetch", "read"].includes(op));
  expect(routed).toHaveLength(4);
  const wireId = routed[0]!.payload.requestId;
  expect(wireId).not.toBe("caller-request");
  expect(routed.every(({ payload }) => payload.requestId === wireId)).toBe(true);
  expect(routed[2]!.payload.request).toEqual({ ...request, hasBody: true, redirect: "error" });
  await expect(f.broker.read({ requestId: "caller-request" }, f.endpoint)).rejects.toThrow("unavailable");
});

test("another app endpoint cannot read or cancel an existing request even with its caller ID", async () => {
  const f = fixture();
  await f.broker.request({}, f.endpoint);
  await f.broker.fetch({ requestId: "same-id", request }, f.endpoint);
  const other: RegisteredEndpoint = { ...f.endpoint, endpointId: "another-tile", source: {} as Window, sessionId: "other-session" };
  f.endpoints.set(other.endpointId, other);
  await expect(f.broker.read({ requestId: "same-id" }, other)).rejects.toThrow("unavailable");
  expect(f.broker.cancel({ requestId: "same-id" }, other)).toEqual({});
  expect(f.calls.filter(({ op }) => op === "cancel")).toHaveLength(0);
  await expect(f.broker.read({ requestId: "same-id" }, f.endpoint)).resolves.toMatchObject({ done: true });
});

test("manual redirect metadata survives the broker without being turned into an ordinary successful response", async () => {
  const f = fixture();
  await f.broker.request({}, f.endpoint);
  f.setRemote(async (_op, payload) => ({
    requestId: payload.requestId, status: 0, statusText: "", headers: [], url: "",
    type: "opaqueredirect", redirected: false,
  }));
  await expect(f.broker.fetch({ requestId: "redirect", request: { ...request, redirect: "manual" } }, f.endpoint)).resolves.toEqual({
    requestId: "redirect", status: 0, statusText: "", headers: [], url: "",
    type: "opaqueredirect", redirected: false,
  });
});

test("cancellation before response headers aborts the pending remote fetch and suppresses a late response", async () => {
  const f = fixture();
  await f.broker.request({}, f.endpoint);
  const response = deferred<unknown>();
  f.setRemote(async (op) => op === "fetch" ? response.promise : {});
  const fetch = f.broker.fetch({ requestId: "pending", request }, f.endpoint);
  const wireId = f.calls.find(({ op }) => op === "fetch")!.payload.requestId as string;
  f.broker.cancel({ requestId: "pending" }, f.endpoint);
  expect(f.calls.at(-1)).toEqual({ op: "cancel", payload: { requestId: wireId } });
  response.resolve(head(wireId));
  await expect(fetch).rejects.toThrow("cancelled");
});

test("Settings revocation cancels active reads immediately and prevents further network calls", async () => {
  const f = fixture();
  await f.broker.request({}, f.endpoint);
  await f.broker.fetch({ requestId: "stream", request }, f.endpoint);
  const response = deferred<unknown>();
  f.setRemote(async (op) => op === "read" ? response.promise : {});
  const read = f.broker.read({ requestId: "stream" }, f.endpoint);
  f.broker.revoke(f.broker.grants()[0]!.id);
  expect(f.calls.at(-1)!.op).toBe("cancel");
  expect(f.broker.grants()).toHaveLength(0);
  response.resolve({ done: false, chunkBase64: btoa("late data") });
  await expect(read).rejects.toThrow("revoked");
  await expect(f.broker.fetch({ requestId: "another", request }, f.endpoint)).rejects.toMatchObject({ code: "OWNER_REQUIRED" });
});

test("reconciliation cancels abandoned uploads and changed owner sessions without expiring the saved grant", async () => {
  const f = fixture();
  await f.broker.request({}, f.endpoint);
  await f.broker.upload({ requestId: "upload", chunkBase64: "YQ==" }, f.endpoint);
  f.owner.sessionGeneration += 1;
  f.broker.reconcile();
  expect(f.calls.at(-1)!.op).toBe("cancel");
  expect(f.broker.grants()).toHaveLength(1);
  await expect(f.broker.status(f.endpoint)).resolves.toMatchObject({ granted: true });
});

test("disconnect forgets interrupted streams without reconnecting or replaying network requests", async () => {
  const f = fixture();
  await f.broker.request({}, f.endpoint);
  await f.broker.fetch({ requestId: "stream", request }, f.endpoint);
  const callsBefore = f.calls.length;
  f.broker.disconnected();
  expect(f.calls).toHaveLength(callsBefore);
  await expect(f.broker.read({ requestId: "stream" }, f.endpoint)).rejects.toThrow("unavailable");
  expect(f.broker.grants()).toHaveLength(1);
});

test("missing extension does not create a grant or open app consent", async () => {
  const f = fixture();
  f.setAvailable(false);
  await expect(f.broker.request({}, f.endpoint)).rejects.toThrow("Install or enable");
  expect(f.storage.length).toBe(0);
  expect(f.consentCalls()).toBe(0);
});
