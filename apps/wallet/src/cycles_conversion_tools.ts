import { exposeTool, type JsonObject, type MsgBusToolContext } from "neutron-tools/app";
import {
  executeOperatingCyclesConversion, listOperatingCyclesConversions, loadOperatingCyclesSnapshot,
  operatingCyclesServices, quoteOperatingCyclesConversion, readOperatingCyclesConversionStatus,
  type OperatingCyclesOperation, type OperatingCyclesServices,
} from "./cycles_conversion.ts";
import { readRefillOwner } from "./refill.ts";
import { Principal } from "@dfinity/principal";

const text: JsonObject = { type: "string" };
const nat: JsonObject = { type: "string", pattern: "^0$|^[1-9][0-9]*$" };
const id: JsonObject = { type: "string", pattern: "^[0-9a-f]{32}$" };
const nullable = (schema: JsonObject): JsonObject => ({ oneOf: [schema, { type: "null" }] });
const closed = (properties: JsonObject): JsonObject => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const inputProperties: JsonObject = {
  amountAtoms: { type: "string", pattern: "^[1-9][0-9]*$", description: "Gross operating cycles to convert, in raw cycles. 1 TCYCLES = 1,000,000,000,000 cycles. The mint fee is deducted from this amount." },
  target: { ...nullable(text), description: "Principal receiving TCYCLES; null means this Neutron. No CMC conversion or later forwarding is used." },
  allowPartial: { type: "boolean", description: "False requires the exact amount. True authorizes up to this cap, reducing it at dispatch if necessary to leave the Kernel's operating reserve and call cost." },
};
export const walletOperatingCyclesInputSchema = closed({ requestId: id, ...inputProperties });
export const walletOperatingCyclesQuoteInputSchema: JsonObject = {
  type: "object",
  properties: {
    ...inputProperties,
    amountAtoms: { ...nullable(inputProperties.amountAtoms as JsonObject), description: "Gross operating cycles to preview. Omit or pass null to discover the current maximum after the operating reserve and call cost. This is read-only; execute still requires a positive explicit amount and owner approval." },
  },
  required: ["target", "allowPartial"], additionalProperties: false,
};
export const walletOperatingCyclesQuoteOutputSchema = closed({
  version: { const: 1 }, owner: text, target: text, amountAtoms: nat, allowPartial: { type: "boolean" },
  feeAtoms: nat, expectedNetAtoms: nullable(nat), balanceAtoms: nat, reserveAtoms: nat, callCostAtoms: nat, maxCyclesAtoms: nat, remainingCyclesAtoms: nat,
  observedAt: { type: "integer" }, ownerApprovalRequired: { const: true }, eligible: { type: "boolean" }, reason: nullable(text),
});
export const walletOperatingCyclesOperationSchema = closed({
  requestId: id, target: nullable(text), requestedCyclesAtoms: nat, attachedCyclesAtoms: nullable(nat), expectedNetAtoms: nullable(nat), feeAtoms: nullable(nat),
  status: { enum: ["pending", "complete", "failed", "unknown"] }, ledgerBlockIndex: nullable(nat), recipientBalanceAtoms: nullable(nat), error: nullable(text),
  createdAtNs: nat, updatedAtNs: nat, refundedCyclesAtoms: nullable(nat), chargedCyclesAtoms: nullable(nat), allowPartial: { type: "boolean" }, detailsAvailable: { type: "boolean" },
});
export const walletOperatingCyclesOutputSchema = closed({
  version: { const: 1 }, operation: walletOperatingCyclesOperationSchema,
  recovery: closed({ requestId: id, statusTool: { const: "wallet_cycles_conversion_status_v1" } }), nextAction: { enum: ["check_status", "none"] }, message: text,
});

export function registerOperatingCyclesTools(): void {
  exposeTool("wallet_cycles_conversion_quote_v1", {
    title: "Quote Neutron operating cycles to TCYCLES",
    description: "Read the Neutron's operating cycle balance, its retained reserve, exact call cost, and the TCYCLES ledger mint fee. Omit amountAtoms or pass null to discover the current maximum without guessing a balance. eligible=false with a reason means no conversion currently fits; expectedNetAtoms is null. No payment or approval is requested. Operating cycles are separate from the Wallet's TCYCLES token balance. The displayed net credit is an estimate after the retained fee. Execution always requires explicit Kernel owner approval, including for root agents.",
    inputSchema: walletOperatingCyclesQuoteInputSchema, outputSchema: walletOperatingCyclesQuoteOutputSchema,
    annotations: { "neutron:effects": ["read", "network"] },
  }, handleOperatingCyclesQuote);
  exposeTool("wallet_cycles_conversion_v1", {
    title: "Convert operating cycles with owner approval",
    description: "Ask the owner in Kernel's red spending dialog to convert Neutron operating cycles into TCYCLES at the selected principal. Root agents must also wait for owner approval; they cannot bypass it. This one-time call does not change ordinary app budgets. Keep requestId and the original amount, recipient and allowPartial unchanged. Cycles-ledger deposit has no remote deduplication: after interruption, use the returned status tool to read Kernel's original call receipt, never another deposit. A known fully refunded rejection may be followed by a fresh explicitly approved request.",
    inputSchema: walletOperatingCyclesInputSchema, outputSchema: walletOperatingCyclesOutputSchema,
    annotations: { "neutron:consent": "provider_once", "neutron:audit": "metadata_only", "neutron:effects": ["write", "network", "user_visible_ui"], "neutron:longRunning": true },
  }, handleOperatingCyclesConversion);
  exposeTool("wallet_cycles_conversion_status_v1", {
    title: "Read the original operating-cycle conversion receipt",
    description: "Read Kernel's retained original one-time call and decode its TCYCLES deposit receipt. This never opens a spending dialog or repeats deposit. A returned ledger block proves the recorded deposit; expectedNetAtoms remains the estimate from its retained reviewed fee. recipientBalanceAtoms is the recipient's total balance, not this operation's credit.",
    inputSchema: closed({ requestId: id }), outputSchema: closed({ version: { const: 1 }, result: nullable(walletOperatingCyclesOutputSchema) }), annotations: { "neutron:effects": ["read"] },
  }, async (args, context) => {
    const operation = await readOperatingCyclesConversionStatus(validId(args.requestId), operatingCyclesServices(context.kernel));
    return { version: 1, result: operation ? operatingCyclesResult(operation) : null };
  });
  exposeTool("wallet_cycles_conversions_v1", {
    title: "Find operating-cycle conversion records",
    description: "Page Kernel's compact one-time call records for Wallet TCYCLES deposits. Follow nextCursor for older records. detailsAvailable=false means the retained Candid receipt has not been fetched or decoded; use wallet_cycles_conversion_status_v1 for the recipient and verified deposit block. No payment or retry occurs.",
    inputSchema: { type: "object", properties: { before: text, limit: { type: "integer", minimum: 1, default: 20 } }, additionalProperties: false },
    outputSchema: closed({ version: { const: 1 }, operations: { type: "array", items: walletOperatingCyclesOperationSchema }, nextCursor: nullable(text), excludedCount: { type: "integer", minimum: 0 } }), annotations: { "neutron:effects": ["read"] },
  }, async (args, context) => {
    const page = await listOperatingCyclesConversions({ ...(typeof args.before === "string" ? { before: args.before } : {}), ...(typeof args.limit === "number" ? { limit: args.limit } : {}) }, operatingCyclesServices(context.kernel));
    return { version: 1, ...page } as unknown as JsonObject;
  });
}
export async function handleOperatingCyclesQuote(args: JsonObject, context: MsgBusToolContext, io = operatingCyclesServices(context.kernel)): Promise<JsonObject> {
  const owner = await readRefillOwner(context.kernel);
  const discoverMax = args.amountAtoms == null;
  const parsed = parseInput({ ...args, amountAtoms: discoverMax ? "1" : args.amountAtoms! }, owner, "00".repeat(16));
  const snapshot = await loadOperatingCyclesSnapshot(owner, parsed.target, io);
  const input = { ...parsed, amountAtoms: discoverMax ? snapshot.maxCyclesAtoms : parsed.amountAtoms };
  if (discoverMax && BigInt(snapshot.maxCyclesAtoms) <= BigInt(snapshot.feeAtoms)) {
    return {
      version: 1, owner, target: input.target, amountAtoms: snapshot.maxCyclesAtoms, allowPartial: input.allowPartial,
      feeAtoms: snapshot.feeAtoms, expectedNetAtoms: null, balanceAtoms: snapshot.balanceAtoms,
      reserveAtoms: snapshot.reserveAtoms, callCostAtoms: snapshot.callCostAtoms, maxCyclesAtoms: snapshot.maxCyclesAtoms,
      remainingCyclesAtoms: snapshot.balanceAtoms, observedAt: snapshot.observedAt, ownerApprovalRequired: true,
      eligible: false, reason: "No conversion currently fits after keeping Neutron's operating reserve and covering the call cost and TCYCLES mint fee. Refill Neutron before converting operating cycles.",
    };
  }
  const quote = quoteOperatingCyclesConversion(input, snapshot);
  const { requestId: _requestId, ...fields } = quote;
  return { version: 1, ...fields, ownerApprovalRequired: true, eligible: true, reason: null };
}
export async function handleOperatingCyclesConversion(args: JsonObject, context: MsgBusToolContext, io = operatingCyclesServices(context.kernel)): Promise<JsonObject> {
  const requestId = validId(args.requestId);
  const owner = await readRefillOwner(context.kernel);
  const input = parseInput(args, owner, requestId);
  context.signal?.throwIfAborted();
  context.reportProgress({ phase: "Checking the original cycle-conversion request" });
  const saved = await readOperatingCyclesConversionStatus(requestId, io);
  if (saved) {
    if (saved.target !== input.target || saved.requestedCyclesAtoms !== input.amountAtoms || saved.allowPartial !== input.allowPartial) throw new Error("This request ID belongs to a different saved cycle conversion. Check its original status.");
    return operatingCyclesResult(saved);
  }
  const quote = quoteOperatingCyclesConversion(input, await loadOperatingCyclesSnapshot(owner, input.target, io));
  context.signal?.throwIfAborted();
  context.reportProgress({ phase: "Waiting for the owner's one-time cycle spending approval" });
  // Deliberately identical for normal and root audiences: Kernel owns consent.
  return operatingCyclesResult(await executeOperatingCyclesConversion(quote, io));
}
export function operatingCyclesResult(operation: OperatingCyclesOperation): JsonObject {
  const message = operation.status === "complete" ? "The original cycles-ledger deposit returned a verified receipt. The net amount shown is the estimate after the retained mint fee."
    : operation.status === "failed" ? "The original call was rejected without consuming its cycle attachment. Network costs may still apply."
    : operation.error ?? "The original cycle conversion is still awaiting a verified outcome. Read its saved status; do not submit another deposit.";
  return { version: 1, operation: operation as unknown as JsonObject, recovery: { requestId: operation.requestId, statusTool: "wallet_cycles_conversion_status_v1" }, nextAction: operation.status === "complete" || operation.status === "failed" ? "none" : "check_status", message };
}
function parseInput(args: JsonObject, owner: string, requestId: string) {
  if (typeof args.amountAtoms !== "string" || !/^[1-9][0-9]*$/.test(args.amountAtoms)) throw new Error("Enter a positive number of operating cycles");
  if (args.target !== null && typeof args.target !== "string") throw new Error("Choose a recipient principal or null for this Neutron");
  if (typeof args.allowPartial !== "boolean") throw new Error("Choose exact or up-to conversion");
  return { requestId, owner, target: Principal.fromText(args.target ?? owner).toText(), amountAtoms: args.amountAtoms, allowPartial: args.allowPartial };
}
function validId(value: unknown): string { if (typeof value !== "string" || !/^[0-9a-f]{32}$/.test(value)) throw new Error("Invalid cycle conversion request ID"); return value; }
