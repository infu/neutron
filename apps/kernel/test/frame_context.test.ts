import { expect, test } from "bun:test";
import {
  connectFrameEndpoint,
  getRegisteredEndpoint,
  installFrameEndpointHandshake,
  isFrameEndpointReady,
  listRegisteredEndpoints,
  markFrameEndpointLoaded,
  registerFrameContext,
  resolveFrameContext,
  subscribeEndpointChanges,
  waitForFrameEndpointPort,
} from "../src/frame_context.ts";
import {
  MSG_BUS_FRAME_PROBE,
  MSG_BUS_FRAME_READY,
} from "neutron-tools/src/frame_handshake.js";
import { ResidentFrameSecurityMode } from "../src/capabilities/plan.ts";

test("frame context registers, replaces, and unregisters by exact source", () => {
  const source = {} as Window;
  const first = {
    role: "tile" as const,
    appId: "hello",
    tileId: "main",
    instanceId: "one",
    workspace: 1,
  };
  const second = {
    role: "tile" as const,
    appId: "hello",
    tileId: "tools",
    instanceId: "two",
    workspace: 2,
  };

  const unregisterFirst = registerFrameContext(source, first);
  expect(resolveFrameContext(source)).toEqual(first);

  const unregisterSecond = registerFrameContext(source, second);
  expect(resolveFrameContext(source)).toEqual(second);

  unregisterFirst();
  expect(resolveFrameContext(source)).toEqual(second);

  unregisterSecond();
  expect(resolveFrameContext(source)).toBeNull();
});

test("background endpoints use one canonical app namespace", () => {
  const source = {} as Window;
  const unregister = registerFrameContext(source, {
    role: "background",
    appId: "gemma",
  });

  expect(getRegisteredEndpoint("app:gemma:background")?.context).toEqual({
    role: "background",
    appId: "gemma",
  });
  expect(
    listRegisteredEndpoints().some(
      (endpoint) => endpoint.endpointId === "app:gemma:background"
    )
  ).toBe(true);
  unregister();
  expect(getRegisteredEndpoint("app:gemma:background")).toBeNull();
});

test("tray endpoints preserve instance spelling and app binding through replacement", () => {
  const firstSource = {} as Window;
  const secondSource = {} as Window;
  const context = {
    role: "tray" as const,
    appId: "mail",
    instanceId: "panel-one",
  };
  const endpointId = "app:mail:tray:instance:panel-one";
  const unregisterFirst = registerFrameContext(firstSource, context, {
    appVersion: 106,
    appGeneration: 3,
    origin: "null",
  });

  expect(getRegisteredEndpoint(endpointId)).toMatchObject({
    endpointId,
    source: firstSource,
    context,
    appVersion: 106,
    appGeneration: 3,
    origin: "null",
  });
  expect(resolveFrameContext(firstSource)).toEqual(context);

  const unregisterSecond = registerFrameContext(secondSource, context, {
    appVersion: 107,
    appGeneration: 4,
    origin: "null",
  });
  expect(resolveFrameContext(firstSource)).toBeNull();
  expect(getRegisteredEndpoint(endpointId)).toMatchObject({
    source: secondSource,
    appVersion: 107,
    appGeneration: 4,
  });

  unregisterFirst();
  expect(getRegisteredEndpoint(endpointId)?.source).toBe(secondSource);
  unregisterSecond();
  expect(getRegisteredEndpoint(endpointId)).toBeNull();
  expect(resolveFrameContext(secondSource)).toBeNull();
});

test("replacing an endpoint id invalidates the previous source", () => {
  const firstSource = {} as Window;
  const secondSource = {} as Window;
  const context = { role: "background" as const, appId: "gemma" };
  const unregisterFirst = registerFrameContext(firstSource, context);
  const unregisterSecond = registerFrameContext(secondSource, context);

  expect(resolveFrameContext(firstSource)).toBeNull();
  expect(resolveFrameContext(secondSource)).toEqual(context);
  unregisterFirst();
  expect(resolveFrameContext(secondSource)).toEqual(context);
  unregisterSecond();
});

test("resident background ports require authenticated frame readiness", () => {
  const posted: Array<{
    message: unknown;
    targetOrigin: string;
    transfer: Transferable[];
  }> = [];
  const source = {
    postMessage(message: unknown, targetOrigin: string, transfer: Transferable[]) {
      posted.push({ message, targetOrigin, transfer });
    },
  } as unknown as Window;
  const unregister = registerFrameContext(
    source,
    { role: "background", appId: "gemma" },
    {
      origin: "null",
      residentSecurityBinding: {
        mode: ResidentFrameSecurityMode.CREDENTIALLESS_OPAQUE_V1,
        browserOriginNonce: "0123456789abcdef0123456789abcdef",
        browserOriginAuthorityEpoch: "1",
      },
    },
  );

  expect(connectFrameEndpoint(source)).toBe(false);
  expect(connectFrameEndpoint(source, true)).toBe(true);
  expect(posted).toHaveLength(2);
  expect(posted[0]?.message).toEqual({
    type: "neutron:msgbus:probe",
    version: 1,
  });
  expect(posted[1]?.targetOrigin).toBe("*");
  expect(posted[1]?.message).toMatchObject({
    type: "neutron:msgbus:connect",
    version: 1,
  });
  expect(posted[1]?.transfer).toHaveLength(1);
  expect(getRegisteredEndpoint("app:gemma:background")?.port).toBeDefined();
  unregister();
});

test("authenticated ready replaces exact-origin sessions without duplicate churn", () => {
  let onKernelMessage: (event: Event) => void = () => undefined;
  installFrameEndpointHandshake({
    addEventListener(name: string, listener: EventListener) {
      if (name === "message") onKernelMessage = listener;
    },
  } as unknown as Pick<Window, "addEventListener">);
  const posted: Array<{ message: unknown; targetOrigin: string }> = [];
  const origin =
    "http://i3aa79fc331fed4c37ec77196--4caro.localhost:8000";
  const source = {
    postMessage(message: unknown, targetOrigin: string) {
      posted.push({ message, targetOrigin });
    },
  } as unknown as Window;
  const unregister = registerFrameContext(
    source,
    {
      role: "tile",
      appId: "calls",
      tileId: "call",
      instanceId: "one",
      workspace: 1,
    },
    { origin },
  );

  const endpoint = getRegisteredEndpoint(
    "app:calls:tile:call:instance:one",
  );
  onKernelMessage({
    data: MSG_BUS_FRAME_READY,
    origin,
    source,
  } as unknown as MessageEvent);
  const firstPort = endpoint?.port;
  const firstSessionId = endpoint?.sessionId;
  expect(firstPort).toBeDefined();
  expect(firstSessionId).toBeDefined();
  expect(markFrameEndpointLoaded(source)).toBe("preserved");

  onKernelMessage({
    data: MSG_BUS_FRAME_READY,
    origin,
    source,
  } as unknown as MessageEvent);
  expect(endpoint?.port).toBe(firstPort);
  expect(endpoint?.sessionId).toBe(firstSessionId);

  // A proactive ready that races ahead of the next load is ignored while the
  // old document still has its port. The load retires it and probes the new
  // document, whose authenticated response creates the replacement session.
  onKernelMessage({
    data: MSG_BUS_FRAME_READY,
    origin,
    source,
  } as unknown as MessageEvent);
  expect(markFrameEndpointLoaded(source)).toBe("retired");
  expect(endpoint?.port).toBeUndefined();
  onKernelMessage({
    data: MSG_BUS_FRAME_READY,
    origin,
    source,
  } as unknown as MessageEvent);
  expect(endpoint?.port).toBeDefined();
  expect(endpoint?.port).not.toBe(firstPort);
  expect(endpoint?.sessionId).not.toBe(firstSessionId);
  expect(
    posted.filter(
      ({ message }) =>
        typeof message === "object" &&
        message !== null &&
        (message as { type?: unknown }).type === "neutron:msgbus:connect",
    ),
  ).toHaveLength(2);
  expect(posted.every(({ targetOrigin }) => targetOrigin === origin)).toBe(true);
  unregister();
});

test("legacy opaque tray reload replaces the old document's port", () => {
  let onKernelMessage: (event: Event) => void = () => undefined;
  installFrameEndpointHandshake({
    addEventListener(name: string, listener: EventListener) {
      if (name === "message") onKernelMessage = listener;
    },
  } as unknown as Pick<Window, "addEventListener">);
  let connectionCount = 0;
  const source = {
    postMessage(message: unknown) {
      if (
        typeof message === "object" &&
        message !== null &&
        (message as { type?: unknown }).type === "neutron:msgbus:connect"
      ) {
        connectionCount += 1;
      }
    },
  } as unknown as Window;
  const unregister = registerFrameContext(
    source,
    {
      role: "tray",
      appId: "calls",
      instanceId: "opaque",
    },
    { origin: "null" },
  );
  const ready = () =>
    onKernelMessage({
      data: MSG_BUS_FRAME_READY,
      origin: "null",
      source,
    } as unknown as MessageEvent);

  // Tile and tray surfaces historically connect from their parent-observed
  // load as well as from the SDK ready signal. Keep both event orderings
  // working for already-installed opaque apps.
  expect(markFrameEndpointLoaded(source)).toBe("preserved");
  expect(connectionCount).toBe(1);
  expect(isFrameEndpointReady(source)).toBe(true);
  const endpoint = getRegisteredEndpoint(
    "app:calls:tray:instance:opaque",
  );
  const firstPort = endpoint?.port;
  const firstSessionId = endpoint?.sessionId;

  // READY from the loading replacement document can arrive before its load.
  // The old port must not make that document permanently miss its transfer.
  ready();
  expect(connectionCount).toBe(1);
  expect(endpoint?.port).toBe(firstPort);
  expect(markFrameEndpointLoaded(source)).toBe("preserved");
  expect(connectionCount).toBe(2);
  expect(endpoint?.port).not.toBe(firstPort);
  expect(endpoint?.sessionId).not.toBe(firstSessionId);
  ready();
  expect(connectionCount).toBe(2);
  unregister();
});

test("legacy opaque background reload waits for the new document's readiness", () => {
  let onKernelMessage: (event: Event) => void = () => undefined;
  installFrameEndpointHandshake({
    addEventListener(name: string, listener: EventListener) {
      if (name === "message") onKernelMessage = listener;
    },
  } as unknown as Pick<Window, "addEventListener">);
  let connectionCount = 0;
  let probeCount = 0;
  const source = {
    postMessage(message: unknown) {
      if (message === MSG_BUS_FRAME_PROBE) {
        probeCount += 1;
      } else if (
        typeof message === "object" &&
        message !== null &&
        (message as { type?: unknown }).type === "neutron:msgbus:connect"
      ) {
        connectionCount += 1;
      }
    },
  } as unknown as Window;
  const unregister = registerFrameContext(
    source,
    { role: "background", appId: "opaque-load-first" },
    { origin: "null" },
  );
  const ready = () =>
    onKernelMessage({
      data: MSG_BUS_FRAME_READY,
      origin: "null",
      source,
    } as unknown as MessageEvent);

  expect(markFrameEndpointLoaded(source)).toBe("retired");
  expect(connectionCount).toBe(0);
  ready();
  expect(connectionCount).toBe(1);
  expect(isFrameEndpointReady(source)).toBe(true);
  const endpoint = getRegisteredEndpoint(
    "app:opaque-load-first:background",
  );
  const firstPort = endpoint?.port;
  const firstSessionId = endpoint?.sessionId;
  const probesBeforeReload = probeCount;

  // A pre-load READY sees the still-live old session. The subsequent load
  // retires it, probes the new document, and remains gated until that document
  // answers READY.
  ready();
  expect(endpoint?.port).toBe(firstPort);
  expect(markFrameEndpointLoaded(source)).toBe("retired");
  expect(endpoint?.port).toBeUndefined();
  expect(connectionCount).toBe(1);
  expect(probeCount).toBeGreaterThan(probesBeforeReload);
  ready();
  expect(connectionCount).toBe(2);
  expect(endpoint?.port).not.toBe(firstPort);
  expect(endpoint?.sessionId).not.toBe(firstSessionId);

  unregister();
});

test("a retained legacy opaque tile reconnects after re-registration", () => {
  let connectionCount = 0;
  const source = {
    postMessage(message: unknown) {
      if (
        typeof message === "object" &&
        message !== null &&
        (message as { type?: unknown }).type === "neutron:msgbus:connect"
      ) {
        connectionCount += 1;
      }
    },
  } as unknown as Window;
  const context = {
    role: "tile" as const,
    appId: "calls-retained-compat",
    tileId: "call",
    instanceId: "retained",
    workspace: 1,
  };
  const unregisterFirst = registerFrameContext(
    source,
    context,
    { origin: "null" },
  );
  expect(markFrameEndpointLoaded(source)).toBe("preserved");
  const firstEndpoint = getRegisteredEndpoint(
    "app:calls-retained-compat:tile:call:instance:retained",
  );
  expect(firstEndpoint?.port).toBeDefined();
  unregisterFirst();
  expect(firstEndpoint?.port).toBeUndefined();

  const unregisterSecond = registerFrameContext(source, context, {
    origin: "null",
  });
  expect(markFrameEndpointLoaded(source)).toBe("preserved");
  expect(connectionCount).toBe(2);
  expect(isFrameEndpointReady(source)).toBe(true);
  const secondEndpoint = getRegisteredEndpoint(
    "app:calls-retained-compat:tile:call:instance:retained",
  );
  const retainedPort = secondEndpoint?.port;
  // Re-registration must not forget that a later load replaces the Document.
  expect(markFrameEndpointLoaded(source)).toBe("preserved");
  expect(connectionCount).toBe(3);
  expect(secondEndpoint?.port).not.toBe(retainedPort);

  unregisterSecond();
});

test("exact-origin initial load can precede SDK readiness", () => {
  let onKernelMessage: (event: Event) => void = () => undefined;
  installFrameEndpointHandshake({
    addEventListener(name: string, listener: EventListener) {
      if (name === "message") onKernelMessage = listener;
    },
  } as unknown as Pick<Window, "addEventListener">);
  const origin = "https://i-load-first.example";
  const posted: Array<{ message: unknown; targetOrigin: string }> = [];
  const source = {
    postMessage(message: unknown, targetOrigin: string) {
      posted.push({ message, targetOrigin });
    },
  } as unknown as Window;
  const unregister = registerFrameContext(
    source,
    {
      role: "tile",
      appId: "originful-load-first",
      tileId: "call",
      instanceId: "one",
      workspace: 1,
    },
    { origin },
  );

  expect(markFrameEndpointLoaded(source)).toBe("retired");
  expect(isFrameEndpointReady(source)).toBe(false);
  onKernelMessage({
    data: MSG_BUS_FRAME_READY,
    origin,
    source,
  } as unknown as MessageEvent);
  expect(isFrameEndpointReady(source)).toBe(true);
  expect(posted.at(-1)).toMatchObject({ targetOrigin: origin });
  expect(
    (posted.at(-1)?.message as { type?: unknown } | undefined)?.type,
  ).toBe("neutron:msgbus:connect");
  expect(posted.every(({ targetOrigin }) => targetOrigin === origin)).toBe(true);
  unregister();
});

test("replacement and unregister detach before notifying reconnect listeners", () => {
  const context = {
    role: "tile" as const,
    appId: "calls",
    tileId: "call",
    instanceId: "detached",
    workspace: 1,
  };
  let firstConnections = 0;
  let secondConnections = 0;
  const firstSource = {
    postMessage(message: unknown) {
      if (
        typeof message === "object" &&
        message !== null &&
        (message as { type?: unknown }).type === "neutron:msgbus:connect"
      ) {
        firstConnections += 1;
      }
    },
  } as unknown as Window;
  const secondSource = {
    postMessage(message: unknown) {
      if (
        typeof message === "object" &&
        message !== null &&
        (message as { type?: unknown }).type === "neutron:msgbus:connect"
      ) {
        secondConnections += 1;
      }
    },
  } as unknown as Window;
  const unregisterFirst = registerFrameContext(firstSource, context, {
    origin: "https://icalls.example",
  });
  expect(connectFrameEndpoint(firstSource, true)).toBe(true);
  const firstEndpoint = getRegisteredEndpoint(
    "app:calls:tile:call:instance:detached",
  );
  if (!firstEndpoint) throw new Error("First endpoint did not register");
  let reconnectSource = firstSource;
  const unsubscribe = subscribeEndpointChanges(() => {
    connectFrameEndpoint(reconnectSource, true);
  });

  const unregisterSecond = registerFrameContext(secondSource, context, {
    origin: "https://icalls.example",
  });
  expect(resolveFrameContext(firstSource)).toBeNull();
  expect(firstEndpoint.port).toBeUndefined();
  expect(firstEndpoint.sessionId).toBeUndefined();
  expect(firstConnections).toBe(1);

  expect(connectFrameEndpoint(secondSource, true)).toBe(true);
  const secondEndpoint = getRegisteredEndpoint(
    "app:calls:tile:call:instance:detached",
  );
  if (!secondEndpoint) throw new Error("Second endpoint did not register");
  reconnectSource = secondSource;
  unregisterSecond();
  expect(resolveFrameContext(secondSource)).toBeNull();
  expect(secondEndpoint.port).toBeUndefined();
  expect(secondEndpoint.sessionId).toBeUndefined();
  expect(secondConnections).toBe(1);

  unsubscribe();
  unregisterFirst();
});

test("frame readiness requires the exact source and a current private port", () => {
  const firstSource = {
    postMessage() {},
  } as unknown as Window;
  const secondSource = {
    postMessage() {},
  } as unknown as Window;
  let authorityCurrent = true;
  const context = { role: "background" as const, appId: "files" };
  const unregisterFirst = registerFrameContext(firstSource, context, {
    isAuthorityCurrent: () => authorityCurrent,
  });

  expect(isFrameEndpointReady(firstSource)).toBe(false);
  expect(connectFrameEndpoint(firstSource, true)).toBe(true);
  expect(isFrameEndpointReady(firstSource)).toBe(true);
  authorityCurrent = false;
  expect(isFrameEndpointReady(firstSource)).toBe(false);
  authorityCurrent = true;

  const unregisterSecond = registerFrameContext(secondSource, context);
  expect(isFrameEndpointReady(firstSource)).toBe(false);
  expect(isFrameEndpointReady(secondSource)).toBe(false);
  expect(connectFrameEndpoint(secondSource, true)).toBe(true);
  expect(isFrameEndpointReady(secondSource)).toBe(true);

  unregisterFirst();
  unregisterSecond();
});

test("kernel waits for a loading frame's private message port", async () => {
  const source = {
    postMessage() {},
  } as unknown as Window;
  const unregister = registerFrameContext(
    source,
    { role: "background", appId: "files" },
    { origin: "null" },
  );
  const endpoint = getRegisteredEndpoint("app:files:background");
  if (!endpoint) throw new Error("Files endpoint did not register");

  const pending = waitForFrameEndpointPort(endpoint, 1);
  expect(connectFrameEndpoint(source, true)).toBe(true);
  await expect(pending).resolves.toBe(endpoint.port!);
  unregister();
});

test("frame readiness and registration form a lossless handshake", async () => {
  let onKernelMessage: (event: Event) => void = () => undefined;
  const kernelWindow = {
    addEventListener(name: string, listener: EventListener) {
      if (name === "message") onKernelMessage = listener;
    },
  } as unknown as Pick<Window, "addEventListener">;
  installFrameEndpointHandshake(kernelWindow);
  let connectionCount = 0;
  const source = {
    postMessage(message: unknown) {
      if (message === MSG_BUS_FRAME_PROBE) {
        queueMicrotask(() =>
          onKernelMessage({
            data: MSG_BUS_FRAME_READY,
            origin: "null",
            source,
          } as unknown as MessageEvent),
        );
      } else if (
        typeof message === "object" &&
        message !== null &&
        (message as { type?: unknown }).type === "neutron:msgbus:connect"
      ) {
        connectionCount += 1;
      }
    },
  } as unknown as Window;

  // A ready event that beats registration is harmless: registration probes
  // the now-ready document and receives a fresh response.
  onKernelMessage({
    data: MSG_BUS_FRAME_READY,
    origin: "null",
    source,
  } as unknown as MessageEvent);
  const unregister = registerFrameContext(
    source,
    { role: "background", appId: "files" },
    { origin: "null" },
  );
  await Promise.resolve();
  expect(markFrameEndpointLoaded(source)).toBe("preserved");

  expect(getRegisteredEndpoint("app:files:background")?.port).toBeDefined();
  expect(connectionCount).toBe(1);
  onKernelMessage({
    data: MSG_BUS_FRAME_READY,
    origin: "null",
    source,
  } as unknown as MessageEvent);
  expect(connectionCount).toBe(1);
  unregister();
});

test("a tile-origin ready handshake cannot claim a background context", () => {
  let onKernelMessage: (event: Event) => void = () => undefined;
  installFrameEndpointHandshake({
    addEventListener(name: string, listener: EventListener) {
      if (name === "message") onKernelMessage = listener;
    },
  } as unknown as Pick<Window, "addEventListener">);
  const tileOrigin = "https://itile--4caro.icp0.io";
  const backgroundOrigin = "https://ibackground--4caro.icp0.io";
  const tileSource = { postMessage() {} } as unknown as Window;
  const backgroundSource = { postMessage() {} } as unknown as Window;
  const unregisterTile = registerFrameContext(
    tileSource,
    {
      role: "tile",
      appId: "calls",
      tileId: "call",
      instanceId: "one",
      workspace: 1,
    },
    { origin: tileOrigin },
  );
  const unregisterBackground = registerFrameContext(
    backgroundSource,
    { role: "background", appId: "calls" },
    { origin: backgroundOrigin },
  );

  onKernelMessage({
    data: MSG_BUS_FRAME_READY,
    origin: backgroundOrigin,
    source: tileSource,
  } as unknown as MessageEvent);
  expect(getRegisteredEndpoint("app:calls:background")?.port).toBeUndefined();
  expect(
    getRegisteredEndpoint("app:calls:tile:call:instance:one")?.port,
  ).toBeUndefined();

  onKernelMessage({
    data: MSG_BUS_FRAME_READY,
    origin: tileOrigin,
    source: tileSource,
  } as unknown as MessageEvent);
  expect(markFrameEndpointLoaded(tileSource)).toBe("preserved");
  expect(resolveFrameContext(tileSource)?.role).toBe("tile");
  expect(
    getRegisteredEndpoint("app:calls:tile:call:instance:one")?.port,
  ).toBeDefined();
  expect(getRegisteredEndpoint("app:calls:background")?.port).toBeUndefined();
  unregisterTile();
  unregisterBackground();
});

test("kernel stops waiting when a loading frame is replaced", async () => {
  const first = {} as Window;
  const context = { role: "background" as const, appId: "files" };
  const unregisterFirst = registerFrameContext(first, context, {
  });
  const endpoint = getRegisteredEndpoint("app:files:background");
  if (!endpoint) throw new Error("Files endpoint did not register");

  const pending = waitForFrameEndpointPort(endpoint, 1);
  const unregisterSecond = registerFrameContext({} as Window, context, {
  });
  await expect(pending).rejects.toThrow("was replaced before connecting");
  unregisterFirst();
  unregisterSecond();
});

test("kernel targets real-origin background handshakes exactly", () => {
  const posted: Array<{ targetOrigin: string }> = [];
  const source = {
    postMessage(_message: unknown, targetOrigin: string) {
      posted.push({ targetOrigin });
    },
  } as unknown as Window;
  const origin =
    "http://agemmaa--4caro-hl777-77775-aaaba-cai.localhost:8000";
  const unregister = registerFrameContext(
    source,
    { role: "background", appId: "gemma" },
    { origin }
  );

  expect(connectFrameEndpoint(source, true)).toBe(true);
  expect(posted).toEqual([
    { targetOrigin: origin },
    { targetOrigin: origin },
  ]);
  unregister();
});

test("kernel ignores a dedicated frame's initial same-origin document", () => {
  const posted: unknown[] = [];
  const source = {
    location: { origin: "http://4caro.localhost:8000" },
    postMessage(message: unknown) {
      posted.push(message);
    },
  } as unknown as Window;
  const unregister = registerFrameContext(
    source,
    { role: "background", appId: "agent" },
    { origin: "http://aopenrouter-agenta--4caro.localhost:8000" },
  );

  expect(connectFrameEndpoint(source, true)).toBe(false);
  expect(posted).toEqual([]);
  expect(
    getRegisteredEndpoint("app:agent:background")?.port,
  ).toBeUndefined();
  unregister();
});

test("kernel does not probe a resident before dedicated-origin navigation", () => {
  let onKernelMessage: (event: Event) => void = () => undefined;
  installFrameEndpointHandshake({
    addEventListener(name: string, listener: EventListener) {
      if (name === "message") onKernelMessage = listener;
    },
  } as unknown as Pick<Window, "addEventListener">);
  const posted: Array<{ message: unknown; targetOrigin: string }> = [];
  const origin =
    "http://p0123456789abcdef01234567--4caro.localhost:8000";
  let navigated = false;
  const source = {
    location: {
      get origin() {
        if (navigated) throw new DOMException("Cross-origin frame");
        return "http://4caro.localhost:8000";
      },
    },
    postMessage(message: unknown, targetOrigin: string) {
      posted.push({ message, targetOrigin });
    },
  } as unknown as Window;
  const unregister = registerFrameContext(
    source,
    { role: "background", appId: "wagyu" },
    {
      origin,
      residentSecurityBinding: {
        mode: ResidentFrameSecurityMode.PERSISTENT_DEDICATED_V1,
        browserOriginNonce: "0123456789abcdef0123456789abcdef",
        browserOriginAuthorityEpoch: "1",
      },
    },
  );

  expect(posted).toEqual([]);
  navigated = true;
  onKernelMessage({
    data: MSG_BUS_FRAME_READY,
    origin,
    source,
  } as unknown as MessageEvent);
  expect(markFrameEndpointLoaded(source)).toBe("preserved");
  expect(posted).toHaveLength(1);
  expect(posted[0]!.targetOrigin).toBe(origin);
  expect(
    (posted[0]!.message as { type?: unknown }).type,
  ).toBe("neutron:msgbus:connect");
  unregister();
});

test("resident endpoint ports are bound to current mode, nonce, and epoch", () => {
  let onKernelMessage: (event: Event) => void = () => undefined;
  installFrameEndpointHandshake({
    addEventListener(name: string, listener: EventListener) {
      if (name === "message") onKernelMessage = listener;
    },
  } as unknown as Pick<Window, "addEventListener">);
  const posted: Array<{ transfer: Transferable[] }> = [];
  const origin =
    "http://p0123456789abcdef01234567--4caro.localhost:8000";
  const source = {
    postMessage(
      _message: unknown,
      _targetOrigin: string,
      transfer: Transferable[] = [],
    ) {
      posted.push({ transfer });
    },
  } as unknown as Window;
  let current = true;
  const binding = {
    mode:
      ResidentFrameSecurityMode.CREDENTIALLESS_EPHEMERAL_DEDICATED_V1,
    browserOriginNonce: "0123456789abcdef0123456789abcdef",
    browserOriginAuthorityEpoch: "7",
  } as const;
  const unregister = registerFrameContext(
    source,
    { role: "background", appId: "files" },
    {
      origin,
      residentSecurityBinding: binding,
      isAuthorityCurrent: () => current,
    },
  );

  expect(getRegisteredEndpoint("app:files:background")).toMatchObject({
    origin,
  });
  expect(connectFrameEndpoint(source)).toBe(false);
  expect(isFrameEndpointReady(source)).toBe(false);
  onKernelMessage({
    data: MSG_BUS_FRAME_READY,
    origin: "https://wrong.example",
    source,
  } as unknown as MessageEvent);
  expect(isFrameEndpointReady(source)).toBe(false);
  expect(
    getRegisteredEndpoint("app:files:background")?.sessionId,
  ).toBeUndefined();
  onKernelMessage({
    data: MSG_BUS_FRAME_READY,
    origin,
    source,
  } as unknown as MessageEvent);
  expect(markFrameEndpointLoaded(source)).toBe("preserved");
  expect(posted.at(-1)?.transfer).toHaveLength(1);
  expect(
    getRegisteredEndpoint("app:files:background")?.sessionId,
  ).toBeDefined();
  expect(isFrameEndpointReady(source)).toBe(true);

  current = false;
  expect(isFrameEndpointReady(source)).toBe(false);
  onKernelMessage({
    data: MSG_BUS_FRAME_READY,
    origin,
    source,
  } as unknown as MessageEvent);
  expect(getRegisteredEndpoint("app:files:background")?.port).toBeUndefined();
  expect(
    getRegisteredEndpoint("app:files:background")?.sessionId,
  ).toBeUndefined();
  unregister();
});

test("resident endpoint binding rejects the wrong surface and origin class", () => {
  const binding = {
    mode: ResidentFrameSecurityMode.PERSISTENT_DEDICATED_V1,
    browserOriginNonce: "0123456789abcdef0123456789abcdef",
    browserOriginAuthorityEpoch: "1",
  } as const;
  expect(() =>
    registerFrameContext(
      {} as Window,
      {
        role: "tile",
        appId: "files",
        tileId: "main",
        instanceId: "one",
        workspace: 1,
      },
      { origin: "https://app.example", residentSecurityBinding: binding },
    ),
  ).toThrow("only a background endpoint");
  expect(() =>
    registerFrameContext(
      {} as Window,
      { role: "background", appId: "files" },
      { origin: "null", residentSecurityBinding: binding },
    ),
  ).toThrow("does not match its security binding");
});

test("frame context ignores null and unknown sources", () => {
  const unregister = registerFrameContext(null, {
    role: "tile",
    appId: "hello",
    tileId: "main",
    instanceId: "one",
    workspace: 1,
  });

  unregister();
  expect(resolveFrameContext(null)).toBeNull();
  expect(resolveFrameContext({} as Window)).toBeNull();
});
