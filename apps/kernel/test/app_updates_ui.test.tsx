import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { gzipSync } from "fflate";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import msgpack from "tiny-msgpack";
import { NEUTRON_REPOSITORY_PROTOCOL } from "neutron-tools/repository";
import { hashContent } from "neutron-tools/src/hash.js";
import {
  DEPLOYMENT_WASM_TRANSPORT_ENCODER,
  parseDeploymentBuildRecord,
} from "neutron-compiler/src/deployment_record.js";
import {
  preparePackageInstall,
  type PreparedPackageInstall,
} from "neutron-compiler/src/install.js";
import type { DeploymentBuildReviewInput } from "../src/install_review/deployment_build_review.ts";

mock.module("icblast", () => ({
  default: Object.assign(() => async () => ({}), {
    explainMethodSchema: () => ({}),
    toState: (value: unknown) => value,
    validateMethodInput: () => ({ ok: true }),
  }),
  InternetIdentity: {
    create: async () => undefined,
    getIdentity: () => ({
      getPrincipal: () => ({ toText: () => "2vxsx-fae" }),
    }),
    getPrincipal: () => ({ toText: () => "2vxsx-fae" }),
    isAuthenticated: async () => false,
    login: async () => undefined,
    logout: async () => undefined,
  },
}));

const originalWindow = globalThis.window;
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: { location: { href: "http://aaaaa-aa.localhost:8000/" } },
});

const [
  {
    AppUpdateCell,
    AppUpdatesBulkAction,
    AppUpdatesCoordinator,
    AppUpdatesFeedback,
  },
  { clearUpdateResults },
  { useUpdateCheckStore },
] = await Promise.all([
  import("../src/settings/AppUpdatesSection.tsx"),
  import("../src/updates/service.ts"),
  import("../src/updates/store.ts"),
]);

type UpdateState = ReturnType<typeof useUpdateCheckStore.getState>;

const idleState: UpdateState = {
  phase: "idle",
  checkedAt: null,
  results: [],
  progress: {},
  selectedAppIds: [],
  updatedAppCount: 0,
  compiledSizeKiB: null,
  review: null,
  error: null,
  errorStage: null,
};

afterEach(() => clearUpdateResults());

afterAll(() => {
  if (originalWindow === undefined) {
    delete (globalThis as { window?: Window }).window;
  } else {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
  }
});

test("Installed Apps has no separate check control and distinguishes manual apps", () => {
  const html = renderSurface(idleState, [
    { appId: "mail", appName: "Mail", updateSource: SOURCE },
    { appId: "files", appName: "Files" },
  ]);

  expect(html).not.toContain('data-tid="app-updates-check"');
  expect(html).not.toContain("Check updates");
  expect(html).toContain("Not checked");
  expect(html).toContain("Manual");
  expect(html).not.toContain("Update All");
  expect(html).not.toContain('data-tid="app-updates"');
  expect(html.match(/aria-live="polite"/gu)).toHaveLength(1);
});

test("checking uses row-level spinners without a separate control", () => {
  const state: UpdateState = {
    ...idleState,
    phase: "checking",
    progress: {
      [SOURCE]: { source: SOURCE, completed: 1, total: 2 },
    },
    results: [
      {
        kind: "queued",
        appId: "mail",
        name: "Mail",
        installed: 100,
        source: SOURCE,
      },
      {
        kind: "manual_only",
        appId: "files",
        name: "Files",
        installed: 100,
      },
    ],
  };
  const html = renderSurface(
    state,
    [
      { appId: "mail", appName: "Mail", updateSource: SOURCE },
      { appId: "contacts", appName: "Contacts", updateSource: SOURCE },
      { appId: "files", appName: "Files" },
    ],
    true
  );

  expect(html).not.toContain("Cancel check");
  expect(html).not.toContain('data-tid="app-updates-check"');
  expect(html.match(/>Checking</gu)).toHaveLength(2);
  expect(html).toContain(">Manual<");
  expect(html).toContain("Checking app update sources.");
  expect(html).not.toContain('role="status"');
});

test("update results are joined to rows by app id and expose one-app actions", () => {
  const state: UpdateState = {
    ...idleState,
    phase: "ready",
    checkedAt: 1_700_000_000_000,
    selectedAppIds: ["contacts", "mail"],
    results: [
      {
        kind: "failed",
        appId: "contacts",
        name: "Contacts",
        installed: 100,
        source: SOURCE,
        reason: "timed_out",
      },
      available("mail", "Mail", 101),
      {
        kind: "current",
        appId: "calendar",
        name: "Calendar",
        installed: 101,
        source: SOURCE,
        release: release("calendar", 101),
        releaseDigest: "c".repeat(64),
      },
    ],
  };
  const html = renderSurface(state, [
    { appId: "mail", appName: "Mail", updateSource: SOURCE },
    { appId: "calendar", appName: "Calendar", updateSource: SOURCE },
    { appId: "contacts", appName: "Contacts", updateSource: SOURCE },
  ]);

  expect(html).toContain('data-tid="settings-update-mail"');
  expect(html).toContain("Update Mail to v0.1.1");
  expect(html).toContain("Up to date");
  expect(html).toContain("Check failed");
  expect(html).toContain("took too long");
  expect(html).not.toContain('data-tid="settings-update-contacts"');
  expect(html).not.toContain("Update All");
});

test("verified updates expose one bulk upgrade action", () => {
  const state: UpdateState = {
    ...idleState,
    phase: "ready",
    checkedAt: 1_700_000_000_000,
    selectedAppIds: ["contacts", "mail"],
    results: [
      available("contacts", "Contacts", 101),
      available("mail", "Mail", 102),
      {
        kind: "failed",
        appId: "calendar",
        name: "Calendar",
        installed: 100,
        source: SOURCE,
        reason: "unavailable",
      },
    ],
  };
  const html = renderSurface(state, [
    { appId: "contacts", appName: "Contacts", updateSource: SOURCE },
    { appId: "mail", appName: "Mail", updateSource: SOURCE },
    { appId: "calendar", appName: "Calendar", updateSource: SOURCE },
  ]);

  expect(html).toContain('data-tid="settings-upgrade-all"');
  expect(html).toContain("Upgrade all (2)");
  expect(html).toContain("Upgrade all 2 available apps");
});

test("Settings selection replaces Upgrade all with explicit selected actions", () => {
  const state: UpdateState = {
    ...idleState,
    phase: "ready",
    checkedAt: 1_700_000_000_000,
    results: [
      available("mail", "Mail", 102),
      {
        kind: "current",
        appId: "calendar",
        name: "Calendar",
        installed: 101,
        source: SOURCE,
        release: release("calendar", 101),
        releaseDigest: "c".repeat(64),
      },
    ],
  };
  const html = renderSurface(
    state,
    [
      { appId: "mail", appName: "Mail", updateSource: SOURCE },
      { appId: "calendar", appName: "Calendar", updateSource: SOURCE },
    ],
    false,
    ["calendar", "mail"],
  );

  expect(html).toContain('data-tid="settings-delete-selected"');
  expect(html).toContain("Delete selected (2)");
  expect(html).toContain('data-tid="settings-update-selected"');
  expect(html).toContain("Update selected (1)");
  expect(html).not.toContain('data-tid="settings-upgrade-all"');
});

test("terminal update states stay visible in their Installed Apps cells", () => {
  const state: UpdateState = {
    ...idleState,
    phase: "ready",
    checkedAt: 1,
    selectedAppIds: ["regressed", "cancelled"],
    results: [
      {
        kind: "not_published",
        appId: "missing",
        name: "Missing",
        installed: 100,
        source: SOURCE,
      },
      {
        kind: "source_regression",
        appId: "regressed",
        name: "Regressed",
        installed: 102,
        advertised: 101,
        source: SOURCE,
      },
      {
        kind: "cancelled",
        appId: "cancelled",
        name: "Cancelled",
        installed: 100,
        source: SOURCE,
      },
    ],
  };
  const html = renderSurface(state, [
    { appId: "missing", appName: "Missing", updateSource: SOURCE },
    { appId: "regressed", appName: "Regressed", updateSource: SOURCE },
    { appId: "cancelled", appName: "Cancelled", updateSource: SOURCE },
  ]);

  expect(html).toContain("Not published");
  expect(html).toContain("Source behind");
  expect(html).toContain("The source advertises v0.1.1");
  expect(html).toContain("Not checked");
  expect(html).toContain("Update check complete: 2 checks need attention, 1 not published.");
});

test("failure feedback distinguishes preparation from uncertain deployment", () => {
  const preparation = renderSurface({
    ...idleState,
    phase: "error",
    error: "Package validation failed.",
    errorStage: "prepare",
  });
  expect(preparation).toContain("No updates were applied.");
  expect(preparation).not.toContain("do not assume");

  const deployment = renderSurface({
    ...idleState,
    phase: "error",
    error: "Status is unknown.",
    errorStage: "apply",
  });
  expect(deployment).toContain("Deployment did not report success.");
  expect(deployment).toContain("checked deployment journal");
  expect(deployment).toContain("do not assume");
});

test("verified review and apply stay in the consolidated per-app update flow", () => {
  const state = reviewState([
    reviewApp({
      appId: "mail",
      name: "Mail",
      dependencies: {
        address_book: {
          app: "contacts",
          min_version: 101,
          functions: ["contacts_search"],
        },
      },
    }),
  ]);
  const html = renderSurface(state);

  expect(html).toContain('data-tid="app-update-review-dialog"');
  expect(html.match(/data-tid="deployment-build-review"/gu)).toHaveLength(1);
  expect(html).toContain("Deployment ready");
  expect(html).not.toContain('data-tid="deployment-build-review-download-record"');
  expect(html).not.toContain(
    'data-tid="deployment-build-review-download-archive-mail"',
  );
  expect(html).not.toContain("Raw compiler Wasm");
  expect(html).not.toContain("Transport Wasm");
  expect(html).toContain("Review app update");
  expect(html).toContain("verified certified transport");
  expect(html).toContain("not publisher identity or code endorsement");
  expect(html).toContain(`Copy source ${SOURCE}`);
  expect(html).toContain("Dependency requirements");
  expect(html).toContain("address_book");
  expect(html).toContain("contacts_search");
  expect(html).toContain("at least v0.1.1");
  expect(html).toContain('data-tid="app-updates-apply"');
  expect(html.indexOf('data-tid="deployment-build-review"')).toBeLessThan(
    html.indexOf('data-tid="app-updates-apply"'),
  );
  expect(html).toContain("Update 1 app");
  expect(html).not.toContain("Update All");
});

test("bulk review stays plural and preserves a bulk return target", () => {
  const html = renderSurface(
    reviewState([
      reviewApp({ appId: "contacts", name: "Contacts" }),
      reviewApp({ appId: "mail", name: "Mail" }),
    ]),
  );

  expect(html).toContain("Review app updates");
  expect(html.match(/data-tid="deployment-build-review"/gu)).toHaveLength(1);
  expect(html).toContain("Reviewing updates");
  expect(html).toContain("Update 2 apps");
});

test("review distinguishes update-source add, change, and removal", () => {
  const nextSource = "ryjl3-tyaaa-aaaaa-aaaba-cai";
  const html = renderSurface(
    reviewState([
      reviewApp({
        appId: "add_source",
        name: "Add source",
        currentUpdateSource: undefined,
        targetUpdateSource: nextSource,
      }),
      reviewApp({
        appId: "change_source",
        name: "Change source",
        currentUpdateSource: SOURCE,
        targetUpdateSource: nextSource,
      }),
      reviewApp({
        appId: "remove_source",
        name: "Remove source",
        currentUpdateSource: SOURCE,
        targetUpdateSource: undefined,
      }),
    ])
  );

  expect(html).toContain(`Adds source ${nextSource}`);
  expect(html).toContain(`Changes source ${SOURCE} → ${nextSource}`);
  expect(html).toContain(`Removes source ${SOURCE} · manual updates`);
});

test("success feedback reports the committed app count", () => {
  const html = renderSurface({
    ...idleState,
    phase: "success",
    updatedAppCount: 1,
  });
  expect(html).toContain("Updated 1 app.");
  expect(html).toContain("Installed version and integrity records were committed together.");
});

test("preparing one app keeps one toolbar cancel and passive row status", () => {
  const html = renderSurface(
    {
      ...idleState,
      phase: "preparing",
      checkedAt: 1,
      selectedAppIds: ["mail"],
      results: [available("mail", "Mail", 101)],
    },
    [{ appId: "mail", appName: "Mail", updateSource: SOURCE }]
  );

  expect(html.match(/data-tid="settings-update-cancel"/gu)).toHaveLength(1);
  expect(html).toContain(">Preparing<");
  expect(html).not.toContain('role="status"');
});

test("bulk preparation has one cancel action and passive row status", () => {
  const html = renderSurface(
    {
      ...idleState,
      phase: "preparing",
      checkedAt: 1,
      selectedAppIds: ["contacts", "mail"],
      results: [
        available("contacts", "Contacts", 101),
        available("mail", "Mail", 101),
      ],
    },
    [
      { appId: "contacts", appName: "Contacts", updateSource: SOURCE },
      { appId: "mail", appName: "Mail", updateSource: SOURCE },
    ],
  );

  expect(html.match(/data-tid="settings-update-cancel"/gu)).toHaveLength(
    1,
  );
  expect(html.match(/>Preparing</gu)).toHaveLength(2);
  expect(html).not.toContain("Cancel update preparation for Contacts");
  expect(html).not.toContain("Cancel update preparation for Mail");
});

const SOURCE = "rrkah-fqaaa-aaaaa-aaaaq-cai";

function renderSurface(
  state: UpdateState,
  apps: readonly {
    appId: string;
    appName: string;
    updateSource?: string;
  }[] = [],
  disabled = false,
  actionAppIds: readonly string[] = [],
): string {
  useUpdateCheckStore.setState(state);
  const returnFocusRef = React.createRef<HTMLButtonElement>();
  const fallbackFocusRef = React.createRef<HTMLElement>();
  const tree = withCurrentStoreDispatcher(() => (
    <>
      {apps.map((app) => (
        <div data-app-id={app.appId} key={app.appId}>
          {AppUpdateCell({
            appId: app.appId,
            appName: app.appName,
            disabled,
            returnFocusRef,
            ...(app.updateSource ? { updateSource: app.updateSource } : {}),
          })}
        </div>
      ))}
      {AppUpdatesBulkAction({
        deleteDisabled: disabled,
        deleteTitle: "Delete selected apps",
        disabled,
        onDeleteSelected: () => undefined,
        returnFocusRef,
        actionAppIds,
      })}
      {AppUpdatesFeedback()}
      {AppUpdatesCoordinator({ fallbackFocusRef, returnFocusRef })}
    </>
  ));
  return renderToStaticMarkup(tree);
}

function withCurrentStoreDispatcher<T>(run: () => T): T {
  const internals = (
    React as typeof React & {
      __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: {
        H: unknown;
      };
    }
  ).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const original = internals.H;
  internals.H = {
    useCallback<TValue>(callback: TValue) {
      return callback;
    },
    useDebugValue() {},
    useEffect() {},
    useRef<TValue>(initial: TValue) {
      return { current: initial };
    },
    useSyncExternalStore<TValue>(_subscribe: unknown, getSnapshot: () => TValue) {
      return getSnapshot();
    },
  };
  try {
    return run();
  } finally {
    internals.H = original;
  }
}

function release(appId: string, version: number) {
  return {
    protocol: NEUTRON_REPOSITORY_PROTOCOL,
    id: appId,
    version,
    sha256: "b".repeat(64),
    size: 1_234,
  } as const;
}

function available(appId: string, name: string, version: number) {
  return {
    kind: "available",
    appId,
    name,
    installed: 100,
    source: SOURCE,
    releaseDigest: "a".repeat(64),
    release: release(appId, version),
  } as const;
}

function reviewApp(input: {
  appId: string;
  name: string;
  currentUpdateSource?: string;
  targetUpdateSource?: string;
  dependencies?: Record<string, { app: string; min_version: number; functions: string[] }>;
}) {
  const { appId, name, dependencies = {} } = input;
  const currentUpdateSource = Object.hasOwn(input, "currentUpdateSource")
    ? input.currentUpdateSource
    : SOURCE;
  const targetUpdateSource = Object.hasOwn(input, "targetUpdateSource")
    ? input.targetUpdateSource
    : SOURCE;
  return {
    appId,
    name,
    installedVersion: 100,
    targetVersion: 101,
    source: SOURCE,
    ...(currentUpdateSource ? { currentUpdateSource } : {}),
    ...(targetUpdateSource ? { targetUpdateSource } : {}),
    packageBytes: 2_048,
    packageDigest: "a".repeat(64),
    releaseDigest: "b".repeat(64),
    capabilityPlanDiff: { entries: [] },
    capabilityDisclosures: [],
    permissions: [],
    appExplanations: [],
    dependencies,
  };
}

function reviewState(apps: ReturnType<typeof reviewApp>[]): UpdateState {
  return {
    ...idleState,
    phase: "review",
    checkedAt: 1,
    results: apps.map(({ appId, name, targetVersion }) =>
      available(appId, name, targetVersion),
    ),
    selectedAppIds: apps.map(({ appId }) => appId),
    compiledSizeKiB: 12,
    review: {
      deploymentBuild: deploymentBuildReview(apps),
      compiledSizeKiB: 12,
      diagnostics: [],
      compatibilityDiagnostics: [],
      migrationPlan: {
        upgrades: [],
        removedApps: [],
        destructiveMemoryRoots: [],
      },
      apps,
    },
  } as unknown as UpdateState;
}

function deploymentBuildReview(
  apps: ReturnType<typeof reviewApp>[],
): DeploymentBuildReviewInput {
  const suppliedPackages = apps
    .map(preparedUpdatePackage)
    .sort((left, right) => left.manifest.id.localeCompare(right.manifest.id));
  const suppliedKernel = suppliedPackages.find(
    ({ manifest }) => manifest.id === "kernel",
  );
  const orderedSupplied = [
    ...(suppliedKernel ? [suppliedKernel] : []),
    ...suppliedPackages.filter(({ manifest }) => manifest.id !== "kernel"),
  ];
  const packageEntries = [
    ...(!suppliedKernel
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
    ...orderedSupplied.map((prepared) => ({
      app_id: prepared.manifest.id,
      version: prepared.manifest.version,
      archive: {
        state: "verified" as const,
        sha256: prepared.archiveIdentity!.sha256,
        bytes: prepared.archiveIdentity!.size,
      },
      package_information: { state: "not_supplied" as const },
      dependencies: [],
    })),
  ];
  const parsed = parseDeploymentBuildRecord({
    format: 1,
    state: "complete",
    deployment_id: "a".repeat(32),
    previous: {
      deployment_id: null,
      stable_signature_sha256: null,
      apps: [],
      memories: [],
    },
    build: {
      compiler_id: "moc_test",
      assembler_id: "neutron_actor_v25",
      environment: "local",
      deployment_nonce: "b".repeat(32),
      reachable_module_sha256: [],
    },
    packages: packageEntries,
    target: {
      apps: packageEntries.map(({ app_id, version }) => ({
        app_id,
        version,
        capability_plan_fingerprint:
          suppliedPackages.find(({ manifest }) => manifest.id === app_id)
            ?.capabilityPlanFingerprint ?? "f".repeat(64),
        resident_frame_security: "credentialless_opaque_v1",
      })),
      memories: [],
    },
    warnings: {
      diagnostics: [],
      compatibility_diagnostics: [],
      memory_changes: [],
      removed_apps: [],
      destructive_memory_roots: [],
    },
    installation: {
      target_canister: SOURCE,
      mode: "upgrade",
      argument: { sha256: hashContent(new Uint8Array()), bytes: 0 },
      wasm_memory_persistence: "replace",
    },
    wasm: {
      raw: {
        sha256: "c".repeat(64),
        bytes: 12 * 1024,
        representation: "neutron_compile_result_wasm",
        content_encoding: "identity",
      },
      transport: {
        sha256: "d".repeat(64),
        bytes: 6 * 1024,
        representation: "ic_install_wasm_payload",
        content_encoding: "gzip",
        encoder: DEPLOYMENT_WASM_TRANSPORT_ENCODER,
      },
    },
  });
  if (parsed.state !== "complete") throw new Error("Expected complete fixture");
  return Object.freeze({
    record: parsed,
    suppliedPackages: Object.freeze(suppliedPackages),
  });
}

function preparedUpdatePackage(
  app: ReturnType<typeof reviewApp>,
): PreparedPackageInstall {
  const encoder = new TextEncoder();
  const moduleContent = encoder.encode(
    `module { public let fixtureVersion : Nat = ${app.targetVersion} }`,
  );
  const entry = hashContent(moduleContent);
  const files = {
    "neutron.json": encoder.encode(
      JSON.stringify({
        format: 3,
        id: app.appId,
        name: app.name,
        version: app.targetVersion,
        entry,
        ...(app.targetUpdateSource
          ? { update_source: app.targetUpdateSource }
          : {}),
      }),
    ),
    [`mo/${entry}.mo`]: moduleContent,
  };
  const archiveBytes = msgpack.encode(
    Object.fromEntries(
      Object.entries(files).map(([path, content]) => [
        path,
        gzipSync(content),
      ]),
    ),
  );
  return preparePackageInstall(archiveBytes);
}
