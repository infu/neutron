import {
  isJsonObject,
  type BackendCallReservationsRequest,
  type JsonValue,
} from "neutron-tools/app";
import { physicalPublicIngressMethodName } from "neutron-tools/src/physical_names.js";
import {
  normalizeGameId,
  normalizePrincipal,
  type ChessInvite,
} from "./invite_code.ts";

// Ordinary app methods are physically namespaced in the assembled Neutron
// actor. The manifest and self-call API retain the logical method name.
export const REMOTE_EXCHANGE_METHOD =
  physicalPublicIngressMethodName("chess", "chess_v1", "update");

export type RemotePushTarget = {
  gameId: string;
  guestPrincipal: string;
  method: typeof REMOTE_EXCHANGE_METHOD;
  pendingRevision: string | null;
};

export function remoteJoinRequest(
  tileId: string,
  invite: ChessInvite,
): BackendCallReservationsRequest {
  return {
    actions: [
      {
        kind: "reserve",
        scope: {
          kind: "exact",
          principal: invite.hostPrincipal,
          method: REMOTE_EXCHANGE_METHOD,
        },
      },
    ],
    call: {
      method: "chess_join_game",
      args: [
        {
          tile_id: tileId,
          host: invite.hostPrincipal,
          game_id: invite.gameId,
        },
      ],
    },
  };
}

export function parseRemotePushTarget(value: JsonValue): RemotePushTarget | null {
  if (value === null) return null;
  if (!isJsonObject(value)) throw new Error("Invalid remote push target");
  const keys = Object.keys(value).sort();
  if (
    keys.join(",") !== "game_id,guest,method" &&
    keys.join(",") !== "game_id,guest,method,pending_revision"
  ) {
    throw new Error("Invalid remote push target");
  }
  if (typeof value.game_id !== "string" || typeof value.guest !== "string") {
    throw new Error("Invalid remote push target");
  }
  if (value.method !== REMOTE_EXCHANGE_METHOD) {
    throw new Error("Invalid remote push method");
  }
  // Motoko optional record fields are omitted by the JSON bridge when null.
  const pending = value.pending_revision ?? null;
  if (
    pending !== null &&
    (typeof pending !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(pending))
  ) {
    throw new Error("Invalid remote push revision");
  }
  return {
    gameId: normalizeGameId(value.game_id),
    guestPrincipal: normalizePrincipal(value.guest),
    method: REMOTE_EXCHANGE_METHOD,
    pendingRevision: pending,
  };
}

export function hasRemotePushReservation(
  value: JsonValue,
  target: RemotePushTarget,
): boolean {
  if (!isJsonObject(value) || !Array.isArray(value.reservations)) {
    throw new Error("Invalid Chess backend reservation response");
  }
  return value.reservations.some((candidate) => {
    if (!isJsonObject(candidate)) {
      throw new Error("Invalid Chess backend reservation");
    }
    if (candidate.appId !== "chess") {
      throw new Error("Invalid Chess backend reservation owner");
    }
    return (
      candidate.scopeKind === "exact" &&
      candidate.principal === target.guestPrincipal &&
      candidate.method === target.method
    );
  });
}

export function remotePushReservationRequest(
  tileId: string,
  target: RemotePushTarget,
): BackendCallReservationsRequest {
  return {
    actions: [
      {
        kind: "reserve",
        scope: {
          kind: "exact",
          principal: target.guestPrincipal,
          method: target.method,
        },
      },
    ],
    call: {
      method: "chess_sync_game",
      args: [{ tile_id: tileId }],
    },
  };
}

export function remotePushAttemptKey(target: RemotePushTarget): string {
  return (
    `${target.gameId}:${target.guestPrincipal}:${target.method}:` +
    (target.pendingRevision ?? "grant")
  );
}
