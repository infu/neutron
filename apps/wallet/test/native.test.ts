import { expect, test } from "bun:test";
import {
  defaultSubaccountWord,
  ethereumPrincipalWord,
  icrcDepositAddress,
  queryTransport,
} from "../src/native.ts";

test("Wallet derives canonical default-account deposit values", () => {
  const owner = "4caro-hl777-77775-aaaba-cai";
  expect(icrcDepositAddress(owner)).toBe(owner);
  expect(ethereumPrincipalWord(owner)).toMatch(/^0x[0-9a-f]{64}$/);
  expect(defaultSubaccountWord()).toBe(`0x${"00".repeat(32)}`);
});

test("Wallet resolves isolated local app origins to the local API gateway", () => {
  expect(
    queryTransport(
      "http://awalleta--4caro-hl777-77775-aaaba-cai.localhost:8000/app/wallet/index.html",
    ),
  ).toEqual({ host: "http://localhost:8000", local: true });
  expect(
    queryTransport(
      "https://awalleta--4caro-hl777-77775-aaaba-cai.raw.icp0.io/app/wallet/index.html",
    ),
  ).toEqual({ host: "https://icp-api.io", local: false });
});
