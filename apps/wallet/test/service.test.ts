import { afterAll, expect, mock, test } from "bun:test";
import * as appModule from "neutron-tools/app";

type ToolHandler = (args: unknown, context: unknown) => Promise<unknown>;

const handlers = new Map<string, ToolHandler>();
const publications: Array<{ topic: string; revision: number }> = [];
const postDispatchError = new Error("post-dispatch cancellation");
const fundingRequest = {
  requestId: "00112233445566778899aabbccddeeff",
  ledger: "ryjl3-tyaaa-aaaaa-aaaba-cai",
  amountAtoms: "1",
  validUntilNs: "1800000000000000000",
  route: {
    kind: "direct",
    to: "togwv-zqaaa-aaaal-qr7aa-cai",
  },
};
const commandId = {
  caller_app_id: "swap",
  request_id: Uint8Array.from(
    { length: 16 },
    (_, index) => index * 0x11,
  ),
};

mock.module("neutron-tools/app", () => ({
  ...appModule,
  exposeTool: (
    name: string,
    _options: unknown,
    handler: ToolHandler,
  ): void => {
    handlers.set(name, handler);
  },
  publishAppStateChange: async (
    topic: string,
    revision: number,
  ): Promise<void> => {
    publications.push({ topic, revision });
    throw new Error("projection notification unavailable");
  },
  querySelf: async (): Promise<never> => {
    throw new Error("Unexpected Wallet query");
  },
  setTrayState: async (): Promise<void> => undefined,
  updateSelf: async (): Promise<never> => {
    throw new Error("Unexpected Wallet update");
  },
}));

await import("../src/service.ts");

afterAll(() => {
  mock.restore();
});

test("token information uses one exact Wallet self-call", async () => {
  const handler = handlers.get("wallet_token_info_v1");
  if (!handler) throw new Error("Wallet token information tool was not exposed");
  const calls: unknown[][] = [];

  await expect(
    handler(
      { ledger: fundingRequest.ledger },
      {
        kernel: {
          updateSelf: async (...args: unknown[]): Promise<unknown> => {
            calls.push(args);
            return {
              ledger: fundingRequest.ledger,
              account: {
                owner: "togwv-zqaaa-aaaal-qr7aa-cai",
                subaccount: null,
              },
              token_name: "Internet Computer",
              token_symbol: "ICP",
              decimals: "8",
              fee_atoms: "10000",
              balance_atoms: "123456789",
              observed_at_ns: "1800000000000000000",
            };
          },
        },
      },
    ),
  ).resolves.toEqual({
    ledger: fundingRequest.ledger,
    account: "togwv-zqaaa-aaaal-qr7aa-cai",
    name: "Internet Computer",
    symbol: "ICP",
    decimals: 8,
    feeAtoms: "10000",
    balanceAtoms: "123456789",
    observedAtNs: "1800000000000000000",
  });
  expect(calls).toEqual([
    ["wallet_token_info_v1", [{ ledger: fundingRequest.ledger }], 60],
  ]);
});

test("root funding invalidates the Wallet projection after a failed attempt", async () => {
  publications.length = 0;
  const handler = handlers.get("wallet_fund_root_v1");
  if (!handler) throw new Error("Wallet root funding tool was not exposed");

  await expect(
    handler(fundingRequest, {
      audience: "agent_root",
      caller: {
        endpoint: "app:swap:background",
        appId: "swap",
        role: "background",
        sessionId: "swap-session",
      },
      kernel: {
        updateSelf: async (): Promise<never> => {
          throw postDispatchError;
        },
      },
      reportProgress: () => undefined,
    }),
  ).rejects.toBe(postDispatchError);
  expect(publications).toEqual([
    { topic: "wallet_projection", revision: expect.any(Number) },
  ]);
});

test("root funding refreshes once and preserves its receipt when refresh fails", async () => {
  publications.length = 0;
  const handler = handlers.get("wallet_fund_root_v1");
  if (!handler) throw new Error("Wallet root funding tool was not exposed");
  const methods: string[] = [];

  await expect(
    handler(fundingRequest, {
      audience: "agent_root",
      caller: {
        endpoint: "app:swap:background",
        appId: "swap",
        role: "background",
        sessionId: "swap-session",
      },
      kernel: {
        updateSelf: async (method: string): Promise<unknown> => {
          methods.push(method);
          if (method === "wallet_funding_prepare_v1") {
            return {
              prepared: {
                command_id: commandId,
                review: {
                  command_id: commandId,
                  kind: { direct: null },
                  ledger: fundingRequest.ledger,
                  token_name: "Internet Computer",
                  token_symbol: "ICP",
                  decimals: "8",
                  amount_atoms: fundingRequest.amountAtoms,
                  transfer_fee_atoms: "10",
                  total_debit_atoms: "11",
                  destination: { owner: fundingRequest.route.to },
                  valid_until_ns: fundingRequest.validUntilNs,
                },
              },
            };
          }
          if (method === "wallet_funding_execute_v1") {
            return {
              transferred: {
                command_id: commandId,
                block_index: "7",
                duplicate: false,
              },
            };
          }
          if (method === "wallet_refresh_balances") {
            throw new Error("refresh unavailable");
          }
          throw new Error(`Unexpected Wallet update ${method}`);
        },
      },
      reportProgress: () => undefined,
    }),
  ).resolves.toMatchObject({
    status: "transferred",
    blockIndex: "7",
    duplicate: false,
  });
  expect(methods).toEqual([
    "wallet_funding_prepare_v1",
    "wallet_funding_execute_v1",
    "wallet_refresh_balances",
  ]);
  expect(publications).toEqual([
    { topic: "wallet_projection", revision: expect.any(Number) },
  ]);
});
