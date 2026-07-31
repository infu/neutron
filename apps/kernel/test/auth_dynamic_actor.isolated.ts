// This file is launched by auth_dynamic_actor.test.ts in a separate Bun
// process. Bun module mocks are process-global and cannot be restored safely.
import { beforeEach, expect, mock, test } from "bun:test";

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
const actorLoads: Deferred<object>[] = [];
let actorLoadCount = 0;
let assetFetchCount = 0;

const client = async (_canister: string, candid?: string): Promise<object> => {
  expect(candid).toBe("service : {};");
  actorLoadCount += 1;
  const next = actorLoads.shift();
  if (!next) throw new Error("Missing dynamic actor result");
  return next.promise;
};

const createIcblast = () => client;
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
globalThis.fetch = (async () => {
  assetFetchCount += 1;
  return {
    ok: true,
    status: 200,
    text: async () => "service : {};",
  } as Response;
}) as unknown as typeof fetch;

const { loadRuntimeDeployment } = await import(
  "../src/runtime_deployment.ts"
);
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

const { getNeutronDynamicCan, resetNeutronCan } = await import(
  "../src/reducer/auth.ts"
);

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
});
