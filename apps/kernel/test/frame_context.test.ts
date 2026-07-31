import { expect, test } from "bun:test";
import {
  connectFrameEndpoint,
  getRegisteredEndpoint,
  installFrameEndpointHandshake,
  isFrameEndpointReady,
  listRegisteredEndpoints,
  registerFrameContext,
  resolveFrameContext,
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

test("kernel connects a registered frame with a private message port", () => {
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
    { origin: "null" }
  );

  expect(connectFrameEndpoint(source)).toBe(true);
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
  expect(connectFrameEndpoint(firstSource)).toBe(true);
  expect(isFrameEndpointReady(firstSource)).toBe(true);
  authorityCurrent = false;
  expect(isFrameEndpointReady(firstSource)).toBe(false);
  authorityCurrent = true;

  const unregisterSecond = registerFrameContext(secondSource, context);
  expect(isFrameEndpointReady(firstSource)).toBe(false);
  expect(isFrameEndpointReady(secondSource)).toBe(false);
  expect(connectFrameEndpoint(secondSource)).toBe(true);
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
  expect(connectFrameEndpoint(source)).toBe(true);
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

  expect(connectFrameEndpoint(source)).toBe(true);
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
    residentSecurityBinding: binding,
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
