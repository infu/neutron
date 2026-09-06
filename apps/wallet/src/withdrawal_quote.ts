import {
  type JsonObject,
  type MsgBusToolContext,
  type SelfCallObject,
  type SelfCallValue,
} from "neutron-tools/app";
import { parsePrincipal } from "./icrc_account.ts";
import { WALLET_NAT_PATTERN, exactObject, requiredNat, requiredNat64 } from "./funding.ts";

export const WALLET_WITHDRAWAL_QUOTE_TOOL = "wallet_withdrawal_quote_v1";
export const WALLET_WITHDRAWAL_QUOTE_METHOD = WALLET_WITHDRAWAL_QUOTE_TOOL;

const principalSchema: JsonObject = {
  type: "string", minLength: 5, maxLength: 63, pattern: "^[a-z0-9-]+$",
};
const natSchema: JsonObject = { type: "string", pattern: WALLET_NAT_PATTERN };
const nullable = (schema: JsonObject): JsonObject => ({ oneOf: [schema, { type: "null" }] });
const authorizationGasSchema: JsonObject = {
  type: "object",
  required: ["ledger", "minter", "budget", "ledgerFee"],
  properties: {
    ledger: principalSchema, minter: principalSchema,
    budget: natSchema, ledgerFee: natSchema,
  },
  additionalProperties: false,
};

export const walletWithdrawalQuoteInputSchema: JsonObject = {
  type: "object",
  required: ["ledger"],
  properties: { ledger: principalSchema, amount: natSchema },
  additionalProperties: false,
};

export const walletWithdrawalQuoteOutputSchema: JsonObject = {
  type: "object",
  required: [
    "ledger", "minter", "observedAtNs", "amount", "assetFee", "assetAllowance",
    "assetTotalDebit", "assetBalance", "assetSufficient", "gas", "authorization",
  ],
  properties: {
    ledger: principalSchema,
    minter: principalSchema,
    observedAtNs: { type: "string", pattern: "^0$|^[1-9][0-9]{0,19}$" },
    amount: nullable(natSchema),
    assetFee: natSchema,
    assetAllowance: nullable(natSchema),
    assetTotalDebit: nullable(natSchema),
    assetBalance: natSchema,
    assetSufficient: nullable({ type: "boolean" }),
    gas: nullable({
      type: "object",
      required: ["ledger", "budget", "ledgerFee", "allowance", "totalDebit", "balance", "sufficient"],
      properties: {
        ledger: principalSchema, budget: natSchema, ledgerFee: natSchema,
        allowance: natSchema, totalDebit: natSchema, balance: natSchema,
        sufficient: { type: "boolean" },
      },
      additionalProperties: false,
    }),
    authorization: {
      type: "object",
      required: ["assetFee", "gas"],
      properties: { assetFee: natSchema, gas: nullable(authorizationGasSchema) },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

export type WalletWithdrawalQuote = {
  ledger: string;
  minter: string;
  observedAtNs: string;
  amount: string | null;
  assetFee: string;
  assetAllowance: string | null;
  assetTotalDebit: string | null;
  assetBalance: string;
  assetSufficient: boolean | null;
  gas: {
    ledger: string;
    budget: string;
    ledgerFee: string;
    allowance: string;
    totalDebit: string;
    balance: string;
    sufficient: boolean;
  } | null;
  authorization: {
    assetFee: string;
    gas: { ledger: string; minter: string; budget: string; ledgerFee: string } | null;
  };
};

export function walletWithdrawalQuoteRequest(value: unknown): {
  ledger: string; amount: string | null; wire: SelfCallObject;
} {
  const request = exactObject(value, ["ledger"], "Wallet withdrawal quote request", ["amount"]);
  const ledger = principal(request.ledger, "ledger");
  const amount = Object.hasOwn(request, "amount")
    ? requiredNat(request.amount, "Wallet withdrawal amount") : null;
  return { ledger, amount, wire: { ledger, ...(amount === null ? {} : { amount }) } };
}

/** Parses the private self-call result after the Kernel unwraps Candid #ok. */
export function parseWalletWithdrawalQuote(
  value: unknown,
  expectedLedger?: string,
  expectedAmount?: string | null,
): WalletWithdrawalQuote {
  const record = exactObject(value,
    ["ledger", "minter", "observed_at_ns", "asset_fee", "asset_balance", "authorization"],
    "Wallet withdrawal quote", ["amount", "asset_allowance", "asset_total_debit", "asset_sufficient", "gas"]);
  const authorization = exactObject(record.authorization, ["asset_fee"], "Wallet withdrawal authorization", ["gas"]);
  const quote: WalletWithdrawalQuote = {
    ledger: principal(record.ledger, "ledger"),
    minter: principal(record.minter, "minter"),
    observedAtNs: requiredNat64(record.observed_at_ns, "Wallet withdrawal observation time"),
    amount: optionalNat(record.amount, "amount"),
    assetFee: requiredNat(record.asset_fee, "Wallet withdrawal asset fee"),
    assetAllowance: optionalNat(record.asset_allowance, "asset allowance"),
    assetTotalDebit: optionalNat(record.asset_total_debit, "asset total debit"),
    assetBalance: requiredNat(record.asset_balance, "Wallet withdrawal asset balance"),
    assetSufficient: record.asset_sufficient == null ? null : boolean(record.asset_sufficient, "asset sufficiency"),
    gas: record.gas == null ? null : parseGas(record.gas),
    authorization: {
      assetFee: requiredNat(authorization.asset_fee, "Wallet withdrawal authorized asset fee"),
      gas: authorization.gas == null ? null : parseAuthorizationGas(authorization.gas),
    },
  };
  if (expectedLedger !== undefined && quote.ledger !== expectedLedger) {
    throw new Error("Wallet returned a withdrawal quote for another ledger");
  }
  if (expectedAmount !== undefined && quote.amount !== expectedAmount) {
    throw new Error("Wallet returned a withdrawal quote for another amount");
  }
  validateQuote(quote);
  return quote;
}

/** Freeze the reviewed fee values for backend comparison before approval. */
export function quoteAuthorizationWire(quote: WalletWithdrawalQuote): SelfCallObject {
  const { assetFee, gas } = quote.authorization;
  return {
    asset_fee: assetFee,
    ...(gas === null ? {} : {
      gas: { ledger: gas.ledger, minter: gas.minter, budget: gas.budget, ledger_fee: gas.ledgerFee },
    }),
  };
}

export async function readWalletWithdrawalQuote(
  value: { ledger: string; amount?: string },
  updateSelf: (method: string, args: SelfCallValue[], timeout?: number) => Promise<unknown>,
): Promise<WalletWithdrawalQuote> {
  const request = walletWithdrawalQuoteRequest(value);
  return parseWalletWithdrawalQuote(
    await updateSelf(WALLET_WITHDRAWAL_QUOTE_METHOD, [request.wire], 60),
    request.ledger, request.amount,
  );
}

export function walletWithdrawalQuoteJson(value: WalletWithdrawalQuote): JsonObject {
  return { ...value };
}

export async function handleWalletWithdrawalQuote(
  args: JsonObject,
  context: MsgBusToolContext,
): Promise<JsonObject> {
  const request = walletWithdrawalQuoteRequest(args);
  return walletWithdrawalQuoteJson(await readWalletWithdrawalQuote(
    { ledger: request.ledger, ...(request.amount === null ? {} : { amount: request.amount }) },
    (method, values, timeout) => context.kernel.updateSelf(method, values, timeout),
  ));
}

function parseGas(value: unknown): NonNullable<WalletWithdrawalQuote["gas"]> {
  const gas = exactObject(value,
    ["ledger", "budget", "ledger_fee", "allowance", "total_debit", "balance", "sufficient"],
    "Wallet withdrawal gas");
  return {
    ledger: principal(gas.ledger, "gas ledger"),
    budget: requiredNat(gas.budget, "Wallet withdrawal gas budget"),
    ledgerFee: requiredNat(gas.ledger_fee, "Wallet withdrawal gas ledger fee"),
    allowance: requiredNat(gas.allowance, "Wallet withdrawal gas allowance"),
    totalDebit: requiredNat(gas.total_debit, "Wallet withdrawal gas total debit"),
    balance: requiredNat(gas.balance, "Wallet withdrawal gas balance"),
    sufficient: boolean(gas.sufficient, "gas sufficiency"),
  };
}

function parseAuthorizationGas(value: unknown): NonNullable<WalletWithdrawalQuote["authorization"]["gas"]> {
  const gas = exactObject(value, ["ledger", "minter", "budget", "ledger_fee"], "Wallet withdrawal gas authorization");
  return {
    ledger: principal(gas.ledger, "authorized gas ledger"),
    minter: principal(gas.minter, "authorized gas minter"),
    budget: requiredNat(gas.budget, "Wallet withdrawal authorized gas budget"),
    ledgerFee: requiredNat(gas.ledger_fee, "Wallet withdrawal authorized gas ledger fee"),
  };
}

function validateQuote(quote: WalletWithdrawalQuote): void {
  if (quote.amount === null) {
    if (quote.assetAllowance !== null || quote.assetTotalDebit !== null || quote.assetSufficient !== null) {
      throw new Error("Wallet withdrawal quote totals require an amount");
    }
  } else {
    // Minter burns carry no ledger fee; the separate approval charges one fee.
    const total = BigInt(quote.amount) + BigInt(quote.assetFee);
    if (quote.assetAllowance !== quote.amount || quote.assetTotalDebit !== total.toString() ||
      quote.assetSufficient !== (BigInt(quote.assetBalance) >= total)) {
      throw new Error("Inconsistent Wallet withdrawal asset totals");
    }
  }
  if (quote.assetFee !== quote.authorization.assetFee) {
    throw new Error("Wallet withdrawal asset fee authorization mismatch");
  }
  const gas = quote.gas;
  const authorized = quote.authorization.gas;
  if (gas === null || authorized === null) {
    if (gas !== null || authorized !== null) throw new Error("Wallet withdrawal gas authorization mismatch");
    return;
  }
  const total = BigInt(gas.budget) + BigInt(gas.ledgerFee);
  if (gas.allowance !== gas.budget || gas.totalDebit !== total.toString() ||
    gas.sufficient !== (BigInt(gas.balance) >= total)) {
    throw new Error("Inconsistent Wallet withdrawal gas totals");
  }
  if (gas.ledger !== authorized.ledger || quote.minter !== authorized.minter ||
    gas.budget !== authorized.budget || gas.ledgerFee !== authorized.ledgerFee) {
    throw new Error("Wallet withdrawal gas authorization mismatch");
  }
}

function principal(value: unknown, label: string): string {
  return parsePrincipal(value, `Wallet withdrawal ${label}`).toText();
}

function optionalNat(value: unknown, label: string): string | null {
  return value == null ? null : requiredNat(value, `Wallet withdrawal ${label}`);
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`Invalid Wallet withdrawal ${label}`);
  return value;
}
