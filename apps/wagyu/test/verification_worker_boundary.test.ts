import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  createWagyuVerificationWorkerClient,
  installWagyuVerificationWorkerBootstrap,
  WagyuVerificationWorkerHostV1,
  WAGYU_VERIFICATION_WORKER_PROTOCOL,
  type WagyuWorkerBootstrapScopeV1,
  type WagyuVerificationEngineLikeV1,
  type WagyuWorkerHostScopeV1,
  type WagyuWorkerLikeV1,
  type WagyuWorkerResultV1,
  type WagyuWorkerTaskV1,
} from "../src/worker/index.ts";

const NETWORK_HEX = "11".repeat(32);

describe("Wagyu verification Worker boundary", () => {
  test("executes tasks across a real message boundary and preserves invalid versus unavailable", async () => {
    const boundary = loopbackBoundary(fakeEngine());
    const client = createWagyuVerificationWorkerClient({
      trusted: {
        rootKey: Uint8Array.of(1, 2, 3),
        networkId: new Uint8Array(32).fill(0x11),
        gatewayOrigin: "https://icp0.io",
      },
      worker: boundary.worker,
      defaultTimeoutMs: 1_000,
    });

    expect(await client.ready).toEqual({
      state: "verified",
      value: { networkId: NETWORK_HEX },
    });
    expect(
      await client.verifyProfile({ nodeId: "invalid-profile-node" }),
    ).toMatchObject({
      state: "invalid",
      code: "fixture_invalid",
    });
    expect(
      await client.verifyProfile({ nodeId: "unavailable-profile-node" }),
    ).toMatchObject({
      state: "unavailable",
      code: "fixture_unavailable",
    });

    client.close();
    boundary.host.close();
  });

  test("cancellation and deadlines stop a hung Worker task with explicit unavailable states", async () => {
    const boundary = loopbackBoundary(fakeEngine());
    const client = createWagyuVerificationWorkerClient({
      trusted: {
        rootKey: Uint8Array.of(1),
        networkId: new Uint8Array(32).fill(0x11),
        gatewayOrigin: "https://icp0.io",
      },
      worker: boundary.worker,
      defaultTimeoutMs: 1_000,
    });
    await client.ready;

    const controller = new AbortController();
    const cancelled = client.verifyProfile(
      { nodeId: "hung-profile-node" },
      { signal: controller.signal },
    );
    controller.abort();
    expect(await cancelled).toMatchObject({
      state: "unavailable",
      code: "worker_cancelled",
    });

    expect(
      await client.verifyProfile(
        { nodeId: "hung-profile-node" },
        { timeoutMs: 5 },
      ),
    ).toMatchObject({
      state: "unavailable",
      code: "worker_timeout",
    });

    const slotControllers = Array.from(
      { length: 32 },
      () => new AbortController(),
    );
    const saturated = slotControllers.map((slotController, index) =>
      client.verifyProfile(
        { nodeId: `hung-profile-node-${index}` },
        { signal: slotController.signal },
      )
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      await client.verifyProfile({ nodeId: "ordinary-profile-node" }),
    ).toMatchObject({
      state: "unavailable",
      code: "worker_busy",
    });

    slotControllers[0]!.abort();
    await saturated[0];
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      await client.verifyProfile({ nodeId: "ordinary-profile-node" }),
    ).toMatchObject({ state: "verified" });

    for (const controller of slotControllers.slice(1)) controller.abort();
    await Promise.all(saturated.slice(1));

    client.close();
    boundary.host.close();
  });

  test("accepts one private MessagePort and never processes trust on the global Worker channel", async () => {
    const listeners = new Set<(event: MessageEvent<unknown>) => void>();
    const scope: WagyuWorkerBootstrapScopeV1 = {
      addEventListener(_type, listener) {
        listeners.add(listener);
      },
      removeEventListener(_type, listener) {
        listeners.delete(listener);
      },
    };
    const bootstrap = installWagyuVerificationWorkerBootstrap(
      scope,
      async () => fakeEngine(),
    );

    emitBootstrapMessage(listeners, {
      data: {
        protocol: WAGYU_VERIFICATION_WORKER_PROTOCOL,
        type: "init",
        requestId: "global-init",
        trusted: {},
      },
      ports: [],
    });
    expect(listeners.size).toBe(1);

    const channel = new MessageChannel();
    const channelId = "ab".repeat(32);
    const connected = nextPortMessage(channel.port1);
    emitBootstrapMessage(listeners, {
      data: {
        protocol: WAGYU_VERIFICATION_WORKER_PROTOCOL,
        type: "connect",
        channelId,
      },
      ports: [channel.port2],
    });
    expect(await connected).toEqual({
      protocol: WAGYU_VERIFICATION_WORKER_PROTOCOL,
      type: "connected",
      channelId,
    });
    expect(listeners.size).toBe(0);

    const initialized = nextPortMessage(channel.port1);
    channel.port1.postMessage({
      protocol: WAGYU_VERIFICATION_WORKER_PROTOCOL,
      type: "init",
      requestId: "private-init",
      trusted: {
        rootKey: Uint8Array.of(1),
        networkId: new Uint8Array(32).fill(0x11),
        gatewayOrigin: "https://icp0.io",
      },
    });
    expect(await initialized).toEqual({
      protocol: WAGYU_VERIFICATION_WORKER_PROTOCOL,
      type: "response",
      requestId: "private-init",
      result: {
        state: "verified",
        value: { networkId: NETWORK_HEX },
      },
    });

    bootstrap.close();
    channel.port1.close();
  });
});

test("the packaged Worker is URL-independent and gets a closed resident CSP", async () => {
  const [
    build,
    bootstrap,
    client,
    entry,
    runtime,
    trust,
    verifierBytes,
    service,
    html,
  ] =
    await Promise.all([
    readFile(new URL("../build.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/worker/bootstrap.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/worker/client.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/worker/entry.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/worker/runtime.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/worker/trust.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/verifier/bytes.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/service.ts", import.meta.url), "utf8"),
    readFile(new URL("../public/service.html", import.meta.url), "utf8"),
  ]);
  expect(build).toContain('entryPoints: ["./src/worker/entry.ts"]');
  expect(build).toContain("wagyu-packaged-verification-worker");
  expect(build).toContain('const packagedWorkerPolicy = "worker-src blob:;"');
  expect(bootstrap).toContain("new Blob([sourceBytes]");
  expect(bootstrap).toContain("URL.createObjectURL(workerBlob)");
  expect(bootstrap).toContain("new MessageChannel()");
  expect(bootstrap).toContain("type: \"connect\"");
  expect(bootstrap).not.toContain('new Worker("data:');
  expect(client).not.toContain("new Worker(");
  expect(client).not.toContain("workerUrl");
  expect(entry).toContain("installWagyuVerificationWorkerBootstrap");
  expect(runtime).toContain("event.ports.length !== 1");
  expect(html).toContain("worker-src 'self';");
  expect(html).toContain(
    "connect-src 'self' https://*.icp0.io http://localhost:* http://*.localhost:*;",
  );
  expect(html).not.toContain("worker-src 'self' blob:");
  expect(service).toContain('"persistent-background"');
  expect(runtime).toContain("createMemoryVerificationStore()");
  expect(runtime).toContain(
    'trusted.storageMode === "persistent-background"',
  );
  expect(trust).toContain(
    "const packageAssetOrigin = new URL(globalThis.location.href).origin",
  );
  expect(trust).toContain("localAgentHost: packageAssetOrigin");
  expect(trust).toContain(
    'storageMode: config.target === "pocketic" ? "memory" : storageMode',
  );
  expect(runtime).toContain("requireLocalAgentHost(trusted.localAgentHost)");
  expect(trust).toContain("host: agentHost");
  expect(verifierBytes).toContain(
    'import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js"',
  );
  expect(verifierBytes).not.toContain("crypto.subtle");
});

function emitBootstrapMessage(
  listeners: ReadonlySet<(event: MessageEvent<unknown>) => void>,
  event: Pick<MessageEvent<unknown>, "data" | "ports">,
): void {
  for (const listener of listeners) {
    listener(event as MessageEvent<unknown>);
  }
}

function nextPortMessage(port: MessagePort): Promise<unknown> {
  return new Promise((resolve) => {
    const listener = (event: MessageEvent<unknown>) => {
      port.removeEventListener("message", listener);
      resolve(event.data);
    };
    port.addEventListener("message", listener);
    port.start();
  });
}

function fakeEngine(): WagyuVerificationEngineLikeV1 {
  return {
    trustedNetworkIdHex: NETWORK_HEX,
    async execute(
      task: WagyuWorkerTaskV1,
      _signal: AbortSignal,
    ): Promise<WagyuWorkerResultV1<unknown>> {
      if (task.kind !== "profile") {
        return {
          state: "invalid",
          code: "fixture_wrong_kind",
          reason: "Fixture accepts profile tasks only",
        };
      }
      if (task.nodeId.startsWith("invalid")) {
        return {
          state: "invalid",
          code: "fixture_invalid",
          reason: "Invalid fixture evidence",
        };
      }
      if (task.nodeId.startsWith("unavailable")) {
        return {
          state: "unavailable",
          code: "fixture_unavailable",
          reason: "Fixture transport unavailable",
        };
      }
      if (task.nodeId.startsWith("hung")) {
        return new Promise(() => undefined);
      }
      return {
        state: "verified",
        value: { nodeId: task.nodeId },
      };
    },
  };
}

function loopbackBoundary(engine: WagyuVerificationEngineLikeV1): {
  readonly worker: WagyuWorkerLikeV1;
  readonly host: WagyuVerificationWorkerHostV1;
} {
  const clientListeners = new Set<(event: MessageEvent<unknown>) => void>();
  const hostListeners = new Set<(event: MessageEvent<unknown>) => void>();
  const scope: WagyuWorkerHostScopeV1 = {
    postMessage(message) {
      const cloned = structuredClone(message);
      queueMicrotask(() => {
        for (const listener of clientListeners) {
          listener({ data: cloned } as MessageEvent<unknown>);
        }
      });
    },
    addEventListener(_type, listener) {
      hostListeners.add(listener);
    },
    removeEventListener(_type, listener) {
      hostListeners.delete(listener);
    },
  };
  const host = new WagyuVerificationWorkerHostV1(
    scope,
    async () => engine,
  );
  const worker: WagyuWorkerLikeV1 = {
    postMessage(message) {
      const cloned = structuredClone(message);
      queueMicrotask(() => {
        for (const listener of hostListeners) {
          listener({ data: cloned } as MessageEvent<unknown>);
        }
      });
    },
    addEventListener(_type, listener) {
      clientListeners.add(listener);
    },
    removeEventListener(_type, listener) {
      clientListeners.delete(listener);
    },
    terminate() {
      host.close();
    },
  };
  return { worker, host };
}
