// This file is launched by update_service.test.ts in a separate Bun process.
// Bun module mocks are process-global and cannot be restored safely.
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import type {
  AppRegistry,
  CompileResult,
  PreparedPackageInstall,
} from "neutron-compiler/src/install.js";
import { hashContent } from "neutron-tools/src/hash.js";
import {
  NEUTRON_REPOSITORY_PROTOCOL,
  type RepositoryReleaseRecord,
} from "neutron-tools/repository";
import type { PackagedNeutronManifest } from "neutron-tools/src/schema.js";
import { createStore } from "zustand/vanilla";
import { registryApp } from "./app_registry_fixture.ts";

const SOURCE = "rrkah-fqaaa-aaaaa-aaaaq-cai";
const SECOND_SOURCE = "ryjl3-tyaaa-aaaaa-aaaba-cai";

type FakeAppsState = {
  operationBusy: boolean;
  list: AppRegistry;
};

type UpdateSnapshot = {
  apps: AppRegistry;
  provenance: {
    format: 1;
    apps: Record<string, { package_digest: string }>;
  };
  deploymentId: string;
};

type Session = {
  baseline: {
    state: { apps: AppRegistry };
    runtime: { deployment_id: string };
  };
  compile(packages: readonly PreparedPackageInstall[]): Promise<CompileResult>;
  deploy(input: {
    packages: readonly PreparedPackageInstall[];
    compiled: CompileResult;
    provenance: Readonly<Record<string, unknown>>;
  }): Promise<AppRegistry>;
  cancel(): void;
};

const appsStore = createStore<FakeAppsState>(() => ({
  operationBusy: false,
  list: {},
}));

const useAppsStore = Object.assign(
  (selector: (state: FakeAppsState) => unknown) => selector(appsStore.getState()),
  {
    getState: appsStore.getState,
    subscribe: appsStore.subscribe,
  },
);

let getSnapshotImpl: () => Promise<UpdateSnapshot>;
let beginSessionImpl: () => Promise<Session>;
let fetchReleaseImpl: (
  source: string,
  appId: string,
  options: { signal?: AbortSignal },
) => Promise<
  | {
      source: string;
      record: RepositoryReleaseRecord;
      releaseDigest: string;
    }
  | null
>;
let fetchPackageImpl: (
  source: string,
  release: RepositoryReleaseRecord,
  options: { signal?: AbortSignal },
) => Promise<Uint8Array>;
let getDetailsImpl: (
  actor: unknown,
  bytes: Uint8Array,
  options: unknown,
) => Promise<unknown>;

mock.module(
  new URL("../src/reducer/apps.ts", import.meta.url).pathname,
  () => ({
    beginPackageInstallSession: () => beginSessionImpl(),
    getAppUpdateSnapshot: () => getSnapshotImpl(),
    useAppsStore,
  }),
);

mock.module(new URL("../src/updates/client.ts", import.meta.url).pathname, () => ({
  fetchUpdatePackage: (
    source: string,
    release: RepositoryReleaseRecord,
    options: { signal?: AbortSignal },
  ) => fetchPackageImpl(source, release, options),
  fetchUpdateRelease: (
    source: string,
    appId: string,
    options: { signal?: AbortSignal },
  ) => fetchReleaseImpl(source, appId, options),
}));

mock.module(new URL("../src/tools/app.ts", import.meta.url).pathname, () => ({
  get_app_details: (actor: unknown, bytes: Uint8Array, options: unknown) =>
    getDetailsImpl(actor, bytes, options),
}));

const [{
  applyPreparedUpdates,
  cancelUpdateWork,
  checkAppUpdates,
  clearUpdateResults,
  prepareAllAvailableUpdates,
  prepareAppUpdate,
  prepareSelectedUpdates,
  retryFailedUpdateChecks,
}, { updateCheckState, useUpdateCheckStore }] = await Promise.all([
  import("../src/updates/service.ts"),
  import("../src/updates/store.ts"),
]);

describe("update service orchestration", () => {
  beforeEach(() => {
    clearUpdateResults();
    appsStore.setState({ operationBusy: false, list: {} });
    getSnapshotImpl = async () => snapshot(appsStore.getState().list);
    beginSessionImpl = async () => {
      throw new Error("Unexpected package-install session");
    };
    fetchReleaseImpl = async () => {
      throw new Error("Unexpected release request");
    };
    fetchPackageImpl = async () => {
      throw new Error("Unexpected package request");
    };
    getDetailsImpl = async () => {
      throw new Error("Unexpected package preparation");
    };
  });

  afterEach(() => {
    clearUpdateResults();
  });

  test("a newer check aborts and cannot be overwritten by an older generation", async () => {
    const registry = appRegistry({ mail: { source: SOURCE, version: 100 } });
    appsStore.setState({ list: registry });
    const first = deferred<ReturnType<typeof fetchedRelease>>();
    const firstStarted = deferred<void>();
    let firstSignal: AbortSignal | undefined;
    let requests = 0;
    fetchReleaseImpl = async (source, appId, { signal }) => {
      requests += 1;
      if (requests === 1) {
        firstSignal = signal;
        firstStarted.resolve();
        return first.promise;
      }
      return fetchedRelease(source, release(appId, 102, packageBytes(appId)));
    };

    const olderCheck = checkAppUpdates();
    await firstStarted.promise;
    const newerCheck = checkAppUpdates();
    await newerCheck;

    expect(firstSignal?.aborted).toBe(true);
    expect(useUpdateCheckStore.getState()).toMatchObject({
      phase: "ready",
      results: [
        expect.objectContaining({
          appId: "mail",
          kind: "available",
          release: expect.objectContaining({ version: 102 }),
        }),
      ],
    });

    first.resolve(
      fetchedRelease(SOURCE, release("mail", 101, packageBytes("old_mail"))),
    );
    await olderCheck;
    expect(useUpdateCheckStore.getState().results[0]).toMatchObject({
      kind: "available",
      release: expect.objectContaining({ version: 102 }),
    });
  });

  test("a registry change during a check aborts stale work with a check-stage error", async () => {
    const registry = appRegistry({ mail: { source: SOURCE, version: 100 } });
    appsStore.setState({ list: registry });
    const started = deferred<void>();
    fetchReleaseImpl = (_source, _appId, { signal }) =>
      new Promise((_, reject) => {
        started.resolve();
        signal?.addEventListener("abort", () => reject(abortError()), {
          once: true,
        });
      });

    const check = checkAppUpdates();
    await started.promise;
    appsStore.setState({
      list: appRegistry({ mail: { source: SOURCE, version: 101 } }),
    });
    await check;

    expect(useUpdateCheckStore.getState()).toMatchObject({
      phase: "error",
      errorStage: "check",
      error: expect.stringContaining("Installed apps changed while checking"),
    });
  });

  test("cancellation cannot be overwritten by a late check resolution", async () => {
    const registry = appRegistry({ mail: { source: SOURCE, version: 100 } });
    appsStore.setState({ list: registry });
    const pending = deferred<ReturnType<typeof fetchedRelease>>();
    const started = deferred<void>();
    let signal: AbortSignal | undefined;
    fetchReleaseImpl = async (_source, _appId, options) => {
      signal = options.signal;
      started.resolve();
      return pending.promise;
    };

    const check = checkAppUpdates();
    await started.promise;
    cancelUpdateWork();

    expect(signal?.aborted).toBe(true);
    const cancelledState = useUpdateCheckStore.getState();
    expect(cancelledState).toMatchObject({
      phase: "ready",
      results: [
        expect.objectContaining({ appId: "mail", kind: "cancelled" }),
      ],
    });

    pending.resolve(
      fetchedRelease(SOURCE, release("mail", 101, packageBytes("mail"))),
    );
    await check;

    expect(useUpdateCheckStore.getState()).toBe(cancelledState);
  });

  test("retry requests only failed apps and preserves successful results", async () => {
    const registry = appRegistry({
      contacts: { source: SECOND_SOURCE, version: 100 },
      mail: { source: SOURCE, version: 100 },
    });
    appsStore.setState({ list: registry });
    const mail = candidate("mail", "Mail", SOURCE, packageBytes("mail"));
    updateCheckState.ready(
      [
        {
          kind: "failed",
          appId: "contacts",
          name: "Contacts",
          installed: 100,
          source: SECOND_SOURCE,
          reason: "unavailable",
        },
        mail,
      ],
      1_700_000_000_000,
    );
    const requested: string[] = [];
    fetchReleaseImpl = async (source, appId) => {
      requested.push(appId);
      expect(source).toBe(SECOND_SOURCE);
      return fetchedRelease(
        source,
        release(appId, 101, packageBytes(appId)),
      );
    };

    await retryFailedUpdateChecks();

    expect(requested).toEqual(["contacts"]);
    expect(useUpdateCheckStore.getState()).toMatchObject({
      phase: "ready",
      results: [
        expect.objectContaining({ appId: "contacts", kind: "available" }),
        mail,
      ],
      selectedAppIds: ["contacts", "mail"],
    });
  });

  test("all available releases compile and deploy once with exact provenance", async () => {
    const registry = appRegistry({
      contacts: { source: SECOND_SOURCE, version: 100 },
      mail: { source: SOURCE, version: 100 },
    });
    appsStore.setState({ list: registry });
    const bytesById = new Map([
      ["contacts", packageBytes("contacts")],
      ["mail", packageBytes("mail")],
    ]);
    const releases = [
      candidate(
        "contacts",
        "Contacts",
        SECOND_SOURCE,
        bytesById.get("contacts")!,
      ),
      candidate("mail", "Mail", SOURCE, bytesById.get("mail")!),
    ] as const;
    updateCheckState.ready(releases, 1_700_000_000_000);
    updateCheckState.selection(["mail"]);

    const preparedById = new Map(
      releases.map((candidate) => [
        candidate.appId,
        preparedPackage(candidate.appId, candidate.name, 101, candidate.source),
      ]),
    );
    const identityExpectations: unknown[] = [];
    getDetailsImpl = async (_actor, bytes, options) => {
      identityExpectations.push(options);
      const id = new TextDecoder().decode(bytes);
      const preparedPackage = preparedById.get(id);
      if (!preparedPackage) throw new Error(`Unknown package bytes for ${id}`);
      return { neutronConfig: preparedPackage.manifest, preparedPackage };
    };
    fetchReleaseImpl = async (source, appId) => {
      const match = releases.find((candidate) => candidate.appId === appId)!;
      expect(source).toBe(match.source);
      return fetchedRelease(source, match.release, match.releaseDigest);
    };
    fetchPackageImpl = async (_source, published) => bytesById.get(published.id)!;

    const compiled = compiledResult();
    const compileBatches: string[][] = [];
    const deploys: Array<Parameters<Session["deploy"]>[0]> = [];
    let cancelled = 0;
    beginSessionImpl = async () => ({
      baseline: {
        state: { apps: registry },
        runtime: { deployment_id: "deployment_before" },
      },
      async compile(packages) {
        compileBatches.push(packages.map(({ manifest }) => manifest.id));
        return compiled;
      },
      async deploy(input) {
        deploys.push(input);
        return registry;
      },
      cancel() {
        cancelled += 1;
      },
    });

    await prepareAllAvailableUpdates();
    expect(useUpdateCheckStore.getState()).toMatchObject({
      phase: "review",
      review: {
        apps: [
          expect.objectContaining({ appId: "contacts", targetVersion: 101 }),
          expect.objectContaining({ appId: "mail", targetVersion: 101 }),
        ],
      },
    });
    expect(compileBatches).toEqual([["contacts", "mail"]]);
    expect(identityExpectations).toHaveLength(2);
    for (const expectation of identityExpectations) {
      expect(expectation).toMatchObject({
        expectedIdentity: expect.objectContaining({ version: 101 }),
      });
    }

    await applyPreparedUpdates();
    expect(deploys).toHaveLength(1);
    expect(deploys[0]!.packages.map(({ manifest }) => manifest.id)).toEqual([
      "contacts",
      "mail",
    ]);
    expect(deploys[0]!.compiled).toBe(compiled);
    expect(deploys[0]!.provenance).toEqual({
      contacts: {
        kind: "update_source",
        source_canister: SECOND_SOURCE,
        release_digest: releases[0].releaseDigest,
        package_digest: releases[0].release.sha256,
        checked_at: 1_700_000_000_000,
      },
      mail: {
        kind: "update_source",
        source_canister: SOURCE,
        release_digest: releases[1].releaseDigest,
        package_digest: releases[1].release.sha256,
        checked_at: 1_700_000_000_000,
      },
    });
    expect(cancelled).toBe(0);
    expect(useUpdateCheckStore.getState()).toMatchObject({
      phase: "success",
      selectedAppIds: [],
      updatedAppCount: 2,
    });
  });

  test("a row update prepares only that available app", async () => {
    const registry = appRegistry({
      contacts: { source: SECOND_SOURCE, version: 100 },
      mail: { source: SOURCE, version: 100 },
    });
    appsStore.setState({ list: registry });
    updateCheckState.ready(
      [
        candidate(
          "contacts",
          "Contacts",
          SECOND_SOURCE,
          packageBytes("contacts"),
        ),
        candidate("mail", "Mail", SOURCE, packageBytes("mail")),
      ],
      1_700_000_000_000,
    );
    expect(useUpdateCheckStore.getState().selectedAppIds).toEqual([
      "contacts",
      "mail",
    ]);

    let selectionAtPrepare: readonly string[] = [];
    beginSessionImpl = async () => {
      selectionAtPrepare = useUpdateCheckStore.getState().selectedAppIds;
      throw new Error("Stop after observing the prepared selection");
    };

    await prepareAppUpdate("mail");

    expect(selectionAtPrepare).toEqual(["mail"]);
    expect(useUpdateCheckStore.getState()).toMatchObject({
      phase: "error",
      selectedAppIds: ["mail"],
      errorStage: "prepare",
    });
  });

  test("source changes and removals commit only through the exact atomic target batch", async () => {
    const registry = appRegistry({
      contacts: { source: SECOND_SOURCE, version: 100 },
      mail: { source: SOURCE, version: 100 },
    });
    appsStore.setState({ list: registry });
    const bytesById = new Map([
      ["contacts", packageBytes("contacts")],
      ["mail", packageBytes("mail")],
    ]);
    const releases = [
      candidate(
        "contacts",
        "Contacts",
        SECOND_SOURCE,
        bytesById.get("contacts")!,
      ),
      candidate("mail", "Mail", SOURCE, bytesById.get("mail")!),
    ] as const;
    updateCheckState.ready(releases, 1_700_000_000_000);

    const targets = new Map([
      ["contacts", preparedPackage("contacts", "Contacts", 101, SOURCE)],
      ["mail", preparedPackage("mail", "Mail", 101, undefined)],
    ]);
    fetchReleaseImpl = async (source, appId) => {
      const checked = releases.find(({ appId: id }) => id === appId)!;
      expect(source).toBe(checked.source);
      return fetchedRelease(source, checked.release, checked.releaseDigest);
    };
    fetchPackageImpl = async (_source, published) => bytesById.get(published.id)!;
    getDetailsImpl = async (_actor, bytes) => {
      const id = new TextDecoder().decode(bytes);
      const preparedPackage = targets.get(id);
      if (!preparedPackage) throw new Error(`Unknown package bytes for ${id}`);
      return { neutronConfig: preparedPackage.manifest, preparedPackage };
    };

    const compileBatches: PreparedPackageInstall[][] = [];
    const deploys: Array<Parameters<Session["deploy"]>[0]> = [];
    beginSessionImpl = async () => ({
      baseline: {
        state: { apps: registry },
        runtime: { deployment_id: "deployment_before" },
      },
      async compile(packages) {
        compileBatches.push([...packages]);
        return compiledResult();
      },
      async deploy(input) {
        deploys.push(input);
        return registry;
      },
      cancel() {},
    });

    await prepareSelectedUpdates();

    expect(deploys).toHaveLength(0);
    expect(compileBatches).toHaveLength(1);
    expect(
      compileBatches[0]!.map(({ manifest }) => ({
        id: manifest.id,
        updateSource: manifest.update_source,
      })),
    ).toEqual([
      { id: "contacts", updateSource: SOURCE },
      { id: "mail", updateSource: undefined },
    ]);
    expect(useUpdateCheckStore.getState()).toMatchObject({
      phase: "review",
      review: {
        apps: [
          {
            appId: "contacts",
            currentUpdateSource: SECOND_SOURCE,
            targetUpdateSource: SOURCE,
          },
          {
            appId: "mail",
            currentUpdateSource: SOURCE,
          },
        ],
      },
    });
    expect(
      useUpdateCheckStore.getState().review!.apps[1],
    ).not.toHaveProperty("targetUpdateSource");

    await applyPreparedUpdates();

    expect(deploys).toHaveLength(1);
    expect(deploys[0]!.packages).toEqual(compileBatches[0]!);
    expect(
      deploys[0]!.packages.map(({ manifest }) => ({
        id: manifest.id,
        updateSource: manifest.update_source,
      })),
    ).toEqual([
      { id: "contacts", updateSource: SOURCE },
      { id: "mail", updateSource: undefined },
    ]);
    expect(deploys[0]!.provenance).toMatchObject({
      contacts: { source_canister: SECOND_SOURCE },
      mail: { source_canister: SOURCE },
    });
  });

  test("a baseline mutation after review invalidates the whole prepared batch", async () => {
    const registry = appRegistry({
      contacts: { source: SECOND_SOURCE, version: 100 },
      mail: { source: SOURCE, version: 100 },
    });
    appsStore.setState({ list: registry });
    const releases = [
      candidate("contacts", "Contacts", SECOND_SOURCE, packageBytes("contacts")),
      candidate("mail", "Mail", SOURCE, packageBytes("mail")),
    ] as const;
    updateCheckState.ready(releases, 1_700_000_000_000);
    fetchReleaseImpl = async (source, appId) => {
      const match = releases.find((candidate) => candidate.appId === appId)!;
      return fetchedRelease(source, match.release, match.releaseDigest);
    };
    fetchPackageImpl = async (_source, published) => packageBytes(published.id);
    getDetailsImpl = async (_actor, bytes) => {
      const id = new TextDecoder().decode(bytes);
      const match = releases.find((candidate) => candidate.appId === id)!;
      const prepared = preparedPackage(id, match.name, 101, match.source);
      return { neutronConfig: prepared.manifest, preparedPackage: prepared };
    };
    let committed = 0;
    let cancelled = 0;
    beginSessionImpl = async () => ({
      baseline: {
        state: { apps: registry },
        runtime: { deployment_id: "deployment_before" },
      },
      async compile() {
        return compiledResult();
      },
      async deploy() {
        // The real package session performs this checked baseline re-read before
        // its first staging write. Model that boundary here so the updater's
        // apply/error contract is exercised independently of compiler IO.
        expect(appsStore.getState().list).not.toBe(registry);
        throw new Error(
          "Installed app state changed in another tab. Reload this setup before installing.",
        );
      },
      cancel() {
        cancelled += 1;
      },
    });

    await prepareSelectedUpdates();
    expect(useUpdateCheckStore.getState().phase).toBe("review");
    appsStore.setState({
      list: appRegistry({
        contacts: { source: SECOND_SOURCE, version: 101 },
        mail: { source: SOURCE, version: 100 },
      }),
    });
    await applyPreparedUpdates();

    expect({ committed, cancelled }).toEqual({ committed: 0, cancelled: 0 });
    expect(useUpdateCheckStore.getState()).toMatchObject({
      phase: "error",
      errorStage: "apply",
      error: expect.stringContaining("Installed app state changed"),
    });
  });

  test("a preparation failure cancels the session and is never reported as apply failure", async () => {
    const registry = appRegistry({ mail: { source: SOURCE, version: 100 } });
    appsStore.setState({ list: registry });
    const available = candidate(
      "mail",
      "Mail",
      SOURCE,
      packageBytes("mail"),
    );
    updateCheckState.ready([available], 1_700_000_000_000);
    fetchReleaseImpl = async () =>
      fetchedRelease(SOURCE, available.release, available.releaseDigest);
    fetchPackageImpl = async () => {
      throw new Error("Package download failed before compilation");
    };
    let compiled = 0;
    let deployed = 0;
    let cancelled = 0;
    beginSessionImpl = async () => ({
      baseline: {
        state: { apps: registry },
        runtime: { deployment_id: "deployment_before" },
      },
      async compile() {
        compiled += 1;
        return compiledResult();
      },
      async deploy() {
        deployed += 1;
        return registry;
      },
      cancel() {
        cancelled += 1;
      },
    });

    await prepareSelectedUpdates();

    expect({ compiled, deployed, cancelled }).toEqual({
      compiled: 0,
      deployed: 0,
      cancelled: 1,
    });
    expect(useUpdateCheckStore.getState()).toMatchObject({
      phase: "error",
      errorStage: "prepare",
      error: "Package download failed before compilation",
      results: [expect.objectContaining({ appId: "mail", kind: "available" })],
    });
  });

  test("a release changed after checking aborts before package preparation", async () => {
    const registry = appRegistry({ mail: { source: SOURCE, version: 100 } });
    appsStore.setState({ list: registry });
    const available = candidate(
      "mail",
      "Mail",
      SOURCE,
      packageBytes("mail_v101"),
    );
    updateCheckState.ready([available], 1_700_000_000_000);
    fetchReleaseImpl = async () =>
      fetchedRelease(
        SOURCE,
        release("mail", 102, packageBytes("mail_v102")),
      );
    let downloaded = 0;
    let prepared = 0;
    let compiled = 0;
    let deployed = 0;
    let cancelled = 0;
    fetchPackageImpl = async () => {
      downloaded += 1;
      return packageBytes("mail_v102");
    };
    getDetailsImpl = async () => {
      prepared += 1;
      throw new Error("Package preparation must not start");
    };
    beginSessionImpl = async () => ({
      baseline: {
        state: { apps: registry },
        runtime: { deployment_id: "deployment_before" },
      },
      async compile() {
        compiled += 1;
        return compiledResult();
      },
      async deploy() {
        deployed += 1;
        return registry;
      },
      cancel() {
        cancelled += 1;
      },
    });

    await prepareSelectedUpdates();

    expect({ downloaded, prepared, compiled, deployed, cancelled }).toEqual({
      downloaded: 0,
      prepared: 0,
      compiled: 0,
      deployed: 0,
      cancelled: 1,
    });
    expect(useUpdateCheckStore.getState()).toMatchObject({
      phase: "error",
      errorStage: "prepare",
      error: "Mail's published release changed. Refresh Settings before updating.",
      results: [expect.objectContaining({ appId: "mail", kind: "available" })],
    });
  });

  test("one invalid package aborts a two-app batch without silently shrinking it", async () => {
    const registry = appRegistry({
      contacts: { source: SECOND_SOURCE, version: 100 },
      mail: { source: SOURCE, version: 100 },
    });
    appsStore.setState({ list: registry });
    const bytesById = new Map([
      ["contacts", packageBytes("contacts")],
      ["mail", packageBytes("mail")],
    ]);
    const releases = [
      candidate("contacts", "Contacts", SECOND_SOURCE, bytesById.get("contacts")!),
      candidate("mail", "Mail", SOURCE, bytesById.get("mail")!),
    ] as const;
    updateCheckState.ready(releases, 1_700_000_000_000);
    fetchReleaseImpl = async (source, appId) => {
      const match = releases.find((candidate) => candidate.appId === appId)!;
      expect(source).toBe(match.source);
      return fetchedRelease(source, match.release, match.releaseDigest);
    };
    const downloaded: string[] = [];
    fetchPackageImpl = async (_source, published) => {
      downloaded.push(published.id);
      return bytesById.get(published.id)!;
    };
    getDetailsImpl = async (_actor, bytes) => {
      const id = new TextDecoder().decode(bytes);
      if (id === "mail") throw new Error("Mail package manifest is invalid");
      const prepared = preparedPackage(
        "contacts",
        "Contacts",
        101,
        SECOND_SOURCE,
      );
      return { neutronConfig: prepared.manifest, preparedPackage: prepared };
    };
    let compiled = 0;
    let deployed = 0;
    let cancelled = 0;
    beginSessionImpl = async () => ({
      baseline: {
        state: { apps: registry },
        runtime: { deployment_id: "deployment_before" },
      },
      async compile() {
        compiled += 1;
        return compiledResult();
      },
      async deploy() {
        deployed += 1;
        return registry;
      },
      cancel() {
        cancelled += 1;
      },
    });

    await prepareSelectedUpdates();

    expect(downloaded).toEqual(["contacts", "mail"]);
    expect({ compiled, deployed, cancelled }).toEqual({
      compiled: 0,
      deployed: 0,
      cancelled: 1,
    });
    expect(useUpdateCheckStore.getState()).toMatchObject({
      phase: "error",
      errorStage: "prepare",
      error: "Mail package manifest is invalid",
      selectedAppIds: ["contacts", "mail"],
      results: [
        expect.objectContaining({ appId: "contacts", kind: "available" }),
        expect.objectContaining({ appId: "mail", kind: "available" }),
      ],
      review: null,
    });
  });
});

function snapshot(apps: AppRegistry): UpdateSnapshot {
  return {
    apps,
    provenance: { format: 1, apps: {} },
    deploymentId: "deployment_before",
  };
}

function appRegistry(
  apps: Readonly<Record<string, { source: string; version: number }>>,
): AppRegistry {
  return Object.fromEntries(
    Object.entries(apps).map(([id, { source, version }]) => [
      id,
      registryApp({
        id,
        name: id === "mail" ? "Mail" : "Contacts",
        version,
        update_source: source,
      }),
    ]),
  );
}

function packageBytes(id: string): Uint8Array {
  return new TextEncoder().encode(id);
}

function release(
  id: string,
  version: number,
  bytes: Uint8Array,
): RepositoryReleaseRecord {
  return {
    protocol: NEUTRON_REPOSITORY_PROTOCOL,
    id,
    version,
    sha256: hashContent(bytes),
    size: bytes.byteLength,
  };
}

function fetchedRelease(
  source: string,
  record: RepositoryReleaseRecord,
  releaseDigest = hashContent(JSON.stringify(record)),
) {
  return { source, record, releaseDigest };
}

function candidate(
  appId: string,
  name: string,
  source: string,
  bytes: Uint8Array,
) {
  const published = release(appId, 101, bytes);
  return {
    kind: "available" as const,
    appId,
    name,
    installed: 100,
    source,
    release: published,
    releaseDigest: hashContent(JSON.stringify(published)),
  };
}

function preparedPackage(
  id: string,
  name: string,
  version: number,
  source: string | undefined,
): PreparedPackageInstall {
  const manifest = {
    format: 3,
    id,
    name,
    version,
    entry: hashContent(`${id}:${version}`),
    ...(source ? { update_source: source } : {}),
  } satisfies PackagedNeutronManifest;
  const entry = registryApp({
    id,
    name,
    version,
    ...(source ? { update_source: source } : {}),
  });
  return {
    manifest,
    capabilityPlan: entry.capability_plan,
    capabilityPlanFingerprint: entry.capability_plan_fingerprint,
    files: [],
    appPrefix: `/app/${id}/`,
    isKernel: false,
  };
}

function compiledResult(): CompileResult {
  return {
    wasm: new Uint8Array(1_025),
    candid: "service : {}",
    stable: "",
    diagnostics: [],
    compatibilityDiagnostics: [],
    danger: {},
    dependencyPlan: { apps: {}, order: [] },
    migrationPlan: {
      upgrades: [],
      removedApps: [],
      destructiveMemoryRoots: [],
    },
    managedMemoryRetirements: [],
    capabilityPlans: {},
    appInstanceInventory: [],
    managedMemoryInventory: [],
    deploymentId: "deployment_after",
    compilerId: "moc_test",
    modulePaths: [],
  } as unknown as CompileResult;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve, reject };
}

function abortError(): Error {
  const error = new Error("Update check cancelled");
  error.name = "AbortError";
  return error;
}
