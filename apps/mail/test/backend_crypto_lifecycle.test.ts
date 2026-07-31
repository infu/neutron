import { describe, expect, test } from "bun:test";
import { toError } from "neutron-tools/app";
import {
  isMailCryptoNotConfiguredError,
  parseMailCryptoStatus,
} from "../src/backend.ts";

const HOLDER = "pcofx-mj5y3-27jya-3jcsk-jzcy2-2y6yj-bvf32-ousik-tb3ks-uyjkz-rqe";

function progress(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mail_revision: "8",
    key_holder: HOLDER,
    current_epoch: "3",
    previous_epoch: null,
    previous_references: {
      settings: "0",
      inbox: "0",
      outbox: "0",
      total: "0",
    },
    ready_to_retire: false,
    ...overrides,
  };
}

describe("Mail crypto lifecycle decoding", () => {
  test("accepts strict bare configured progress and the current rejected error", () => {
    expect(parseMailCryptoStatus(progress())).toEqual({
      revision: "8",
      keyHolder: HOLDER,
      currentEpoch: "3",
      previousEpoch: null,
      previousReferences: { settings: "0", inbox: "0", outbox: "0", total: "0" },
      readyToRetire: false,
    });
    expect(isMailCryptoNotConfiguredError(toError({
      name: "CanisterResultError",
      message: "Canister call returned a domain error",
      code: "not_configured",
    }))).toBe(true);
  });

  test("validates previous reference sums and retirement readiness", () => {
    expect(parseMailCryptoStatus(progress({
      previous_epoch: "2",
      previous_references: {
        settings: "0",
        inbox: "0",
        outbox: "0",
        total: "0",
      },
      ready_to_retire: true,
    }))).toMatchObject({ previousEpoch: "2", readyToRetire: true });

    expect(() => parseMailCryptoStatus(progress({
      previous_references: {
        settings: "1",
        inbox: "0",
        outbox: "0",
        total: "0",
      },
    }))).toThrow("Invalid Mail crypto previous references");
    expect(() => parseMailCryptoStatus(
      progress({ previous_epoch: "2", ready_to_retire: false }),
    )).toThrow("Invalid Mail crypto retirement state");
  });

  test("rejects obsolete raw Result success, error, and ambiguous wrappers", () => {
    for (const value of [
      { ok: progress() },
      { err: { vetkeys: { busy: null } } },
      { ok: progress(), err: { not_configured: null } },
    ]) {
      expect(() => parseMailCryptoStatus(value)).toThrow(
        "Invalid Mail crypto progress",
      );
    }
  });

  test("only the exact classified not-configured error becomes empty state", () => {
    for (const code of [
      "generation_unavailable",
      "capability_changed",
      "key_holder_changed",
    ]) {
      expect(isMailCryptoNotConfiguredError(toError({
        name: "CanisterResultError",
        message: "Canister call returned a domain error",
        code,
      }))).toBe(false);
    }
    expect(isMailCryptoNotConfiguredError(new Error("not_configured"))).toBe(false);
  });

  test("rejects zero epochs, noncanonical principals, extra fields, and bad totals", () => {
    const cases = [
      progress({ current_epoch: "0" }),
      progress({ previous_epoch: "0" }),
      progress({ key_holder: "2vxsx-fae" }),
      progress({ extra: true }),
      progress({
        previous_references: { settings: "0", inbox: "0", outbox: "0", total: "00" },
      }),
    ];
    for (const value of cases) {
      expect(() => parseMailCryptoStatus(value)).toThrow();
    }
  });
});
