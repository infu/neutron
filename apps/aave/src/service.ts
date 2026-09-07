import { exposeTool, type JsonObject, type JsonValue, type MsgBusToolContext } from "neutron-tools/app";
import { createEvmWalletClient, requireEvmWalletCaller } from "neutron-tools/evm_wallet";
import { getAddress } from "viem";
import { chain, walletReader } from "./contracts.ts";
import { readMarket } from "./markets.ts";
import { estimateFees, parseInput, preparePlan, type Input, type Plan } from "./plans.ts";
import { createStore, type RecordRow } from "./store.ts";
import { intentOf, latestRecord, operationId, resultOf, runOperation, savedResult, type Result } from "./workflow.ts";

const text = { type: "string" }, nullableText = { oneOf: [text, { type: "null" }] };
const address = { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" }, nullableAddress = { oneOf: [address, { type: "null" }] };
const uint = { type: "string", pattern: "^0$|^[1-9][0-9]*$" }, chainSchema = { enum: ["1", "42161"] };
const idSchema = { type: "string", pattern: "^[0-9a-f]{32}$" };
const schema = (properties: JsonObject, required = Object.keys(properties)): JsonObject => ({ type: "object", properties, required, additionalProperties: false });
const json = (value: unknown) => value as JsonValue;
const inputProperties: JsonObject = {
  kind: { enum: ["supply", "withdraw", "borrow", "repay", "repay_atokens", "collateral", "emode", "rewards"] }, chainId: chainSchema,
  asset: nullableAddress, amount: uint, all: { type: "boolean" }, useNative: { type: "boolean" },
  maxPaymentAmount: { oneOf: [uint, { type: "null" }] }, collateralEnabled: { type: "boolean" },
  eModeId: { type: "integer", minimum: 0, maximum: 255 }, quoteValiditySeconds: uint,
};
const resultSchema = schema({ operationId: text, summary: text, recordId: nullableText, state: { enum: ["complete", "pending", "review", "stopped"] }, phase: text, transactionHash: nullableText, message: text,
  steps: { type: "array", items: schema({ label: text, status: text, transactionHash: nullableText }) } });
const readAnnotations: JsonObject = { "neutron:effects": ["read", "network"], "neutron:longRunning": true };
const effectAnnotations: JsonObject = { "neutron:effects": ["read", "write", "network", "user_visible_ui"], "neutron:longRunning": true };
const calls = new Map<string, Promise<Result>>();

function caller(context: MsgBusToolContext) {
  const authenticated = requireEvmWalletCaller(context);
  // Only the app's own authenticated human tile owns UI continuations. An
  // external app or Agent cannot turn a saved invocation into a tile request.
  return !context.agentMode && authenticated.appId === "aave" && context.caller?.role === "tile" ? null : authenticated;
}
async function account(context: MsgBusToolContext) {
  const wallet = createEvmWalletClient(context.kernel, context.signal ? { callOptions: { signal: context.signal } } : {});
  const selected = (await wallet.accounts()).accounts.find((account) => account.accountId === "main");
  if (!selected) throw new Error("Install EVM Wallet to use your Ethereum account in Aave.");
  return { wallet, account: selected, read: walletReader(wallet, context.signal) };
}

async function execute(context: MsgBusToolContext, id: string, input: Input, effects: boolean): Promise<JsonValue> {
  operationId(id);
  const owner = caller(context), store = createStore(context.kernel), controller = new AbortController();
  const cancel = () => controller.abort(context.signal?.reason ?? new Error("Aave tracking paused"));
  context.signal?.addEventListener("abort", cancel, { once: true });
  if (context.signal?.aborted) cancel();
  // Match the existing long-tool transport window; no operation or attempt
  // expires when tracking yields. Every retry retains its original identity.
  const timer = setTimeout(() => controller.abort(new Error("Continue this saved operation to keep tracking")), 240000);
  const key = `${owner?.appId ?? "human"}:${owner?.installationUid ?? "tile"}:${id}`;
  let latest: RecordRow | null = null;
  const task = Promise.resolve(calls.get(key)).catch(() => undefined).then(() => runOperation(
    createEvmWalletClient(context.kernel, { callOptions: { signal: controller.signal } }), store, id, input, owner, !!context.agentMode,
    { execute: effects, signal: controller.signal, onRecord: (record) => { latest = record; }, onProgress: (message) => context.reportProgress({ phase: message, operationId: id }) },
  ));
  calls.set(key, task);
  const release = () => { if (calls.get(key) === task) calls.delete(key); };
  void task.then(release, release);
  let listener!: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    listener = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", listener, { once: true });
    if (controller.signal.aborted) listener();
  });
  try { return json(await Promise.race([task, interrupted])); }
  catch (error) {
    if (!controller.signal.aborted) throw error;
    return json(latest ? resultOf(latest, "pending", "Tracking paused. Continue this same operation ID; an interrupted reply does not mean the transaction failed.") : {
      operationId: id, recordId: null, state: "pending", phase: "preparing", summary: "Preparing Aave operation", transactionHash: null, steps: [], message: "Preparation paused. Retry the same operation ID and original inputs to recover any saved intent.",
    });
  } finally { clearTimeout(timer); context.signal?.removeEventListener("abort", cancel); controller.signal.removeEventListener("abort", listener); }
}

exposeTool("aave_markets_v1", {
  title: "Read Aave market and positions",
  description: "Read Ethereum Core V3 or Arbitrum V3 reserves, wallet supplies and variable debts, rates, liquidity, caps, collateral configuration, E-mode categories, reward observations and account health through EVM Wallet. Every read refreshes at a consistent block. Reserves match the actual Pool contract by chain and address; names do not prove identity. Base values and atomic amounts are decimal strings, rates vary, and errors identify unavailable observations rather than zero balances. This is a read, not a signature or investment recommendation.",
  inputSchema: schema({ chainId: chainSchema, refresh: { type: "boolean" } }, ["chainId"]), outputSchema: schema({ marketJson: text }), annotations: readAnnotations,
}, async (args, context) => {
  const connection = await account(context);
  return { marketJson: JSON.stringify(await readMarket(connection.read, chain(args.chainId), getAddress(connection.account.address), { ...(context.signal ? { signal: context.signal } : {}), onProgress: (phase) => context.reportProgress({ phase }) })) };
});

exposeTool("aave_quote_v1", {
  title: "Preview an Aave lending operation",
  description: "Preview supply, withdraw, variable borrow, repay, repay_atokens, collateral, emode or rewards on the signing wallet. Input asset is the reserve underlying contract; useNative selects the official WETH gateway for that reserve. amount and maxPaymentAmount are atomic units. all selects whole debt/supply where supported; full payment/native withdrawal requires an explicit bounded maxPaymentAmount to cover accrual, never an implicit unlimited approval. collateralEnabled toggles the asset; eModeId is the protocol uint8 category (0 disables). Quotes read current protocol constraints and show account/health changes, changing rates and exact transaction steps. No signing. Default quote freshness 1200 seconds; Aave transactions themselves have no onchain expiry. Use execute_v1 to finish the same operation through its final receipt.",
  inputSchema: schema(inputProperties, ["kind", "chainId"]), outputSchema: schema({ planJson: text }), annotations: readAnnotations,
}, async (args, context) => {
  const connection = await account(context);
  return { planJson: JSON.stringify(await preparePlan(connection.wallet, connection.account, parseInput(args), { ...(context.signal ? { signal: context.signal } : {}), onProgress: (phase) => context.reportProgress({ phase }) })) };
});

exposeTool("aave_fees_v1", {
  title: "Estimate Aave network fees", description: "Estimate the exact quoted transaction steps through EVM Wallet. Estimates can remain unavailable until prerequisite approvals/delegations confirm. This does not reserve nonces or request signatures; the Wallet reviews the current fee before signing.",
  inputSchema: schema({ planJson: text }), outputSchema: schema({ feesJson: text }), annotations: readAnnotations,
}, async (args, context) => ({ feesJson: JSON.stringify(await estimateFees(createEvmWalletClient(context.kernel), JSON.parse(String(args.planJson)) as Plan, context.signal)) }));

exposeTool("aave_execute_v1", {
  title: "Complete an Aave lending operation", description: "Save original inputs and exact Wallet request IDs, obtain each authenticated human or Agent review, confirm required approvals/delegations and the final Aave transaction. Reuse one 32-hex operationId and identical inputs after pending/review or a lost reply; do not stop at token approval or create a second debt/supply operation. Expired plans renew against live protocol state only when no outstanding Wallet request remains. An open original review must be finished or declined in Wallet Activity; Aave calldata has no expiry. Ambiguous requests retain their IDs. Defaults, bounded full-payment budgets and amounts match quote_v1. Every new effect uses EVM Wallet public provider review under current owner instructions. Serialize effectful flows within one Agent run.",
  inputSchema: schema({ operationId: idSchema, ...inputProperties }, ["operationId", "kind", "chainId"]), outputSchema: resultSchema, annotations: effectAnnotations,
}, (args, context) => execute(context, String(args.operationId), parseInput(args), true));

for (const [name, effects] of [["aave_continue_v1", true], ["aave_reconcile_v1", false]] as const) exposeTool(name, {
  title: effects ? "Continue a saved Aave operation" : "Check saved Aave transaction status",
  description: effects ? "Resume the original saved inputs and request IDs for this authenticated caller. Human UI cannot take over an Agent operation. Current protocol checks and exact Wallet review apply to every new transaction." : "Reconcile existing Wallet requests and actual receipts. Wallet may resend already approved signed bytes during recovery; this tool never asks for fresh approval or a new signature. Continue_v1 resumes incomplete execution.",
  inputSchema: schema({ operationId: idSchema }), outputSchema: resultSchema, annotations: effects ? effectAnnotations : { "neutron:effects": ["read", "write", "network"], "neutron:longRunning": true },
}, async (args, context) => {
  const id = operationId(args.operationId), record = await latestRecord(createStore(context.kernel), id);
  if (!record) throw new Error("No saved Aave operation was found.");
  return execute(context, id, intentOf(record).input, effects);
});

exposeTool("aave_status_v1", {
  title: "Read saved Aave progress", description: "Read retained progress and original input without contacting the EVM network or sending transactions. Reconcile_v1 checks live receipts; continue_v1 resumes the same caller's flow.",
  inputSchema: schema({ operationId: idSchema }), outputSchema: schema({ result: { oneOf: [resultSchema, { type: "null" }] }, inputJson: nullableText, humanOwned: { type: "boolean" } }), annotations: { "neutron:effects": ["read"] },
}, async (args, context) => {
  const store = createStore(context.kernel), id = String(args.operationId), record = await latestRecord(store, id), intent = record ? intentOf(record) : null;
  return json({ result: record ? await savedResult(store, id, record) : null, inputJson: intent ? JSON.stringify(intent.input) : null, humanOwned: !!intent && intent.caller === null && !intent.agentMode });
});

exposeTool("aave_history_v1", {
  title: "Read Aave activity", description: "Read paginated saved operations with current retained progress. Follow nextCursor for older records. Every renewed quote remains attached to its original operation; history never prunes pending requests. This reads the journal, not live chain finality.",
  inputSchema: schema({ cursor: nullableText, limit: { type: "integer", minimum: 1 } }, []), outputSchema: schema({ rowsJson: text, nextCursor: nullableText }), annotations: { "neutron:effects": ["read"] },
}, async (args, context) => {
  const store = createStore(context.kernel), page = await store.page(args.cursor as string | null | undefined, args.limit as number | undefined);
  const rows = await Promise.all(page.rows.map(async (summary) => {
    const record = await latestRecord(store, summary.id);
    if (!record) throw new Error("A saved operation disappeared.");
    const intent = intentOf(record);
    return { ...summary, result: await savedResult(store, summary.id, record), input: intent.input, humanOwned: intent.caller === null && !intent.agentMode };
  }));
  return { rowsJson: JSON.stringify(rows), nextCursor: page.nextCursor };
});
