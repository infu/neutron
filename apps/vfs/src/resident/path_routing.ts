/**
 * Resident-only routing authority.
 *
 * The public tool surface always supplies the rooted policy token; callers
 * cannot select routing in JSON. The legacy token remains resident-internal
 * only for migration adapters and their compatibility tests. The rooted port
 * falls back to that closed behavior for an absent or forged value.
 */
const FILES_PATH_ROUTING_BRAND: unique symbol = Symbol(
  "neutron.files.path-routing",
);

export type FilesPathRoutingMode = "legacy_vault" | "policy_v3";

export type FilesPathRouting = Readonly<{
  mode: FilesPathRoutingMode;
  [FILES_PATH_ROUTING_BRAND]: true;
}>;

function route(mode: FilesPathRoutingMode): FilesPathRouting {
  return Object.freeze({
    mode,
    [FILES_PATH_ROUTING_BRAND]: true as const,
  });
}

export const FILES_LEGACY_VAULT_PATH_ROUTING = route("legacy_vault");
export const FILES_POLICY_V3_PATH_ROUTING = route("policy_v3");

export function filesPathRoutingMode(
  routing: FilesPathRouting | undefined,
): FilesPathRoutingMode {
  return routing === FILES_POLICY_V3_PATH_ROUTING
    ? "policy_v3"
    : "legacy_vault";
}
