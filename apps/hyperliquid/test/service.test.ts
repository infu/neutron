import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { validateToolArguments, type JsonObject, type MsgBusToolDescriptor } from "neutron-tools/protocol";

// Import the actual resident and UI into a separate process. exposeTool uses
// Neutron's production descriptor validator; no registry or SDK is mocked.
const descriptors = promisify(execFile)(process.execPath, ["--eval", `
  await import(${JSON.stringify(new URL("../src/service.ts", import.meta.url).href)});
  await import(${JSON.stringify(new URL("../src/ui.ts", import.meta.url).href)});
  const { listExposedTools } = await import("neutron-tools/app");
  console.log(JSON.stringify(listExposedTools()));
  process.exit(0);
`], { cwd: new URL("..", import.meta.url).pathname }).then(({ stdout }) => JSON.parse(stdout) as MsgBusToolDescriptor[]);

const operationId = "a".repeat(32);
const examples: Record<string, JsonObject> = {
  hl_identity_v1: {},
  hl_setup_status_v1: {},
  hl_setup_v1: { operationId, action: "approve" },
  hl_markets_v1: { query: "ETH" },
  hl_market_v1: { coin: "ETH" },
  hl_chart_v1: { coin: "ETH", interval: "1h", startTime: 1, endTime: 10 },
  hl_orderbook_v1: { coin: "ETH", side: "buy", size: "0.01", limitPrice: "4500.1" },
  hl_account_v1: {},
  hl_fills_v1: {},
  hl_funding_rates_v1: { coin: "ETH", startTime: 1 },
  hl_preview_order_v1: { coin: "ETH", side: "buy", orderType: "market", size: "0.01" },
  hl_order_capacity_v1: { coin: "ETH", side: "buy", orderType: "market", slippageBps: 50 },
  hl_place_order_v1: { operationId, coin: "ETH", side: "buy", orderType: "market", size: "0.01", slippageBps: 50 },
  hl_close_position_v1: { operationId, coin: "ETH" },
  hl_cancel_order_v1: { operationId, coin: "ETH", oid: 42 },
  hl_cancel_orders_v1: { operationId },
  hl_modify_order_v1: { operationId, coin: "ETH", oid: 42, side: "sell", size: "0.01", price: "4300.1" },
  hl_protect_position_v1: { operationId, coin: "ETH", side: "sell", size: "0.01", triggerPrice: "4000", triggerKind: "sl", execution: "market" },
  hl_leverage_v1: { operationId, coin: "ETH", leverage: 3, isCross: true },
  hl_isolated_margin_v1: { operationId, coin: "ETH", amountUsdc: "-1.25" },
  hl_funding_quote_v1: { direction: "deposit", chainId: "1", amount: "100" },
  hl_funding_capacity_v1: { direction: "deposit", chainId: "1" },
  hl_funding_execute_v1: { operationId, direction: "withdraw", chainId: "1", amount: "100" },
  hl_funding_recover_v1: { operationId, method: "wallet" },
  hl_reconcile_v1: { operationId, kind: "trade" },
  hl_retry_trade_v1: { operationId },
  hl_activity_v1: {},
  hl_owner_review_v1: { reviewJson: "{}" },
  hl_review_v1: { reviewJson: "{}" },
};
const trades = ["hl_place_order_v1", "hl_close_position_v1", "hl_cancel_order_v1", "hl_cancel_orders_v1", "hl_modify_order_v1", "hl_protect_position_v1", "hl_leverage_v1", "hl_isolated_margin_v1", "hl_retry_trade_v1"];

test("all resident and review tools register with the actual Neutron descriptor validator", async () => {
  const registered = await descriptors;
  expect(registered.map((entry) => entry.name).sort()).toEqual(Object.keys(examples).sort());
  for (const descriptor of registered) {
    expect(() => validateToolArguments(descriptor, examples[descriptor.name]!)).not.toThrow();
    expect(descriptor.inputSchema.additionalProperties).toBe(false);
    expect(descriptor.outputSchema?.additionalProperties).toBe(false);
  }
});

test("caller provenance and arbitrary signing payloads cannot enter through tool arguments", async () => {
  for (const descriptor of await descriptors) {
    for (const spoofed of [
      { caller: { appId: "hyperliquid", installationUid: "17", endpoint: "app:hyperliquid:background" } },
      { agentMode: false, audience: "foreground_tile" },
      { installationUid: "17", walletAddress: `0x${"11".repeat(20)}` },
      { typedData: {}, signature: `0x${"22".repeat(65)}` },
    ]) {
      expect(() => validateToolArguments(descriptor, { ...examples[descriptor.name]!, ...spoofed })).toThrow();
    }
  }
});

test("modification tools expose a typed always-place override and its cancellation semantics", async () => {
  const descriptor = (await descriptors).find(entry => entry.name === "hl_modify_order_v1")!;
  for (const alwaysPlace of [true, false]) expect(() => validateToolArguments(descriptor, { ...examples.hl_modify_order_v1!, alwaysPlace })).not.toThrow();
  expect(() => validateToolArguments(descriptor, { ...examples.hl_modify_order_v1!, alwaysPlace: "true" })).toThrow();
  expect(descriptor.description).toContain("original cancel fails");
  expect(descriptor.description).toContain("modification.original");
});

test("exact trade authority is declared on effects while analysis requires no provider consent", async () => {
  const registered = await descriptors;
  for (const name of trades) {
    const descriptor = registered.find((entry) => entry.name === name)!;
    expect(descriptor.annotations).toMatchObject({ "neutron:consent": "provider_once", "neutron:audit": "metadata_only" });
    expect(descriptor.annotations!["neutron:effects"]).toEqual(expect.arrayContaining(["write", "network", "user_visible_ui"]));
    expect(descriptor.inputSchema.required).toContain("operationId");
  }
  for (const name of ["hl_markets_v1", "hl_market_v1", "hl_chart_v1", "hl_orderbook_v1", "hl_account_v1", "hl_fills_v1", "hl_funding_rates_v1", "hl_preview_order_v1", "hl_order_capacity_v1", "hl_funding_quote_v1", "hl_funding_capacity_v1"]) {
    const descriptor = registered.find((entry) => entry.name === name)!;
    expect(descriptor.annotations!["neutron:consent"]).toBeUndefined();
    expect(descriptor.annotations!["neutron:effects"]).toEqual(["read", "network"]);
  }
});

test("installation and approval helpers stay private and external review requires foreground attestation", async () => {
  const registered = await descriptors;
  for (const name of ["hl_identity_v1", "hl_owner_review_v1", "hl_review_v1"]) {
    expect(registered.find((entry) => entry.name === name)!.annotations!["neutron:visibility"]).toBe("same_app");
  }
  expect(registered.find((entry) => entry.name === "hl_review_v1")!.annotations!["neutron:audience"]).toBe("foreground_tile");
  expect(registered.find((entry) => entry.name === "hl_owner_review_v1")!.annotations!["neutron:audience"]).toBeUndefined();
});

test("perps tools reject spot and HIP-3 symbol forms and unsupported transfer networks", async () => {
  const registered = await descriptors;
  for (const name of ["hl_place_order_v1", "hl_close_position_v1", "hl_chart_v1", "hl_orderbook_v1"]) {
    const descriptor = registered.find((entry) => entry.name === name)!;
    for (const coin of ["@1", "PURR/USDC", "xyz:XYZ100"]) expect(() => validateToolArguments(descriptor, { ...examples[name]!, coin })).toThrow();
  }
  const funding = registered.find((entry) => entry.name === "hl_funding_execute_v1")!;
  for (const chainId of ["1337", "421614", "999"]) expect(() => validateToolArguments(funding, { ...examples[funding.name]!, chainId })).toThrow();
  expect(() => validateToolArguments(funding, { ...examples[funding.name]!, chainId: "42161" })).not.toThrow();
  const recovery = registered.find((entry) => entry.name === "hl_funding_recover_v1")!;
  for (const method of ["circle", "wallet", "perps"]) expect(() => validateToolArguments(recovery, { operationId, method })).not.toThrow();
  for (const untrusted of [{ amount: "100" }, { recipient: `0x${"11".repeat(20)}` }, { message: "0x1234", attestation: "0x5678" }]) {
    expect(() => validateToolArguments(recovery, { operationId, method: "wallet", ...untrusted })).toThrow();
  }
});
