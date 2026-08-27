import type { AppRegistryEntry } from "neutron-compiler/src/install.js";
import { BROWSER_PERMISSION_FEATURES } from "neutron-tools/src/capabilities/catalog.js";
import {
  appBackgroundUrl,
  appIndexUrl,
  appTrayUrl,
  installationAppTileSurfaceKey,
  isInstallationAppOrigin,
  type InstallationAppSurfaceKey,
} from "neutron-tools/src/runtime.js";
import type { AppInstanceProjection } from "./app_scope.ts";
import {
  declaredCapability,
  residentFrameSecurityMode,
  ResidentFrameSecurityMode,
} from "./capabilities/plan.ts";
import {
  assertRuntimeFrameUrl,
  type RuntimeDeployment,
} from "./runtime_deployment.ts";

export const ORIGINFUL_APP_FRAME_SANDBOX =
  "allow-scripts allow-same-origin" as const;
export const OPAQUE_APP_FRAME_SANDBOX = "allow-scripts" as const;
export const CREDENTIALLESS_APP_FRAME_PROPS = Object.freeze({
  credentialless: "true",
});

type OrdinaryAppFrameEndpoint =
  | Readonly<{
      role: "tile";
      path: string;
      tileId: string;
      instanceId: string;
      workspace: number;
    }>
  | Readonly<{
      role: "tray";
      path: string;
      instanceId: string;
    }>
  | Readonly<{
      role: "background";
      path: string;
    }>;

type OrdinaryAppFramePolicy = Readonly<{
  src: string;
  origin: string;
  allow?: string;
}>;

export type AppFrameEndpointAuthority = Readonly<{
  appId: string;
  appVersion: number;
  appGeneration: number;
  capabilityPlanFingerprint: string;
  deploymentId: string;
  installationUid: string;
  browserOriginNonce: string;
  browserOriginAuthorityEpoch: string;
  residentFrameSecurity: AppInstanceProjection["residentFrameSecurity"];
  browserSurfaceOriginAdopted: boolean;
}>;

type AppFrameAuthoritySnapshot = Readonly<{
  list: Readonly<Record<string, AppRegistryEntry>>;
  appInstances: Readonly<Record<string, AppInstanceProjection>>;
  runtimeGenerations: Readonly<Record<string, number>>;
  browserSurfaceOriginAppIds: readonly string[];
}>;

export function appFrameEndpointAuthority({
  appId,
  app,
  appInstance,
  appGeneration,
  browserSurfaceOriginAdopted,
}: {
  appId: string;
  app: AppRegistryEntry;
  appInstance: AppInstanceProjection;
  appGeneration: number;
  browserSurfaceOriginAdopted: boolean;
}): AppFrameEndpointAuthority {
  return Object.freeze({
    appId,
    appVersion: app.version,
    appGeneration,
    capabilityPlanFingerprint: app.capability_plan_fingerprint,
    deploymentId: appInstance.deploymentId,
    installationUid: appInstance.scope.installationUid,
    browserOriginNonce: appInstance.browserOriginNonce,
    browserOriginAuthorityEpoch: appInstance.browserOriginAuthorityEpoch,
    residentFrameSecurity: appInstance.residentFrameSecurity,
    browserSurfaceOriginAdopted,
  });
}

export function appFrameAuthorityCurrent(
  expected: AppFrameEndpointAuthority,
  state: AppFrameAuthoritySnapshot,
  authorityPending: boolean,
): boolean {
  if (authorityPending) return false;
  const app = state.list[expected.appId];
  const instance = state.appInstances[expected.appId];
  return Boolean(
    app &&
      instance &&
      app.version === expected.appVersion &&
      app.capability_plan_fingerprint ===
        expected.capabilityPlanFingerprint &&
      (state.runtimeGenerations[expected.appId] ?? 0) ===
        expected.appGeneration &&
      state.browserSurfaceOriginAppIds.includes(expected.appId) ===
        expected.browserSurfaceOriginAdopted &&
      instance.scope.appId === expected.appId &&
      instance.scope.installationUid === expected.installationUid &&
      instance.version === expected.appVersion &&
      instance.deploymentId === expected.deploymentId &&
      instance.capabilityPlanFingerprint ===
        expected.capabilityPlanFingerprint &&
      instance.browserOriginNonce === expected.browserOriginNonce &&
      instance.browserOriginAuthorityEpoch ===
        expected.browserOriginAuthorityEpoch &&
      instance.residentFrameSecurity === expected.residentFrameSecurity,
  );
}

type PreparedOrdinaryAppFrame = Readonly<{
  source: Window;
  origin: string;
}>;

export function ordinaryAppFramePolicy({
  appId,
  app,
  appInstance,
  endpoint,
  deployment,
  browserSurfaceOriginAdopted,
}: {
  appId: string;
  app: AppRegistryEntry;
  appInstance: AppInstanceProjection;
  endpoint: OrdinaryAppFrameEndpoint;
  deployment: RuntimeDeployment;
  browserSurfaceOriginAdopted: boolean;
}): OrdinaryAppFramePolicy {
  if (appInstance.scope.appId !== appId) {
    throw new Error("App frame installation scope does not match its app");
  }
  const common = {
    canisterId: deployment.canisterId,
    appId,
    local: deployment.local,
    ...(deployment.localHost ? { localHost: deployment.localHost } : {}),
  };
  if (!browserSurfaceOriginAdopted) {
    return legacyOpaqueAppFramePolicy(app, endpoint, common, deployment);
  }
  const isolatedCommon = {
    ...common,
    surfaceBaseNonce: appInstance.browserOriginNonce,
  };
  const surfaceKey = ordinaryAppFrameSurfaceKey(endpoint);
  const src =
    endpoint.role === "tile"
      ? appIndexUrl({
          ...isolatedCommon,
          path: endpoint.path,
          tileId: endpoint.tileId,
          instanceId: endpoint.instanceId,
          workspace: endpoint.workspace,
        })
      : endpoint.role === "tray"
        ? appTrayUrl({
            ...isolatedCommon,
            path: endpoint.path,
            instanceId: endpoint.instanceId,
          })
        : appBackgroundUrl({ ...isolatedCommon, path: endpoint.path });
  assertRuntimeFrameUrl(src, true, deployment);
  if (
    !isInstallationAppOrigin(
      src,
      deployment.canisterId,
      appId,
      appInstance.browserOriginNonce,
      surfaceKey,
    )
  ) {
    throw new Error("App frame does not match its installation origin");
  }
  const origin = new URL(src).origin;
  const allow =
    endpoint.role === "tile"
      ? tileBrowserPermissionAllow(app, endpoint.tileId, origin)
      : undefined;
  return Object.freeze({ src, origin, ...(allow ? { allow } : {}) });
}

function legacyOpaqueAppFramePolicy(
  app: AppRegistryEntry,
  endpoint: OrdinaryAppFrameEndpoint,
  common: {
    canisterId: string;
    appId: string;
    local: boolean;
    localHost?: string;
  },
  deployment: RuntimeDeployment,
): OrdinaryAppFramePolicy {
  const unprefixed =
    endpoint.role !== "background" &&
    residentFrameSecurityMode(app) !==
      ResidentFrameSecurityMode.CREDENTIALLESS_OPAQUE_V1;
  const src =
    endpoint.role === "tile"
      ? appIndexUrl({
          ...common,
          path: endpoint.path,
          tileId: endpoint.tileId,
          instanceId: endpoint.instanceId,
          workspace: endpoint.workspace,
          unprefixed,
        })
      : endpoint.role === "tray"
        ? appTrayUrl({
            ...common,
            path: endpoint.path,
            instanceId: endpoint.instanceId,
            unprefixed,
          })
        : appBackgroundUrl({ ...common, path: endpoint.path });
  assertRuntimeFrameUrl(src, !unprefixed, deployment);
  return Object.freeze({ src, origin: "null" });
}

function ordinaryAppFrameSurfaceKey(
  endpoint: OrdinaryAppFrameEndpoint,
): InstallationAppSurfaceKey {
  return endpoint.role === "tile"
    ? installationAppTileSurfaceKey(endpoint.tileId)
    : endpoint.role;
}

export function tileBrowserPermissionAllow(
  app: AppRegistryEntry,
  tileId: string,
  origin: string,
): string | undefined {
  const grant = declaredCapability(app, "browser_permissions")?.tiles.find(
    (tile) => tile.id === tileId,
  );
  if (!grant) return undefined;
  const granted = new Set(grant.features);
  const policies = BROWSER_PERMISSION_FEATURES.filter((feature) =>
    granted.has(feature),
  ).map((feature) => `${feature} ${origin}`);
  return policies.length > 0 ? policies.join("; ") : undefined;
}

export type CredentiallessWindow = Window & {
  readonly credentialless?: unknown;
};

export type CredentiallessIFrame = HTMLIFrameElement & {
  readonly credentialless?: unknown;
};

export function credentiallessOriginfulFrameSupported(
  iframe: HTMLIFrameElement,
): boolean {
  const source = iframe.contentWindow as CredentiallessWindow | null;
  if (!source) return false;
  try {
    return (
      (iframe as CredentiallessIFrame).credentialless === true &&
      source.credentialless === true
    );
  } catch {
    return false;
  }
}

/**
 * Select and apply the complete container policy before navigation. The
 * caller registers the returned source/origin pair, then assigns policy.src.
 */
export function prepareOrdinaryAppFrame(
  iframe: HTMLIFrameElement,
  policy: OrdinaryAppFramePolicy,
): PreparedOrdinaryAppFrame {
  if (iframe.getAttribute("src") !== null) {
    throw new Error("App frame security must be selected before navigation");
  }
  const source = iframe.contentWindow;
  if (!source) throw new Error("App frame has no initial Window");

  const originful =
    policy.origin !== "null" && credentiallessOriginfulFrameSupported(iframe);
  const sandbox = originful
    ? ORIGINFUL_APP_FRAME_SANDBOX
    : OPAQUE_APP_FRAME_SANDBOX;
  const allow = originful ? policy.allow : undefined;
  iframe.setAttribute("sandbox", sandbox);
  if (allow) iframe.setAttribute("allow", allow);
  else iframe.removeAttribute("allow");

  return Object.freeze({
    source,
    origin: originful ? policy.origin : "null",
  });
}
