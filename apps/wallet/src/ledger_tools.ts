import {
  exposeTool,
  publishAppStateChange,
  requestBackendCallReservationsForTool,
  type BackendCallReservationAction,
  type BackendCallReservationsRequest,
  type ScopedKernelClient,
  type JsonValue,
  type JsonObject,
  type MsgBusToolContext,
} from "neutron-tools/app";
import { parseCustomLedgerPrincipal, type CatalogLedger } from "./catalog.ts";
import { exactObject } from "./funding.ts";
import { desiredWalletReservationScopes, parseWalletReservationScopes, reservationActions } from "./reservations.ts";
import { parseWalletCatalog, parseWalletSnapshot, type WalletSnapshot } from "./wallet_data.ts";
import { WALLET_PROJECTION_TOPIC } from "./wallet_projection.ts";
import {
  parseWalletTokenInfo,
  walletTokenInfoInputSchema,
  walletTokenInfoJson,
  walletTokenInfoOutputSchema,
} from "./token_info.ts";

export const WALLET_ADD_LEDGER_TOOL = "wallet_add_ledger_v1";
export const WALLET_ADD_LEDGER_ROOT_TOOL = "wallet_add_ledger_root_v1";
export const WALLET_ADD_LEDGER_PRESENT_TOOL = "wallet_add_ledger_present_v1";
export const walletAddLedgerInputSchema = walletTokenInfoInputSchema;
export const walletAddLedgerOutputSchema: JsonObject = {
  type: "object",
  required: ["ledger", "selected", "alreadySelected", "tokenInfo", "metadataError"],
  properties: {
    ledger: { type: "string", minLength: 5, maxLength: 63 },
    selected: { type: "boolean" },
    alreadySelected: { type: "boolean" },
    tokenInfo: { oneOf: [walletTokenInfoOutputSchema, { type: "null" }] },
    metadataError: { oneOf: [{ type: "string" }, { type: "null" }] },
  },
  additionalProperties: false,
};

type LedgerAddition = {
  ledger: string;
  alreadySelected: boolean;
  catalogEntry: CatalogLedger | null;
  actions: BackendCallReservationAction[];
};

export type WalletLedgerServices = {
  requestAccess: (kernel: ScopedKernelClient, request: BackendCallReservationsRequest) => Promise<JsonValue>;
  publish: () => Promise<void>;
};
const ledgerServices: WalletLedgerServices = {
  requestAccess: requestBackendCallReservationsForTool,
  publish: () => publishAppStateChange(WALLET_PROJECTION_TOPIC, Date.now()),
};

export function registerLedgerTools(): void {
  exposeTool(WALLET_ADD_LEDGER_TOOL, {
    title: "Add a token to Wallet",
    description: "Select one catalog or custom ICRC ledger without removing any selected tokens. Normal mode opens Wallet for one exact token/access approval. Root mode uses the agent permission judge without interactive UI. Returns live token metadata, fee and balance when available; a metadata error does not undo the saved selection. No tokens move. Retry the same ledger safely after a lost reply.",
    inputSchema: walletAddLedgerInputSchema,
    outputSchema: walletAddLedgerOutputSchema,
    annotations: {
      "neutron:consent": "provider_once",
      "neutron:effects": ["persistent_permission", "write", "network", "user_visible_ui"],
    },
  }, handleWalletAddLedger);
  exposeTool(WALLET_ADD_LEDGER_ROOT_TOOL, {
    title: "Add a token to Wallet as the root agent",
    description: "Select one catalog or custom ICRC ledger and obtain Wallet's required ledger access without interactive UI. Available only to the active root agent. Preserves every other token selection. Returns live metadata, fee and balance when available. No transfer or allowance is dispatched. Idempotent: retry the same ledger after an interrupted reply.",
    inputSchema: walletAddLedgerInputSchema,
    outputSchema: walletAddLedgerOutputSchema,
    annotations: {
      "neutron:audience": "agent_root",
      "neutron:visibility": "same_app",
      "neutron:effects": ["persistent_permission", "write", "network"],
    },
  }, handleWalletAddLedgerRoot);
}

export async function handleWalletAddLedger(args: JsonObject, context: MsgBusToolContext, services: WalletLedgerServices = ledgerServices): Promise<JsonObject> {
  const ledger = requestedLedger(args);
  context.signal?.throwIfAborted();
  if (!context.agentMode) {
    if (!context.presentUserInterface) throw new Error("Wallet token selection requires Kernel provider UI support");
    return context.presentUserInterface<JsonObject>({
      tileId: "wallet", tool: WALLET_ADD_LEDGER_PRESENT_TOOL, arguments: { ledger },
    });
  }
  const addition = await prepareAddition({ ledger }, context);
  if (!context.requestApproval) throw new Error("Wallet token selection requires Kernel provider approval support");
  // This capability is bound to the exact invocation; Root's permission judge
  // receives the retained ledger and scopes without opening an owner dialog.
  await context.requestApproval({
    kind: "wallet_add_ledger",
    ledger: addition.ledger,
    name: addition.catalogEntry?.name ?? null,
    symbol: addition.catalogEntry?.symbol ?? null,
    metadataSource: addition.catalogEntry ? "Wallet catalog" : "Custom ledger; metadata is read after access approval",
    alreadySelected: addition.alreadySelected,
    backendAccess: addition.actions as unknown as JsonObject[],
    selection: "Add this ledger and retain every other selected token",
  });
  context.signal?.throwIfAborted();
  return executeAddition(addition, context, services);
}

export async function handleWalletAddLedgerPresentation(args: JsonObject, context: MsgBusToolContext, services: WalletLedgerServices = ledgerServices): Promise<JsonObject> {
  if (context.audience !== "foreground_tile") throw new Error("Wallet token selection UI requires foreground-tile attestation");
  return executeAddition(await prepareAddition(args, context), context, services);
}

function requestedLedger(args: JsonObject): string {
  const request = exactObject(args, ["ledger"], "Wallet token selection request");
  if (typeof request.ledger !== "string") throw new Error("Enter a ledger canister ID");
  return parseCustomLedgerPrincipal(request.ledger);
}

export async function handleWalletAddLedgerRoot(args: JsonObject, context: MsgBusToolContext, services: WalletLedgerServices = ledgerServices): Promise<JsonObject> {
  if (context.audience !== "agent_root") throw new Error("Wallet root token selection requires root-agent attestation");
  return executeAddition(await prepareAddition(args, context), context, services);
}

async function prepareAddition(args: JsonObject, context: MsgBusToolContext): Promise<LedgerAddition> {
  context.signal?.throwIfAborted();
  const ledger = requestedLedger(args);
  const [snapshotValue, catalogValue, accessValue] = await Promise.all([
    context.kernel.querySelf("wallet_snapshot", [null]),
    context.kernel.querySelf("wallet_catalog", [null]),
    context.kernel.callTool({ target: "kernel", name: "backend_calls.list", arguments: {} }),
  ]);
  context.signal?.throwIfAborted();
  const snapshot = parseWalletSnapshot(snapshotValue);
  if (ledger === snapshot.owner) throw new Error("Wallet canister is not a ledger principal");
  const catalog = parseWalletCatalog(catalogValue);
  const current = parseWalletReservationScopes(accessValue);
  const desired = desiredWalletReservationScopes(catalog, new Set([ledger]));
  // Additive access only. A token tool must not release another token's grants,
  // nor replace a selection snapshot that may change while approval is open.
  const actions = reservationActions(current, desired).filter((action) => action.kind === "reserve");
  return {
    ledger,
    alreadySelected: snapshot.ledgers.some((entry) => entry.principal === ledger),
    catalogEntry: catalog.find((entry) => entry.principal === ledger) ?? null,
    actions,
  };
}

async function executeAddition(addition: LedgerAddition, context: MsgBusToolContext, services: WalletLedgerServices): Promise<JsonObject> {
  context.signal?.throwIfAborted();
  // The existing combined transport reviews these exact additive arguments
  // and access scopes together. It retains the invocation and cancellation;
  // no new preapproved method or ambient background authority is required.
  const value = await services.requestAccess(context.kernel, {
    actions: addition.actions,
    call: { method: WALLET_ADD_LEDGER_TOOL, args: [addition.ledger] },
  });
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Wallet access response");
  if (typeof value.callError === "string") throw new Error(`Access was updated but Wallet could not add the token: ${value.callError}. Retry the same ledger safely.`);
  if (value.callResult === undefined) throw new Error("Wallet did not return its saved selection; refresh Wallet or retry the same ledger");
  const snapshot = parseWalletSnapshot(value.callResult as JsonValue);
  assertSelected(snapshot, addition.ledger);
  let tokenInfo: JsonObject | null = null;
  let metadataError: string | null = null;
  try {
    context.signal?.throwIfAborted();
    tokenInfo = walletTokenInfoJson(parseWalletTokenInfo(
      await context.kernel.updateSelf("wallet_token_info_v1", [{ ledger: addition.ledger }], 60),
      addition.ledger,
    ));
  } catch (error) {
    // Selection is durable even when this subsequent read is unavailable. A
    // retry safely refreshes metadata without adding another token or spending.
    metadataError = error instanceof Error ? error.message : String(error);
  }
  try { await services.publish(); } catch { /* Saved backend state is authoritative. */ }
  return { ledger: addition.ledger, selected: true, alreadySelected: addition.alreadySelected, tokenInfo, metadataError };
}

function assertSelected(snapshot: WalletSnapshot, ledger: string): void {
  if (!snapshot.ledgers.some((entry) => entry.principal === ledger)) {
    throw new Error("Wallet did not confirm the requested ledger selection; refresh Wallet before retrying the same ledger");
  }
}
