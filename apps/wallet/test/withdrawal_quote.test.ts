import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { extractPublicTypeAliases, motokoTypeToIdl } from "neutron-scripts/src/method_schema.js";
import { normalizeToolDescriptor } from "neutron-tools/src/app.ts";
import { type JsonObject, type SelfCallValue } from "neutron-tools/app";
import { encodeSelfCallResult, materializeSelfCallArguments, normalizeSelfCallResult } from "../../kernel/src/self_calls.ts";
import { savedTransferArgs } from "../src/transfers.ts";
import {
  WALLET_WITHDRAWAL_QUOTE_METHOD,
  WALLET_WITHDRAWAL_QUOTE_TOOL,
  parseWalletWithdrawalQuote,
  quoteAuthorizationWire,
  readWalletWithdrawalQuote,
  walletWithdrawalQuoteInputSchema,
  walletWithdrawalQuoteJson,
  walletWithdrawalQuoteOutputSchema,
  walletWithdrawalQuoteRequest,
} from "../src/withdrawal_quote.ts";

const ledger = "xevnm-gaaaa-aaaar-qafnq-cai";
const gasLedger = "ss2fx-dyaaa-aaaar-qacoq-cai";
const minter = "sv3dd-oaaaa-aaaar-qacoa-cai";
const amount = "123456789012345678901234567890";
const total = "123456789012345678901234577890";

function wireQuote(): JsonObject {
  return {
    ledger, minter, amount,
    observed_at_ns: "1800000000000000000",
    asset_fee: "10000", asset_allowance: amount, asset_total_debit: total,
    asset_balance: total, asset_sufficient: true,
    gas: {
      ledger: gasLedger, budget: "25000000000000", ledger_fee: "2000000000",
      allowance: "25000000000000", total_debit: "25002000000000",
      balance: "25001999999999", sufficient: false,
    },
    authorization: {
      asset_fee: "10000",
      gas: { ledger: gasLedger, minter, budget: "25000000000000", ledger_fee: "2000000000" },
    },
  };
}

test("withdrawal quotes expose closed versioned read-only tool schemas", () => {
  expect(WALLET_WITHDRAWAL_QUOTE_TOOL).toBe("wallet_withdrawal_quote_v1");
  expect(() => normalizeToolDescriptor({
    name: WALLET_WITHDRAWAL_QUOTE_TOOL,
    inputSchema: walletWithdrawalQuoteInputSchema,
    outputSchema: walletWithdrawalQuoteOutputSchema,
    annotations: { "neutron:effects": ["read", "network"] },
  })).not.toThrow();
  expect(walletWithdrawalQuoteInputSchema).toMatchObject({ required: ["ledger"], additionalProperties: false });
  expect(walletWithdrawalQuoteOutputSchema).toMatchObject({ additionalProperties: false });
});

test("withdrawal requests accept canonical ledgers and optional exact unsigned amounts", () => {
  expect(walletWithdrawalQuoteRequest({ ledger })).toEqual({ ledger, amount: null, wire: { ledger } });
  expect(walletWithdrawalQuoteRequest({ ledger, amount })).toEqual({ ledger, amount, wire: { ledger, amount } });
  expect(walletWithdrawalQuoteRequest({ ledger, amount: "0" }).amount).toBe("0");
  for (const invalid of ["01", "-1", "1.5", "1e3", 10, null, true]) {
    expect(() => walletWithdrawalQuoteRequest({ ledger, amount: invalid })).toThrow("Invalid Wallet withdrawal amount");
  }
  expect(() => walletWithdrawalQuoteRequest({ ledger: `${ledger}.` })).toThrow("Invalid Wallet withdrawal ledger");
  expect(() => walletWithdrawalQuoteRequest({ ledger, account: "aaaaa-aa" })).toThrow("Invalid Wallet withdrawal quote request");
});

test("withdrawal quotes preserve exact asset and gas balances with one approval fee each", () => {
  const quote = parseWalletWithdrawalQuote(wireQuote(), ledger, amount);
  expect(quote).toEqual({
    ledger, minter, amount, observedAtNs: "1800000000000000000",
    assetFee: "10000", assetAllowance: amount, assetTotalDebit: total,
    assetBalance: total, assetSufficient: true,
    gas: {
      ledger: gasLedger, budget: "25000000000000", ledgerFee: "2000000000",
      allowance: "25000000000000", totalDebit: "25002000000000",
      balance: "25001999999999", sufficient: false,
    },
    authorization: {
      assetFee: "10000",
      gas: { ledger: gasLedger, minter, budget: "25000000000000", ledgerFee: "2000000000" },
    },
  });
  expect(quoteAuthorizationWire(quote)).toEqual(wireQuote().authorization as JsonObject);
  expect(walletWithdrawalQuoteJson(quote)).toEqual(quote);
});

test("withdrawal quote option fields support both omitted and null self-call projections", () => {
  for (const absent of [false, true]) {
    const raw = {
      ledger: gasLedger, minter, observed_at_ns: "0", asset_fee: "2000000000",
      asset_balance: "5000000000",
      authorization: { asset_fee: "2000000000", ...(absent ? {} : { gas: null }) },
      ...(absent ? {} : { amount: null, asset_allowance: null, asset_total_debit: null, asset_sufficient: null, gas: null }),
    };
    const quote = parseWalletWithdrawalQuote(raw, gasLedger, null);
    expect(quote).toMatchObject({ amount: null, assetAllowance: null, assetTotalDebit: null, assetSufficient: null, gas: null, authorization: { gas: null } });
    expect(quoteAuthorizationWire(quote)).toEqual({ asset_fee: "2000000000" });
  }
});

test("withdrawal quotes reject malformed amounts, non-boolean sufficiency, and wrong request identity", () => {
  for (const asset_fee of [1, "-1", "00", "1.0", true]) {
    expect(() => parseWalletWithdrawalQuote({ ...wireQuote(), asset_fee })).toThrow("Invalid Wallet withdrawal asset fee");
  }
  expect(() => parseWalletWithdrawalQuote({ ...wireQuote(), observed_at_ns: "18446744073709551616" })).toThrow("Invalid Wallet withdrawal observation time");
  expect(() => parseWalletWithdrawalQuote({ ...wireQuote(), asset_sufficient: "true" })).toThrow("Invalid Wallet withdrawal asset sufficiency");
  expect(() => parseWalletWithdrawalQuote({ ...wireQuote(), gas: { ...wireQuote().gas as JsonObject, sufficient: 0 } })).toThrow("Invalid Wallet withdrawal gas sufficiency");
  expect(() => parseWalletWithdrawalQuote(wireQuote(), gasLedger)).toThrow("another ledger");
  expect(() => parseWalletWithdrawalQuote(wireQuote(), ledger, "1")).toThrow("another amount");
  expect(() => parseWalletWithdrawalQuote(wireQuote(), ledger, null)).toThrow("another amount");
  expect(() => parseWalletWithdrawalQuote({ ...wireQuote(), unexpected: true })).toThrow("Invalid Wallet withdrawal quote");
});

test("withdrawal quotes cannot present different arithmetic or authorization than the backend will execute", () => {
  expect(() => parseWalletWithdrawalQuote({ ...wireQuote(), asset_allowance: total })).toThrow("Inconsistent Wallet withdrawal asset totals");
  expect(() => parseWalletWithdrawalQuote({ ...wireQuote(), asset_total_debit: (BigInt(total) + 10000n).toString() })).toThrow("Inconsistent Wallet withdrawal asset totals");
  expect(() => parseWalletWithdrawalQuote({ ...wireQuote(), asset_balance: "0" })).toThrow("Inconsistent Wallet withdrawal asset totals");
  expect(() => parseWalletWithdrawalQuote({ ...wireQuote(), amount: null })).toThrow("totals require an amount");
  expect(() => parseWalletWithdrawalQuote({ ...wireQuote(), gas: { ...wireQuote().gas as JsonObject, total_debit: "25004000000000" } })).toThrow("Inconsistent Wallet withdrawal gas totals");
  expect(() => parseWalletWithdrawalQuote({ ...wireQuote(), gas: { ...wireQuote().gas as JsonObject, allowance: "25002000000000" } })).toThrow("Inconsistent Wallet withdrawal gas totals");
  expect(() => parseWalletWithdrawalQuote({ ...wireQuote(), gas: { ...wireQuote().gas as JsonObject, sufficient: true } })).toThrow("Inconsistent Wallet withdrawal gas totals");
  expect(() => parseWalletWithdrawalQuote({ ...wireQuote(), authorization: { ...wireQuote().authorization as JsonObject, asset_fee: "0" } })).toThrow("asset fee authorization mismatch");
  expect(() => parseWalletWithdrawalQuote({ ...wireQuote(), authorization: { asset_fee: "10000" } })).toThrow("gas authorization mismatch");
  expect(() => parseWalletWithdrawalQuote({ ...wireQuote(), authorization: { asset_fee: "10000", gas: { ledger: gasLedger, minter: "aaaaa-aa", budget: "25000000000000", ledger_fee: "2000000000" } } })).toThrow("gas authorization mismatch");
});

test("reading a quote uses the resident wallet method and preserves its exact requested amount", async () => {
  const calls: { method: string; args: SelfCallValue[]; timeout: number | undefined }[] = [];
  const quote = await readWalletWithdrawalQuote({ ledger, amount }, async (method, args, timeout) => {
    calls.push({ method, args, timeout });
    return wireQuote();
  });
  expect(calls).toEqual([{ method: WALLET_WITHDRAWAL_QUOTE_METHOD, args: [{ ledger, amount }], timeout: 60 }]);
  expect(quote.assetTotalDebit).toBe(total);
  expect(quote.gas?.sufficient).toBe(false);
});

test("quote reads surface backend errors and never fabricate success or reuse another amount", async () => {
  const error = new Error("Unable to read live ckETH balance");
  await expect(readWalletWithdrawalQuote({ ledger }, async () => { throw error; })).rejects.toBe(error);
  await expect(readWalletWithdrawalQuote({ ledger }, async () => wireQuote())).rejects.toThrow("another amount");
  await expect(readWalletWithdrawalQuote({ ledger, amount }, async () => ({ ok: wireQuote() }))).rejects.toThrow("Invalid Wallet withdrawal quote");
});

test("withdrawal quote requests bind to the actual private Candid method with an absent or present amount", () => {
  const aliases = backendAliases();
  const input = motokoTypeToIdl(aliases.wallet_withdrawal_quote_v1_Input!, IDL, aliases);
  for (const request of [{ ledger }, { ledger, amount }]) {
    const wire = walletWithdrawalQuoteRequest(request).wire;
    const encoded = encodeSelfCallResult([wire]);
    const bound = materializeSelfCallArguments(encoded.value, encoded.blobs, [input]);
    expect(bound.args).toEqual([{ ...wire, amount: wire.amount ?? null }]);
    expect(bound.binary.count).toBe(0);
  }
});

test("the actual private Candid quote unwraps ok and projects optional records without losing precision", () => {
  const aliases = backendAliases();
  const output = motokoTypeToIdl(aliases.wallet_withdrawal_quote_v1_Output!, IDL, aliases);
  const gas = {
    ledger: Principal.fromText(gasLedger), budget: 25_000_000_000_000n,
    ledger_fee: 2_000_000_000n, allowance: 25_000_000_000_000n,
    total_debit: 25_002_000_000_000n, balance: 25_001_999_999_999n, sufficient: false,
  };
  for (const { withAmount, withGas } of [
    { withAmount: false, withGas: false }, { withAmount: true, withGas: false },
    { withAmount: false, withGas: true }, { withAmount: true, withGas: true },
  ]) {
    const native = { ok: {
      ledger: Principal.fromText(ledger), minter: Principal.fromText(minter),
      observed_at_ns: 1_800_000_000_000_000_000n,
      amount: withAmount ? [BigInt(amount)] : [], asset_fee: 10000n,
      asset_allowance: withAmount ? [BigInt(amount)] : [],
      asset_total_debit: withAmount ? [BigInt(total)] : [],
      asset_balance: BigInt(total), asset_sufficient: withAmount ? [true] : [],
      gas: withGas ? [gas] : [], authorization: { asset_fee: 10000n,
        gas: withGas ? [{ ledger: gas.ledger, minter: Principal.fromText(minter), budget: gas.budget, ledger_fee: gas.ledger_fee }] : [],
      },
    } };
    const decoded = IDL.decode([output], IDL.encode([output], [native]))[0];
    const projected = normalizeSelfCallResult(decoded, output);
    const quote = parseWalletWithdrawalQuote(projected, ledger, withAmount ? amount : null);
    expect(quote.assetBalance).toBe(total);
    expect(quote.amount).toBe(withAmount ? amount : null);
    expect(quote.assetTotalDebit).toBe(withAmount ? total : null);
    expect(quote.gas?.sufficient ?? null).toBe(withGas ? false : null);
    expect(quoteAuthorizationWire(quote)).toEqual(withGas ? wireQuote().authorization as JsonObject : { asset_fee: "10000" });
  }
});

test("reviewed quote authorization binds unchanged to the actual durable transfer preparation", () => {
  const aliases = backendAliases();
  const input = motokoTypeToIdl(aliases.wallet_transfer_prepare_v2_Input!, IDL, aliases);
  for (const withGas of [false, true]) {
    const quote = parseWalletWithdrawalQuote(withGas ? wireQuote() : {
      ...wireQuote(), gas: null, authorization: { asset_fee: "10000" },
    });
    const wire = savedTransferArgs({
      requestId: "ab".repeat(16),
      transfer: {
        ledger, amount, network: { ethereum_mainnet: null },
        contact_id: "1", contact_revision: "7", address_id: "2",
        expected_destination: { ethereum_mainnet: `0x${"1".repeat(40)}` },
      },
      withdrawalQuote: quoteAuthorizationWire(quote),
    });
    const encoded = encodeSelfCallResult([wire]);
    const bound = materializeSelfCallArguments(encoded.value, encoded.blobs, [input]);
    expect(bound.args).toEqual([{
      ...wire,
      withdrawal_quote: {
        asset_fee: quote.assetFee,
        gas: withGas ? (wireQuote().authorization as JsonObject).gas : null,
      },
    }]);
    expect(bound.binary.count).toBe(1);
  }
});

function backendAliases() {
  const aliases = extractPublicTypeAliases(readFileSync(new URL("../backend/main.mo", import.meta.url), "utf8"));
  expect(aliases.wallet_withdrawal_quote_v1_Input).toBeDefined();
  expect(aliases.wallet_withdrawal_quote_v1_Output).toBeDefined();
  return aliases;
}
