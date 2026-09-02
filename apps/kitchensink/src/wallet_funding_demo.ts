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

const REQUEST_VALIDITY_MS = 4 * 60 * 1_000;
const ALLOWANCE_VALIDITY_MS = 5 * 60 * 1_000;
const WALLET_FUNDING_TIMEOUT_SECONDS = 180;
export const WALLET_FUNDING_REQUEST_ID_PATTERN = "^[0-9a-f]{32}$";
const REQUEST_ID = new RegExp(WALLET_FUNDING_REQUEST_ID_PATTERN, "u");
const NAT64 = /^[1-9][0-9]{0,19}$/u;
const MAX_NAT64 = 18_446_744_073_709_551_615n;
const REQUEST_FIELDS = [
  "requestId", "ledger", "amountAtoms", "validUntilNs", "route",
] as const;

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

export const walletFundingDemoRequestSchema = closedSchema(REQUEST_FIELDS, {
  requestId: { type: "string", pattern: REQUEST_ID.source },
  ledger: { type: "string", enum: [ICP_LEDGER] },
  amountAtoms: { type: "string", enum: [ICP_SWAP_AMOUNT_ATOMS] },
  validUntilNs: { type: "string", pattern: NAT64.source },
  route: {
    oneOf: [
      closedSchema(["kind", "to"], {
        kind: { type: "string", enum: ["direct"] },
        to: { type: "string", enum: [NEUTRINITE_GOVERNANCE] },
      }),
      closedSchema(["kind", "spender", "expiresAtNs"], {
        kind: { type: "string", enum: ["allowance"] },
        spender: { type: "string", enum: [NEUTRINITE_GOVERNANCE] },
        expiresAtNs: { type: "string", pattern: NAT64.source },
      }),
    ],
  },
});

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
  return parseWalletFundingDemoRequest({
    requestId,
    ledger: ICP_LEDGER,
    amountAtoms: ICP_SWAP_AMOUNT_ATOMS,
    validUntilNs,
    route,
  }, kind);
}

export function parseWalletFundingDemoRequest(
  value: unknown,
  kind: WalletFundingDemoKind,
): WalletFundingDemoRequest {
  const request = closed(value, REQUEST_FIELDS, "intent");
  if (
    typeof request.requestId !== "string" || !REQUEST_ID.test(request.requestId) ||
    request.ledger !== ICP_LEDGER || request.amountAtoms !== ICP_SWAP_AMOUNT_ATOMS
  ) invalid("intent");
  const validUntilNs = nat64(request.validUntilNs, "deadline");
  const route = objectValue(request.route, "route");
  if (kind === "direct") {
    exactKeys(route, ["kind", "to"], "direct route");
    if (route.kind !== "direct" || route.to !== NEUTRINITE_GOVERNANCE) {
      invalid("direct route");
    }
    return fixedRequest(request.requestId, validUntilNs, {
      kind: "direct", to: NEUTRINITE_GOVERNANCE,
    });
  }
  exactKeys(route, ["kind", "spender", "expiresAtNs"], "allowance route");
  if (route.kind !== "allowance" || route.spender !== NEUTRINITE_GOVERNANCE) {
    invalid("allowance route");
  }
  const expiresAtNs = nat64(route.expiresAtNs, "allowance expiration");
  if (BigInt(expiresAtNs) !== BigInt(validUntilNs) + 60_000_000_000n) {
    invalid("allowance expiration");
  }
  return fixedRequest(request.requestId, validUntilNs, {
    kind: "allowance", spender: NEUTRINITE_GOVERNANCE, expiresAtNs,
  });
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
  request: WalletFundingDemoRequest,
  result: JsonValue,
): boolean {
  if (
    !isJsonObject(result) ||
    result.commandId !== `kitchensink:${request.requestId}`
  ) return false;
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

function closedSchema(
  required: readonly string[],
  properties: JsonObject,
): JsonObject {
  return { type: "object", required: [...required], properties, additionalProperties: false };
}

function fixedRequest(
  requestId: JsonValue | undefined,
  validUntilNs: string,
  route: DirectRoute | AllowanceRoute,
): WalletFundingDemoRequest {
  return {
    requestId: requestId as string,
    ledger: ICP_LEDGER,
    amountAtoms: ICP_SWAP_AMOUNT_ATOMS,
    validUntilNs,
    route,
  };
}

function closed(value: unknown, keys: readonly string[], label: string): JsonObject {
  const object = objectValue(value, label);
  exactKeys(object, keys, label);
  return object;
}

function objectValue(value: unknown, label: string): JsonObject {
  if (!isJsonObject(value)) invalid(label);
  return value as JsonObject;
}

function exactKeys(value: JsonObject, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, i) => key !== expected[i])) {
    invalid(`${label} fields`);
  }
}

function nat64(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string" || !NAT64.test(value) || BigInt(value) > MAX_NAT64) {
    invalid(label);
  }
  return value as string;
}

function invalid(label: string): never {
  throw new Error(`Invalid Wallet funding ${label}`);
}
