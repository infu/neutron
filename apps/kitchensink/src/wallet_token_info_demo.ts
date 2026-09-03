import {
  isJsonObject,
  type JsonValue,
  type MsgBusClient,
} from "neutron-tools/app";
import {
  ICP_LEDGER,
  WALLET_FUNDING_TARGET,
} from "./wallet_funding_demo.ts";

export const WALLET_TOKEN_INFO_TOOL = "wallet_token_info_v1";

export type WalletTokenInfoDemo = {
  ledger: string;
  account: string;
  name: string | null;
  symbol: string;
  decimals: number;
  feeAtoms: string;
  balanceAtoms: string;
  observedAtNs: string;
};

export async function callWalletTokenInfoDemo(
  client: Pick<MsgBusClient, "callTool">,
): Promise<WalletTokenInfoDemo> {
  return parseWalletTokenInfoDemo(
    await client.callTool(
      {
        target: WALLET_FUNDING_TARGET,
        name: WALLET_TOKEN_INFO_TOOL,
        arguments: { ledger: ICP_LEDGER },
      },
      60,
    ),
  );
}

export function parseWalletTokenInfoDemo(value: JsonValue): WalletTokenInfoDemo {
  if (!isJsonObject(value)) throw new Error("Wallet returned invalid token information");
  const fields = [
    "ledger",
    "account",
    "name",
    "symbol",
    "decimals",
    "feeAtoms",
    "balanceAtoms",
    "observedAtNs",
  ];
  const keys = Object.keys(value);
  if (
    keys.length !== fields.length ||
    fields.some((field) => !Object.hasOwn(value, field)) ||
    value.ledger !== ICP_LEDGER ||
    typeof value.account !== "string" ||
    value.account.length < 5 ||
    (value.name !== null && typeof value.name !== "string") ||
    typeof value.symbol !== "string" ||
    typeof value.decimals !== "number" ||
    !Number.isInteger(value.decimals) ||
    value.decimals < 0 ||
    value.decimals > 255 ||
    !atomicAmount(value.feeAtoms) ||
    !atomicAmount(value.balanceAtoms) ||
    !nat64(value.observedAtNs)
  ) {
    throw new Error("Wallet returned invalid token information");
  }
  return value as WalletTokenInfoDemo;
}

function atomicAmount(value: JsonValue | undefined): value is string {
  return typeof value === "string" && /^(0|[1-9][0-9]{0,79})$/u.test(value);
}

function nat64(value: JsonValue | undefined): value is string {
  return atomicAmount(value) && BigInt(value) <= 18_446_744_073_709_551_615n;
}
