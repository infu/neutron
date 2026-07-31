import { Principal } from "@dfinity/principal";
import type { NeutronBackendCallReservation } from "./catalog.ts";
import {
  getCapabilityPlanEntry,
  type CapabilityPlanWireV1,
} from "./wire.ts";

export type BackendCallReservationActionV1 = {
  kind: "reserve" | "release";
  scope: NeutronBackendCallReservation;
};

export function installBackendCallReservationActions(
  plan: CapabilityPlanWireV1,
): BackendCallReservationActionV1[] {
  const configured =
    getCapabilityPlanEntry(plan, "backend_calls")?.config
      .install_reservations ?? [];
  return configured.map((scope) => ({ kind: "reserve", scope }));
}

export function backendCallReservationActionToCandid(
  action: BackendCallReservationActionV1,
): unknown {
  const { scope } = action;
  const encoded =
    scope.kind === "principal"
      ? { principal: Principal.fromText(scope.principal) }
      : scope.kind === "method"
        ? { method: scope.method }
        : {
            exact: {
              principal: Principal.fromText(scope.principal),
              method: scope.method,
            },
          };
  return { [action.kind]: encoded };
}
