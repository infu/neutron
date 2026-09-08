import { expect, test } from "bun:test";
import { parseActionProgress, runSwapAction, continueAction, type SwapActionInput } from "../src/action_client.ts";

const input: SwapActionInput = { operationId: "ab".repeat(16), from_ledger_id: "ryjl3-tyaaa-aaaaa-aaaba-cai", to_ledger_id: "xevnm-gaaaa-aaaar-qafnq-cai", amount: "12345678901234567890", slippage: 500 };

test("swap retry sends the saved original intent through the background workflow", async () => {
  const calls: any[] = [];
  const client = { callTool: async (call: unknown) => { calls.push(call); return { operationId: input.operationId, state: "pending", message: "Wallet pending" }; } } as never;
  await runSwapAction(input, client);
  await runSwapAction(JSON.parse(JSON.stringify(input)), client);
  expect(calls).toHaveLength(2);
  expect(calls[1]).toEqual(calls[0]);
  expect(calls[0]).toEqual({ target: "app:icpswap:background", name: "icpswap_swap_v1", arguments: input });
});

test("a reply for another operation never clears a tile's unresolved request", () => {
  expect(() => parseActionProgress({ operationId: "cd".repeat(16), state: "complete", message: "Completed" }, input.operationId)).toThrow("saved operation");
});

test("activity continuation contains only the durable operation identity", async () => {
  const calls: unknown[] = [];
  const client = { callTool: async (call: unknown) => { calls.push(call); return { operationId: input.operationId, state: "uncertain", message: "Do not repeat pool dispatch" }; } } as never;
  const result = await continueAction(input.operationId, client);
  expect(result.state).toBe("uncertain");
  expect(calls).toEqual([{ target: "app:icpswap:background", name: "icpswap_continue_v1", arguments: { operationId: input.operationId } }]);
});
