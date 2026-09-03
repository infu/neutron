import {
  type JsonObject,
  type MsgBusClient,
} from "neutron-tools/app";
import {
  WALLET_FUNDING_REQUEST_ID_PATTERN,
  createWalletFundingDemoRequest,
  parseWalletFundingDemoRequest,
  walletFundingDemoRequestSchema,
  type WalletFundingDemoKind,
  type WalletFundingDemoRequest,
} from "./wallet_funding_demo.ts";

export const WALLET_FUNDING_INTENT_TOOL = "wallet_funding_intent_v1";
export const WALLET_FUNDING_INTENT_STORAGE_KEY =
  "neutron.kitchensink.wallet-funding-intent.v1";
export const WALLET_FUNDING_UNREADABLE_ERROR =
  "Unreadable saved Wallet funding intent";

const KIND_SCHEMA: JsonObject = {
  type: "string",
  enum: ["direct", "allowance"],
};

export const walletFundingIntentActionSchema: JsonObject = {
  oneOf: [
    {
      type: "object",
      required: ["action", "kind"],
      properties: {
        action: { type: "string", enum: ["prepare", "reset"] },
        kind: KIND_SCHEMA,
      },
      additionalProperties: false,
    },
    {
      type: "object",
      required: ["action", "kind", "requestId"],
      properties: {
        action: { type: "string", enum: ["complete", "discard"] },
        kind: KIND_SCHEMA,
        requestId: {
          type: "string",
          pattern: WALLET_FUNDING_REQUEST_ID_PATTERN,
        },
      },
      additionalProperties: false,
    },
  ],
};

export const walletFundingIntentResultSchema: JsonObject =
  walletFundingDemoRequestSchema;

export type WalletFundingIntentAction =
  | { action: "prepare"; kind: WalletFundingDemoKind }
  | { action: "reset"; kind: WalletFundingDemoKind }
  | {
      action: "complete" | "discard";
      kind: WalletFundingDemoKind;
      requestId: string;
    };

type IntentStorage = Pick<Storage, "getItem" | "setItem">;

class UnreadableWalletFundingIntentError extends Error {}

export function runWalletFundingIntentAction(
  storage: IntentStorage,
  action: WalletFundingIntentAction,
  create = createWalletFundingDemoRequest,
): WalletFundingDemoRequest {
  if (action.action === "reset") {
    try {
      const current = load(storage, action.kind);
      if (current) return current;
    } catch (error) {
      if (!(error instanceof UnreadableWalletFundingIntentError)) throw error;
    }
    return replace(storage, action.kind, null, create);
  }
  const current = load(storage, action.kind);
  if (action.action === "prepare") {
    if (current) return current;
    return replace(storage, action.kind, null, create);
  }
  if (!current) return replace(storage, action.kind, null, create);
  if (current.requestId !== action.requestId) return current;
  return replace(storage, action.kind, current.requestId, create);
}

export async function callWalletFundingIntent(
  bus: Pick<MsgBusClient, "callTool">,
  action: WalletFundingIntentAction,
): Promise<WalletFundingDemoRequest> {
  const value = await bus.callTool({
    target: "app:kitchensink:background",
    name: WALLET_FUNDING_INTENT_TOOL,
    arguments: action as JsonObject,
  }, 10);
  return parseWalletFundingDemoRequest(value, action.kind);
}

function replace(
  storage: IntentStorage,
  kind: WalletFundingDemoKind,
  previousId: string | null,
  create: typeof createWalletFundingDemoRequest,
): WalletFundingDemoRequest {
  const request = parseWalletFundingDemoRequest(create(kind), kind);
  if (request.requestId === previousId) {
    throw new Error("Invalid Wallet funding fresh request ID");
  }
  storage.setItem(storageKey(kind), JSON.stringify(request));
  return request;
}

function load(
  storage: IntentStorage,
  kind: WalletFundingDemoKind,
): WalletFundingDemoRequest | null {
  const encoded = storage.getItem(storageKey(kind));
  if (encoded === null) return null;
  try {
    return parseWalletFundingDemoRequest(JSON.parse(encoded), kind);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid value";
    throw new UnreadableWalletFundingIntentError(
      `${WALLET_FUNDING_UNREADABLE_ERROR} (${kind}): ${detail}`,
    );
  }
}

function storageKey(kind: WalletFundingDemoKind): string {
  return `${WALLET_FUNDING_INTENT_STORAGE_KEY}.${kind}`;
}
