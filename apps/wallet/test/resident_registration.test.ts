import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  validateToolResult,
  type JsonObject,
  type MsgBusToolDescriptor,
} from "neutron-tools/protocol";

test("Wallet resident registers every bridge, quote, and released tool through the real SDK validator", async () => {
  // Import the actual resident in a fresh process: no mocked exposeTool or
  // copied descriptors can hide a startup failure before later registrations.
  // This registration-only smoke exits after discovery; the optional tray badge
  // has no Kernel transport in this process and is outside this test's scope.
  const { stdout, stderr } = await promisify(execFile)("bun", ["--eval",
    `await import(${JSON.stringify(new URL("../src/service.ts", import.meta.url).href)});
     const { listExposedTools } = await import("neutron-tools/app");
     console.log(JSON.stringify(listExposedTools()));
     process.exit(0);`,
  ], { cwd: new URL("..", import.meta.url).pathname });
  expect(stderr).toBe("");
  const descriptors = JSON.parse(stdout) as MsgBusToolDescriptor[];
  expect(descriptors.map(({ name }) => name).sort()).toEqual([
    "wallet_account_transactions_v1",
    "wallet_add_ledger_root_v1", "wallet_add_ledger_v1",
    "wallet_bridge_attach_replacement_root_v1", "wallet_bridge_attach_root_v1", "wallet_bridge_next_root_v1",
    "wallet_bridge_prepare_root_v1", "wallet_bridge_quote_v1",
    "wallet_bridge_refresh_v1", "wallet_bridge_status_v1",
    "wallet_conversion_routes_v1",
    "wallet_cycles_conversion_quote_v1", "wallet_cycles_conversion_status_v1",
    "wallet_cycles_conversion_v1", "wallet_cycles_conversions_v1",
    "wallet_fund_root_v1", "wallet_fund_v1", "wallet_history_v1", "wallet_overview",
    "wallet_refill_continue_root_v1", "wallet_refill_continue_v1", "wallet_refill_quote_v1",
    "wallet_refill_root_v1", "wallet_refill_status_v1", "wallet_refill_v1", "wallet_refills_v1",
    "wallet_refresh", "wallet_token_info_v1", "wallet_transaction_v1", "wallet_unwrap_root_v1", "wallet_unwrap_status_v1", "wallet_withdrawal_quote_v1",
    "wallet_wrap_pending_v1", "wallet_wrap_root_v1", "wallet_wrap_status_v1",
  ]);
  for (const name of ["prepare", "next", "attach"]) {
    expect(descriptors.find((tool) => tool.name === `wallet_bridge_${name}_root_v1`)?.annotations).toMatchObject({
      "neutron:audience": "agent_root", "neutron:visibility": "same_app",
    });
  }

  const status = descriptors.find((tool) => tool.name === "wallet_bridge_status_v1")!;
  const address = `0x${"11".repeat(20)}`;
  const word = `0x${"00".repeat(32)}`;
  const result: JsonObject = {
    id: "01".repeat(16),
    quote: {
      chainId: "1", ledger: "ss2fx-dyaaa-aaaar-qacoq-cai", minter: "sv3dd-oaaaa-aaaar-qacoa-cai",
      helperAddress: address, helperMode: "subaccount", minterAddress: address,
      tokenAddress: null, recipient: "aaaaa-aa", principalWord: word, subaccountWord: word,
    },
    source: { appId: "agent", installationUid: "51" }, account: address,
    amount: "0", steps: [], revision: "0", createdAt: "1", updatedAt: "1",
    eventCursor: "0", acceptedDeposit: null, mint: null, error: null,
  };
  // The supported pattern still accepts precisely unsigned decimal strings,
  // including values larger than a JavaScript number can represent exactly.
  for (const amount of ["0", "1", "123456789012345678901234567890"]) {
    expect(() => validateToolResult(status, { ...result, amount })).not.toThrow();
  }
  for (const amount of ["", "00", "01", "-1", "+1", "1.0", "1e3", "x0", "1x"]) {
    expect(() => validateToolResult(status, { ...result, amount })).toThrow();
  }
});

test("real exposeTool rejects the unsupported grouped pattern before registering it", async () => {
  // Other resident handler tests mock exposeTool in their process. The negative
  // control must use the same isolated, real SDK path as the startup smoke.
  const { stdout, stderr } = await promisify(execFile)("bun", ["--eval",
    `const { exposeTool, listExposedTools } = await import("neutron-tools/app");
     const name = "wallet_test_unsupported_pattern";
     let error = null;
     try {
       exposeTool(name, {
         inputSchema: { type: "object", properties: {
           amount: { type: "string", pattern: "^(0|[1-9][0-9]*)$" }
         } }
       }, async () => ({}));
     } catch (cause) { error = cause.message; }
     console.log(JSON.stringify({ error, registered: listExposedTools().some(tool => tool.name === name) }));`,
  ], { cwd: new URL("..", import.meta.url).pathname });
  expect(stderr).toBe("");
  expect(JSON.parse(stdout)).toEqual({ error: 'Tool inputSchema contains an unsafe pattern (tool "wallet_test_unsupported_pattern")', registered: false });
});
