import { expect, test } from "bun:test";
import {
  REMOTE_EXCHANGE_METHOD,
  hasRemotePushReservation,
  parseRemotePushTarget,
  remoteJoinRequest,
  remotePushAttemptKey,
  remotePushReservationRequest,
} from "../src/remote_connection.ts";

test("Remote Chess asks only for the host exchange method and joins after approval", () => {
  const request = remoteJoinRequest("tile-17", {
    version: 1,
    hostPrincipal: "un4fu-tqaaa-aaaab-qadjq-cai",
    gameId: "00112233445566778899aabbccddeeff",
  });

  expect(request).toEqual({
    actions: [
      {
        kind: "reserve",
        scope: {
          kind: "exact",
          principal: "un4fu-tqaaa-aaaab-qadjq-cai",
          method: REMOTE_EXCHANGE_METHOD,
        },
      },
    ],
    call: {
      method: "chess_join_game",
      args: [
        {
          tile_id: "tile-17",
          host: "un4fu-tqaaa-aaaab-qadjq-cai",
          game_id: "00112233445566778899aabbccddeeff",
        },
      ],
    },
  });
});

test("Remote Chess requests reciprocal exact access and retries the pending push atomically", () => {
  const target = parseRemotePushTarget({
    game_id: "00112233445566778899aabbccddeeff_7",
    guest: "un4fu-tqaaa-aaaab-qadjq-cai",
    method: REMOTE_EXCHANGE_METHOD,
    pending_revision: "42",
  });
  expect(target).not.toBeNull();
  if (!target) throw new Error("Missing target");

  expect(remotePushReservationRequest("host-tile", target)).toEqual({
    actions: [{
      kind: "reserve",
      scope: {
        kind: "exact",
        principal: "un4fu-tqaaa-aaaab-qadjq-cai",
        method: REMOTE_EXCHANGE_METHOD,
      },
    }],
    call: {
      method: "chess_sync_game",
      args: [{ tile_id: "host-tile" }],
    },
  });
  expect(remotePushAttemptKey(target)).toEndWith(":42");
  expect(remotePushAttemptKey({ ...target, pendingRevision: null }))
    .toEndWith(":grant");
});

test("Remote Chess accepts an acknowledged push target with no optional pending revision", () => {
  expect(parseRemotePushTarget({
    game_id: "00112233445566778899aabbccddeeff_7",
    guest: "un4fu-tqaaa-aaaab-qadjq-cai",
    method: REMOTE_EXCHANGE_METHOD,
  })).toEqual({
    gameId: "00112233445566778899aabbccddeeff_7",
    guestPrincipal: "un4fu-tqaaa-aaaab-qadjq-cai",
    method: REMOTE_EXCHANGE_METHOD,
    pendingRevision: null,
  });
});

test("Remote Chess detects only its exact reciprocal reservation", () => {
  const target = parseRemotePushTarget({
    game_id: "00112233445566778899aabbccddeeff_7",
    guest: "un4fu-tqaaa-aaaab-qadjq-cai",
    method: REMOTE_EXCHANGE_METHOD,
    pending_revision: null,
  })!;
  const response = {
    reservations: [{
      id: "1",
      appId: "chess",
      scopeKind: "exact",
      principal: target.guestPrincipal,
      method: target.method,
      createdAt: "2",
      createdBy: "aaaaa-aa",
    }],
  };
  expect(hasRemotePushReservation(response, target)).toBe(true);
  expect(hasRemotePushReservation({
    reservations: [{
      ...response.reservations[0],
      principal: "ryjl3-tyaaa-aaaaa-aaaba-cai",
    }],
  }, target)).toBe(false);
});

test("Remote Chess rejects malformed or broadened reciprocal target facts", () => {
  expect(() => parseRemotePushTarget({
    game_id: "00112233445566778899aabbccddeeff_7",
    guest: "un4fu-tqaaa-aaaab-qadjq-cai",
    method: "other_method",
    pending_revision: "42",
  })).toThrow("Invalid remote push method");
  expect(() => parseRemotePushTarget({
    game_id: "00112233445566778899aabbccddeeff_7",
    guest: "un4fu-tqaaa-aaaab-qadjq-cai",
    method: REMOTE_EXCHANGE_METHOD,
    pending_revision: -1,
  })).toThrow("Invalid remote push revision");
  expect(() => hasRemotePushReservation({
    reservations: [{
      appId: "mail",
      scopeKind: "exact",
      principal: "un4fu-tqaaa-aaaab-qadjq-cai",
      method: REMOTE_EXCHANGE_METHOD,
    }],
  }, {
    gameId: "00112233445566778899aabbccddeeff_7",
    guestPrincipal: "un4fu-tqaaa-aaaab-qadjq-cai",
    method: REMOTE_EXCHANGE_METHOD,
    pendingRevision: null,
  })).toThrow("Invalid Chess backend reservation owner");
});
