import { create } from "zustand";
import {
  KernelPolicyError,
  isJsonObject,
  type JsonValue,
} from "neutron-tools/protocol";
import type { AppRegistry } from "neutron-compiler/src/install.js";
import type { RegisteredEndpoint } from "../frame_context.ts";
import { hasPersistentBackgroundStorage } from "../capabilities/plan.ts";

export const MAX_TRAY_BADGE = 9_999;

export type AppTrayState = {
  badge: number | null;
  version: number;
};

type TrayState = {
  apps: Record<string, AppTrayState>;
};

export const useTrayStore = create<TrayState>(() => ({ apps: {} }));

const stateDeclarations = new Map<string, string>();
const dismissListeners = new Set<(appId: string, instanceId: string) => void>();

/**
 * Update the small piece of kernel-rendered state beside an app's own tray
 * icon. Identity is derived from the authenticated background endpoint; apps
 * cannot name another app or replace kernel-owned icon/chrome.
 */
export function setTrayStateForEndpoint(
  payload: JsonValue,
  endpoint: RegisteredEndpoint,
  registry: AppRegistry,
): null {
  if (endpoint.context.role !== "background") {
    throw new KernelPolicyError(
      "OWNER_REQUIRED",
      "Only the app's resident background can update its tray state",
    );
  }
  const appId = endpoint.context.appId;
  const app = registry[appId];
  if (!app?.background || !app.tray) {
    throw new Error("App does not declare a tray backed by a resident service");
  }
  const version = app.version;
  if (endpoint.appVersion !== version) {
    throw new Error("Tray update came from a stale app background");
  }
  const badge = assertTrayStatePayload(payload);
  const declaration = trayDeclarationKey(app);
  const current = useTrayStore.getState().apps[appId];
  if (
    current?.version === version &&
    current.badge === badge &&
    stateDeclarations.get(appId) === declaration
  ) {
    return null;
  }
  stateDeclarations.set(appId, declaration);
  useTrayStore.setState((state) => ({
    apps: {
      ...state.apps,
      [appId]: { badge, version },
    },
  }));
  return null;
}

/** Close the source-bound tray popout without granting it shell access. */
export function dismissTrayForEndpoint(
  payload: JsonValue,
  endpoint: RegisteredEndpoint,
  registry: AppRegistry,
): null {
  if (!isJsonObject(payload) || Object.keys(payload).length !== 0) {
    throw new Error("Invalid tray dismiss request");
  }
  if (endpoint.context.role !== "tray") {
    throw new KernelPolicyError(
      "USER_INTERACTION_REQUIRED",
      "Only an open tray popout can dismiss itself",
    );
  }
  const app = registry[endpoint.context.appId];
  if (!app?.background || !app.tray) {
    throw new Error("App does not declare a tray");
  }
  if (endpoint.appVersion !== app.version) {
    throw new Error("Tray dismiss came from a stale app popout");
  }
  for (const listener of dismissListeners) {
    listener(endpoint.context.appId, endpoint.context.instanceId);
  }
  return null;
}

export function subscribeTrayDismiss(
  listener: (appId: string, instanceId: string) => void,
): () => void {
  dismissListeners.add(listener);
  return () => dismissListeners.delete(listener);
}

/** Keep badges only while the same installed app version still owns a tray. */
export function reconcileTrayRegistry(registry: AppRegistry): void {
  useTrayStore.setState((state) => {
    const apps = Object.fromEntries(
      Object.entries(state.apps).filter(([appId, item]) => {
        const app = registry[appId];
        return Boolean(
          app?.background &&
            app.tray &&
            app.version === item.version &&
            stateDeclarations.get(appId) === trayDeclarationKey(app),
        );
      }),
    );
    return Object.keys(apps).length === Object.keys(state.apps).length
      ? state
      : { apps };
  });
  for (const appId of stateDeclarations.keys()) {
    if (!useTrayStore.getState().apps[appId]) stateDeclarations.delete(appId);
  }
}

export function removeTrayAppState(appId: string): void {
  stateDeclarations.delete(appId);
  useTrayStore.setState((state) => {
    if (!(appId in state.apps)) return state;
    const apps = { ...state.apps };
    delete apps[appId];
    return { apps };
  });
}

export function clearTrayState(): void {
  stateDeclarations.clear();
  useTrayStore.setState({ apps: {} });
}

function assertTrayStatePayload(payload: JsonValue): number | null {
  if (
    !isJsonObject(payload) ||
    Object.keys(payload).length !== 1 ||
    !("badge" in payload)
  ) {
    throw new Error("Invalid tray state");
  }
  const badge = payload.badge;
  if (badge === null || badge === 0) return null;
  if (
    typeof badge !== "number" ||
    !Number.isSafeInteger(badge) ||
    badge < 0 ||
    badge > MAX_TRAY_BADGE
  ) {
    throw new Error(`Tray badge must be null or an integer from 0 to ${MAX_TRAY_BADGE}`);
  }
  return badge;
}

function trayDeclarationKey(app: AppRegistry[string]): string {
  return JSON.stringify({
    background: app?.background
      ? {
          path: app.background.path,
          persistentStorage: hasPersistentBackgroundStorage(app),
        }
      : null,
    tray: app?.tray
      ? { title: app.tray.title, path: app.tray.path, icon: app.tray.icon }
      : null,
  });
}
