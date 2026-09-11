import { queryWalletRead } from "./wallet_read.ts";
import { registerRefillTools } from "./refill_tools.ts";
import { registerLedgerTools } from "./ledger_tools.ts";
import { registerHistoryTools } from "./history_tools.ts";
import {
  WALLET_WITHDRAWAL_QUOTE_TOOL,
  handleWalletWithdrawalQuote,
  walletWithdrawalQuoteInputSchema,
  walletWithdrawalQuoteOutputSchema,
} from "./withdrawal_quote.ts";
import { registerBridgeTools } from "./bridge_tools.ts";
import { registerConversionTools } from "./conversion_tools.ts";
import { registerDepositTools } from "./deposit_tools.ts";
import {
  exposeTool,
  publishAppStateChange,
  querySelf,
  setTrayState,
  updateSelf,
  type JsonObject,
} from "neutron-tools/app";
import {
  queryHistoryPage,
  parseHistoryStatus,
  parseHistorySyncReport,
} from "./history.ts";
import {
  WALLET_FUNDING_ROOT_TOOL,
  WALLET_FUNDING_TOOL,
  handleWalletFunding,
  handleWalletRootFunding,
  walletFundingResultNeedsRefresh,
  walletFundingInputSchema,
  walletFundingOutputSchema,
} from "./funding.ts";
import {
  WALLET_PROJECTION_ACTIVITY_LIMIT,
  WALLET_PROJECTION_TOOLS,
  WALLET_PROJECTION_TOPIC,
  createWalletProjection,
  walletProjectionForTool,
  walletProjectionInputSchema,
  walletProjectionSchema,
  type WalletProjection,
  type WalletActivitySync,
} from "./wallet_projection.ts";
import {
  parseWalletCatalog,
  parseWalletSnapshot,
  parseWalletSnapshotResult,
  type WalletSnapshot,
} from "./wallet_data.ts";
import {
  WALLET_TOKEN_INFO_METHOD,
  WALLET_TOKEN_INFO_TOOL,
  parseWalletTokenInfo,
  walletTokenInfoInputSchema,
  walletTokenInfoJson,
  walletTokenInfoOutputSchema,
  walletTokenInfoRequest,
} from "./token_info.ts";

registerRefillTools();
registerLedgerTools();
registerHistoryTools();
registerBridgeTools();
registerConversionTools();
registerDepositTools();
exposeTool(
  WALLET_WITHDRAWAL_QUOTE_TOOL,
  {
    title: "Quote a native withdrawal and ckETH gas",
    description: "Read the exact minter approval amounts, asset fee, separate ckETH gas budget and fee, and current balances for a native withdrawal. No allowance or withdrawal is dispatched. The reviewed quote is checked again before execution.",
    inputSchema: walletWithdrawalQuoteInputSchema,
    outputSchema: walletWithdrawalQuoteOutputSchema,
    annotations: { "neutron:effects": ["read", "network"] },
  },
  handleWalletWithdrawalQuote,
);

let revision = 0;
let readInFlight: Promise<WalletProjection> | null = null;
let refreshInFlight: Promise<WalletProjection> | null = null;

exposeTool(
  WALLET_PROJECTION_TOOLS.overview,
  {
    title: "Read Wallet Overview",
    description:
      "Read selected assets, exact cached balances, balance freshness, warnings, and five cached Wallet activity records with per-ledger history status and checkpoints. No synchronization or transfer is performed. historyError=null means the page was read, not that history is current or complete. Missing activity does not prove a payout is absent. Token logos are omitted unless includeLogos is true.",
    inputSchema: walletProjectionInputSchema,
    outputSchema: walletProjectionSchema,
    annotations: { "neutron:effects": ["read"] },
  },
  async (args) => asJson(walletProjectionForTool(
    await readProjection(),
    args.includeLogos === true,
  )),
);

exposeTool(
  WALLET_PROJECTION_TOOLS.refresh,
  {
    title: "Refresh Wallet Balances and Activity",
    description:
      "Refresh selected ledger balances and attempt history synchronization once, then return the Wallet overview with the sync report, per-ledger index/checkpoint status, and any activity errors. A finished attempt or balance-only unchanged result does not prove complete history; missing activity does not prove no payout. This never sends tokens or changes selected assets. Token logos are omitted unless includeLogos is true.",
    inputSchema: walletProjectionInputSchema,
    outputSchema: walletProjectionSchema,
    annotations: { "neutron:effects": ["read", "write", "network"], "neutron:longRunning": true },
  },
  async (args) => asJson(walletProjectionForTool(
    await refreshProjection(),
    args.includeLogos === true,
  )),
);

exposeTool(
  WALLET_TOKEN_INFO_TOOL,
  {
    title: "Read live Wallet token information",
    description:
      "Read current metadata, fee, and Wallet default-account balance for one selected ICRC ledger. Atomic amounts are decimal strings. The fee is advisory; Wallet rechecks it before funding.",
    inputSchema: walletTokenInfoInputSchema,
    outputSchema: walletTokenInfoOutputSchema,
    annotations: { "neutron:effects": ["read", "network"] },
  },
  async (args, context) => {
    const request = walletTokenInfoRequest(args);
    return walletTokenInfoJson(
      parseWalletTokenInfo(
        await context.kernel.updateSelf(
          WALLET_TOKEN_INFO_METHOD,
          [request.wire],
          60,
        ),
        request.ledger,
      ),
    );
  },
);

exposeTool(
  WALLET_FUNDING_TOOL,
  {
    title: "Fund an app with Wallet",
    description:
      "Open Wallet to review and execute one exact ICRC token transfer or short-lived spending allowance.",
    inputSchema: walletFundingInputSchema,
    outputSchema: walletFundingOutputSchema,
    annotations: {
      "neutron:audit": "metadata_only",
      "neutron:consent": "provider_once",
      "neutron:effects": ["write", "network", "user_visible_ui"],
    },
  },
  (args, context) => handleWalletFunding(args, context),
);

exposeTool(
  WALLET_FUNDING_ROOT_TOOL,
  {
    title: "Fund an app with Wallet as the root agent",
    description:
      "Prepare and execute one exact ICRC token transfer or short-lived spending allowance without interactive UI. Available only to the active root agent.",
    inputSchema: walletFundingInputSchema,
    outputSchema: walletFundingOutputSchema,
    annotations: {
      "neutron:audit": "metadata_only",
      "neutron:audience": "agent_root",
      "neutron:effects": ["write", "network"],
      "neutron:visibility": "same_app",
    },
  },
  async (args, context) => {
    try {
      const result = await handleWalletRootFunding(args, context);
      if (walletFundingResultNeedsRefresh(result)) {
        try {
          await context.kernel.updateSelf(
            "wallet_refresh_balances",
            [null],
            60,
          );
        } catch {
          // The durable funding result is authoritative; refresh is best effort.
        }
      }
      return result;
    } finally {
      try {
        await publishAppStateChange(WALLET_PROJECTION_TOPIC, Date.now());
      } catch {
        // The durable funding result is authoritative; notification is best effort.
      }
    }
  },
);

// Wallet does not yet have an unread cursor, so the tray icon intentionally has
// no numeric badge. A balance warning is not an unread item.
void setTrayState({ badge: null }).catch((error) => {
  console.error("[Wallet] Unable to initialize tray state", error);
});

function readProjection(): Promise<WalletProjection> {
  if (refreshInFlight) return refreshInFlight;
  if (readInFlight) return readInFlight;
  const task = loadProjection().finally(() => {
    if (readInFlight === task) readInFlight = null;
  });
  readInFlight = task;
  return task;
}

function refreshProjection(): Promise<WalletProjection> {
  if (refreshInFlight) return refreshInFlight;
  const task = (async () => {
    if (readInFlight) await readInFlight.catch(() => undefined);
    const refreshed = await updateSelf("wallet_refresh_balances", [null]);
    const snapshot = parseWalletSnapshotResult(refreshed);
    const activitySync: WalletActivitySync = { requested: true, report: null, error: null };
    try {
      activitySync.report = parseHistorySyncReport(await updateSelf("wallet_history_sync", [null], 180));
    } catch (error) {
      // Keep refreshed balances and cached activity useful when indexing is unavailable.
      activitySync.error = errorMessage(error);
    }
    const projection = await loadProjection(snapshot, activitySync);
    try {
      await publishAppStateChange(WALLET_PROJECTION_TOPIC, projection.revision);
    } catch {
      // The refresh succeeded. Consumers also refetch whenever the tray opens.
    }
    return projection;
  })().finally(() => {
    if (refreshInFlight === task) refreshInFlight = null;
  });
  refreshInFlight = task;
  return task;
}

async function loadProjection(
  suppliedSnapshot?: WalletSnapshot,
  activitySync?: WalletActivitySync,
): Promise<WalletProjection> {
  const snapshotPromise = suppliedSnapshot
    ? Promise.resolve(suppliedSnapshot)
    : queryWalletRead(querySelf, "snapshot").then(parseWalletSnapshot);
  const catalogPromise = queryWalletRead(querySelf, "catalog").then(
    parseWalletCatalog,
  );
  const historyPromise = queryHistoryPage(null, null, WALLET_PROJECTION_ACTIVITY_LIMIT + 1);
  const historyStatusPromise = querySelf("wallet_history_status", [null]).then(parseHistoryStatus);

  const [snapshot, catalog, historyResult, historyStatusResult] = await Promise.all([
    snapshotPromise,
    catalogPromise,
    historyPromise.then(
      (page) => ({ page, error: null as string | null }),
      (error) => ({ page: null, error: errorMessage(error) }),
    ),
    historyStatusPromise.then(
      (status) => ({ status, error: null as string | null }),
      (error) => ({ status: null, error: errorMessage(error) }),
    ),
  ]);

  revision = revision >= 999_999_999_999_999 ? 1 : revision + 1;
  return createWalletProjection(
    revision,
    snapshot,
    catalog,
    historyResult.page?.records ?? [],
    {
      hasMoreActivity: historyResult.page?.hasMore ?? false,
      historyError: historyResult.error ?? historyResult.page?.warning ?? null,
      historyStatus: historyStatusResult.status,
      historyStatusError: historyStatusResult.error,
      activitySync: activitySync ?? { requested: false, report: null, error: null },
    },
  );
}

function asJson(value: WalletProjection): JsonObject {
  return value as unknown as JsonObject;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return String(error ?? "Wallet activity is unavailable");
}
