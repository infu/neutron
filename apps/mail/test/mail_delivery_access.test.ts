import { expect, test } from "bun:test";
import type {
  BackendCallReservationsRequest,
  JsonValue,
} from "neutron-tools/app";
import { CANISTER_METHOD_MAX_LENGTH } from "neutron-tools/src/physical_names.js";
import {
  ensureMailDeliveryReservations,
  parseMailDeliveryReservationState,
  readMailDeliveryReservationState,
} from "../src/mail_delivery_access.ts";

const MAIL_INGRESS_METHOD = "app_mail__mail_v1_update";

test("delivery setup reserves the Mail protocol once without a post-grant call", async () => {
  let listCalls = 0;
  const captured: BackendCallReservationsRequest[] = [];
  const list = async (): Promise<JsonValue> => {
    listCalls += 1;
    return { reservations: [] };
  };
  const request = async (
    input: BackendCallReservationsRequest,
  ): Promise<JsonValue> => {
    captured.push(input);
    return {
      reservations: [reservation(MAIL_INGRESS_METHOD)],
    };
  };

  const state = await ensureMailDeliveryReservations(list, request);

  expect(listCalls).toBe(1);
  expect(captured).toEqual([{
    actions: [
      { kind: "reserve", scope: { kind: "method", method: MAIL_INGRESS_METHOD } },
    ],
  }]);
  expect(state).toEqual({
    complete: true,
    ownedMethods: [MAIL_INGRESS_METHOD],
    missingMethods: [],
  });
});

test("delivery setup ignores unrelated reservations and requests the protocol", async () => {
  const captured: BackendCallReservationsRequest[] = [];
  const state = await ensureMailDeliveryReservations(
    async () => ({ reservations: [reservation("unrelated_method")] }),
    async (input) => {
      captured.push(input);
      return {
        reservations: [reservation("unrelated_method"), reservation(MAIL_INGRESS_METHOD)],
      };
    },
  );

  expect(captured).toEqual([{
    actions: [{
      kind: "reserve",
      scope: { kind: "method", method: MAIL_INGRESS_METHOD },
    }],
  }]);
  expect(state.complete).toBe(true);
});

test("delivery setup does not request access when Mail already owns its protocol", async () => {
  let requestCalls = 0;
  const state = await ensureMailDeliveryReservations(
    async () => ({
      reservations: [reservation(MAIL_INGRESS_METHOD)],
    }),
    async () => {
      requestCalls += 1;
      throw new Error("must not request");
    },
  );

  expect(requestCalls).toBe(0);
  expect(state.complete).toBe(true);
});

test("delivery reservation reads are strict and fail closed", async () => {
  await expect(readMailDeliveryReservationState(async () => ({
    reservations: [{ ...reservation(MAIL_INGRESS_METHOD), appId: "other" }],
  }))).rejects.toThrow("Invalid Mail delivery reservation owner");

  expect(() => parseMailDeliveryReservationState({
    reservations: [{
      ...reservation(MAIL_INGRESS_METHOD),
      installationUid: "not-a-number",
    }],
  })).toThrow("Invalid Mail delivery access decimal");

  expect(() => parseMailDeliveryReservationState({
    reservations: [reservation(MAIL_INGRESS_METHOD)],
    unexpected: true,
  })).toThrow("Invalid Mail delivery access value");

  expect(() => parseMailDeliveryReservationState({
    reservations: [{
      ...reservation(MAIL_INGRESS_METHOD),
      principal: "ryjl3-tyaaa-aaaaa-aaaba-cai",
    }],
  })).toThrow("Invalid Mail delivery reservation scope");

  expect(parseMailDeliveryReservationState({
    reservations: [reservation("m".repeat(CANISTER_METHOD_MAX_LENGTH))],
  }).complete).toBe(false);
  expect(() => parseMailDeliveryReservationState({
    reservations: [
      reservation("m".repeat(CANISTER_METHOD_MAX_LENGTH + 1)),
    ],
  })).toThrow("Invalid Mail delivery reservation method");
});

test("delivery setup rejects malformed or incomplete apply responses", async () => {
  const missing = () => Promise.resolve({ reservations: [] } as JsonValue);

  await expect(ensureMailDeliveryReservations(
    missing,
    async () => ({ reservations: "not-an-array" }),
  )).rejects.toThrow("Invalid Mail delivery reservation response");

  await expect(ensureMailDeliveryReservations(
    missing,
    async () => ({ reservations: [reservation("unrelated_method")] }),
  )).rejects.toThrow("Mail delivery methods were not reserved");
});

test("delivery setup propagates a denied reservation request and never retries it", async () => {
  let requestCalls = 0;
  await expect(ensureMailDeliveryReservations(
    async () => ({ reservations: [] }),
    async () => {
      requestCalls += 1;
      throw new Error("User cancelled");
    },
  )).rejects.toThrow("User cancelled");
  expect(requestCalls).toBe(1);
});

function reservation(method: string) {
  return {
    id: method === MAIL_INGRESS_METHOD ? "1" : "2",
    appId: "mail",
    installationUid: "100",
    scopeKind: "method",
    principal: null,
    method,
    createdAt: "1",
    createdBy: "aaaaa-aa",
  };
}
