import { afterAll, afterEach, expect, mock, test } from "bun:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NEUTRON_REPOSITORY_PROTOCOL } from "neutron-tools/repository";

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
  expect(html).toContain("Review app update");
  expect(html).toContain("verified certified transport");
  expect(html).toContain("not publisher identity or code endorsement");
  expect(html).toContain(`Copy source ${SOURCE}`);
  expect(html).toContain("Dependency requirements");
  expect(html).toContain("address_book");
  expect(html).toContain("contacts_search");
  expect(html).toContain("at least v0.1.1");
  expect(html).toContain('data-tid="app-updates-apply"');
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
  expect(html).toContain("Reviewing upgrades");
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

test("preparing one app keeps a focused cancel affordance in its row", () => {
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

  expect(html).toContain("Cancel update preparation for Mail");
  expect(html).toContain("Cancel update preparation");
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

  expect(html.match(/data-tid="settings-upgrade-all-cancel"/gu)).toHaveLength(
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
  disabled = false
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
      {AppUpdatesBulkAction({ disabled, returnFocusRef })}
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
