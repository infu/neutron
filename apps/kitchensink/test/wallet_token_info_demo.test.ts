import { expect, test } from "bun:test";
import type {
  JsonValue,
  MsgBusClient,
  MsgBusToolCall,
} from "neutron-tools/app";
import {
  callWalletTokenInfoDemo,
  parseWalletTokenInfoDemo,
} from "../src/wallet_token_info_demo.ts";
import {
  ICP_LEDGER,
  WALLET_FUNDING_TARGET,
} from "../src/wallet_funding_demo.ts";

const reply = {
  ledger: ICP_LEDGER,
  account: "togwv-zqaaa-aaaal-qr7aa-cai",
  name: "Internet Computer",
  symbol: "ICP",
  decimals: 8,
  feeAtoms: "10000",
  balanceAtoms: "123456789012345678901234567890",
  observedAtNs: "1800000000000000000",
} as const;

test("Kitchen Sink reads live ICP information only through Wallet", async () => {
  const calls: Array<{ call: MsgBusToolCall; options?: unknown }> = [];
  const client = {
    callTool(call: MsgBusToolCall, options?: unknown) {
      calls.push({ call, options });
      return Promise.resolve(reply as JsonValue);
    },
  } as Pick<MsgBusClient, "callTool">;
  await expect(callWalletTokenInfoDemo(client)).resolves.toEqual(reply);
  expect(calls).toEqual([{
    call: {
      target: WALLET_FUNDING_TARGET,
      name: "wallet_token_info_v1",
      arguments: { ledger: ICP_LEDGER },
    },
    options: 60,
  }]);
});

test("Kitchen Sink rejects malformed Wallet token information", () => {
  expect(parseWalletTokenInfoDemo(reply)).toEqual(reply);
  expect(() => parseWalletTokenInfoDemo({ ...reply, feeAtoms: "01" })).toThrow(
    "invalid token information",
  );
  expect(() => parseWalletTokenInfoDemo({ ...reply, extra: true })).toThrow(
    "invalid token information",
  );
  expect(() => parseWalletTokenInfoDemo({
    ...reply,
    ledger: "mxzaz-hqaaa-aaaar-qaada-cai",
  })).toThrow("invalid token information");
});
