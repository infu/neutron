import { expect, spyOn, test } from "bun:test";
import { HttpAgent } from "@dfinity/agent";
import {
  defaultSubaccountWord,
  ethereumPrincipalWord,
  icrcDepositAddress,
  queryTransport,
  queryAgent,
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


test("a failed query agent initialization can retry, then reuses its successful agent", async () => {
  const href = "http://localhost:18379/app/wallet/index.html";
  let attempts = 0;
  let rootKeyReads = 0;
  const ready = { fetchRootKey: async () => { rootKeyReads += 1; } } as unknown as HttpAgent;
  const create = spyOn(HttpAgent, "create").mockImplementation(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("temporary gateway failure");
    return ready;
  });
  try {
    await expect(queryAgent(href)).rejects.toThrow("temporary gateway failure");
    expect(await queryAgent(href)).toBe(ready);
    expect(await queryAgent(href)).toBe(ready);
    expect(attempts).toBe(2);
    expect(rootKeyReads).toBe(1);
  } finally { create.mockRestore(); }
});

test("a failed local root-key read also permits a new initialization", async () => {
  const href = "http://localhost:18380/app/wallet/index.html";
  let attempts = 0;
  const create = spyOn(HttpAgent, "create").mockImplementation(async () => {
    attempts += 1;
    const attempt = attempts;
    return { fetchRootKey: async () => { if (attempt === 1) throw new Error("replica is starting"); } } as unknown as HttpAgent;
  });
  try {
    await expect(queryAgent(href)).rejects.toThrow("replica is starting");
    const ready = await queryAgent(href);
    expect(await queryAgent(href)).toBe(ready);
    expect(attempts).toBe(2);
  } finally { create.mockRestore(); }
});
