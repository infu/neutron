import {
  exposeTool,
  publishAppStateChange,
  querySelf,
  setTrayState,
  updateSelf,
  type JsonObject,
} from "neutron-tools/app";
import { historyPageRequest, parseHistoryPage } from "./history.ts";
import {
  WALLET_FUNDING_EXECUTE_METHOD,
  WALLET_FUNDING_ROOT_TOOL,
  WALLET_FUNDING_TOOL,
  executeWalletFundingOperation,
  handleWalletFunding,
  prepareWalletFundingOperation,
  walletFundingInputSchema,
  walletFundingOutputSchema,
  type WalletFundingToolContext,
} from "./funding.ts";
import {
  WALLET_PROJECTION_ACTIVITY_LIMIT,
  WALLET_PROJECTION_TOOLS,
  WALLET_PROJECTION_TOPIC,
  createWalletProjection,
  walletProjectionEmptyInputSchema,
  walletProjectionSchema,
  type WalletProjection,
} from "./wallet_projection.ts";
import {
  parseWalletCatalog,
  parseWalletSnapshot,
  parseWalletSnapshotResult,
  type WalletSnapshot,
} from "./wallet_data.ts";

let revision = 0;
let readInFlight: Promise<WalletProjection> | null = null;
let refreshInFlight: Promise<WalletProjection> | null = null;

exposeTool(
  WALLET_PROJECTION_TOOLS.overview,
  {
    title: "Read Wallet Overview",
    description:
      "Read selected assets, exact cached balances, balance freshness, warnings, and the five most recent Wallet activity records. Amounts are decimal strings and no transfer is performed.",
    inputSchema: walletProjectionEmptyInputSchema,
    outputSchema: walletProjectionSchema,
    annotations: { "neutron:effects": ["read"] },
  },
  async () => asJson(await readProjection()),
);

exposeTool(
  WALLET_PROJECTION_TOOLS.refresh,
  {
    title: "Refresh Wallet Balances",
    description:
      "Refresh all selected ledger balances, then return the same bounded Wallet overview. This never sends tokens or changes the selected assets.",
    inputSchema: walletProjectionEmptyInputSchema,
    outputSchema: walletProjectionSchema,
    annotations: { "neutron:effects": ["write"] },
  },
  async () => asJson(await refreshProjection()),
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
  (args, context) =>
    handleWalletFunding(
      args,
      context as WalletFundingToolContext,
    ),
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
    if (context.audience !== "agent_root") {
      throw new Error("Wallet root funding requires root-agent attestation");
    }
    const operation = await prepareWalletFundingOperation(
      args,
      context as WalletFundingToolContext,
      true,
    );
    const result = await executeWalletFundingOperation(
      operation,
      (executeArgs) =>
        context.kernel.updateSelf(
          WALLET_FUNDING_EXECUTE_METHOD,
          [executeArgs],
          120,
        ),
      context.signal,
    );
    try {
      await publishAppStateChange(WALLET_PROJECTION_TOPIC, Date.now());
    } catch {
      // The durable funding result is authoritative; notification is best effort.
    }
    return result;
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
    const projection = await loadProjection(parseWalletSnapshotResult(refreshed));
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
): Promise<WalletProjection> {
  const snapshotPromise = suppliedSnapshot
    ? Promise.resolve(suppliedSnapshot)
    : querySelf("wallet_snapshot", [null]).then(parseWalletSnapshot);
  const catalogPromise = querySelf("wallet_catalog", [null]).then(
    parseWalletCatalog,
  );
  const historyPromise = querySelf("wallet_history_page", [
    historyPageRequest(null, null, WALLET_PROJECTION_ACTIVITY_LIMIT + 1),
  ]).then(parseHistoryPage);

  const [snapshot, catalog, historyResult] = await Promise.all([
    snapshotPromise,
    catalogPromise,
    historyPromise.then(
      (page) => ({ page, error: null as string | null }),
      (error) => ({ page: null, error: errorMessage(error) }),
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
