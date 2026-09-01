import { expect, test } from "bun:test";
import type {
  JsonValue,
  MsgBusClient,
  MsgBusToolCall,
} from "neutron-tools/app";
import {
  ICP_LEDGER,
  ICP_SWAP_AMOUNT_ATOMS,
  NEUTRINITE_GOVERNANCE,
  WALLET_FUNDING_TARGET,
  WALLET_FUNDING_TOOL,
  callWalletFundingDemo,
  createWalletFundingDemoRequest,
  walletFundingDemoRequestExpired,
  walletFundingDemoResultIsTerminal,
} from "../src/wallet_funding_demo.ts";

const NOW_MS = 1_700_000_000_000;
const REQUEST_ID = "000102030405060708090a0b0c0d0e0f";

test("the direct demo builds one closed fixed ICP transfer intent", () => {
  expect(createWalletFundingDemoRequest("direct", deterministicOptions())).toEqual({
    requestId: REQUEST_ID,
    ledger: ICP_LEDGER,
    amountAtoms: ICP_SWAP_AMOUNT_ATOMS,
    validUntilNs: "1700000120000000000",
    route: {
      kind: "direct",
      to: NEUTRINITE_GOVERNANCE,
    },
  });
});

test("the allowance demo binds the same governance account for five minutes", () => {
  expect(createWalletFundingDemoRequest("allowance", deterministicOptions())).toEqual({
    requestId: REQUEST_ID,
    ledger: ICP_LEDGER,
    amountAtoms: ICP_SWAP_AMOUNT_ATOMS,
    validUntilNs: "1700000120000000000",
    route: {
      kind: "allowance",
      spender: NEUTRINITE_GOVERNANCE,
      expiresAtNs: "1700000300000000000",
    },
  });
});

test("request IDs use sixteen cryptographic bytes and expired requests rotate", () => {
  const request = createWalletFundingDemoRequest("direct");
  expect(request.requestId).toMatch(/^[0-9a-f]{32}$/u);
  expect(walletFundingDemoRequestExpired(request)).toBe(false);
  expect(
    walletFundingDemoRequestExpired(
      createWalletFundingDemoRequest("direct", deterministicOptions()),
      NOW_MS + 120_000,
    ),
  ).toBe(true);
  expect(() => createWalletFundingDemoRequest("direct", { nowMs: -1 }))
    .toThrow("Invalid Wallet funding clock");
});

test("the demo calls only Wallet's exact resident tool once", async () => {
  const calls: Array<{ call: MsgBusToolCall; options?: unknown }> = [];
  let callStarted = false;
  const result: JsonValue = {
    status: "transferred",
    commandId: `kitchensink:${REQUEST_ID}`,
    blockIndex: "42",
    duplicate: false,
    message: null,
  };
  const client = {
    callTool(call: MsgBusToolCall, options?: unknown) {
      callStarted = true;
      calls.push({ call, options });
      return Promise.resolve(result);
    },
  } as Pick<MsgBusClient, "callTool">;
  const request = createWalletFundingDemoRequest(
    "direct",
    deterministicOptions(),
  );

  const pending = callWalletFundingDemo(client, request);
  expect(callStarted).toBe(true);
  await expect(pending).resolves.toEqual(result);
  expect(calls).toEqual([{
    call: {
      target: WALLET_FUNDING_TARGET,
      name: WALLET_FUNDING_TOOL,
      arguments: request,
    },
    options: 180,
  }]);
});

test("only terminal results permit the next click to use a new request ID", () => {
  expect(walletFundingDemoResultIsTerminal("direct", {
    status: "transferred",
  })).toBe(true);
  expect(walletFundingDemoResultIsTerminal("allowance", {
    status: "approved",
  })).toBe(true);
  expect(walletFundingDemoResultIsTerminal("direct", {
    status: "rejected",
  })).toBe(true);
  expect(walletFundingDemoResultIsTerminal("direct", {
    status: "pending",
  })).toBe(false);
  expect(walletFundingDemoResultIsTerminal("direct", {
    status: "approved",
  })).toBe(false);
  expect(walletFundingDemoResultIsTerminal("direct", null)).toBe(false);
});

function deterministicOptions() {
  return {
    nowMs: NOW_MS,
    fillRandomValues(bytes: Uint8Array) {
      bytes.forEach((_byte, index) => {
        bytes[index] = index;
      });
    },
  };
}
