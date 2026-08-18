// This file is launched by repository_offer_service.test.ts in a separate Bun
// process. Bun module mocks are process-global and cannot be restored safely.
import {
  afterAll,
  afterEach,
  beforeEach,
  expect,
  mock,
  test,
} from "bun:test";
import {
  readPendingRepositorySetup,
  REPOSITORY_PENDING_STORAGE_KEY,
  stagePendingRepositorySetup,
  type RepositorySetupReference,
  type RepositoryStorage,
} from "neutron-tools/repository";
import type { AttestedInstallOfferRequester } from "../src/install_offers/types.ts";

const FIXED_NOW = 1_800_000_000_000;
const offeredReference: RepositorySetupReference = {
  repo: "rrkah-fqaaa-aaaaa-aaaaq-cai",
  manifest: "social-suite",
  digest: "a".repeat(64),
};
const racingReference: RepositorySetupReference = {
  repo: "ryjl3-tyaaa-aaaaa-aaaba-cai",
  manifest: "mail-suite",
  digest: "b".repeat(64),
};
const offeredBy: AttestedInstallOfferRequester = {
  kind: "agent",
  appId: "assistant",
  appName: "Assistant",
  rootAppId: "assistant",
  rootAppName: "Assistant",
  entrypoint: "discover_apps",
  tool: "discover_apps",
  rootId: "agent-root-17",
};

class MemoryStorage implements RepositoryStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

type RepositoryClientOptions = {
  signal?: AbortSignal;
  onProgress?(progress: {
    label: string;
    current: number;
    total: number;
  }): void;
};

type LoadCall = {
  reference: RepositorySetupReference;
  options: RepositoryClientOptions;
};

const storage = new MemoryStorage();
let beginCalls = 0;
let loadCalls: LoadCall[] = [];
let transportFetches = 0;
let loadStarted = deferred<void>();

const originalNow = Date.now;
const originalFetch = globalThis.fetch;
Date.now = () => FIXED_NOW;
globalThis.fetch = (async () => {
  transportFetches += 1;
  throw new Error("Unexpected carrier URL transport");
}) as unknown as typeof fetch;

mock.module(new URL("../src/bootstrap.ts", import.meta.url).pathname, () => ({
  kernelSetupStorage: storage,
}));

mock.module(
  new URL("../src/reducer/apps.ts", import.meta.url).pathname,
  () => ({
    beginRepositoryInstallSession: async () => {
      beginCalls += 1;
      return {
        baseline: {
          state: { apps: {}, existingConfigs: {} },
          runtime: {
            deployment_id: "deployment",
            assembler_id: "assembler",
            compiler_id: "compiler",
            apps: [],
            memories: [],
          },
        },
        compile: async () => {
          throw new Error("Unexpected compile");
        },
        deploy: async () => {
          throw new Error("Unexpected deploy");
        },
        cancel: () => undefined,
      };
    },
  }),
);

mock.module(
  new URL("../src/repository/client.ts", import.meta.url).pathname,
  () => ({
    loadRepositorySetupBytes: (
      reference: RepositorySetupReference,
      options: RepositoryClientOptions,
    ) => {
      loadCalls.push({
        reference: { ...reference },
        options,
      });
      loadStarted.resolve();
      return new Promise((_, reject) => {
        options.signal?.addEventListener(
          "abort",
          () =>
            reject(
              new DOMException(
                "Repository setup was cancelled",
                "AbortError",
              ),
            ),
          { once: true },
        );
      });
    },
  }),
);

mock.module(new URL("../src/tools/app.ts", import.meta.url).pathname, () => ({
  get_app_details: async () => {
    throw new Error("Unexpected package decoding");
  },
}));

const [
  {
    dismissRepositorySetup,
    startRepositorySetupFromOffer,
  },
  {
    repositorySetupState,
    useRepositorySetupStore,
  },
] = await Promise.all([
  import("../src/repository/service.ts"),
  import("../src/repository/store.ts"),
]);

beforeEach(async () => {
  await dismissRepositorySetup();
  storage.values.clear();
  beginCalls = 0;
  loadCalls = [];
  transportFetches = 0;
  loadStarted = deferred<void>();
});

afterEach(async () => {
  await dismissRepositorySetup();
  storage.values.clear();
  await Promise.resolve();
});

afterAll(() => {
  Date.now = originalNow;
  globalThis.fetch = originalFetch;
});

test("stages the exact trusted reference and immediately enters the existing load pipeline", async () => {
  startRepositorySetupFromOffer(offeredReference, offeredBy);
  await loadStarted.promise;

  expect(
    JSON.parse(storage.getItem(REPOSITORY_PENDING_STORAGE_KEY)!),
  ).toEqual({
    format: 1,
    captured_at_ms: FIXED_NOW,
    reference: offeredReference,
  });
  expect(readPendingRepositorySetup(storage, FIXED_NOW)).toEqual({
    reference: offeredReference,
    capturedAt: FIXED_NOW,
  });
  expect(beginCalls).toBe(1);
  expect(loadCalls).toHaveLength(1);
  expect(loadCalls[0]?.reference).toEqual(offeredReference);
  expect(loadCalls[0]?.reference).not.toBe(offeredReference);
  expect(loadCalls[0]?.options.signal).toBeInstanceOf(AbortSignal);
  expect(transportFetches).toBe(0);
  expect(useRepositorySetupStore.getState()).toMatchObject({
    phase: "loading",
    reference: offeredReference,
  });
});

test("rejects a same-tab capture race without replacing or loading it", () => {
  stagePendingRepositorySetup(storage, racingReference, FIXED_NOW - 1);
  const originalStoredValue = storage.getItem(REPOSITORY_PENDING_STORAGE_KEY);

  expect(() =>
    startRepositorySetupFromOffer(offeredReference, offeredBy),
  ).toThrow("Another repository setup was captured while this offer was open");

  expect(storage.getItem(REPOSITORY_PENDING_STORAGE_KEY)).toBe(
    originalStoredValue,
  );
  expect(readPendingRepositorySetup(storage, FIXED_NOW)).toEqual({
    reference: racingReference,
    capturedAt: FIXED_NOW - 1,
  });
  expect(beginCalls).toBe(0);
  expect(loadCalls).toEqual([]);
  expect(transportFetches).toBe(0);
  expect(useRepositorySetupStore.getState()).toMatchObject({
    phase: "idle",
    reference: null,
    offeredBy: null,
  });
});

test("retains an immutable Kernel-attested requester through final review state", async () => {
  const requester = { ...offeredBy };
  startRepositorySetupFromOffer(offeredReference, requester);
  await loadStarted.promise;

  requester.appName = "Mutated caller claim";
  expect(useRepositorySetupStore.getState().offeredBy).toEqual(offeredBy);
  expect(Object.isFrozen(useRepositorySetupStore.getState().offeredBy)).toBe(
    true,
  );

  const deploymentReview = Object.freeze({ marker: "review" }) as never;
  repositorySetupState.review(deploymentReview);
  expect(useRepositorySetupStore.getState()).toMatchObject({
    phase: "review",
    deploymentReview,
    offeredBy,
  });
});

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}
