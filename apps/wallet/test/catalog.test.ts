import { expect, test } from "bun:test";
import {
  parseCustomLedgerPrincipal,
  WALLET_LEDGER_LIMIT,
} from "../src/catalog.ts";

test("custom ledger input accepts and canonicalizes an IC principal", () => {
  expect(
    parseCustomLedgerPrincipal("  ryjl3-tyaaa-aaaaa-aaaba-cai  "),
  ).toBe("ryjl3-tyaaa-aaaaa-aaaba-cai");
});

test("custom ledger input rejects empty and invalid principals", () => {
  expect(() => parseCustomLedgerPrincipal("   ")).toThrow(
    "Enter a ledger canister ID",
  );
  expect(() => parseCustomLedgerPrincipal("not-a-principal")).toThrow(
    "Enter a valid IC principal",
  );
});

test("custom ledger input rejects special non-ledger principals", () => {
  expect(() => parseCustomLedgerPrincipal("2vxsx-fae")).toThrow(
    "The anonymous principal cannot be a ledger",
  );
  expect(() => parseCustomLedgerPrincipal("aaaaa-aa")).toThrow(
    "The management canister cannot be a ledger",
  );
});

test("Wallet exposes its selected ledger limit", () => {
  expect(WALLET_LEDGER_LIMIT).toBe(16);
});
