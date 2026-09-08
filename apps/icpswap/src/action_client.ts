import { createMsgBusClient, isJsonObject, type JsonObject, type JsonValue, type ScopedKernelClient } from "neutron-tools/app";

export type ActionProgress = {
  operationId: string;
  state: string;
  message: string;
  raw: JsonObject;
};
export function parseActionProgress(value: JsonValue, expectedId: string): ActionProgress {
  if (!isJsonObject(value) || value.operationId !== expectedId || typeof value.state !== "string" || typeof value.message !== "string") {
    throw new Error("The action reply did not identify this saved operation. Check Activity before starting another.");
  }
  return { operationId: expectedId, state: value.state, message: value.message, raw: value };
}

export type SwapActionInput = JsonObject & {
  operationId: string;
  from_ledger_id: string;
  to_ledger_id: string;
  amount: string;
  slippage: number;
};

/** Reusing the exact original inputs also recovers a lost prepare reply. */
export async function runSwapAction(input: SwapActionInput, client: Pick<ScopedKernelClient, "callTool"> = createMsgBusClient()): Promise<ActionProgress> {
  return parseActionProgress(await client.callTool({ target: "app:icpswap:background", name: "icpswap_swap_v1", arguments: input }, 300), input.operationId);
}

export async function continueAction(operationId: string, client: Pick<ScopedKernelClient, "callTool"> = createMsgBusClient()): Promise<ActionProgress> {
  return parseActionProgress(await client.callTool({ target: "app:icpswap:background", name: "icpswap_continue_v1", arguments: { operationId } }, 300), operationId);
}
