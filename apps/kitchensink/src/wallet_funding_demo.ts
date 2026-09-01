import {
  isJsonObject,
  type JsonObject,
  type JsonValue,
  type MsgBusClient,
} from "neutron-tools/app";

export const WALLET_FUNDING_TARGET = "app:wallet:background" as const;
export const WALLET_FUNDING_TOOL = "wallet_fund_v1";
export const ICP_LEDGER = "ryjl3-tyaaa-aaaaa-aaaba-cai";
export const NEUTRINITE_GOVERNANCE = "eqsml-lyaaa-aaaaq-aacdq-cai";
export const ICP_SWAP_AMOUNT_ATOMS = "1000000";
export const ICP_SWAP_AMOUNT_DISPLAY = "0.01 ICP";

const REQUEST_VALIDITY_MS = 2 * 60 * 1_000;
const ALLOWANCE_VALIDITY_MS = 5 * 60 * 1_000;
const WALLET_FUNDING_TIMEOUT_SECONDS = 180;

export type WalletFundingDemoKind = "direct" | "allowance";

type DirectRoute = JsonObject & {
  kind: "direct";
  to: string;
};

type AllowanceRoute = JsonObject & {
  kind: "allowance";
  spender: string;
  expiresAtNs: string;
};

export type WalletFundingDemoRequest = JsonObject & {
  requestId: string;
  ledger: string;
  amountAtoms: string;
  validUntilNs: string;
  route: DirectRoute | AllowanceRoute;
};

type RequestOptions = {
  nowMs?: number;
  fillRandomValues?: (bytes: Uint8Array) => void;
};

export function createWalletFundingDemoRequest(
  kind: WalletFundingDemoKind,
  options: RequestOptions = {},
): WalletFundingDemoRequest {
  const nowMs = options.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error("Invalid Wallet funding clock");
  }
  const requestIdBytes = new Uint8Array(16);
  (options.fillRandomValues ?? fillCryptographicRandomValues)(requestIdBytes);
  const requestId = Array.from(
    requestIdBytes,
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  const validUntilNs = millisecondsToNanoseconds(
    nowMs + REQUEST_VALIDITY_MS,
  );
  const route: DirectRoute | AllowanceRoute = kind === "direct"
    ? {
        kind: "direct",
        to: NEUTRINITE_GOVERNANCE,
      }
    : {
        kind: "allowance",
        spender: NEUTRINITE_GOVERNANCE,
        expiresAtNs: millisecondsToNanoseconds(
          nowMs + ALLOWANCE_VALIDITY_MS,
        ),
      };
  return {
    requestId,
    ledger: ICP_LEDGER,
    amountAtoms: ICP_SWAP_AMOUNT_ATOMS,
    validUntilNs,
    route,
  };
}

export function walletFundingDemoRequestExpired(
  request: WalletFundingDemoRequest,
  nowMs = Date.now(),
): boolean {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error("Invalid Wallet funding clock");
  }
  return BigInt(request.validUntilNs) <= BigInt(nowMs) * 1_000_000n;
}

export function callWalletFundingDemo(
  client: Pick<MsgBusClient, "callTool">,
  request: WalletFundingDemoRequest,
): Promise<JsonValue> {
  return client.callTool(
    {
      target: WALLET_FUNDING_TARGET,
      name: WALLET_FUNDING_TOOL,
      arguments: request,
    },
    WALLET_FUNDING_TIMEOUT_SECONDS,
  );
}

export function walletFundingDemoResultIsTerminal(
  kind: WalletFundingDemoKind,
  result: JsonValue,
): boolean {
  if (!isJsonObject(result)) return false;
  return result.status === "rejected" ||
    (kind === "direct" && result.status === "transferred") ||
    (kind === "allowance" && result.status === "approved");
}

function fillCryptographicRandomValues(bytes: Uint8Array): void {
  crypto.getRandomValues(bytes as Uint8Array<ArrayBuffer>);
}

function millisecondsToNanoseconds(milliseconds: number): string {
  return (BigInt(milliseconds) * 1_000_000n).toString();
}
