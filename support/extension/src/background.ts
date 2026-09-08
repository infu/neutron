import { BRIDGE_PORT, BridgeError, PAIRING_KEY, PROTOCOL_VERSION, errorReply, parseRequest, topLevelOrigin } from "./protocol";
import type { Pairing, Reply, Request } from "./protocol";

const extensionVersion = chrome.runtime.getManifest().version;
const connections = new Set<Connection>();
interface Stream { key: string; started: boolean; cancelled: boolean }
interface Connection { port: ChromePort; origin: string; streams: Map<string, Stream>; live: boolean }
interface PairRequest { id: string; origin: string; windowId?: number; promise: Promise<void>; resolve(): void; reject(error: Error): void }
const pairRequests = new Map<string, PairRequest>();
let storageMutation = Promise.resolve();
let networkPort: ChromePort | undefined;
let offscreenCreating: Promise<void> | undefined;
const networkWaiting = new Set<(port: ChromePort) => void>();
const networkPending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
let heartbeat: ReturnType<typeof setInterval> | undefined;

// Browser pages cannot read persistent extension state through a content script.
const storageReady = chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });

async function pairedOrigins(): Promise<Pairing[]> {
  await storageReady;
  const stored = (await chrome.storage.local.get(PAIRING_KEY))[PAIRING_KEY];
  if (!Array.isArray(stored)) return [];
  return stored.filter((entry): entry is Pairing => typeof entry === "object" && entry !== null && typeof entry.origin === "string" && typeof entry.connectedAt === "number");
}

async function isPaired(origin: string): Promise<boolean> { return (await pairedOrigins()).some(entry => entry.origin === origin); }
function changePairing(origin: string, connect: boolean): Promise<void> {
  const operation = storageMutation.then(async () => {
    const entries = (await pairedOrigins()).filter(entry => entry.origin !== origin);
    if (connect) entries.push({ origin, connectedAt: Date.now() });
    await chrome.storage.local.set({ [PAIRING_KEY]: entries });
  });
  storageMutation = operation.catch(() => {});
  return operation;
}

async function status(origin: string) { return { version: PROTOCOL_VERSION, extensionVersion, origin, paired: await isPaired(origin) }; }
function post(port: ChromePort, value: unknown) { try { port.postMessage(value); } catch { /* Chrome disconnect events clean up requests. */ } }

function refreshHeartbeat() {
  const active = pairRequests.size > 0 || [...connections].some(connection => connection.streams.size > 0);
  if (active && heartbeat === undefined) heartbeat = setInterval(() => {
    // Port traffic resets Chrome's idle service-worker timer. The connection
    // grant itself has no deadline and does not depend on these heartbeats.
    for (const connection of connections) if (connection.streams.size || pairRequests.size) post(connection.port, { type: "keepalive" });
  }, 20_000);
  if (!active && heartbeat !== undefined) { clearInterval(heartbeat); heartbeat = undefined; }
}

async function ensureNetwork(): Promise<ChromePort> {
  if (networkPort) return networkPort;
  if (!offscreenCreating) offscreenCreating = (async () => {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [chrome.runtime.getURL("offscreen.html")] });
    if (!contexts.length) await chrome.offscreen.createDocument({ url: "offscreen.html", reasons: ["WORKERS"], justification: "Run a dedicated network worker for browser HTTP requests and streaming responses without a visible tab." });
  })().finally(() => { offscreenCreating = undefined; });
  await offscreenCreating;
  if (networkPort) return networkPort;
  return new Promise(resolve => networkWaiting.add(resolve));
}

async function networkCall(message: Record<string, unknown>, stream?: Stream): Promise<unknown> {
  const port = await ensureNetwork();
  if (stream?.cancelled) throw new BridgeError("ABORTED", "The request was cancelled.");
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    networkPending.set(id, { resolve, reject });
    try { port.postMessage({ ...message, id }); }
    catch (error) { networkPending.delete(id); reject(error instanceof Error ? error : new Error("The network worker disconnected.")); }
  });
}

function cancelStream(connection: Connection, requestId: string): void {
  const stream = connection.streams.get(requestId);
  if (!stream) return;
  connection.streams.delete(requestId);
  stream.cancelled = true;
  // Never create an offscreen context just to cancel work that has not started.
  if (networkPort) void networkCall({ op: "cancel", key: stream.key }).catch(() => {});
  refreshHeartbeat();
}

function cancelOrigin(origin: string) {
  for (const connection of connections) if (connection.origin === origin) {
    for (const requestId of connection.streams.keys()) cancelStream(connection, requestId);
    post(connection.port, { type: "revoked" });
  }
}

function finishPair(id: string, error?: Error) {
  const pending = pairRequests.get(id);
  if (!pending) return;
  pairRequests.delete(id);
  if (error) pending.reject(error); else pending.resolve();
  refreshHeartbeat();
}

async function pair(origin: string): Promise<void> {
  if (await isPaired(origin)) return;
  const existing = [...pairRequests.values()].find(request => request.origin === origin);
  if (existing) return existing.promise;
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  const pending: PairRequest = { id: crypto.randomUUID(), origin, promise, resolve, reject };
  pairRequests.set(pending.id, pending);
  refreshHeartbeat();
  void chrome.windows.create({ url: chrome.runtime.getURL(`pair.html?request=${pending.id}`), type: "popup", width: 460, height: 430 }).then(window => {
    if (window.id !== undefined) pending.windowId = window.id;
  }).catch(error => finishPair(pending.id, error instanceof Error ? error : new Error("Could not open the connection confirmation.")));
  return promise;
}

async function handle(connection: Connection, request: Request): Promise<unknown> {
  if (request.op === "status") return status(connection.origin);
  if (request.op === "pair") { await pair(connection.origin); return status(connection.origin); }
  if (request.op === "revoke") {
    await changePairing(connection.origin, false);
    cancelOrigin(connection.origin);
    return status(connection.origin);
  }
  if (request.op === "cancel") { cancelStream(connection, request.requestId); return {}; }

  // Reserve before awaiting authorization or creating the network worker so a
  // cancel received while fetch is awaiting headers also cancels its setup.
  let stream = connection.streams.get(request.requestId);
  if (request.op === "fetch" || request.op === "upload") {
    if (!stream) {
      stream = { key: crypto.randomUUID(), started: false, cancelled: false };
      connection.streams.set(request.requestId, stream);
      refreshHeartbeat();
    }
    if (stream.started) throw new BridgeError("DUPLICATE_REQUEST", "This stream ID is already in use.");
    if (request.op === "fetch") stream.started = true;
  }
  if (!stream) throw new BridgeError("UNKNOWN_REQUEST", "This request is not open on this connection.");
  try {
    if (!await isPaired(connection.origin)) throw new BridgeError("NOT_PAIRED", "Connect this Neutron to the extension first.");
    if (!connection.live || stream.cancelled) throw new BridgeError("ABORTED", "The request was cancelled.");
    if (request.op === "upload") return await networkCall({ op: "upload", key: stream.key, chunkBase64: request.chunkBase64 }, stream);
    if (request.op === "fetch") {
      const result = await networkCall({ op: "fetch", key: stream.key, request: request.request }, stream) as Record<string, unknown>;
      return { ...result, requestId: request.requestId };
    }
    const result = await networkCall({ op: "read", key: stream.key }, stream) as { done: boolean };
    if (result.done) { connection.streams.delete(request.requestId); refreshHeartbeat(); }
    return result;
  } catch (error) {
    // A duplicate concurrent read is a caller error; its first read remains live.
    if (!(error instanceof BridgeError && error.code === "READ_IN_PROGRESS")) cancelStream(connection, request.requestId);
    throw error;
  }
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name === "neutron-network-worker" && port.sender?.id === chrome.runtime.id && port.sender.url === chrome.runtime.getURL("offscreen.html")) {
    networkPort = port;
    port.onMessage.addListener(value => {
      const reply = value as Reply;
      const pending = networkPending.get(reply.id);
      if (!pending) return;
      networkPending.delete(reply.id);
      if (reply.ok) pending.resolve(reply.result);
      else pending.reject(new BridgeError(reply.error.code, reply.error.message));
    });
    port.onDisconnect.addListener(() => {
      if (networkPort === port) networkPort = undefined;
      for (const pending of networkPending.values()) pending.reject(new BridgeError("EXTENSION_DISCONNECTED", "The network worker disconnected. The request was not retried."));
      networkPending.clear();
      for (const connection of connections) connection.port.disconnect();
    });
    for (const resolve of networkWaiting) resolve(port);
    networkWaiting.clear();
    return;
  }
  if (port.name !== BRIDGE_PORT) { port.disconnect(); return; }
  let origin: string;
  try { origin = topLevelOrigin(port.sender ?? {}); }
  catch { port.disconnect(); return; }
  const connection: Connection = { port, origin, streams: new Map(), live: true };
  connections.add(connection);
  post(port, { type: "ready", version: PROTOCOL_VERSION, extensionVersion });
  port.onMessage.addListener(value => {
    let request: Request;
    try { request = parseRequest(value); }
    catch (error) { post(port, errorReply(typeof (value as { id?: unknown })?.id === "string" ? (value as { id: string }).id : "", error)); return; }
    void handle(connection, request).then(result => post(port, { id: request.id, ok: true, result }), error => post(port, errorReply(request.id, error)));
  });
  port.onDisconnect.addListener(() => {
    connection.live = false;
    for (const requestId of connection.streams.keys()) cancelStream(connection, requestId);
    connections.delete(connection);
    refreshHeartbeat();
  });
});

chrome.windows.onRemoved.addListener(windowId => {
  for (const pending of pairRequests.values()) if (pending.windowId === windowId) finishPair(pending.id, new BridgeError("PAIRING_CANCELLED", "The connection request was closed."));
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[PAIRING_KEY]) return;
  void pairedOrigins().then(entries => {
    for (const origin of new Set([...connections].map(connection => connection.origin))) if (!entries.some(entry => entry.origin === origin)) cancelOrigin(origin);
  });
});

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  // Only packaged extension UI can approve or enumerate connections.
  const ownPage = sender.id === chrome.runtime.id && (sender.url?.startsWith(chrome.runtime.getURL("pair.html")) || sender.url === chrome.runtime.getURL("settings.html"));
  if (!ownPage || message?.target !== "neutron-extension-settings") return;
  void (async () => {
    if (message.op === "list") return { entries: await pairedOrigins() };
    if (message.op === "pair_details") {
      const pending = pairRequests.get(message.requestId);
      if (!pending) throw new BridgeError("PAIRING_CLOSED", "This connection request is no longer open. Start it again from Neutron.");
      return { origin: pending.origin };
    }
    if (message.op === "pair_decide") {
      const pending = pairRequests.get(message.requestId);
      if (!pending) throw new BridgeError("PAIRING_CLOSED", "This connection request is no longer open.");
      if (message.accept === true) {
        await changePairing(pending.origin, true);
        finishPair(pending.id);
      } else finishPair(pending.id, new BridgeError("PAIRING_CANCELLED", "The connection was not accepted."));
      return {};
    }
    if (message.op === "revoke" && typeof message.origin === "string") {
      await changePairing(message.origin, false);
      cancelOrigin(message.origin);
      return {};
    }
    throw new BridgeError("INVALID_REQUEST", "Unknown settings operation.");
  })().then(result => reply({ ok: true, result }), error => reply(errorReply("", error)));
  return true;
});
