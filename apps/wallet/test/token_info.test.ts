import { expect, test } from "bun:test";
import { normalizeToolDescriptor } from "neutron-tools/src/app.ts";
import type { MsgBusToolContext, SelfCallValue } from "neutron-tools/app";
import {
  WALLET_TOKEN_INFO_TOOL,
  handleWalletTokenInfo,
  parseWalletTokenInfo,
  walletTokenInfoInputSchema,
  walletTokenInfoOutputSchema,
  walletTokenInfoRequest,
} from "../src/token_info.ts";

const ledger = "ryjl3-tyaaa-aaaaa-aaaba-cai";
const account = "togwv-zqaaa-aaaal-qr7aa-cai";

test("Wallet token information has a closed versioned tool contract", () => {
  expect(() =>
    normalizeToolDescriptor({
      name: WALLET_TOKEN_INFO_TOOL,
      inputSchema: walletTokenInfoInputSchema,
      outputSchema: walletTokenInfoOutputSchema,
      annotations: { "neutron:effects": ["read", "network"] },
    }),
  ).not.toThrow();
  expect(walletTokenInfoInputSchema).toMatchObject({
    required: ["ledger"],
    additionalProperties: false,
  });
  expect(walletTokenInfoOutputSchema).toMatchObject({
    additionalProperties: false,
  });
});

test("live token tool uses parallel direct observations followed by one policy query, never an update", async () => {
  const calls: { method: string; args: SelfCallValue[] }[] = [];
  const facts = { owner: account, metadata: [["icrc1:symbol", { Text: "ICP" }], ["icrc1:decimals", { Nat: "8" }]], fee: "10000", balance: "900719925474099312345" };
  const context = { kernel: {
    querySelf: async (method: string, args: SelfCallValue[]) => {
      calls.push({ method, args });
      return { token_info_preview: { ok: { ledger, account: { owner: account, subaccount: null }, token_name: "Internet Computer", token_symbol: "ICP", decimals: "8", fee_atoms: facts.fee, balance_atoms: facts.balance, observed_at_ns: "1800000000000000000" } } };
    },
    updateSelf: async () => { throw new Error("Token reads must not dispatch updates"); },
  } } as unknown as MsgBusToolContext;
  let reads = 0;
  const result = await handleWalletTokenInfo({ ledger }, context, async (requestedLedger) => { reads++; expect(requestedLedger).toBe(ledger); return facts; });
  expect(reads).toBe(1);
  expect(calls).toEqual([{ method: "wallet_read_v1", args: [{ token_info_preview: { ledger, ...facts } }] }]);
  expect(result).toMatchObject({ ledger, account, symbol: "ICP", decimals: 8, feeAtoms: "10000", balanceAtoms: facts.balance });
});

test("cancelled or failed direct token observations never enter the backend policy query", async () => {
  let calls = 0;
  const controller = new AbortController();
  const context = { signal: controller.signal, kernel: { querySelf: async () => { calls++; return {}; } } } as unknown as MsgBusToolContext;
  await expect(handleWalletTokenInfo({ ledger }, context, async () => { throw new Error("Ledger query unavailable"); })).rejects.toThrow("Ledger query unavailable");
  await expect(handleWalletTokenInfo({ ledger }, context, async () => {
    controller.abort(new Error("Cancelled"));
    return { owner: account, metadata: [], fee: "10000", balance: "0" };
  })).rejects.toThrow("Cancelled");
  expect(calls).toBe(0);
});

test("Wallet token information accepts only an exact canonical ledger request", () => {
  expect(walletTokenInfoRequest({ ledger })).toEqual({
    ledger,
    wire: { ledger },
  });
  expect(() => walletTokenInfoRequest({ ledger, account })).toThrow(
    "Invalid Wallet token information request",
  );
  expect(() => walletTokenInfoRequest({ ledger: "aaaaa-aa." })).toThrow(
    "Invalid Wallet token ledger",
  );
});

test("Wallet token information preserves large atomic values and default accounts", () => {
  const value = parseWalletTokenInfo(
    {
      ledger,
      account: { owner: account, subaccount: null },
      token_name: "Internet Computer",
      token_symbol: "ICP",
      decimals: "8",
      fee_atoms: "10000",
      balance_atoms: "1234567890123456789012345678901234567890",
      observed_at_ns: "1800000000000000000",
    },
    ledger,
  );
  expect(value).toEqual({
    ledger,
    account,
    name: "Internet Computer",
    symbol: "ICP",
    decimals: 8,
    feeAtoms: "10000",
    balanceAtoms: "1234567890123456789012345678901234567890",
    observedAtNs: "1800000000000000000",
  });
});

test("Wallet token information rejects mismatched and malformed backend replies", () => {
  const valid = {
    ledger,
    account: { owner: account },
    token_symbol: "ICP",
    decimals: "8",
    fee_atoms: "10000",
    balance_atoms: "1",
    observed_at_ns: "1800000000000000000",
  };
  expect(() =>
    parseWalletTokenInfo(
      { ...valid, ledger: "mxzaz-hqaaa-aaaar-qaada-cai" },
      ledger,
    ),
  ).toThrow("another ledger");
  expect(() =>
    parseWalletTokenInfo({ ...valid, fee_atoms: "01" }, ledger),
  ).toThrow("Invalid Wallet token fee");
  expect(() =>
    parseWalletTokenInfo({ ...valid, extra: true }, ledger),
  ).toThrow("Invalid Wallet token information");
});
