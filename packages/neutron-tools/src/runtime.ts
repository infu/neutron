import { isValidAppId } from "./app_ids.ts";

export const DEFAULT_LOCAL_HOST = "http://localhost:8000";
export const LOCAL_II_FRONTEND_CANISTER_ID =
  "uqzsh-gqaaa-aaaaq-qaada-cai";

const DNS_LABEL_MAX_LENGTH = 63;

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
 * Opaque-mode app frames use an isolated verified subdomain; frames belonging
 * to an app with a dedicated resident may use the verified unprefixed canister
 * origin, which is also the trusted shell origin. Unverified raw/custom
 * gateways are not valid parent-authentication surfaces.
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
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  const canisterId = canisterIdFromUrl(url);
  if (!canisterId) return null;
  const port = url.port ? `:${url.port}` : "";
  const hostname = url.hostname.toLowerCase();

  // Raw gateways deliberately skip response verification. They are not a
  // valid parent-authentication surface for Neutron app frames.
  if (
    hostname.endsWith(".raw.icp0.io") ||
    hostname.endsWith(".raw.ic0.app") ||
    hostname.endsWith(".raw.icp.net")
  ) return null;

  const mainnetSuffix = ".icp0.io";
  if (hostname.endsWith(mainnetSuffix)) {
    const firstLabel = hostname.split(".")[0] ?? "";
    if (firstLabel.endsWith(`--${canisterId}`)) {
      return `${url.protocol}//${canisterId}${mainnetSuffix}${port}`;
    }
    return url.origin;
  }

  if (url.port === "8000" && hostname.endsWith(".localhost")) {
    const labels = hostname.split(".");
    const first = labels[0] ?? "";
    if (first === canisterId || first.endsWith(`--${canisterId}`)) {
      const suffix = labels.slice(1).join(".");
      return `${url.protocol}//${canisterId}${suffix ? `.${suffix}` : ""}${port}`;
    }
  }

  return null;
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
  if (!/^[a-f0-9]{32}$/u.test(browserOriginNonce)) {
    throw new Error("Invalid browser-origin nonce");
  }
  // Ninety-six bits of the kernel-assigned nonce keep the DNS label compact
  // enough to coexist with the canister suffix while making an app reinstall
  // a different browser origin. App identity remains source-bound by the
  // kernel and request path; this label is a storage partition identifier,
  // never an authority token or secret.
  const prefix = `p${browserOriginNonce.slice(0, 24)}`;
  if (prefix.length > maxLength) {
    throw new Error("Persistent app origin prefix exceeds DNS limits");
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
  unprefixed,
  local,
  localHost,
}: {
  canisterId: string;
  appId: string;
  browserOriginNonce?: string;
  unprefixed?: boolean;
  local: boolean;
  localHost: string;
}): string {
  if (local) assertVerifiedLocalAppGateway(localHost);
  if (unprefixed) {
    return canisterOrigin({ canisterId, local, localHost });
  }
  const prefix = browserOriginNonce
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
  if (hostname !== "localhost" || gateway.port !== "8000") {
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
  const url = new URL(href);
  const prefix = browserOriginNonce
    ? persistentAppFramePrefix({ browserOriginNonce })
    : appFramePrefix({ appId });
  return url.hostname.split(".")[0] === prefixedCanisterLabel(canisterId, prefix);
}

export function appIndexUrl({
  canisterId,
  appId,
  path = "index.html",
  tileId,
  instanceId,
  workspace,
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
  local = false,
  localHost = DEFAULT_LOCAL_HOST,
}: {
  canisterId: string;
  appId: string;
  path: string;
  residentBinding?: DedicatedResidentBackgroundBinding;
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
  unprefixed = false,
  local = false,
  localHost = DEFAULT_LOCAL_HOST,
}: {
  canisterId: string;
  appId: string;
  path: string;
  instanceId: string;
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
    unprefixed,
    local,
    localHost,
  });

  return `${origin}/app/${appId}/${path}?${search.toString()}`;
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
