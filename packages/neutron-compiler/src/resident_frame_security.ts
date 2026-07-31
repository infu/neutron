import type { CapabilityPlanWireV1 } from "neutron-tools/src/capabilities/wire.js";
import type { NeutronResidentFrameSecurityMode } from "neutron-tools/src/capabilities/catalog.js";

export type ResidentFrameSecurity = NeutronResidentFrameSecurityMode;

export const DEFAULT_RESIDENT_FRAME_SECURITY =
  "credentialless_opaque_v1" as const;

export function residentFrameSecurity(
  plan: Pick<CapabilityPlanWireV1, "entries">,
): ResidentFrameSecurity {
  const background = plan.entries.find(
    (entry) => entry.id === "background_endpoint",
  );
  if (!background) return DEFAULT_RESIDENT_FRAME_SECURITY;
  if (background.id !== "background_endpoint") {
    return DEFAULT_RESIDENT_FRAME_SECURITY;
  }
  const mode = background.config.frame_security;
  assertResidentFrameSecurity(mode);
  return mode;
}

export function assertResidentFrameSecurity(
  value: unknown,
): asserts value is NeutronResidentFrameSecurityMode {
  if (
    value !== "credentialless_opaque_v1" &&
    value !== "credentialless_ephemeral_dedicated_v1" &&
    value !== "persistent_dedicated_v1"
  ) {
    throw new Error(`Invalid resident frame security ${String(value)}`);
  }
}
