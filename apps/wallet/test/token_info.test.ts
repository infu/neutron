import { expect, test } from "bun:test";
import { normalizeToolDescriptor } from "neutron-tools/src/app.ts";
import {
  WALLET_TOKEN_INFO_TOOL,
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
