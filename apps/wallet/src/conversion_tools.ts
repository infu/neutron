import { queryWalletRead } from "./wallet_read.ts";
import { Principal } from "@dfinity/principal";
import { getAddress, keccak256, stringToHex } from "viem";
import { exposeTool, type JsonObject, type MsgBusToolContext, type SelfCallObject } from "neutron-tools/app";
import { createEvmWalletClient, requireEvmWalletCaller } from "neutron-tools/evm_wallet";
import { parseWalletCatalog, parseWalletSnapshot } from "./wallet_data.ts";
import { parseTransferOperation, transferIdBytes, type WalletTransferOperation } from "./transfers.ts";
import { quoteAuthorizationWire, readWalletWithdrawalQuote } from "./withdrawal_quote.ts";

const text: JsonObject = { type: "string" };
const nat: JsonObject = { type: "string", pattern: "^0$|^[1-9][0-9]*$" };
const id: JsonObject = { type: "string", pattern: "^[0-9a-f]{32}$" };
const address: JsonObject = { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" };
const nullable = (schema: JsonObject): JsonObject => ({ oneOf: [schema, { type: "null" }] });
const closed = (properties: JsonObject): JsonObject => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const phase: JsonObject = { enum: ["pending", "withdrawing", "submitted", "completed", "failed", "unresolved"] };

export const walletUnwrapInputSchema = closed({
  requestId: id, ledger: text, amountAtoms: { type: "string", pattern: "^[1-9][0-9]*$" },
  ethereumAddress: nullable(address),
});
export const walletUnwrapOutputSchema = closed({
  requestId: nullable(id), operationId: id, chainId: { const: "1" }, ledger: text,
  amountAtoms: nat, ethereumAddress: address, phase, message: text,
  transactionHash: nullable(text), burnBlockIndex: nullable(nat),
  nextAction: { enum: ["resume_same_request", "check_status", "none"] },
});
export const walletConversionRoutesSchema = closed({
  chainId: { const: "1" }, network: { const: "Ethereum Mainnet" },
  routes: { type: "array", items: closed({
    ledger: text, symbol: text, ethereumSymbol: text, enabled: { type: "boolean" },
    decimals: nullable({ type: "integer", minimum: 0, maximum: 255 }),
    balanceAtoms: nullable(nat), ethereumTokenAddress: nullable(address),
    gasLedger: nullable(text), wrapTool: { const: "wallet_wrap_root_v1" },
    unwrapTool: { const: "wallet_unwrap_root_v1" },
  }) },
  message: text,
});

export function registerConversionTools(): void {
  exposeTool("wallet_conversion_routes_v1", {
    title: "Find Ethereum and ck-token conversion routes",
    description: "Discover supported ETH/ckETH and ERC20/ck-token pairs, ledger IDs, selected assets, decimals and cached IC balances. Wrap converts Ethereum assets into IC Wallet ck-tokens; unwrap redeems ck-tokens to Ethereum Mainnet. ckUSDC represents USDC, not a bank USD balance. Enable an unselected token in Wallet before converting. Use wallet_token_info_v1 for live metadata/balance and exact atomic-unit conversion.",
    inputSchema: closed({}), outputSchema: walletConversionRoutesSchema,
    annotations: { "neutron:effects": ["read"] },
  }, handleWalletConversionRoutes);
  exposeTool("wallet_unwrap_root_v1", {
    title: "Convert ck-tokens to Ethereum as the root Agent",
    description: "Redeem ckETH to ETH or a supported ckERC20 (for example ckUSDC) to its Ethereum token. One call quotes fees, saves the exact withdrawal, and executes minter approvals and withdrawal. ethereumAddress null sends to your EVM Wallet on Ethereum Mainnet; an explicit address sends there without a Contacts entry. amountAtoms is the ck-token amount in atomic units. Keep requestId and every original argument unchanged when continuing; never use a fresh ID to recover an uncertain result. Native settlement is asynchronous: a burn or approval is not completion. Use wallet_unwrap_status_v1 with operationId to follow it. ckERC20 withdrawals also need ckETH for gas. Available only to the active root Agent; serialize financial operations sharing this minter.",
    inputSchema: walletUnwrapInputSchema, outputSchema: walletUnwrapOutputSchema,
    annotations: { "neutron:audience": "agent_root", "neutron:visibility": "same_app", "neutron:audit": "metadata_only", "neutron:effects": ["write", "network"], "neutron:longRunning": true },
  }, handleWalletUnwrap);
  exposeTool("wallet_unwrap_status_v1", {
    title: "Check a ck-token withdrawal to Ethereum",
    description: "Check the saved withdrawal and refresh its minter settlement evidence. operationId is returned by wallet_unwrap_root_v1 or the Wallet Send flow. Never sends another withdrawal or repeats an approval. Completed means the minter reports Ethereum settlement, not merely the IC burn. A pending/unresolved result keeps its original operation ID.",
    inputSchema: closed({ operationId: id }), outputSchema: walletUnwrapOutputSchema,
    annotations: { "neutron:effects": ["read", "write", "network"], "neutron:longRunning": true },
  }, handleWalletUnwrapStatus);
}

export async function handleWalletConversionRoutes(_args: JsonObject, context: MsgBusToolContext): Promise<JsonObject> {
  const [catalog, snapshot] = await Promise.all([
    queryWalletRead(context.kernel.querySelf, "catalog").then(parseWalletCatalog),
    queryWalletRead(context.kernel.querySelf, "snapshot").then(parseWalletSnapshot),
  ]);
  return {
    chainId: "1", network: "Ethereum Mainnet",
    routes: catalog.filter((entry) => entry.nativeRoute?.originNetwork === "ethereum_mainnet" && entry.nativeRoute.nativeActionsAvailable).map((entry) => {
      const selected = snapshot.ledgers.find((ledger) => ledger.principal === entry.principal);
      return {
        ledger: entry.principal, symbol: entry.symbol, ethereumSymbol: entry.symbol.replace(/^ck/, ""),
        enabled: selected !== undefined, decimals: selected?.decimals ?? null, balanceAtoms: selected?.balance ?? null,
        ethereumTokenAddress: entry.nativeRoute!.contract, gasLedger: entry.nativeRoute!.gasLedger,
        wrapTool: "wallet_wrap_root_v1", unwrapTool: "wallet_unwrap_root_v1",
      };
    }),
    message: "Wrap uses ETH for Ethereum network fees. ERC20 unwrapping uses a separate ckETH gas budget. Both directions use Ethereum Mainnet; settlement can remain pending while the minter processes the exact transaction.",
  };
}

/** Each original caller installation has its own deterministic backend ID.
 * UI-generated transfer IDs remain compatible with the existing journal. */
export function walletUnwrapOperationId(context: MsgBusToolContext, requestId: string): string {
  const caller = requireEvmWalletCaller(context, true);
  validId(requestId);
  return keccak256(stringToHex(JSON.stringify(["wallet.ethereum.withdraw.v1", caller.appId, caller.installationUid, requestId]))).slice(2, 34);
}

async function savedWithdrawal(context: MsgBusToolContext, operationId: string): Promise<WalletTransferOperation | null> {
  let value;
  try { value = await context.kernel.querySelf("wallet_transfer_status_v2", [transferIdBytes(operationId)]); }
  catch (error) {
    // Only the backend's explicit absence result permits preparation. A lost
    // status response never becomes evidence that a withdrawal does not exist.
    if (message(error).includes("Transfer request was not found")) return null;
    throw error;
  }
  return parseTransferOperation(value);
}

export async function handleWalletUnwrap(args: JsonObject, context: MsgBusToolContext): Promise<JsonObject> {
  const requestId = validId(args.requestId);
  const operationId = walletUnwrapOperationId(context, requestId);
  const ledger = Principal.fromText(requiredString(args.ledger)).toText();
  const amount = requiredString(args.amountAtoms);
  if (!/^[1-9][0-9]*$/.test(amount)) throw new Error("Enter a positive ck-token amount in atomic units");
  const explicitAddress = args.ethereumAddress === null ? null : getAddress(requiredString(args.ethereumAddress));
  const wireId = transferIdBytes(operationId);
  context.signal?.throwIfAborted();
  context.reportProgress({ phase: "Checking saved Ethereum withdrawal" });
  let saved = await savedWithdrawal(context, operationId);
  if (saved) {
    if (!saved.native || !/^0x[0-9a-fA-F]{40}$/.test(saved.destination) || saved.ledger !== ledger || saved.amount !== amount || (explicitAddress !== null && saved.destination.toLowerCase() !== explicitAddress.toLowerCase())) throw new Error("This request ID already belongs to a different withdrawal. Continue with its original arguments.");
  } else {
    context.reportProgress({ phase: "Checking Ethereum destination and withdrawal fees" });
    let destination = explicitAddress;
    if (destination === null) {
      const wallet = createEvmWalletClient(context.kernel, context.signal ? { callOptions: { signal: context.signal } } : {});
      const account = (await wallet.accounts()).accounts.find((entry) => entry.accountId === "main");
      if (!account) throw new Error("EVM Wallet's main account is unavailable");
      destination = getAddress(account.address);
    }
    const quote = await readWalletWithdrawalQuote({ ledger, amount }, (method, values, timeout) => context.kernel.updateSelf(method, values, timeout));
    if (quote.assetSufficient === false) throw new Error("Insufficient ck-token balance for the withdrawal amount and approval fee");
    if (quote.gas?.sufficient === false) throw new Error("Insufficient ckETH for the Ethereum withdrawal gas budget and approval fee. Wrap ETH into ckETH first.");
    context.signal?.throwIfAborted();
    const request: SelfCallObject = { request_id: wireId, ledger, address: destination, amount, withdrawal_quote: quoteAuthorizationWire(quote) };
    saved = parseTransferOperation(await context.kernel.updateSelf("wallet_ethereum_withdraw_prepare_v1", [request], 60));
  }
  context.signal?.throwIfAborted();
  if (saved.status !== "pending") return refreshResult(context, saved, requestId);
  context.reportProgress({ phase: "Approving and requesting the Ethereum withdrawal" });
  try {
    const operation = parseTransferOperation(await context.kernel.updateSelf("wallet_transfer_resume_v2", [wireId], 120));
    return operation.status === "succeeded" ? refreshResult(context, operation, requestId) : unwrapResult(operation, requestId);
  } catch (error) {
    // A transport failure is not proof that the minter rejected the burn.
    // Recover only the saved result; never construct another withdrawal here.
    if (!context.signal?.aborted) {
      try {
        const recovered = await savedWithdrawal(context, operationId);
        if (recovered) return unwrapResult(recovered, requestId, message(error));
      } catch { /* Return the durable prepared ID below. */ }
    }
    return unwrapResult(saved, requestId, message(error));
  }
}

export async function handleWalletUnwrapStatus(args: JsonObject, context: MsgBusToolContext): Promise<JsonObject> {
  const operationId = validId(args.operationId);
  const operation = parseTransferOperation(await context.kernel.querySelf("wallet_transfer_status_v2", [transferIdBytes(operationId)]));
  // This tool is Ethereum-specific; other native withdrawal tools can expose
  // the same underlying journal without mislabelling their network.
  if (!operation.native || !/^0x[0-9a-fA-F]{40}$/.test(operation.destination)) throw new Error("This operation is not an Ethereum withdrawal");
  return refreshResult(context, operation, null);
}

async function refreshResult(context: MsgBusToolContext, operation: WalletTransferOperation, requestId: string | null): Promise<JsonObject> {
  if (operation.status !== "rejected" && operation.settlement?.status !== "confirmed" && operation.settlement?.status !== "failed") {
    context.reportProgress({ phase: "Checking minter settlement on Ethereum" });
    try {
      operation = parseTransferOperation(await context.kernel.updateSelf("wallet_transfer_refresh_v2", [transferIdBytes(operation.requestId)], 120));
    } catch (error) { return unwrapResult(operation, requestId, message(error)); }
  }
  return unwrapResult(operation, requestId);
}

export function unwrapResult(operation: WalletTransferOperation, requestId: string | null, error: string | null = null): JsonObject {
  const settlement = operation.settlement;
  const state = operation.status === "rejected" || settlement?.status === "failed" ? "failed"
    : settlement?.status === "confirmed" ? "completed"
    : settlement?.status === "submitted" ? "submitted"
    : settlement?.status === "unknown" ? "unresolved"
    : operation.status === "succeeded" ? "withdrawing" : "pending";
  const description = state === "completed" ? "The minter confirmed the withdrawal on Ethereum Mainnet."
    : state === "withdrawing" ? "The ck-token burn was accepted; Ethereum settlement is still pending."
    : settlement?.message ?? operation.message ?? "The saved withdrawal is pending. Continue the same request; do not create another withdrawal.";
  const receipt = operation.receipt;
  return {
    requestId, operationId: operation.requestId, chainId: "1", ledger: operation.ledger,
    amountAtoms: operation.amount, ethereumAddress: getAddress(operation.destination), phase: state,
    message: error ? `${description} Last check: ${error}` : description,
    transactionHash: settlement?.transactionHash ?? null,
    burnBlockIndex: receipt && typeof receipt === "object" && !Array.isArray(receipt) && typeof receipt.block_index === "string" ? receipt.block_index : null,
    nextAction: state === "completed" || state === "failed" ? "none" : operation.status === "pending" ? "resume_same_request" : "check_status",
  };
}
function validId(value: unknown): string { const id = requiredString(value); if (!/^[0-9a-f]{32}$/.test(id)) throw new Error("Invalid withdrawal request ID"); return id; }
function requiredString(value: unknown): string { if (typeof value !== "string") throw new Error("Expected a string"); return value; }
function message(value: unknown): string { return value instanceof Error ? value.message : String(value); }
