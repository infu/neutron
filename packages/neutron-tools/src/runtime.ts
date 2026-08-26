import { isValidAppId } from "./app_ids.ts";
import { sha256 } from "js-sha256";
import { isValidTileId } from "./tile_ids.ts";

export const DEFAULT_LOCAL_HOST = "http://localhost:8000";
export const LOCAL_II_FRONTEND_CANISTER_ID =
  "uqzsh-gqaaa-aaaaq-qaada-cai";

const DNS_LABEL_MAX_LENGTH = 63;
const INSTALLATION_APP_SURFACE_DOMAIN =
  "neutron.app-browser-surface-origin.v1";

export function envFlag(value: unknown): boolean {
  return (
    value === true || value === "1" || String(value).toLowerCase() === "true"
  );
}

export function canisterIdFromUrl(
  href: string | URL,
  fallback?: string | false | null
): string | false {
  const url = new URL(href);
  const fromQuery = url.searchParams.get("canisterId");
  if (fromQuery && isCanisterIdLike(fromQuery)) return fromQuery;

  const hostLabel = url.hostname.split(".")[0];
  const fromHost = canisterIdFromHostLabel(hostLabel);
  if (fromHost) return fromHost;
  return fallback || false;
}

function isCanisterIdLike(value: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)+-cai$/.test(value);
}

function canisterIdFromHostLabel(label?: string): string | false {
  if (!label) return false;
  if (isCanisterIdLike(label)) return label;

  const prefixed = label.split("--").at(-1);
  return prefixed && isCanisterIdLike(prefixed) ? prefixed : false;
}

function isIpHost(hostname: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":");
}

function usesLocalCanisterSubdomains(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost");
}

export function localCanisterOrigin(
  canisterId: string,
  localHost = DEFAULT_LOCAL_HOST,
  prefix?: string
): string {
  const gateway = new URL(localHost || DEFAULT_LOCAL_HOST);
  const hostname =
    gateway.hostname === "127.0.0.1" || gateway.hostname === "0.0.0.0"
      ? "localhost"
      : gateway.hostname;
  const port = gateway.port ? `:${gateway.port}` : "";
  if (isIpHost(hostname) || !usesLocalCanisterSubdomains(hostname)) {
    return `${gateway.protocol}//${hostname}${port}`;
  }
  const label = prefix ? prefixedCanisterLabel(canisterId, prefix) : canisterId;
  return `${gateway.protocol}//${label}.${hostname}${port}`;
}

export function canisterOrigin({
  canisterId,
  local = false,
  localHost = DEFAULT_LOCAL_HOST,
  raw = false,
}: {
  canisterId: string;
  local?: boolean;
  localHost?: string;
  raw?: boolean;
}): string {
  if (local) return localCanisterOrigin(canisterId, localHost);
  return `https://${canisterId}.${raw ? "raw.icp0.io" : "icp0.io"}`;
}

/**
 * Derive the only parent origin that may act as the kernel for an app frame.
 * Accepted app documents may use a legacy app prefix, an installation-surface
 * prefix, a dedicated-resident prefix, or the legacy unprefixed canister URL.
 * Every accepted form maps back to the verified Kernel shell origin;
 * unverified raw and custom gateways are not authentication surfaces.
 */
export function kernelParentOriginFromAppUrl(
  href: string | URL,
): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const appUrl = verifiedAppGatewayUrl(url);
  if (!appUrl) return null;
  if (
    appUrl.prefix !== null &&
    appUrl.prefix !== appFramePrefix({ appId: appUrl.appId }) &&
    !/^[ip][a-f0-9]{24}$/u.test(appUrl.prefix)
  ) return null;
  return appUrl.parentOrigin;
}

type AppWindowLocation = Readonly<{
  location: Readonly<{ href: string }>;
}>;

const kernelParentOriginsByAppWindow = new WeakMap<object, string | null>();

/**
 * Cache the authenticated Kernel parent from an app window's launch URL.
 * History API route changes must not change the parent identity after launch.
 */
export function kernelParentOriginFromAppWindow(
  appWindow: AppWindowLocation,
): string | null {
  if (kernelParentOriginsByAppWindow.has(appWindow)) {
    return kernelParentOriginsByAppWindow.get(appWindow) ?? null;
  }
  let origin: string | null = null;
  try {
    origin = kernelParentOriginFromAppUrl(appWindow.location.href);
  } catch {
    // Unreadable or invalid launch locations fail closed.
  }
  kernelParentOriginsByAppWindow.set(appWindow, origin);
  return origin;
}

type VerifiedAppGatewayUrl = Readonly<{
  appId: string;
  canisterId: string;
  prefix: string | null;
  parentOrigin: string;
}>;

function verifiedAppGatewayUrl(url: URL): VerifiedAppGatewayUrl | null {
  if (url.username !== "" || url.password !== "") return null;
  const path = /^\/app\/([^/]+)\//u.exec(url.pathname);
  const appId = path?.[1];
  if (!appId || !isValidAppId(appId)) return null;

  const hostname = url.hostname.toLowerCase();
  const mainnet =
    url.protocol === "https:" &&
    url.port === ""
      ? /^([^.]+)\.icp0\.io$/u.exec(hostname)
      : null;
  const local =
    url.protocol === "http:" &&
    url.port === "8000"
      ? /^([^.]+)\.localhost$/u.exec(hostname)
      : null;
  const gateway = mainnet || local;
  const firstLabel = gateway?.[1];
  if (!firstLabel) return null;

  const labels = firstLabel.split("--");
  if (labels.length > 2) return null;
  const canisterId = labels.at(-1);
  if (!canisterId || !isCanisterIdLike(canisterId)) return null;
  const prefix = labels.length === 2 ? labels[0]! : null;
  if (prefix === "") return null;
  const parentOrigin = mainnet
    ? `https://${canisterId}.icp0.io`
    : `http://${canisterId}.localhost:8000`;
  return Object.freeze({ appId, canisterId, prefix, parentOrigin });
}

export function appFramePrefix({
  appId,
  maxLength = DNS_LABEL_MAX_LENGTH,
}: {
  appId: string;
  tileId?: string;
  instanceId?: string;
  maxLength?: number;
}): string {
  if (!isValidAppId(appId)) {
    throw new Error(`Invalid app id '${appId}' for app origin`);
  }
  const prefix = `a${appId.replaceAll("_", "-")}a`;
  if (prefix.length > maxLength) {
    throw new Error(`App origin prefix for '${appId}' exceeds DNS limits`);
  }
  return prefix;
}

export function persistentAppFramePrefix({
  browserOriginNonce,
  maxLength = DNS_LABEL_MAX_LENGTH,
}: {
  browserOriginNonce: string;
  maxLength?: number;
}): string {
  // Ninety-six bits of the kernel-assigned nonce keep the DNS label compact
  // enough to coexist with the canister suffix while making an app reinstall
  // a different browser origin. App identity remains source-bound by the
  // kernel and request path; this label is a storage partition identifier,
  // never an authority token or secret.
  return nonceAppFramePrefix(
    "p",
    browserOriginNonce,
    maxLength,
    "browser-origin",
  );
}

export type InstallationAppSurfaceKey =
  | `tile:${string}`
  | "tray"
  | "background";

export function installationAppSurfaceNonce({
  surfaceBaseNonce,
  surfaceKey,
}: {
  surfaceBaseNonce: string;
  surfaceKey: InstallationAppSurfaceKey;
}): string {
  if (!/^[a-f0-9]{32}$/u.test(surfaceBaseNonce)) {
    throw new Error("Invalid browser surface-base nonce");
  }
  assertInstallationAppSurfaceKey(surfaceKey);
  const hash = sha256.create();
  hash.update(lengthPrefixedUtf8(INSTALLATION_APP_SURFACE_DOMAIN));
  hash.update(lengthPrefixedUtf8(surfaceBaseNonce));
  hash.update(lengthPrefixedUtf8(surfaceKey));
  return hash.hex().slice(0, 32);
}

export function installationAppSurfacePrefix({
  surfaceBaseNonce,
  surfaceKey,
  maxLength = DNS_LABEL_MAX_LENGTH,
}: {
  surfaceBaseNonce: string;
  surfaceKey: InstallationAppSurfaceKey;
  maxLength?: number;
}): string {
  return nonceAppFramePrefix(
    "i",
    installationAppSurfaceNonce({ surfaceBaseNonce, surfaceKey }),
    maxLength,
    "browser surface-origin",
  );
}

function assertInstallationAppSurfaceKey(
  surfaceKey: InstallationAppSurfaceKey,
): void {
  if (
    surfaceKey === "tray" ||
    surfaceKey === "background" ||
    (surfaceKey.startsWith("tile:") &&
      isValidTileId(surfaceKey.slice("tile:".length)))
  ) return;
  throw new Error("Invalid installation app surface key");
}

function lengthPrefixedUtf8(value: string): Uint8Array {
  return lengthPrefixedBytes(new TextEncoder().encode(value));
}

function lengthPrefixedBytes(value: Uint8Array): Uint8Array {
  const result = new Uint8Array(4 + value.byteLength);
  new DataView(result.buffer).setUint32(0, value.byteLength, false);
  result.set(value, 4);
  return result;
}

function nonceAppFramePrefix(
  discriminator: "i" | "p",
  nonce: string,
  maxLength: number,
  label: "browser-origin" | "browser surface-origin",
): string {
  if (!/^[a-f0-9]{32}$/u.test(nonce)) {
    throw new Error(`Invalid ${label} nonce`);
  }
  const prefix = `${discriminator}${nonce.slice(0, 24)}`;
  if (prefix.length > maxLength) {
    throw new Error(`${label} app origin prefix exceeds DNS limits`);
  }
  return prefix;
}

function prefixedCanisterLabel(canisterId: string, prefix: string): string {
  const suffix = `--${canisterId}`;
  const maxPrefixLength = DNS_LABEL_MAX_LENGTH - suffix.length;
  if (maxPrefixLength < 1 || prefix.length > maxPrefixLength) {
    throw new Error("Canister id leaves no room for an isolated app origin");
  }
  return `${prefix}${suffix}`;
}

function appCanisterOrigin({
  canisterId,
  appId,
  browserOriginNonce,
  surfaceBaseNonce,
  browserSurfaceKey,
  unprefixed,
  local,
  localHost,
}: {
  canisterId: string;
  appId: string;
  browserOriginNonce?: string;
  surfaceBaseNonce?: string;
  browserSurfaceKey?: InstallationAppSurfaceKey;
  unprefixed?: boolean;
  local: boolean;
  localHost: string;
}): string {
  if (!isValidAppId(appId)) {
    throw new Error(`Invalid app id '${appId}' for app origin`);
  }
  if (local) assertVerifiedLocalAppGateway(localHost);
  if (
    Number(Boolean(unprefixed)) +
      Number(browserOriginNonce !== undefined) +
      Number(surfaceBaseNonce !== undefined) >
    1
  ) {
    throw new Error("App origin selectors are mutually exclusive");
  }
  if (
    (surfaceBaseNonce === undefined) !==
    (browserSurfaceKey === undefined)
  ) {
    throw new Error("Installation origin requires one exact app surface");
  }
  if (unprefixed) {
    return canisterOrigin({ canisterId, local, localHost });
  }
  const prefix = surfaceBaseNonce !== undefined
    ? installationAppSurfacePrefix({
        surfaceBaseNonce,
        surfaceKey: browserSurfaceKey!,
      })
    : browserOriginNonce !== undefined
      ? persistentAppFramePrefix({ browserOriginNonce })
      : appFramePrefix({ appId });
  if (local) return localCanisterOrigin(canisterId, localHost, prefix);
  return `https://${prefixedCanisterLabel(canisterId, prefix)}.icp0.io`;
}

function assertVerifiedLocalAppGateway(localHost: string): void {
  const gateway = new URL(localHost || DEFAULT_LOCAL_HOST);
  const hostname =
    gateway.hostname === "127.0.0.1" || gateway.hostname === "0.0.0.0"
      ? "localhost"
      : gateway.hostname.toLowerCase();
  if (
    gateway.protocol !== "http:" ||
    hostname !== "localhost" ||
    gateway.port !== "8000"
  ) {
    throw new Error(
      "Verified local app origins require the localhost gateway on port 8000",
    );
  }
}

export function isDedicatedAppOrigin(
  href: string | URL,
  canisterId: string,
  appId: string,
  browserOriginNonce?: string,
): boolean {
  if (!isValidAppId(appId)) return false;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  const appUrl = verifiedAppGatewayUrl(url);
  if (
    !appUrl ||
    appUrl.canisterId !== canisterId ||
    appUrl.appId !== appId
  ) return false;
  const prefix = browserOriginNonce
    !== undefined
    ? persistentAppFramePrefix({ browserOriginNonce })
    : appFramePrefix({ appId });
  return appUrl.prefix === prefix;
}

export function isInstallationAppOrigin(
  href: string | URL,
  canisterId: string,
  appId: string,
  surfaceBaseNonce: string,
  surfaceKey: InstallationAppSurfaceKey,
): boolean {
  if (!isValidAppId(appId)) return false;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  const prefix = installationAppSurfacePrefix({
    surfaceBaseNonce,
    surfaceKey,
  });
  const appUrl = verifiedAppGatewayUrl(url);
  return Boolean(
    appUrl &&
      appUrl.canisterId === canisterId &&
      appUrl.appId === appId &&
      appUrl.prefix === prefix,
  );
}

export function appIndexUrl({
  canisterId,
  appId,
  path = "index.html",
  tileId,
  instanceId,
  workspace,
  surfaceBaseNonce,
  unprefixed = false,
  local = false,
  localHost = DEFAULT_LOCAL_HOST,
}: {
  canisterId: string;
  appId: string;
  path?: string;
  tileId?: string;
  instanceId?: string;
  workspace?: number;
  surfaceBaseNonce?: string;
  unprefixed?: boolean;
  local?: boolean;
  localHost?: string;
}): string {
  const search = new URLSearchParams();
  search.set("app", appId);
  if (tileId) search.set("tile", tileId);
  if (instanceId) search.set("instance", instanceId);
  if (workspace) search.set("workspace", String(workspace));
  const query = tileId || instanceId || workspace ? `?${search.toString()}` : "";
  const origin = appCanisterOrigin({
    canisterId,
    appId,
    ...(surfaceBaseNonce !== undefined
      ? {
          surfaceBaseNonce,
          browserSurfaceKey: installationAppTileSurfaceKey(tileId),
        }
      : {}),
    unprefixed,
    local,
    localHost,
  });

  return `${origin}/app/${appId}/${path}${query}`;
}

export function appBackgroundUrl({
  canisterId,
  appId,
  path,
  residentBinding,
  surfaceBaseNonce,
  local = false,
  localHost = DEFAULT_LOCAL_HOST,
}: {
  canisterId: string;
  appId: string;
  path: string;
  residentBinding?: DedicatedResidentBackgroundBinding;
  surfaceBaseNonce?: string;
  local?: boolean;
  localHost?: string;
}): string {
  const search = new URLSearchParams();
  search.set("app", appId);
  search.set("role", "background");
  if (residentBinding) {
    assertDedicatedResidentBackgroundBinding(residentBinding);
    search.set("installation-uid", residentBinding.installationUid);
    search.set("resident-frame-security", residentBinding.mode);
    search.set("browser-origin-nonce", residentBinding.browserOriginNonce);
    search.set(
      "browser-origin-authority-epoch",
      residentBinding.browserOriginAuthorityEpoch,
    );
  }
  const origin = appCanisterOrigin({
    canisterId,
    appId,
    ...(residentBinding
      ? { browserOriginNonce: residentBinding.browserOriginNonce }
      : {}),
    ...(surfaceBaseNonce !== undefined
      ? {
          surfaceBaseNonce,
          browserSurfaceKey: "background" as const,
        }
      : {}),
    local,
    localHost,
  });

  return `${origin}/app/${appId}/${path}?${search.toString()}`;
}

export type DedicatedResidentBackgroundBinding = Readonly<{
  installationUid: string;
  mode:
    | "credentialless_ephemeral_dedicated_v1"
    | "persistent_dedicated_v1";
  browserOriginNonce: string;
  browserOriginAuthorityEpoch: string;
}>;

const NAT64_MAX = 18_446_744_073_709_551_615n;

function assertDedicatedResidentBackgroundBinding(
  binding: DedicatedResidentBackgroundBinding,
): void {
  if (
    !isCanonicalPositiveNat64(binding.installationUid) ||
    (binding.mode !== "credentialless_ephemeral_dedicated_v1" &&
      binding.mode !== "persistent_dedicated_v1") ||
    !/^[a-f0-9]{32}$/u.test(binding.browserOriginNonce) ||
    !isCanonicalPositiveNat64(binding.browserOriginAuthorityEpoch)
  ) {
    throw new Error("Invalid dedicated resident background binding");
  }
}

function isCanonicalPositiveNat64(value: string): boolean {
  if (!/^[1-9][0-9]*$/u.test(value)) return false;
  try {
    return BigInt(value) <= NAT64_MAX;
  } catch {
    return false;
  }
}

export function appTrayUrl({
  canisterId,
  appId,
  path,
  instanceId,
  surfaceBaseNonce,
  unprefixed = false,
  local = false,
  localHost = DEFAULT_LOCAL_HOST,
}: {
  canisterId: string;
  appId: string;
  path: string;
  instanceId: string;
  surfaceBaseNonce?: string;
  unprefixed?: boolean;
  local?: boolean;
  localHost?: string;
}): string {
  const search = new URLSearchParams();
  search.set("app", appId);
  search.set("role", "tray");
  search.set("instance", instanceId);
  const origin = appCanisterOrigin({
    canisterId,
    appId,
    ...(surfaceBaseNonce !== undefined
      ? {
          surfaceBaseNonce,
          browserSurfaceKey: "tray" as const,
        }
      : {}),
    unprefixed,
    local,
    localHost,
  });

  return `${origin}/app/${appId}/${path}?${search.toString()}`;
}

export function installationAppTileSurfaceKey(
  tileId: string | undefined,
): InstallationAppSurfaceKey {
  if (!tileId || !isValidTileId(tileId)) {
    throw new Error("Installation-origin tile URL requires a valid tile id");
  }
  return `tile:${tileId}`;
}

export function neutronUrl({
  canisterId,
  local = false,
  localHost = DEFAULT_LOCAL_HOST,
}: {
  canisterId: string;
  local?: boolean;
  localHost?: string;
}): string {
  return `${canisterOrigin({ canisterId, local, localHost })}/`;
}

export function icHost({
  local = false,
  localHost = DEFAULT_LOCAL_HOST,
}: {
  local?: boolean;
  localHost?: string;
} = {}): string {
  return local ? localHost : "https://icp-api.io";
}

export function localIdentityProvider(localHost = DEFAULT_LOCAL_HOST): string {
  const gateway = new URL(localHost || DEFAULT_LOCAL_HOST);
  const hostname =
    gateway.hostname === "127.0.0.1" || gateway.hostname === "0.0.0.0"
      ? "localhost"
      : gateway.hostname;
  return `${gateway.protocol}//id.ai.${hostname}${
    gateway.port ? `:${gateway.port}` : ""
  }/`;
}

export function scopedLocalIdentityProvider({
  neutronCanisterId,
  localHost = DEFAULT_LOCAL_HOST,
}: {
  neutronCanisterId: string;
  localHost?: string;
}): string {
  const gateway = new URL(localHost || DEFAULT_LOCAL_HOST);
  const supportsCanisterSubdomains =
    gateway.hostname === "127.0.0.1" ||
    gateway.hostname === "0.0.0.0" ||
    usesLocalCanisterSubdomains(gateway.hostname);
  if (!supportsCanisterSubdomains) return localIdentityProvider(localHost);

  const origin = localCanisterOrigin(
    LOCAL_II_FRONTEND_CANISTER_ID,
    localHost,
    `ii-${neutronCanisterId}`
  );
  return `${origin}/`;
}
