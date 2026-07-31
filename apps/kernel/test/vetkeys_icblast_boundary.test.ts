import { describe, expect, test } from "bun:test";
import { VET_KEYS_ERROR_CODES } from "neutron-tools";
import {
  normalizeVetKeysIcblastFailure,
  normalizeVetKeysIcblastSuccess,
} from "../src/vetkeys/icblast_boundary.ts";
import { unwrapVetKeysOperationResult } from "../src/vetkeys/service.ts";

const OPERATIONS = [
  "kernel_vetkeys_binding",
  "kernel_vetkeys_reserve",
  "kernel_vetkeys_enable",
  "kernel_vetkeys_disable",
  "kernel_vetkeys_rotate",
  "kernel_vetkeys_retire_generation",
  "kernel_vetkeys_transfer",
  "kernel_vetkeys_retire_slot",
  "kernel_vetkeys_public_key",
  "kernel_vetkeys_derive",
];

describe("icblast vetKeys result boundary", () => {
  test("restores a result envelope for every unwrapped operation success", () => {
    for (const method of OPERATIONS) {
      const bare = method === "kernel_vetkeys_retire_slot" ? null : { value: method };
      expect(normalizeVetKeysIcblastSuccess(method, bare)).toEqual({ ok: bare });
    }
    const list = [{ slot: "mailbox" }];
    expect(normalizeVetKeysIcblastSuccess("kernel_vetkeys_list", list)).toBe(list);
  });

  test("retains direct canonical Ok/Err results", () => {
    const ok = { ok: { slot: "mailbox" } };
    const err = { err: { disabled: null } };
    expect(normalizeVetKeysIcblastSuccess("kernel_vetkeys_reserve", ok)).toBe(ok);
    expect(normalizeVetKeysIcblastSuccess("kernel_vetkeys_reserve", err)).toBe(err);
  });

  test("reconstructs every thrown closed error without leaking extra data", () => {
    for (const code of VET_KEYS_ERROR_CODES) {
      const thrown = { [code]: null };
      const normalized = normalizeVetKeysIcblastFailure(
        "kernel_vetkeys_derive",
        thrown,
      );
      expect(normalized).toEqual({ err: { [code]: null } });
      expect(() => unwrapVetKeysOperationResult(normalized, "fixture")).toThrow();
    }
  });

  test("rejects malformed, unknown, and non-operation failures", () => {
    const malformed = [
      null,
      {},
      { disabled: null, busy: null },
      { unknown: null },
      { disabled: "backend detail" },
      { rate_limited: null },
    ];
    for (const value of malformed) {
      expect(
        normalizeVetKeysIcblastFailure("kernel_vetkeys_public_key", value),
      ).toBeNull();
    }
    expect(
      normalizeVetKeysIcblastFailure("kernel_vetkeys_list", { disabled: null }),
    ).toBeNull();
  });
});
