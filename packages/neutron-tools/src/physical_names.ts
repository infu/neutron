import { isValidAppId } from "./app_ids.ts";

const LOCAL_SYMBOL_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
export { APP_ID_MAX_LENGTH } from "./app_ids.ts";
export const LOCAL_SYMBOL_MAX_LENGTH = 128;
export const PHYSICAL_APP_METHOD_MAX_LENGTH = 164;
export const PHYSICAL_PUBLIC_INGRESS_METHOD_MAX_LENGTH = 106;
/** Bounded transport limit with headroom over the longest V1 app wrapper. */
export const CANISTER_METHOD_MAX_LENGTH = 192;

function assertAppId(appId: string): void {
  if (!isValidAppId(appId)) {
    throw new Error(`Invalid app id for physical name: ${appId}`);
  }
}

function assertLocalSymbol(localId: string): void {
  if (
    localId.length > LOCAL_SYMBOL_MAX_LENGTH ||
    !LOCAL_SYMBOL_PATTERN.test(localId)
  ) {
    throw new Error(`Invalid local id for physical name: ${localId}`);
  }
}

/**
 * Collision-proof Motoko identifier fragment for an app-owned local resource.
 * Both component lengths are encoded so callers may safely append their own
 * version or role suffixes without reintroducing an ambiguous boundary.
 */
export function scopedPhysicalStem(appId: string, localId: string): string {
  const appStem = appPhysicalStem(appId);
  assertLocalSymbol(localId);
  return `${appStem}_r${localId.length}_${localId}`;
}

/** Collision-proof fragment for identifiers owned by an app as a whole. */
export function appPhysicalStem(appId: string): string {
  assertAppId(appId);
  return `a${appId.length}_${appId}`;
}

/**
 * Stable Candid name for one ordinary app method in the combined Neutron
 * actor. The compiler-owned `__` separator cannot occur in a canonical app
 * id, so the app and local method boundary is unambiguous.
 *
 * Kernel methods deliberately remain unmangled and do not use this helper.
 */
export function physicalAppMethodName(
  appId: string,
  localMethod: string,
): string {
  assertAppId(appId);
  assertLocalSymbol(localMethod);
  const physical = `app_${appId}__${localMethod}`;
  if (physical.length > PHYSICAL_APP_METHOD_MAX_LENGTH) {
    throw new Error("Physical app method exceeds its compiler bound");
  }
  return physical;
}

/**
 * Stable dispatcher name for one app-local public-ingress protocol and mode.
 * Route ids remain inside the bounded request; this endpoint is shared by all
 * routes with the same app, protocol, and query/update mode.
 */
export function physicalPublicIngressMethodName(
  appId: string,
  protocol: string,
  mode: "query" | "update",
): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(protocol)) {
    throw new Error(`Invalid public ingress protocol: ${protocol}`);
  }
  if (mode !== "query" && mode !== "update") {
    throw new Error(`Invalid public ingress mode: ${String(mode)}`);
  }
  assertAppId(appId);
  const physical = `app_${appId}__${protocol}_${mode}`;
  if (physical.length > PHYSICAL_PUBLIC_INGRESS_METHOD_MAX_LENGTH) {
    throw new Error("Physical public ingress method exceeds its compiler bound");
  }
  return physical;
}
