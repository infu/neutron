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
import { gzipSync } from "fflate";
import msgpack from "tiny-msgpack";
import {
  KERNEL_INSTALL_MAX_COPIES,
  preparePackageInstall,
  type AppRegistry,
  type CompileResult,
  type PreparePackageInstallOptions,
  type PreparedPackageInstall,
} from "neutron-compiler/src/install.js";
import {
  DEPLOYMENT_WASM_TRANSPORT_ENCODER,
  parseDeploymentBuildRecord,
  serializeDeploymentBuildRecord,
  type CompleteDeploymentBuildRecord,
} from "neutron-compiler/src/deployment_record.js";
import { hashContent } from "neutron-tools/src/hash.js";
import {
  NEUTRON_REPOSITORY_PROTOCOL,
  type RepositoryReleaseRecord,
} from "neutron-tools/repository";
import { createStore } from "zustand/vanilla";
import { registryApp } from "./app_registry_fixture.ts";
import type { PreparedBrowserDeployment } from "../src/install_review/prepare_browser_deployment.ts";

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
  getPreparedDeployment(
    packages: readonly PreparedPackageInstall[],
    compiled: CompileResult,
  ): PreparedBrowserDeployment;
  deploy(input: {
    packages: readonly PreparedPackageInstall[];
    compiled: CompileResult;
    deploymentBuildRecord: CompleteDeploymentBuildRecord;
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
  options: PreparePackageInstallOptions,
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
  get_app_details: (
    actor: unknown,
    bytes: Uint8Array,
    options: PreparePackageInstallOptions,
  ) => getDetailsImpl(actor, bytes, options),
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
      [
        "contacts",
        packageArchive("contacts", "Contacts", 101, SECOND_SOURCE),
      ],
      ["mail", packageArchive("mail", "Mail", 101, SOURCE)],
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

    const identityExpectations: unknown[] = [];
    getDetailsImpl = async (_actor, bytes, options) => {
      identityExpectations.push(options);
      return preparedPackageDetails(bytes, options);
    };
    const allReleaseRequestsStarted = deferred<void>();
    let releaseRequestsStarted = 0;
    fetchReleaseImpl = async (source, appId) => {
      releaseRequestsStarted += 1;
      if (releaseRequestsStarted === releases.length) {
        allReleaseRequestsStarted.resolve();
      }
      await allReleaseRequestsStarted.promise;
      const match = releases.find((candidate) => candidate.appId === appId)!;
      expect(source).toBe(match.source);
      return fetchedRelease(source, match.release, match.releaseDigest);
    };
    fetchPackageImpl = async (_source, published) => bytesById.get(published.id)!;

    const compiled = compiledResult();
    const compileBatches: string[][] = [];
    const deploys: Array<Parameters<Session["deploy"]>[0]> = [];
    let reviewedDeployment: PreparedBrowserDeployment | null = null;
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
      getPreparedDeployment(packages, exactCompiled) {
        reviewedDeployment = preparedDeploymentFixture(packages, exactCompiled);
        return reviewedDeployment;
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
    expect(releaseRequestsStarted).toBe(2);
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
    expect(reviewedDeployment).not.toBeNull();
    expect(
      useUpdateCheckStore.getState().review?.deploymentBuild,
    ).toBe(reviewedDeployment!.review);
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
    expect(deploys[0]!.deploymentBuildRecord).toBe(
      reviewedDeployment!.prepared.record,
    );
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

  test("Upgrade all from Kernel v0.3.5 deploys the successor plus HTTPS-source app in one batch", async () => {
    const registry = appRegistry({
      kernel: { source: SOURCE, version: 305 },
      hello: { source: SOURCE, version: 202 },
    });
    appsStore.setState({ list: registry });

    const kernelBytes = packageArchive(
      "kernel",
      "Neutron",
      308,
      SOURCE,
    );
    const hello = httpsSourcePackageArchive(
      "hello",
      "Hello",
      203,
      SOURCE,
    );
    const bytesById = new Map([
      ["kernel", kernelBytes],
      ["hello", hello.archive],
    ]);
    const releases = [
      versionedCandidate(
        "kernel",
        "Neutron",
        SOURCE,
        305,
        308,
        kernelBytes,
      ),
      versionedCandidate(
        "hello",
        "Hello",
        SOURCE,
        202,
        203,
        hello.archive,
      ),
    ] as const;
    updateCheckState.ready(releases, 1_700_000_000_000);
    // Model a user who had only one row selected. Upgrade all must replace
    // that subset with every available latest release; there is no version
    // choice and no Kernel-only preparation phase.
    updateCheckState.selection(["hello"]);

    fetchReleaseImpl = async (source, appId) => {
      const match = releases.find((candidate) => candidate.appId === appId)!;
      expect(source).toBe(match.source);
      return fetchedRelease(source, match.release, match.releaseDigest);
    };
    fetchPackageImpl = async (_source, published) =>
      bytesById.get(published.id)!;
    const preparedIds: string[] = [];
    getDetailsImpl = async (_actor, bytes, options) => {
      const details = preparedPackageDetails(bytes, options);
      preparedIds.push(details.preparedPackage.manifest.id);
      if (details.preparedPackage.manifest.id === "hello") {
        expect(details.preparedPackage.manifest).not.toHaveProperty(
          "package_features",
        );
        expect(details.preparedPackage.packageRecord).toMatchObject({
          format: 1,
          source: hello.source,
        });
        expect(details.preparedPackage.packageRecord).not.toHaveProperty(
          "features",
        );
        expect(
          details.preparedPackage.files.some(({ path }) =>
            path.includes("legal/source/app-source.v1.msgpack")
          ),
        ).toBe(false);
      }
      return details;
    };

    const compiled = compiledResult();
    const compileBatches: PreparedPackageInstall[][] = [];
    const deploys: Array<Parameters<Session["deploy"]>[0]> = [];
    const selectionsAtSessionStart: Array<readonly string[]> = [];
    let sessionStarts = 0;
    let reviewedDeployments = 0;
    beginSessionImpl = async () => {
      sessionStarts += 1;
      selectionsAtSessionStart.push([
        ...useUpdateCheckStore.getState().selectedAppIds,
      ]);
      return {
        baseline: {
          state: { apps: registry },
          runtime: { deployment_id: "deployment_before" },
        },
        async compile(packages) {
          compileBatches.push([...packages]);
          return compiled;
        },
        getPreparedDeployment(packages, exactCompiled) {
          reviewedDeployments += 1;
          return preparedDeploymentFixture(packages, exactCompiled);
        },
        async deploy(input) {
          deploys.push(input);
          return registry;
        },
        cancel() {},
      };
    };

    await prepareAllAvailableUpdates();

    expect(selectionsAtSessionStart).toEqual([["hello", "kernel"]]);
    expect(preparedIds).toEqual(["hello", "kernel"]);
    expect(sessionStarts).toBe(1);
    expect(compileBatches).toHaveLength(1);
    expect(
      compileBatches[0]!.map(({ manifest }) => [
        manifest.id,
        manifest.version,
      ]),
    ).toEqual([
      ["hello", 203],
      ["kernel", 308],
    ]);
    expect(reviewedDeployments).toBe(1);
    expect(deploys).toHaveLength(0);
    expect(useUpdateCheckStore.getState()).toMatchObject({
      phase: "review",
      selectedAppIds: ["hello", "kernel"],
      review: {
        apps: [
          expect.objectContaining({ appId: "hello", targetVersion: 203 }),
          expect.objectContaining({ appId: "kernel", targetVersion: 308 }),
        ],
      },
    });

    await applyPreparedUpdates();

    expect(sessionStarts).toBe(1);
    expect(compileBatches).toHaveLength(1);
    expect(reviewedDeployments).toBe(1);
    expect(deploys).toHaveLength(1);
    expect(deploys[0]!.packages).toEqual(compileBatches[0]!);
    expect(
      deploys[0]!.packages.map(({ manifest }) => manifest.id),
    ).toEqual(["hello", "kernel"]);
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
      ["contacts", packageArchive("contacts", "Contacts", 101, SOURCE)],
      ["mail", packageArchive("mail", "Mail", 101, undefined)],
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

    fetchReleaseImpl = async (source, appId) => {
      const checked = releases.find(({ appId: id }) => id === appId)!;
      expect(source).toBe(checked.source);
      return fetchedRelease(source, checked.release, checked.releaseDigest);
    };
    fetchPackageImpl = async (_source, published) => bytesById.get(published.id)!;
    getDetailsImpl = async (_actor, bytes, options) =>
      preparedPackageDetails(bytes, options);

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
      getPreparedDeployment,
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
    const bytesById = new Map([
      [
        "contacts",
        packageArchive("contacts", "Contacts", 101, SECOND_SOURCE),
      ],
      ["mail", packageArchive("mail", "Mail", 101, SOURCE)],
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
    fetchReleaseImpl = async (source, appId) => {
      const match = releases.find((candidate) => candidate.appId === appId)!;
      return fetchedRelease(source, match.release, match.releaseDigest);
    };
    fetchPackageImpl = async (_source, published) =>
      bytesById.get(published.id)!;
    getDetailsImpl = async (_actor, bytes, options) =>
      preparedPackageDetails(bytes, options);
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
      getPreparedDeployment,
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
      compiledSizeKiB: null,
      review: null,
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
      getPreparedDeployment,
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
      getPreparedDeployment,
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
      [
        "contacts",
        packageArchive("contacts", "Contacts", 101, SECOND_SOURCE),
      ],
      ["mail", packageArchive("mail", "Mail", 101, SOURCE)],
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
    getDetailsImpl = async (_actor, bytes, options) => {
      const details = preparedPackageDetails(bytes, options);
      if (details.preparedPackage.manifest.id === "mail") {
        throw new Error("Mail package manifest is invalid");
      }
      return details;
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
      getPreparedDeployment,
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

  test("copy preflight reserves one slot for the deployment build record", async () => {
    const registry = appRegistry({ mail: { source: SOURCE, version: 100 } });
    appsStore.setState({ list: registry });
    const bytes = packageArchive("mail", "Mail", 101, SOURCE);
    const available = candidate("mail", "Mail", SOURCE, bytes);
    updateCheckState.ready([available], 1_700_000_000_000);
    fetchReleaseImpl = async () =>
      fetchedRelease(SOURCE, available.release, available.releaseDigest);
    fetchPackageImpl = async () => bytes;
    const prepared = preparePackageInstall(bytes);
    prepared.files = Array.from(
      { length: KERNEL_INSTALL_MAX_COPIES - 4 },
      (_, index) => ({
        path: `app/mail/pkg/copy-${index}`,
        content: new Uint8Array(),
      }),
    );
    getDetailsImpl = async () => ({
      neutronConfig: prepared.manifest,
      preparedPackage: prepared,
    });
    let compiled = 0;
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
      getPreparedDeployment,
      async deploy() {
        throw new Error("Oversized copy plan must not deploy");
      },
      cancel() {
        cancelled += 1;
      },
    });

    await prepareSelectedUpdates();

    expect({ compiled, cancelled }).toEqual({ compiled: 0, cancelled: 1 });
    expect(useUpdateCheckStore.getState()).toMatchObject({
      phase: "error",
      errorStage: "prepare",
      error: expect.stringContaining(
        `require ${KERNEL_INSTALL_MAX_COPIES + 1} asset copies`,
      ),
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

function packageArchive(
  id: string,
  name: string,
  version: number,
  source: string | undefined,
): Uint8Array {
  const encoder = new TextEncoder();
  const moduleContent = encoder.encode(
    `module { public let fixtureVersion : Nat = ${version} }`,
  );
  const entry = hashContent(moduleContent);
  const files: Record<string, Uint8Array> = {
    "neutron.json": encoder.encode(
      JSON.stringify({
        format: 3,
        id,
        name,
        version,
        entry,
        ...(source ? { update_source: source } : {}),
      }),
    ),
    [`mo/${entry}.mo`]: moduleContent,
  };
  if (id === "kernel") {
    files["connection-providers.json"] = encoder.encode(
      JSON.stringify({
        schema: "neutron.connection-provider-support.v1",
        providers: [{ provider: "openrouter", scopes: [] }],
      }),
    );
  }
  return msgpack.encode(
    Object.fromEntries(
      Object.entries(files).map(([path, content]) => [
        path,
        gzipSync(content),
      ]),
    ),
  );
}

function httpsSourcePackageArchive(
  id: string,
  name: string,
  version: number,
  sourceCanister: string,
) {
  const encoder = new TextEncoder();
  const moduleContent = encoder.encode(
    `module { public let fixtureVersion : Nat = ${version} }`,
  );
  const entry = hashContent(moduleContent);
  const manifestBytes = encoder.encode(
    JSON.stringify({
      format: 3,
      id,
      name,
      version,
      entry,
      update_source: sourceCanister,
    }),
  );
  const licenseBytes = encoder.encode("NSAL update-service fixture\n");
  const applicationNoticeBytes = encoder.encode(
    "Application notice update-service fixture\n",
  );
  const thirdPartyNoticeBytes = encoder.encode(
    "Third-party notice update-service fixture\n",
  );
  const offeredSourceBytes = gzipSync(
    encoder.encode("deterministic external source artifact fixture"),
  );
  const sourceSha256 = hashContent(offeredSourceBytes);
  const source = Object.freeze({
    kind: "https" as const,
    revision: `source-sha256:${sourceSha256}`,
    url:
      `https://${sourceCanister}.icp0.io/repo/v1/sources/` +
      `${sourceSha256}.source.v1.msgpack.gz`,
    sha256: sourceSha256,
    bytes: offeredSourceBytes.byteLength,
  });
  const embeddedReference = (path: string, content: Uint8Array) => ({
    path,
    sha256: hashContent(content),
    bytes: content.byteLength,
  });
  const record = {
    format: 1,
    package: {
      id,
      version,
      manifest: embeddedReference("neutron.json", manifestBytes),
    },
    license: {
      id: "LicenseRef-Neutron-Sovereign-Application-License-1.0",
      texts: [
        {
          id: "LicenseRef-Neutron-Sovereign-Application-License-1.0",
          ...embeddedReference("legal/LICENSE.APP.txt", licenseBytes),
        },
      ],
    },
    source,
    dependencies: [],
    notices: [
      embeddedReference(
        "legal/APPLICATION-NOTICE.txt",
        applicationNoticeBytes,
      ),
      embeddedReference(
        "legal/THIRD_PARTY_NOTICES.md",
        thirdPartyNoticeBytes,
      ),
    ],
    memory: null,
    build: { inputs: [], commands: [] },
  };
  const files: Record<string, Uint8Array> = {
    "neutron.json": manifestBytes,
    [`mo/${entry}.mo`]: moduleContent,
    "legal/LICENSE.APP.txt": licenseBytes,
    "legal/APPLICATION-NOTICE.txt": applicationNoticeBytes,
    "legal/THIRD_PARTY_NOTICES.md": thirdPartyNoticeBytes,
    "legal/package-record.v1.json": encoder.encode(JSON.stringify(record)),
  };
  return Object.freeze({
    archive: msgpack.encode(
      Object.fromEntries(
        Object.entries(files).map(([path, content]) => [
          path,
          gzipSync(content),
        ]),
      ),
    ),
    source,
  });
}

function preparedPackageDetails(
  archiveBytes: Uint8Array,
  options: PreparePackageInstallOptions = {},
) {
  const preparedPackage = preparePackageInstall(archiveBytes, options);
  return {
    neutronConfig: preparedPackage.manifest,
    preparedPackage,
  };
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
  return versionedCandidate(appId, name, source, 100, 101, bytes);
}

function versionedCandidate(
  appId: string,
  name: string,
  source: string,
  installed: number,
  target: number,
  bytes: Uint8Array,
) {
  const published = release(appId, target, bytes);
  return {
    kind: "available" as const,
    appId,
    name,
    installed,
    source,
    release: published,
    releaseDigest: hashContent(JSON.stringify(published)),
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
    deploymentId: "a".repeat(32),
    deploymentNonce: "b".repeat(32),
    vetKeysEnvironment: "local",
    compilerId: "moc_test",
    modulePaths: [],
  } as unknown as CompileResult;
}

function getPreparedDeployment(
  packages: readonly PreparedPackageInstall[],
  compiled: CompileResult,
): PreparedBrowserDeployment {
  return preparedDeploymentFixture(packages, compiled);
}

function preparedDeploymentFixture(
  packages: readonly PreparedPackageInstall[],
  compiled: CompileResult,
): PreparedBrowserDeployment {
  const supplied = [...packages].sort((left, right) =>
    left.manifest.id.localeCompare(right.manifest.id),
  );
  const kernel = supplied.find(({ manifest }) => manifest.id === "kernel");
  const ordered = [
    ...(kernel ? [kernel] : []),
    ...supplied.filter(({ manifest }) => manifest.id !== "kernel"),
  ];
  const packageEntries = [
    ...(!kernel
      ? [
          {
            app_id: "kernel",
            version: 100,
            archive: { state: "legacy_unavailable" as const },
            package_information: { state: "legacy_unavailable" as const },
            dependencies: [],
          },
        ]
      : []),
    ...ordered.map((prepared) => ({
      app_id: prepared.manifest.id,
      version: prepared.manifest.version,
      archive: prepared.archiveIdentity
        ? {
            state: "verified" as const,
            sha256: prepared.archiveIdentity.sha256,
            bytes: prepared.archiveIdentity.size,
          }
        : { state: "legacy_unavailable" as const },
      package_information: packageInformationIdentity(prepared),
      dependencies: [],
    })),
  ];
  const targetApps = packageEntries.map(({ app_id, version }) => ({
    app_id,
    version,
    capability_plan_fingerprint:
      supplied.find(({ manifest }) => manifest.id === app_id)
        ?.capabilityPlanFingerprint ?? "f".repeat(64),
    resident_frame_security: "credentialless_opaque_v1" as const,
  }));
  const parsed = parseDeploymentBuildRecord({
    format: 1,
    state: "complete",
    deployment_id: compiled.deploymentId,
    previous: {
      deployment_id: null,
      stable_signature_sha256: null,
      apps: [],
      memories: [],
    },
    build: {
      compiler_id: compiled.compilerId,
      assembler_id: "neutron_actor_v25",
      environment: compiled.vetKeysEnvironment,
      deployment_nonce: compiled.deploymentNonce,
      reachable_module_sha256: [],
    },
    packages: packageEntries,
    target: { apps: targetApps, memories: [] },
    warnings: {
      diagnostics: [],
      compatibility_diagnostics: [],
      memory_changes: [],
      removed_apps: [],
      destructive_memory_roots: [],
    },
    installation: {
      target_canister: "rrkah-fqaaa-aaaaa-aaaaq-cai",
      mode: "upgrade",
      argument: { sha256: hashContent(new Uint8Array()), bytes: 0 },
      wasm_memory_persistence: "keep",
    },
    wasm: {
      raw: {
        sha256: "c".repeat(64),
        bytes: compiled.wasm.byteLength,
        representation: "neutron_compile_result_wasm",
        content_encoding: "identity",
      },
      transport: {
        sha256: "d".repeat(64),
        bytes: Math.max(1, compiled.wasm.byteLength - 1),
        representation: "ic_install_wasm_payload",
        content_encoding: "gzip",
        encoder: DEPLOYMENT_WASM_TRANSPORT_ENCODER,
      },
    },
  });
  if (parsed.state !== "complete") throw new Error("Expected complete fixture");
  const recordBytes = serializeDeploymentBuildRecord(parsed);
  return Object.freeze({
    prepared: Object.freeze({
      record: parsed,
      recordBytes,
      transportWasm: Uint8Array.of(1),
    }),
    review: Object.freeze({
      record: parsed,
      suppliedPackages: Object.freeze([...packages]),
    }),
  });
}

function packageInformationIdentity(prepared: PreparedPackageInstall) {
  const recordPath =
    `${prepared.appPrefix}pkg/legal/package-record.v1.json`;
  const record = prepared.files.find(({ path }) => path === recordPath);
  return record === undefined
    ? { state: "not_supplied" as const }
    : {
        state: "verified" as const,
        sha256: hashContent(record.content),
      };
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
