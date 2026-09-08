import { KernelPolicyError } from "neutron-tools/protocol";
import { getRegisteredEndpoint, subscribeEndpointChanges } from "../frame_context.ts";
import { useAppsStore } from "../reducer/apps.ts";
import { useAuthStore } from "../reducer/auth.ts";
import { browserExtensionTransport } from "./transport.ts";
import { BrowserExtensionBroker, EXTENSION_GRANT_STORAGE_PREFIX, requireAvailable, type ExtensionConnectionStatus, type ExtensionRouteGrant } from "./broker.ts";
export type { ExtensionConnectionStatus, ExtensionRouteGrant } from "./broker.ts";
import { requestConsent, useBrowserExtensionStore } from "./consent.ts";
export { useBrowserExtensionStore } from "./consent.ts";

function browserStorage(): Storage | null {
  try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; }
}

export const browserExtensionBroker = new BrowserExtensionBroker({
  transport: browserExtensionTransport,
  storage: browserStorage,
  owner: () => useAuthStore.getState(),
  endpoint: getRegisteredEndpoint,
  app: (id) => {
    const state = useAppsStore.getState();
    const app = state.list[id];
    const scope = state.appInstances[id]?.scope;
    return app && scope ? { name: app.name, version: app.version, generation: state.runtimeGenerations[id] ?? 0, installationUid: scope.installationUid } : null;
  },
  consent: requestConsent,
  changed: refreshBrowserExtensionGrants,
});

export function refreshBrowserExtensionGrants(): void {
  try { useBrowserExtensionStore.setState({ grants: browserExtensionBroker.grants() }); }
  catch (error) { useBrowserExtensionStore.setState({ error: error instanceof Error ? error.message : String(error) }); }
}

export async function refreshBrowserExtensionStatus(): Promise<void> {
  try {
    const status = await browserExtensionTransport.status();
    useBrowserExtensionStore.setState({ status, error: null });
    refreshBrowserExtensionGrants();
  } catch (error) {
    useBrowserExtensionStore.setState({ error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

function requireSettingsOwner(): void {
  const auth = useAuthStore.getState();
  if (!auth.logged || !auth.authorized) throw new KernelPolicyError("OWNER_REQUIRED", "Browser extension settings require the authorized owner");
}

export async function connectBrowserExtension(): Promise<void> {
  requireSettingsOwner();
  requireAvailable(await browserExtensionTransport.status());
  await browserExtensionTransport.request("pair");
  await refreshBrowserExtensionStatus();
}

export async function disconnectBrowserExtension(): Promise<void> {
  requireSettingsOwner();
  await browserExtensionTransport.request("revoke");
  browserExtensionBroker.disconnected();
  await refreshBrowserExtensionStatus();
}

export function revokeBrowserExtensionGrant(id: string): void { browserExtensionBroker.revoke(id); }

function reconcile(): void {
  browserExtensionBroker.reconcile();
  const dialog = useBrowserExtensionStore.getState().dialog;
  if (dialog && !dialog.current()) dialog.reject();
}

subscribeEndpointChanges(reconcile);
useAuthStore.subscribe(reconcile);
useAppsStore.subscribe(reconcile);
browserExtensionTransport.subscribeDisconnect(() => {
  browserExtensionBroker.disconnected();
  useBrowserExtensionStore.setState({ status: null });
});
browserExtensionTransport.subscribeRevoked(() => {
  browserExtensionBroker.disconnected();
  useBrowserExtensionStore.setState((state) => ({
    status: { ...state.status, available: true, paired: false },
  }));
});
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== null && !event.key.startsWith(EXTENSION_GRANT_STORAGE_PREFIX)) return;
    refreshBrowserExtensionGrants();
    reconcile();
  });
}
