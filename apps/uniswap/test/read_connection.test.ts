import { expect, test } from "bun:test";
import type { callTool } from "neutron-tools/app";
import { connectWalletReads } from "../src/read_connection.ts";

test("wallet connection requests one exact read grant without signing or status effects", async () => {
  const calls: Parameters<typeof callTool>[0][] = [];
  await connectWalletReads({ callTool: async (call) => { calls.push(call); return { granted: true }; } });
  expect(calls).toEqual([{
    target: "kernel", name: "permissions.request", arguments: {
      target: "app:evm_wallet:background",
      tools: ["evm_accounts_v1", "evm_balances_v1", "evm_call_contract_v1", "evm_estimate_transaction_v1", "evm_transaction_v1", "evm_replacement_transaction_v1"],
    },
  }]);
});

test("declining the read connection fails before wallet reads start", async () => {
  await expect(connectWalletReads({ callTool: async () => { throw new Error("Owner declined permission"); } }))
    .rejects.toThrow("Owner declined permission");
});
