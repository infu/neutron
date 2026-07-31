import { KernelPolicyError } from "neutron-tools/protocol";
import { sameAppScope, type AppScope } from "./app_scope.ts";
import type { RegisteredEndpoint } from "./frame_context.ts";
import {
  isAuthorityPendingState,
  useAppsStore,
  type RuntimeAuthorityFence,
} from "./reducer/apps.ts";

export function isFrontendAuthorityPending(): boolean {
  return isAuthorityPendingState(useAppsStore.getState());
}

export function markFrontendAuthorityStale(
  deploymentId: string | null,
  reason: RuntimeAuthorityFence["reason"] = "runtime_changed",
): void {
  useAppsStore.getState().setRuntimeAuthorityFence({ deploymentId, reason });
}

export function committedFrontendDeploymentId(): string | null {
  const instances = Object.values(useAppsStore.getState().appInstances);
  if (instances.length === 0) return null;
  const deploymentId = instances[0]!.deploymentId;
  return instances.every((instance) => instance.deploymentId === deploymentId)
    ? deploymentId
    : null;
}

export function assertFrontendAuthorityCommitted(): void {
  if (!isFrontendAuthorityPending()) return;
  throw new KernelPolicyError(
    "REQUEST_CANCELLED",
    "App authority is unavailable until the pending installation commits or aborts",
  );
}

export function currentAppScope(appId: string): AppScope | null {
  return useAppsStore.getState().appInstances[appId]?.scope ?? null;
}

export function assertEndpointAppScope(endpoint: RegisteredEndpoint): void {
  let endpointAuthorityCurrent = true;
  try {
    endpointAuthorityCurrent = endpoint.isAuthorityCurrent?.() ?? true;
  } catch {
    endpointAuthorityCurrent = false;
  }
  if (!endpointAuthorityCurrent) {
    throw new KernelPolicyError(
      "REQUEST_CANCELLED",
      "App endpoint belongs to retired runtime authority",
    );
  }
  const current = currentAppScope(endpoint.context.appId);
  if (!endpoint.appScope) {
    if (current) {
      throw new KernelPolicyError(
        "REQUEST_CANCELLED",
        "App endpoint is missing its installation scope",
      );
    }
    return;
  }
  if (!sameAppScope(endpoint.appScope, current)) {
    throw new KernelPolicyError(
      "REQUEST_CANCELLED",
      "App endpoint belongs to a retired installation",
    );
  }
}
