import { Principal } from "@dfinity/principal";
import {
  NEUTRON_POCKET_IC_SUBNET_KINDS,
  type PocketIcTopology,
} from "../src/pocketic_rest.ts";

export function pocketIcTestTopology(): PocketIcTopology {
  return {
    subnet_configs: Object.fromEntries(
      NEUTRON_POCKET_IC_SUBNET_KINDS.map((subnet_kind, index) => [
        Principal.selfAuthenticating(new Uint8Array(32).fill(index + 1)).toText(),
        {
          subnet_kind,
          subnet_admins: null,
          cost_schedule: "Normal" as const,
          subnet_seed: new Array<number>(32).fill(index),
          instruction_config: "Production" as const,
          canister_ranges: [
            {
              start: { canister_id: Buffer.from([index]).toString("base64") },
              end: { canister_id: Buffer.from([index, 255]).toString("base64") },
            },
          ],
        },
      ]),
    ),
    default_effective_canister_id: {
      canister_id: Buffer.from([42, 1, 1]).toString("base64"),
    },
  };
}

export function pocketIcCreatedResponse(topology = pocketIcTestTopology()): unknown {
  return {
    Created: {
      instance_id: 0,
      topology,
      http_gateway_info: {
        instance_id: 0,
        port: 8000,
      },
    },
  };
}

export function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
