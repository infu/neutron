import { beforeEach, expect, test } from "bun:test";
import type {
  AppRegistry,
} from "neutron-compiler/src/install.js";
import type { JsonValue } from "neutron-tools";
import {
  endpointIdForContext,
  type FrameContext,
  type RegisteredEndpoint,
} from "../src/frame_context.ts";
import {
  clearTrayState,
  dismissTrayForEndpoint,
  MAX_TRAY_BADGE,
  reconcileTrayRegistry,
  removeTrayAppState,
  setTrayStateForEndpoint,
  subscribeTrayDismiss,
  useTrayStore,
} from "../src/tray/service.ts";
import { registryApp } from "./app_registry_fixture.ts";

const moduleWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
if (!moduleWindow) {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: {
        href: "http://4caro-hl777-77775-aaaba-cai.localhost:8000/",
      },
    },
  });
}
const {
  formatTrayBadge,
  positionTrayPopover,
  trayButtonLabel,
} = await import("../src/workspace/AppTray.tsx");
if (!moduleWindow) Reflect.deleteProperty(globalThis, "window");

beforeEach(() => {
  clearTrayState();
});

test("tray state is source-bound to the authenticated resident background", () => {
  const registry = trayRegistry();
  const resident = backgroundEndpoint("mail", 102);

  expect(
    setTrayStateForEndpoint({ badge: 4 }, resident, registry),
  ).toBeNull();
  expect(useTrayStore.getState().apps).toEqual({
    mail: { badge: 4, version: 102 },
  });
  expect(useTrayStore.getState().apps.wallet).toBeUndefined();

  expect(() =>
    setTrayStateForEndpoint(
      { badge: 7, appId: "wallet" } as JsonValue,
      resident,
      registry,
    ),
  ).toThrow("Invalid tray state");
  for (const endpoint of [
    trayEndpoint("mail", "panel-one", 102),
    tileEndpoint("mail", 102),
  ]) {
    expect(captureError(() =>
      setTrayStateForEndpoint({ badge: 7 }, endpoint, registry),
    )).toMatchObject({ code: "OWNER_REQUIRED" });
  }
  expect(useTrayStore.getState().apps).toEqual({
    mail: { badge: 4, version: 102 },
  });
});

test("tray updates require the installed declaration and exact app version", () => {
  const resident = backgroundEndpoint("mail", 102);
  const app = trayApp("mail", 102);

  for (const registry of [
    {},
    { mail: { ...app, tray: undefined } },
    { mail: { ...app, background: undefined } },
  ] as AppRegistry[]) {
    expect(() =>
      setTrayStateForEndpoint({ badge: 1 }, resident, registry),
    ).toThrow("does not declare a tray backed by a resident service");
  }

  expect(() =>
    setTrayStateForEndpoint(
      { badge: 1 },
      backgroundEndpoint("mail", 101),
      { mail: app },
    ),
  ).toThrow("stale app background");
  expect(() =>
    setTrayStateForEndpoint(
      { badge: 1 },
      backgroundEndpoint("mail"),
      { mail: app },
    ),
  ).toThrow("stale app background");
  expect(useTrayStore.getState().apps).toEqual({});
});

test("tray badges accept only the exact null and integer bounds", () => {
  const registry = trayRegistry();
  const resident = backgroundEndpoint("mail", 102);
  const accepted: Array<[JsonValue, number | null]> = [
    [{ badge: null }, null],
    [{ badge: 0 }, null],
    [{ badge: 1 }, 1],
    [{ badge: MAX_TRAY_BADGE }, MAX_TRAY_BADGE],
  ];

  for (const [payload, badge] of accepted) {
    expect(
      setTrayStateForEndpoint(payload, resident, registry),
    ).toBeNull();
    expect(useTrayStore.getState().apps.mail).toEqual({ badge, version: 102 });
  }

  const invalid: unknown[] = [
    null,
    [],
    {},
    { badge: 1, extra: true },
    { badge: -1 },
    { badge: MAX_TRAY_BADGE + 1 },
    { badge: 1.5 },
    { badge: Number.NaN },
    { badge: Number.POSITIVE_INFINITY },
    { badge: Number.MAX_SAFE_INTEGER + 1 },
    { badge: "4" },
  ];
  for (const payload of invalid) {
    expect(() =>
      setTrayStateForEndpoint(
        payload as JsonValue,
        resident,
        registry,
      ),
    ).toThrow();
  }
  expect(useTrayStore.getState().apps.mail).toEqual({
    badge: MAX_TRAY_BADGE,
    version: 102,
  });
});

test("tray badge updates are not subject to an elapsed-time quota", () => {
  const registry = trayRegistry();
  const resident = backgroundEndpoint("mail", 102);

  for (let index = 0; index < 40; index += 1) {
    expect(
      setTrayStateForEndpoint({ badge: 8 }, resident, registry),
    ).toBeNull();
  }
  expect(useTrayStore.getState().apps.mail).toEqual({ badge: 8, version: 102 });

  expect(setTrayStateForEndpoint({ badge: 9 }, resident, registry)).toBeNull();
  expect(useTrayStore.getState().apps.mail).toEqual({ badge: 9, version: 102 });
});

test("tray state reconciles versions and supports app removal and auth clearing", () => {
  const registry = trayRegistry();
  setTrayStateForEndpoint(
    { badge: 2 },
    backgroundEndpoint("mail", 102),
    registry,
  );
  setTrayStateForEndpoint(
    { badge: 6 },
    backgroundEndpoint("wallet", 100),
    registry,
  );

  reconcileTrayRegistry({
    mail: registry.mail!,
    wallet: trayApp("wallet", 101),
  });
  expect(useTrayStore.getState().apps).toEqual({
    mail: { badge: 2, version: 102 },
  });

  reconcileTrayRegistry({
    mail: {
      ...registry.mail!,
      tray: {
        ...registry.mail!.tray!,
        path: "tray-v2.html",
        icon: "/app/mail/static/tray-v2.svg",
      },
    },
  });
  expect(useTrayStore.getState().apps).toEqual({});

  setTrayStateForEndpoint(
    { badge: 2 },
    backgroundEndpoint("mail", 102),
    registry,
  );

  removeTrayAppState("mail");
  expect(useTrayStore.getState().apps).toEqual({});
  expect(
    setTrayStateForEndpoint(
      { badge: 3 },
      backgroundEndpoint("mail", 102),
      registry,
    ),
  ).toBeNull();

  clearTrayState();
  expect(useTrayStore.getState().apps).toEqual({});
  expect(
    setTrayStateForEndpoint(
      { badge: 4 },
      backgroundEndpoint("mail", 102),
      registry,
    ),
  ).toBeNull();
});

test("tray dismiss is exact, source-bound, version-bound, and instance-bound", () => {
  const registry = trayRegistry();
  const dismissals: Array<[string, string]> = [];
  const unsubscribe = subscribeTrayDismiss((appId, instanceId) => {
    dismissals.push([appId, instanceId]);
  });

  try {
    expect(
      dismissTrayForEndpoint(
        {},
        trayEndpoint("mail", "panel-one", 102),
        registry,
      ),
    ).toBeNull();
    expect(dismissals).toEqual([["mail", "panel-one"]]);

    expect(() =>
      dismissTrayForEndpoint(
        { instanceId: "panel-two" } as JsonValue,
        trayEndpoint("mail", "panel-one", 102),
        registry,
      ),
    ).toThrow("Invalid tray dismiss request");
    expect(captureError(() =>
      dismissTrayForEndpoint({}, backgroundEndpoint("mail", 102), registry),
    )).toMatchObject({ code: "USER_INTERACTION_REQUIRED" });
    expect(() =>
      dismissTrayForEndpoint(
        {},
        trayEndpoint("mail", "stale", 101),
        registry,
      ),
    ).toThrow("stale app popout");
    expect(() =>
      dismissTrayForEndpoint(
        {},
        trayEndpoint("undeclared", "panel", 100),
        registry,
      ),
    ).toThrow("does not declare a tray");
    expect(dismissals).toEqual([["mail", "panel-one"]]);
  } finally {
    unsubscribe();
  }

  dismissTrayForEndpoint(
    {},
    trayEndpoint("mail", "after-unsubscribe", 102),
    registry,
  );
  expect(dismissals).toEqual([["mail", "panel-one"]]);
});

test("tray badge text and accessible labels stay compact and exact", () => {
  expect(formatTrayBadge(1)).toBe("1");
  expect(formatTrayBadge(99)).toBe("99");
  expect(formatTrayBadge(100)).toBe("99+");
  expect(formatTrayBadge(MAX_TRAY_BADGE)).toBe("99+");

  expect(trayButtonLabel("Mailbox", null)).toBe("Mailbox");
  expect(trayButtonLabel("Mailbox", 0)).toBe("Mailbox");
  expect(trayButtonLabel("Mailbox", 1)).toBe("Mailbox, 1 new item");
  expect(trayButtonLabel("Mailbox", 4)).toBe("Mailbox, 4 new items");
});

test("tray popover geometry follows the visible viewport and clamps edges", () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const properties = new Map<string, string>();
  const popover = {
    style: {
      setProperty(name: string, value: string) {
        properties.set(name, value);
      },
    },
  } as unknown as HTMLElement;
  const button = {
    getBoundingClientRect: () => ({ bottom: 30, right: 180 }),
  } as unknown as HTMLElement;

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      innerHeight: 600,
      innerWidth: 200,
      visualViewport: { height: 300, offsetTop: 10 },
    },
  });
  try {
    positionTrayPopover(popover, button);
    expect(Object.fromEntries(properties)).toEqual({
      "--app-tray-top": "36px",
      "--app-tray-right": "20px",
      "--app-tray-available-height": "266px",
    });

    properties.clear();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { innerHeight: 100, innerWidth: 120 },
    });
    positionTrayPopover(popover, {
      getBoundingClientRect: () => ({ bottom: 150, right: 130 }),
    } as unknown as HTMLElement);
    expect(Object.fromEntries(properties)).toEqual({
      "--app-tray-top": "156px",
      "--app-tray-right": "8px",
      "--app-tray-available-height": "0px",
    });
  } finally {
    if (originalWindow) {
      Object.defineProperty(globalThis, "window", originalWindow);
    } else {
      Reflect.deleteProperty(globalThis, "window");
    }
  }
});

function trayRegistry(): AppRegistry {
  return {
    mail: trayApp("mail", 102),
    wallet: trayApp("wallet", 100),
  };
}

function trayApp(appId: string, version: number) {
  return registryApp({
    id: appId,
    name: appId === "mail" ? "Mailbox" : "Wallet",
    version,
    background: { path: "service.html" },
    tray: {
      title: appId === "mail" ? "Mailbox" : "Wallet",
      path: "tray.html",
      icon: "static/tray.svg",
    },
  });
}

function endpoint(context: FrameContext, appVersion?: number): RegisteredEndpoint {
  return {
    endpointId: endpointIdForContext(context),
    source: {} as Window,
    context,
    ...(appVersion === undefined ? {} : { appVersion }),
  };
}

function backgroundEndpoint(
  appId: string,
  appVersion?: number,
): RegisteredEndpoint {
  return endpoint({ role: "background", appId }, appVersion);
}

function trayEndpoint(
  appId: string,
  instanceId: string,
  appVersion?: number,
): RegisteredEndpoint {
  return endpoint({ role: "tray", appId, instanceId }, appVersion);
}

function tileEndpoint(appId: string, appVersion?: number): RegisteredEndpoint {
  return endpoint(
    {
      role: "tile",
      appId,
      tileId: "main",
      instanceId: "tile-one",
      workspace: 1,
    },
    appVersion,
  );
}

function captureError(callback: () => unknown): unknown {
  try {
    callback();
  } catch (error) {
    return error;
  }
  throw new Error("Expected callback to throw");
}
