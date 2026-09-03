// This file is launched by auth_dynamic_actor.test.ts in a separate Bun
// process. Bun module mocks are process-global and cannot be restored safely.
import { beforeEach, expect, mock, test } from "bun:test";
import type { Identity } from "@dfinity/agent";

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

const principal = {
  toText: () => "2vxsx-fae",
};
const identity = {
  getPrincipal: () => principal,
};
const ownerPrincipal = {
  toText: () => "aaaaa-aa",
};
const ownerIdentity = {
  getPrincipal: () => ownerPrincipal,
} as unknown as Identity;
const nextOwnerIdentity = {
  getPrincipal: () => ({ toText: () => "rrkah-fqaaa-aaaaa-aaaaq-cai" }),
} as unknown as Identity;
const bootstrapActor = {
  kernel_check_authorized: async () => true,
};
mock.module("@dfinity/agent", () => ({
  Actor: {
    createActor: () => bootstrapActor,
  },
  HttpAgent: {
    create: async () => ({
      fetchRootKey: async () => undefined,
    }),
  },
}));

const actorLoads: Deferred<object>[] = [];
let actorLoadCount = 0;
let assetFetchCount = 0;
let clientFactoryCount = 0;
const clientFactoryOptions: Record<string, unknown>[] = [];
const externalClientCalls: Array<{
  options: Record<string, unknown>;
  preset: unknown;
}> = [];
let externalOwnerMethodCalls = 0;
const fetchReceivers: unknown[] = [];
const fetchInputs: string[] = [];
const fetchBodies: Array<BodyInit | null | undefined> = [];
const fetchSignals: Array<AbortSignal | null | undefined> = [];
let blockedNativeFetch: Deferred<Response> | null = null;
const EXTERNAL_CANISTER = "rrkah-fqaaa-aaaaa-aaaaq-cai";
const firstExternalIdlFactory = () => ({ _fields: [] });
const secondExternalIdlFactory = () => ({ _fields: [] });
let externalIdlFactory = firstExternalIdlFactory;

const createIcblast = (options: Record<string, unknown> = {}) => {
  clientFactoryCount += 1;
  clientFactoryOptions.push(options);
  let cachedActor: object | null = null;
  return async (canister: string, preset?: unknown): Promise<object> => {
    if (cachedActor) return cachedActor;
    if (canister === EXTERNAL_CANISTER) {
      externalClientCalls.push({ options, preset });
      const ownerFactory =
        typeof preset === "function"
          ? preset
          : options.allowNumberedPrincipals === true
            ? externalIdlFactory
            : null;
      cachedActor = ownerFactory
        ? {
            $idlFactory: ownerFactory,
            probe: async () => {
              externalOwnerMethodCalls += 1;
              return ownerFactory === firstExternalIdlFactory
                ? "owner reply 1"
                : "owner reply 2";
            },
          }
        : { $idlFactory: externalIdlFactory };
      return cachedActor;
    }
    expect(preset).toBe("service : {};");
    actorLoadCount += 1;
    const next = actorLoads.shift();
    if (!next) throw new Error("Missing dynamic actor result");
    cachedActor = await next.promise;
    return cachedActor;
  };
};
const InternetIdentity = {
  create: () => Promise.resolve(),
  isAuthenticated: async () => false,
  getPrincipal: () => principal,
  getIdentity: () => identity,
  login: async () => undefined,
  logout: async () => undefined,
};

mock.module("icblast", () => ({
  default: createIcblast,
  InternetIdentity,
}));

Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    location: { href: "https://kra4t-fiaaa-aaaai-ax2ea-cai.icp0.io/" },
    sessionStorage: {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    },
  },
});
globalThis.fetch = async function (
  this: unknown,
  input: RequestInfo | URL,
  init?: RequestInit,
) {
  fetchReceivers.push(this);
  fetchInputs.push(String(input));
  fetchBodies.push(init?.body);
  fetchSignals.push(init?.signal);
  assetFetchCount += 1;
  if (String(input).includes("/hang")) {
    if (!blockedNativeFetch) {
      throw new Error("Missing blocked native fetch result");
    }
    const signal = init?.signal;
    if (!signal) return blockedNativeFetch.promise;
    if (signal.aborted) throw signal.reason;
    return new Promise<Response>((resolve, reject) => {
      let settled = false;
      const finish = (complete: () => void): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        complete();
      };
      const abort = (): void => finish(() => reject(signal.reason));
      signal.addEventListener("abort", abort, { once: true });
      blockedNativeFetch!.promise.then(
        (response) => finish(() => resolve(response)),
        (error) => finish(() => reject(error)),
      );
      if (signal.aborted) abort();
    });
  }
  return {
    ok: true,
    status: 200,
    text: async () => "service : {};",
  } as Response;
} as unknown as typeof fetch;

const { loadRuntimeDeployment } = await import("../src/runtime_deployment.ts");
await loadRuntimeDeployment(
  (async () =>
    new Response(
      JSON.stringify({
        format: 2,
        target: "ic",
        gateway: "https://icp-api.io",
        identity_provider: "https://id.ai",
        canister_id: "kra4t-fiaaa-aaaai-ax2ea-cai",
        deployment_id: "01".repeat(16),
        root_key_policy: "mainnet",
        allow_loopback_http: false,
        isolated_frame_origin_template:
          "https://{prefix}--kra4t-fiaaa-aaaai-ax2ea-cai.icp0.io",
        update_source_origin: null,
      }),
      {
        headers: {
          "content-type": "application/json",
          "ic-certificate":
            "certificate=:AA==:, tree=:AA==:, expr_path=:AA==:, version=2",
          "ic-certificateexpression":
            "default_certification(ValidationArgs{certification: Certification{}})",
        },
      },
    )) as unknown as typeof fetch,
  window.location.href,
);

const {
  activateIdentity,
  getLegacyExternalDynamicCan,
  getNeutronDynamicCan,
  getStrictExternalDiscoveryCan,
  getStrictExternalDynamicCan,
  resetNeutronCan,
} = await import("../src/reducer/auth.ts");

async function waitForActorLoads(count: number): Promise<void> {
  for (let attempt = 0; attempt < 20 && actorLoadCount < count; attempt += 1) {
    await Promise.resolve();
  }
  expect(actorLoadCount).toBe(count);
}

beforeEach(() => {
  resetNeutronCan();
  actorLoads.length = 0;
  actorLoadCount = 0;
  assetFetchCount = 0;
  clientFactoryCount = 0;
  clientFactoryOptions.length = 0;
  externalClientCalls.length = 0;
  externalOwnerMethodCalls = 0;
  externalIdlFactory = firstExternalIdlFactory;
  fetchReceivers.length = 0;
  fetchInputs.length = 0;
  fetchBodies.length = 0;
  fetchSignals.length = 0;
  blockedNativeFetch = null;
});

test("concurrent dynamic actor requests share Candid fetch and compilation", async () => {
  const load = deferred<object>();
  const actor = { app_method: () => "ok" };
  actorLoads.push(load);

  const first = getNeutronDynamicCan();
  const second = getNeutronDynamicCan();
  expect(second).toBe(first);
  await waitForActorLoads(1);
  expect(assetFetchCount).toBe(1);

  load.resolve(actor);
  expect(await first).toBe(actor);
  expect(await second).toBe(actor);
  expect(await getNeutronDynamicCan()).toBe(actor);
  expect(actorLoadCount).toBe(1);
  expect(assetFetchCount).toBe(1);
  expect(clientFactoryOptions[0]?.didcWasm).toBeString();
  expect(String(clientFactoryOptions[0]?.didcWasm)).toEndWith(
    "didc_rust_bg.bin",
  );
  expect(clientFactoryOptions[0]?.allowNumberedPrincipals).toBeUndefined();
  expect(clientFactoryOptions[0]?.maxCandidSourceBytes).toBe(
    new TextEncoder().encode("service : {};").byteLength,
  );
  expect(clientFactoryOptions[0]?.maxGeneratedJavaScriptBytes).toBe(
    Number.MAX_SAFE_INTEGER,
  );
  for (const option of [
    "maxCandidTypeItems",
    "maxCandidTypeDepth",
    "maxDecodedCandidItems",
    "maxDecodedCandidDepth",
  ]) {
    expect(clientFactoryOptions[0]?.[option]).toBe(Number.MAX_SAFE_INTEGER);
  }
});

test("a rejected dynamic actor load is cleared so the next call retries", async () => {
  const failedLoad = deferred<object>();
  actorLoads.push(failedLoad);
  const first = getNeutronDynamicCan();
  const second = getNeutronDynamicCan();
  await waitForActorLoads(1);

  failedLoad.reject(new Error("Candid compilation failed"));
  const failures = await Promise.allSettled([first, second]);
  expect(failures.map((result) => result.status)).toEqual([
    "rejected",
    "rejected",
  ]);

  const retriedLoad = deferred<object>();
  const actor = { retried: true };
  actorLoads.push(retriedLoad);
  const retry = getNeutronDynamicCan();
  await waitForActorLoads(2);
  retriedLoad.resolve(actor);
  expect(await retry).toBe(actor);
  expect(assetFetchCount).toBe(2);
});

test("reset prevents an old generation actor from entering the new cache", async () => {
  const staleLoad = deferred<object>();
  actorLoads.push(staleLoad);
  const staleRequest = getNeutronDynamicCan();
  await waitForActorLoads(1);

  resetNeutronCan();
  const currentLoad = deferred<object>();
  const currentActor = { generation: "current" };
  actorLoads.push(currentLoad);
  const currentRequest = getNeutronDynamicCan();
  await waitForActorLoads(2);

  staleLoad.resolve({ generation: "stale" });
  currentLoad.resolve(currentActor);
  expect(await currentRequest).toBe(currentActor);
  expect(await staleRequest).toBe(currentActor);
  expect(await getNeutronDynamicCan()).toBe(currentActor);
  expect(assetFetchCount).toBe(2);
  expect(actorLoadCount).toBe(2);
  expect(clientFactoryCount).toBe(2);
});

test("reset bypasses icblast's actor cache for changed live Candid", async () => {
  const firstLoad = deferred<object>();
  actorLoads.push(firstLoad);
  const firstRequest = getNeutronDynamicCan();
  await waitForActorLoads(1);
  const firstActor = { candidGeneration: 1 };
  firstLoad.resolve(firstActor);
  expect(await firstRequest).toBe(firstActor);

  resetNeutronCan();
  const secondLoad = deferred<object>();
  actorLoads.push(secondLoad);
  const secondRequest = getNeutronDynamicCan();
  await waitForActorLoads(2);
  const secondActor = { candidGeneration: 2 };
  secondLoad.resolve(secondActor);

  expect(await secondRequest).toBe(secondActor);
  expect(clientFactoryCount).toBe(2);
});

test("each external call rediscovers anonymously and owner binding uses only that preset", async () => {
  await activateIdentity(ownerIdentity, true);
  const firstTarget = await getStrictExternalDynamicCan(
    EXTERNAL_CANISTER,
    () => undefined,
  );

  expect(externalClientCalls).toHaveLength(2);
  const [discovery, ownerBinding] = externalClientCalls;
  expect(discovery?.preset).toBeUndefined();
  expect(discovery?.options.identity).toBeUndefined();
  expect(discovery?.options.allowNumberedPrincipals).toBe(false);
  for (const option of [
    "maxCandidTypeItems",
    "maxCandidTypeDepth",
    "maxDecodedCandidItems",
    "maxDecodedCandidDepth",
  ]) {
    expect(discovery?.options[option]).toBeUndefined();
  }
  expect(ownerBinding?.preset).toBe(externalIdlFactory);
  expect(ownerBinding?.options.identity).toBe(ownerIdentity);
  expect(ownerBinding?.options.allowNumberedPrincipals).toBe(false);
  for (const option of [
    "maxCandidTypeItems",
    "maxCandidTypeDepth",
    "maxDecodedCandidItems",
    "maxDecodedCandidDepth",
  ]) {
    expect(ownerBinding?.options[option]).toBeUndefined();
  }
  expect(externalOwnerMethodCalls).toBe(0);

  await expect(
    (firstTarget as { probe(): Promise<string> }).probe(),
  ).resolves.toBe("owner reply 1");
  expect(externalOwnerMethodCalls).toBe(1);

  externalIdlFactory = secondExternalIdlFactory;
  const secondTarget = await getStrictExternalDynamicCan(
    EXTERNAL_CANISTER,
    () => undefined,
  );
  expect(externalClientCalls).toHaveLength(4);
  const [secondDiscovery, secondOwnerBinding] = externalClientCalls.slice(2);
  expect(secondDiscovery?.preset).toBeUndefined();
  expect(secondDiscovery?.options.identity).toBeUndefined();
  expect(secondOwnerBinding?.preset).toBe(secondExternalIdlFactory);
  expect(secondOwnerBinding?.options.identity).toBe(ownerIdentity);
  await expect(
    (secondTarget as { probe(): Promise<string> }).probe(),
  ).resolves.toBe("owner reply 2");
  expect(externalOwnerMethodCalls).toBe(2);
});

test("legacy external requests retain owner discovery and numbered principals", async () => {
  await activateIdentity(ownerIdentity, true);
  const first = await getLegacyExternalDynamicCan(
    EXTERNAL_CANISTER,
    () => undefined,
  );
  const second = await getLegacyExternalDynamicCan(
    EXTERNAL_CANISTER,
    () => undefined,
  );

  expect(externalClientCalls).toHaveLength(2);
  for (const call of externalClientCalls) {
    expect(call.preset).toBeUndefined();
    expect(call.options.identity).toBe(ownerIdentity);
    expect(call.options.allowNumberedPrincipals).toBe(true);
    for (const option of [
      "maxCandidTypeItems",
      "maxCandidTypeDepth",
      "maxDecodedCandidItems",
      "maxDecodedCandidDepth",
    ]) {
      expect(call.options[option]).toBeUndefined();
    }
  }
  expect(second).not.toBe(first);
  await expect(
    (first as { probe(): Promise<string> }).probe(),
  ).resolves.toBe("owner reply 1");

  await activateIdentity(nextOwnerIdentity, true);
  const afterIdentityChange = await getLegacyExternalDynamicCan(
    EXTERNAL_CANISTER,
    () => undefined,
  );
  expect(externalClientCalls).toHaveLength(3);
  expect(externalClientCalls[2]?.options.identity).toBe(nextOwnerIdentity);
  expect(afterIdentityChange).not.toBe(first);
});

test("legacy requests fence their fetches independently", async () => {
  await activateIdentity(ownerIdentity, true);
  let firstCurrent = true;
  let secondCurrent = true;
  const first = await getLegacyExternalDynamicCan(EXTERNAL_CANISTER, () => {
    if (!firstCurrent) throw new Error("first authority changed");
  });
  const second = await getLegacyExternalDynamicCan(EXTERNAL_CANISTER, () => {
    if (!secondCurrent) throw new Error("second authority changed");
  });
  expect(second).not.toBe(first);

  const firstGuardedFetch = (
    externalClientCalls[0]?.options.agentOptions as
      { fetch?: typeof fetch } | undefined
  )?.fetch;
  const secondGuardedFetch = (
    externalClientCalls[1]?.options.agentOptions as
      { fetch?: typeof fetch } | undefined
  )?.fetch;
  if (!firstGuardedFetch || !secondGuardedFetch) {
    throw new Error("Missing legacy authority-checked fetch");
  }
  const fakeAgentReceiver = { kind: "HttpAgent" };
  secondCurrent = false;
  expect(() =>
    Reflect.apply(secondGuardedFetch, fakeAgentReceiver, [
      "https://icp-api.io/api/v2/status",
    ]),
  ).toThrow("second authority changed");
  await Reflect.apply(firstGuardedFetch, fakeAgentReceiver, [
    "https://icp-api.io/api/v2/status",
  ]);
  expect(fetchReceivers.at(-1)).toBe(globalThis);
  firstCurrent = false;
});

test("strict schema discovery stays anonymous and every fetch is authority gated", async () => {
  await activateIdentity(ownerIdentity, true);
  let authorityCurrent = true;
  let assertions = 0;
  await getStrictExternalDiscoveryCan(EXTERNAL_CANISTER, () => {
    assertions += 1;
    if (!authorityCurrent) throw new Error("authority changed");
  });

  const options = externalClientCalls[0]?.options;
  expect(options?.identity).toBeUndefined();
  expect(options?.allowNumberedPrincipals).toBe(false);
  const guardedFetch = (
    options?.agentOptions as { fetch?: typeof fetch } | undefined
  )?.fetch;
  expect(guardedFetch).toBeFunction();
  if (!guardedFetch) throw new Error("Missing authority-checked fetch");
  const fakeAgentReceiver = { kind: "HttpAgent" };
  const signedBody = new Uint8Array([1, 2, 3]);
  const transportController = new AbortController();
  await Reflect.apply(guardedFetch, fakeAgentReceiver, [
    "https://icp-api.io/api/v3/canister/aaaaa-aa/call",
    { body: signedBody, method: "POST", signal: transportController.signal },
  ]);
  expect(fetchReceivers.at(-1)).toBe(globalThis);
  expect(fetchInputs.at(-1)).toBe(
    "https://icp-api.io/api/v2/canister/aaaaa-aa/call",
  );
  expect(fetchBodies.at(-1)).toBe(signedBody);
  expect(fetchSignals.at(-1)).toBe(transportController.signal);
  const beforeRejectedFetch = assetFetchCount;
  authorityCurrent = false;
  expect(() =>
    Reflect.apply(guardedFetch, fakeAgentReceiver, [
      "https://icp-api.io/api/v3/canister/aaaaa-aa/call",
    ]),
  ).toThrow("authority changed");
  expect(assetFetchCount).toBe(beforeRejectedFetch);
  expect(assertions).toBe(3);
});

test("strict external fetches preserve transport cancellation and the request signal", async () => {
  await activateIdentity(ownerIdentity, true);
  const requestController = new AbortController();
  await getStrictExternalDiscoveryCan(
    EXTERNAL_CANISTER,
    () => undefined,
    requestController.signal,
  );

  const guardedFetch = (
    externalClientCalls[0]?.options.agentOptions as
      { fetch?: typeof fetch } | undefined
  )?.fetch;
  if (!guardedFetch) throw new Error("Missing strict authority-checked fetch");
  const transportController = new AbortController();
  blockedNativeFetch = deferred<Response>();
  const transportPending = Reflect.apply(guardedFetch, { kind: "HttpAgent" }, [
    "https://icp-api.io/hang",
    { signal: transportController.signal },
  ]);
  const transportNativeSignal = fetchSignals.at(-1);
  expect(transportNativeSignal).toBeInstanceOf(AbortSignal);
  expect(transportNativeSignal).not.toBe(requestController.signal);
  expect(transportNativeSignal).not.toBe(transportController.signal);

  const transportReason = new Error("transport cancelled");
  transportController.abort(transportReason);
  await expect(transportPending).rejects.toBe(transportReason);
  expect(transportNativeSignal?.aborted).toBe(true);
  expect(requestController.signal.aborted).toBe(false);

  blockedNativeFetch.resolve(new Response(null, { status: 200 }));
  blockedNativeFetch = deferred<Response>();
  const requestPending = Reflect.apply(guardedFetch, { kind: "HttpAgent" }, [
    "https://icp-api.io/hang",
  ]);
  const requestNativeSignal = fetchSignals.at(-1);
  expect(requestNativeSignal).toBe(requestController.signal);

  const reason = new Error("strict request cancelled");
  requestController.abort(reason);
  await expect(requestPending).rejects.toBe(reason);
  expect(requestNativeSignal?.aborted).toBe(true);

  blockedNativeFetch.resolve(new Response(null, { status: 200 }));
});
