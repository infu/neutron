import { describe, expect, test } from "bun:test";
import { scopedLocalIdentityProvider } from "neutron-tools/src/runtime.js";
import {
  IC_RUNTIME_GATEWAY,
  IC_RUNTIME_IDENTITY_PROVIDER,
  POCKETIC_RUNTIME_GATEWAY,
  createKernelRuntimeConfig,
  encodeKernelRuntimeConfig,
  isolatedFrameOriginTemplate,
  runtimeUpdateSourceOrigin,
} from "neutron-tools/src/runtime_config.js";
import {
  assertBlastTrustedRuntime,
  loadBlastTrustedRuntime,
} from "../src/runtime_config.ts";

const CANISTER = "ryjl3-tyaaa-aaaaa-aaaba-cai";
const DEPLOYMENT = "01".repeat(16);

describe("Blast trusted runtime", () => {
  test("loads the exact production policy from the resident origin", async () => {
    const config = createKernelRuntimeConfig({
      target: "ic",
      gateway: IC_RUNTIME_GATEWAY,
      identity_provider: IC_RUNTIME_IDENTITY_PROVIDER,
      canister_id: CANISTER,
      deployment_id: DEPLOYMENT,
      root_key_policy: "mainnet",
      allow_loopback_http: false,
      isolated_frame_origin_template: isolatedFrameOriginTemplate(
        "ic",
        CANISTER,
      ),
      update_source_origin: null,
    });
    const href = `https://i0123456789abcdef01234567--${CANISTER}.icp0.io/app/blast/service.html`;
    const expectedUrl = new URL("/system/runtime-config.json", href).href;
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetchImpl = fakeFetch(async (input, init) => {
      requests.push(init === undefined ? { input } : { input, init });
      return responseAt(expectedUrl, encodeKernelRuntimeConfig(config));
    });

    const runtime = await loadBlastTrustedRuntime({
      href,
      fetchImpl,
      loadCanisterId: async () => CANISTER,
    });

    expect(runtime.agentHost).toBe(IC_RUNTIME_GATEWAY);
    expect(runtime.local).toBe(false);
    expect(runtime.canisterId).toBe(CANISTER);
    expect(requests).toHaveLength(1);
    expect(String(requests[0]!.input)).toBe(expectedUrl);
    expect(requests[0]!.init).toMatchObject({
      cache: "no-store",
      credentials: "omit",
      method: "GET",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
  });

  test("uses the trusted PocketIC gateway for arbitrary canister traffic", async () => {
    const config = createKernelRuntimeConfig({
      target: "pocketic",
      gateway: POCKETIC_RUNTIME_GATEWAY,
      identity_provider: scopedLocalIdentityProvider({
        neutronCanisterId: CANISTER,
        localHost: POCKETIC_RUNTIME_GATEWAY,
      }),
      canister_id: CANISTER,
      deployment_id: DEPLOYMENT,
      root_key_policy: "fetch",
      allow_loopback_http: true,
      isolated_frame_origin_template: isolatedFrameOriginTemplate(
        "pocketic",
        CANISTER,
      ),
      update_source_origin: runtimeUpdateSourceOrigin("pocketic", CANISTER),
    });
    const origin = `http://i0123456789abcdef01234567--${CANISTER}.localhost:8000`;
    const href = `${origin}/app/blast/service.html`;
    const configUrl = `${origin}/system/runtime-config.json`;
    const runtime = await loadBlastTrustedRuntime({
      href,
      fetchImpl: fakeFetch(async () =>
        responseAt(configUrl, encodeKernelRuntimeConfig(config))),
      loadCanisterId: async () => CANISTER,
    });

    expect(runtime.agentHost).toBe(POCKETIC_RUNTIME_GATEWAY);
    expect(runtime.local).toBe(true);
  });

  test("rejects the unprefixed local Kernel origin", async () => {
    const config = createKernelRuntimeConfig({
      target: "pocketic",
      gateway: POCKETIC_RUNTIME_GATEWAY,
      identity_provider: scopedLocalIdentityProvider({
        neutronCanisterId: CANISTER,
        localHost: POCKETIC_RUNTIME_GATEWAY,
      }),
      canister_id: CANISTER,
      deployment_id: DEPLOYMENT,
      root_key_policy: "fetch",
      allow_loopback_http: true,
      isolated_frame_origin_template: isolatedFrameOriginTemplate(
        "pocketic",
        CANISTER,
      ),
      update_source_origin: runtimeUpdateSourceOrigin("pocketic", CANISTER),
    });
    const href = `http://${CANISTER}.localhost:8000/app/blast/service.html`;

    await expect(
      loadBlastTrustedRuntime({
        href,
        fetchImpl: fakeFetch(async () =>
          responseAt(
            new URL("/system/runtime-config.json", href).href,
            encodeKernelRuntimeConfig(config),
          )),
        loadCanisterId: async () => CANISTER,
      }),
    ).rejects.toThrow("outside the trusted deployment");
  });

  test("rejects redirect aliases, deployment mismatches, and caller host changes", async () => {
    const config = createKernelRuntimeConfig({
      target: "ic",
      gateway: IC_RUNTIME_GATEWAY,
      identity_provider: IC_RUNTIME_IDENTITY_PROVIDER,
      canister_id: CANISTER,
      deployment_id: DEPLOYMENT,
      root_key_policy: "mainnet",
      allow_loopback_http: false,
      isolated_frame_origin_template: isolatedFrameOriginTemplate("ic", CANISTER),
      update_source_origin: null,
    });
    const href = `https://i0123456789abcdef01234567--${CANISTER}.icp0.io/app/blast/service.html`;
    await expect(
      loadBlastTrustedRuntime({
        href,
        fetchImpl: fakeFetch(async () =>
          responseAt(
            "https://example.invalid/system/runtime-config.json",
            encodeKernelRuntimeConfig(config),
          )),
        loadCanisterId: async () => CANISTER,
      }),
    ).rejects.toThrow("changed origin");

    await expect(
      loadBlastTrustedRuntime({
        href,
        fetchImpl: fakeFetch(async () =>
          responseAt(
            new URL("/system/runtime-config.json", href).href,
            encodeKernelRuntimeConfig(config),
          )),
        loadCanisterId: async () => "rrkah-fqaaa-aaaaa-aaaaq-cai",
      }),
    ).rejects.toThrow("another Neutron");

    const valid = await loadBlastTrustedRuntime({
      href,
      fetchImpl: fakeFetch(async () =>
        responseAt(
          new URL("/system/runtime-config.json", href).href,
          encodeKernelRuntimeConfig(config),
        )),
      loadCanisterId: async () => CANISTER,
    });
    expect(() =>
      assertBlastTrustedRuntime({
        ...valid,
        agentHost: "https://caller.example",
      }),
    ).toThrow("network policy");
  });

  test("returns a frozen canonical snapshot independent of caller mutation", () => {
    const config = createKernelRuntimeConfig({
      target: "ic",
      gateway: IC_RUNTIME_GATEWAY,
      identity_provider: IC_RUNTIME_IDENTITY_PROVIDER,
      canister_id: CANISTER,
      deployment_id: DEPLOYMENT,
      root_key_policy: "mainnet",
      allow_loopback_http: false,
      isolated_frame_origin_template: isolatedFrameOriginTemplate(
        "ic",
        CANISTER,
      ),
      update_source_origin: null,
    });
    const pageOrigin = `https://i0123456789abcdef01234567--${CANISTER}.icp0.io`;
    const supplied = {
      config: { ...config },
      canisterId: CANISTER,
      pageOrigin,
      agentHost: IC_RUNTIME_GATEWAY,
      local: false,
    };

    const snapshot = assertBlastTrustedRuntime(supplied);
    supplied.config.gateway = "https://attacker.invalid";
    supplied.agentHost = "https://attacker.invalid";
    supplied.local = true;

    expect(snapshot).not.toBe(supplied);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.config)).toBe(true);
    expect(snapshot).toMatchObject({
      agentHost: IC_RUNTIME_GATEWAY,
      local: false,
    });
    expect(snapshot.config.gateway).toBe(IC_RUNTIME_GATEWAY);
  });

  test("bounds a stalled runtime-config fetch and aborts its request", async () => {
    const href = `https://i0123456789abcdef01234567--${CANISTER}.icp0.io/app/blast/service.html`;
    const deadline = controlledDeadline();
    let fetchSignal: AbortSignal | null = null;
    let rejectFetch!: (error: Error) => void;
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    const pending = loadBlastTrustedRuntime({
      href,
      fetchImpl: fakeFetch(async (_input, init) => {
        fetchSignal = init?.signal ?? null;
        markFetchStarted();
        return await new Promise<Response>((_resolve, reject) => {
          rejectFetch = reject;
        });
      }),
      loadCanisterId: async () => CANISTER,
      scheduleDeadline: deadline.schedule,
    });

    await fetchStarted;
    deadline.fire();
    await expect(pending).rejects.toThrow("trusted runtime startup exceeded");
    expect((fetchSignal as AbortSignal | null)?.aborted).toBe(true);
    expect(deadline.cancelled()).toBe(true);

    rejectFetch(new Error("late fetch failure"));
    await Promise.resolve();
  });

  test("bounds a stalled runtime-config body and cancels its reader", async () => {
    const config = createKernelRuntimeConfig({
      target: "ic",
      gateway: IC_RUNTIME_GATEWAY,
      identity_provider: IC_RUNTIME_IDENTITY_PROVIDER,
      canister_id: CANISTER,
      deployment_id: DEPLOYMENT,
      root_key_policy: "mainnet",
      allow_loopback_http: false,
      isolated_frame_origin_template: isolatedFrameOriginTemplate("ic", CANISTER),
      update_source_origin: null,
    });
    const href = `https://i0123456789abcdef01234567--${CANISTER}.icp0.io/app/blast/service.html`;
    const configUrl = new URL("/system/runtime-config.json", href).href;
    const deadline = controlledDeadline();
    let fetchSignal: AbortSignal | null = null;
    let cancelReason: unknown;
    let resolveRead!: (value: ReadableStreamReadResult<Uint8Array>) => void;
    let markReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    const reader = {
      cancel(reason?: unknown) {
        cancelReason = reason;
        return Promise.resolve();
      },
      read() {
        markReadStarted();
        return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => {
          resolveRead = resolve;
        });
      },
      releaseLock() {},
    };
    const response = {
      body: { getReader: () => reader },
      headers: new Headers({
        "content-length": String(encodeKernelRuntimeConfig(config).byteLength),
        "content-type": "application/json",
      }),
      ok: true,
      redirected: false,
      status: 200,
      type: "basic",
      url: configUrl,
    } as unknown as Response;
    const pending = loadBlastTrustedRuntime({
      href,
      fetchImpl: fakeFetch(async (_input, init) => {
        fetchSignal = init?.signal ?? null;
        return response;
      }),
      loadCanisterId: async () => CANISTER,
      scheduleDeadline: deadline.schedule,
    });

    await readStarted;
    deadline.fire();
    await expect(pending).rejects.toThrow("trusted runtime startup exceeded");
    expect((fetchSignal as AbortSignal | null)?.aborted).toBe(true);
    expect(cancelReason).toBeInstanceOf(Error);
    expect(deadline.cancelled()).toBe(true);

    resolveRead({ done: true, value: undefined });
    await Promise.resolve();
  });

  test("bounds a non-cooperative canister-id loader and observes its rejection", async () => {
    const config = createKernelRuntimeConfig({
      target: "ic",
      gateway: IC_RUNTIME_GATEWAY,
      identity_provider: IC_RUNTIME_IDENTITY_PROVIDER,
      canister_id: CANISTER,
      deployment_id: DEPLOYMENT,
      root_key_policy: "mainnet",
      allow_loopback_http: false,
      isolated_frame_origin_template: isolatedFrameOriginTemplate("ic", CANISTER),
      update_source_origin: null,
    });
    const href = `https://i0123456789abcdef01234567--${CANISTER}.icp0.io/app/blast/service.html`;
    const configUrl = new URL("/system/runtime-config.json", href).href;
    const deadline = controlledDeadline();
    let loaderSignal: AbortSignal | null = null;
    let rejectLoader!: (error: Error) => void;
    let markLoaderStarted!: () => void;
    const loaderStarted = new Promise<void>((resolve) => {
      markLoaderStarted = resolve;
    });
    const pending = loadBlastTrustedRuntime({
      href,
      fetchImpl: fakeFetch(async () =>
        responseAt(configUrl, encodeKernelRuntimeConfig(config))),
      loadCanisterId: async (_path, _fetcher, _currentHref, signal) => {
        loaderSignal = signal;
        markLoaderStarted();
        return await new Promise<string>((_resolve, reject) => {
          rejectLoader = reject;
        });
      },
      scheduleDeadline: deadline.schedule,
    });

    await loaderStarted;
    deadline.fire();
    await expect(pending).rejects.toThrow("trusted runtime startup exceeded");
    expect((loaderSignal as AbortSignal | null)?.aborted).toBe(true);
    expect(deadline.cancelled()).toBe(true);

    rejectLoader(new Error("late canister-id failure"));
    await Promise.resolve();
  });
});

function responseAt(url: string, bytes: Uint8Array): Response {
  const copied = new Uint8Array(bytes.byteLength);
  copied.set(bytes);
  const response = new Response(copied.buffer, {
    status: 200,
    headers: {
      "content-length": String(bytes.byteLength),
      "content-type": "application/json",
    },
  });
  Object.defineProperty(response, "url", { configurable: true, value: url });
  return response;
}

function fakeFetch(
  implementation: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>,
): typeof fetch {
  return implementation as unknown as typeof fetch;
}

function controlledDeadline(): Readonly<{
  schedule: (
    callback: () => void,
    delayMilliseconds: number,
  ) => () => void;
  fire: () => void;
  cancelled: () => boolean;
}> {
  let callback: (() => void) | undefined;
  let wasCancelled = false;
  return {
    schedule(next, delayMilliseconds) {
      expect(delayMilliseconds).toBe(10_000);
      callback = next;
      return () => {
        wasCancelled = true;
      };
    },
    fire() {
      if (!callback) throw new Error("Runtime deadline was not scheduled");
      callback();
    },
    cancelled: () => wasCancelled,
  };
}
