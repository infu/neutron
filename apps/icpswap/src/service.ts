// Resident background for ICPSwap Market.
//
// It exists for two reasons: the research tools stay callable while no tile is
// open, and the token universe is warmed and periodically refreshed so opening
// the tile is instant. It holds no owner authority of its own — every backend
// call goes through the app's preapproved self calls.

import { exposeTool, publishAppStateChange, type JsonObject } from "neutron-tools/app";
import { loadTokenRanks, loadTokenUniverse } from "./api.ts";
import { createActionBackend, readAllActionSummaries } from "./action_backend.ts";
import { registerActionTools } from "./action_tools.ts";
import { authorizeAction } from "./provider.ts";
import { registerTools, retainedPoolsFromOperations } from "./tools.ts";

/** How often the resident re-warms the REST caches while the shell is open. */
const UNIVERSE_REFRESH_MS = 120_000;


const STATE_TOPIC = "market";

let revision = 0;

function announce(): void {
  revision += 1;
  // Invalidation only: tiles re-fetch their own view when they see a new
  // revision. Never a data channel.
  void publishAppStateChange(STATE_TOPIC, revision).catch(() => undefined);
}

async function warmUniverse(): Promise<void> {
  try {
    await loadTokenUniverse(UNIVERSE_REFRESH_MS);
    await loadTokenRanks();
    announce();
  } catch {
    // An upstream outage is expected and non-fatal: the tile falls back to the
    // on-chain snapshot and shows the degraded source.
  }
}


const actions = registerActionTools({ backendFor: createActionBackend, authorize: authorizeAction });

// Existing callers retain their names, while every effect uses the same saved
// operation and provider review as the current UI and Agent tools.
const legacySwapSchema: JsonObject = {
  type: "object",
  properties: {
    operationId: { type: "string", pattern: "^[0-9a-f]{32}$" },
    request_id: { type: "string", pattern: "^[0-9a-f]{32}$", description: "Legacy spelling of operationId. Retain it for every continuation." },
    from_ledger_id: { type: "string" }, to_ledger_id: { type: "string" },
    amount: { type: "string", pattern: "^[0-9]+$", description: "Input token atomic units." },
    slippage: { type: "integer", minimum: 1, maximum: 50000, description: "Thousandths of a percent; 500 is 0.5%." },
  },
  required: ["from_ledger_id", "to_ledger_id", "amount"], additionalProperties: false,
};
for (const name of ["icpswap_agent_swap", "icpswap_execute_swap"]) {
  exposeTool(name, {
    title: "Prepare or execute an ICPSwap swap",
    description: "Compatibility alias for icpswap_swap_v1. With operationId or request_id, uses the saved, reviewed action flow. Without an ID, only prepares and returns a retained operationId: continue that operation to fund and execute. Root funding instructions must be called by the depth-zero Agent and then reconciled with icpswap_continue_v1. Normal mode presents owner approval.",
    inputSchema: legacySwapSchema,
    outputSchema: { type: "object" },
    annotations: { "neutron:effects": ["read", "write", "network", "user_visible_ui"], "neutron:consent": "provider_once", "neutron:longRunning": true },
  }, actions.legacySwap);
}

registerTools({
  accountFor: (context) => createActionBackend(context.kernel).account(),
  retainedPoolsFor: async (context) => retainedPoolsFromOperations(await readAllActionSummaries(createActionBackend(context.kernel), context.signal ? { signal: context.signal } : {})),
});

void warmUniverse();

setInterval(() => {
  void warmUniverse();
}, UNIVERSE_REFRESH_MS);
