import {
  type JsonObject,
  type JsonValue,
  type SelfCallObject,
} from "neutron-tools/app";
import {
  parseCandidIcrcAccount,
  parsePrincipal,
} from "./icrc_account.ts";
import {
  WALLET_NAT_PATTERN,
  boundedString,
  exactObject,
  optionalBoundedString,
  requiredDecimals,
  requiredNat,
  requiredNat64,
} from "./funding.ts";

export const WALLET_TOKEN_INFO_TOOL = "wallet_token_info_v1";
export const WALLET_TOKEN_INFO_METHOD = WALLET_TOKEN_INFO_TOOL;

export const walletTokenInfoInputSchema: JsonObject = {
  type: "object",
  required: ["ledger"],
  properties: {
    ledger: {
      type: "string",
      minLength: 5,
      maxLength: 63,
      pattern: "^[a-z0-9-]+$",
    },
  },
  additionalProperties: false,
};

export const walletTokenInfoOutputSchema: JsonObject = {
  type: "object",
  required: [
    "ledger",
    "account",
    "name",
    "symbol",
    "decimals",
    "feeAtoms",
    "balanceAtoms",
    "observedAtNs",
  ],
  properties: {
    ledger: { type: "string", minLength: 5, maxLength: 63 },
    account: { type: "string", minLength: 5, maxLength: 160 },
    name: {
      oneOf: [
        { type: "string", minLength: 1, maxLength: 128 },
        { type: "null" },
      ],
    },
    symbol: { type: "string", minLength: 1, maxLength: 32 },
    decimals: { type: "integer", minimum: 0, maximum: 255 },
    feeAtoms: { type: "string", pattern: WALLET_NAT_PATTERN },
    balanceAtoms: { type: "string", pattern: WALLET_NAT_PATTERN },
    observedAtNs: {
      type: "string",
      pattern: "^0$|^[1-9][0-9]{0,19}$",
    },
  },
  additionalProperties: false,
};

export type WalletTokenInfo = {
  ledger: string;
  account: string;
  name: string | null;
  symbol: string;
  decimals: number;
  feeAtoms: string;
  balanceAtoms: string;
  observedAtNs: string;
};

export function walletTokenInfoRequest(
  value: JsonObject,
): { ledger: string; wire: SelfCallObject } {
  const request = exactObject(
    value,
    ["ledger"],
    "Wallet token information request",
  );
  const ledger = parsePrincipal(request.ledger, "Wallet token ledger").toText();
  return { ledger, wire: { ledger } };
}

export function parseWalletTokenInfo(
  value: JsonValue,
  expectedLedger: string,
): WalletTokenInfo {
  const record = exactObject(
    value,
    [
      "ledger",
      "account",
      "token_symbol",
      "decimals",
      "fee_atoms",
      "balance_atoms",
      "observed_at_ns",
    ],
    "Wallet token information",
    ["token_name"],
  );
  const ledger = parsePrincipal(record.ledger, "Wallet token ledger").toText();
  if (ledger !== expectedLedger) {
    throw new Error("Wallet returned token information for another ledger");
  }
  return {
    ledger,
    account: parseCandidIcrcAccount(record.account, "Wallet token account"),
    name: optionalBoundedString(record.token_name, 128, "Wallet token name"),
    symbol: boundedString(record.token_symbol, 1, 32, "Wallet token symbol"),
    decimals: requiredDecimals(record.decimals, "Wallet token decimals"),
    feeAtoms: requiredNat(record.fee_atoms, "Wallet token fee"),
    balanceAtoms: requiredNat(record.balance_atoms, "Wallet token balance"),
    observedAtNs: requiredNat64(
      record.observed_at_ns,
      "Wallet token observation time",
    ),
  };
}

export function walletTokenInfoJson(value: WalletTokenInfo): JsonObject {
  return { ...value };
}
