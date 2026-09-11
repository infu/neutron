import { afterAll, expect, mock, test } from "bun:test";
import * as appModule from "neutron-tools/app";

type ToolHandler = (args: unknown, context: unknown) => Promise<unknown>;

const handlers = new Map<string, ToolHandler>();
const publications: Array<{ topic: string; revision: number }> = [];
let querySelfResponse: ((method: string, args: Array<Record<string, unknown>>) => unknown) | null = null;
let updateSelfResponse: ((method: string) => unknown) | null = null;
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
  querySelf: async (method: string, args: Array<Record<string, unknown>>): Promise<unknown> => {
    if (querySelfResponse) return querySelfResponse(method, args);
    throw new Error("Unexpected Wallet query");
  },
  setTrayState: async (): Promise<void> => undefined,
  updateSelf: async (method: string): Promise<unknown> => {
    if (updateSelfResponse) return updateSelfResponse(method);
    throw new Error("Unexpected Wallet update");
  },
}));

await import("../src/service.ts");

afterAll(() => {
  mock.restore();
});

test("overview and refresh expose compact balances by default and preserve explicit visual requests", async () => {
  const logo = "data:image/png;base64,AAAA";
  const snapshot = {
    owner: "aaaaa-aa",
    configured: true,
    ledgers: [{
      id: "7",
      principal: fundingRequest.ledger,
      symbol: "ICP",
      decimals: "8",
      balance: "1234567890123456789",
      fee: "10000",
      logo,
    }],
  };
  const calls: string[] = [];
  querySelfResponse = (method, args) => {
    if (method === "wallet_read_v1" && "snapshot" in args[0]!) return { snapshot };
    if (method === "wallet_read_v1" && "catalog" in args[0]!) return { catalog: [] };
    if (method === "wallet_history_page") return {
      records: [], next: null, inspected: "0", has_more: false, warning: null,
    };
    if (method === "wallet_history_status") return { running: false, ledgers: [] };
    throw new Error(`Unexpected Wallet query ${method}`);
  };
  updateSelfResponse = (method) => {
    calls.push(method);
    if (method === "wallet_refresh_balances") return snapshot;
    if (method === "wallet_history_sync") return { skipped_overlap: false, ledgers: [], started_at: "1", finished_at: "2" };
    throw new Error(`Unexpected Wallet update ${method}`);
  };
  try {
    for (const name of ["wallet_overview", "wallet_refresh"]) {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`${name} was not exposed`);
      for (const args of [{}, { includeLogos: false }, { includeLogos: true }]) {
        await expect(handler(args, {})).resolves.toMatchObject({
          assets: [{
            balance: snapshot.ledgers[0]!.balance,
            logo: args.includeLogos === true ? logo : null,
          }],
        });
      }
    }
    expect(calls).toEqual(Array(3).fill(["wallet_refresh_balances", "wallet_history_sync"]).flat());
    expect(snapshot.ledgers[0]?.logo).toBe(logo);
  } finally {
    querySelfResponse = null;
    updateSelfResponse = null;
  }
});

const emptySnapshot = { owner: "aaaaa-aa", configured: true, ledgers: [] };
const checkpoint = { tip_exclusive: "900719925474099300", balance: "777000001", checked_at: "1800000000000000000" };
const indexedStatus = {
  running: false,
  ledgers: [{
    ledger: fundingRequest.ledger, symbol: "ICP", enabled: true,
    source: { index: "qhbym-qaaaa-aaaaa-aaafq-cai" }, state: { waiting_for_index: null },
    checkpoint, last_attempt_at: "1800000000000000001", last_success_at: "1800000000000000000",
    last_error: null, transaction_count: "7", adjustment_count: "1",
  }],
};

test("overview exposes cached index checkpoints without claiming fresh history or performing updates", async () => {
  const calls: string[] = [];
  querySelfResponse = (method, args) => {
    calls.push(method);
    if (method === "wallet_read_v1" && "snapshot" in args[0]!) return { snapshot: emptySnapshot };
    if (method === "wallet_read_v1" && "catalog" in args[0]!) return { catalog: [] };
    if (method === "wallet_history_page") return { records: [], has_more: false };
    if (method === "wallet_history_status") return indexedStatus;
    throw new Error(`Unexpected query ${method}`);
  };
  updateSelfResponse = (method) => { calls.push(method); throw new Error("Overview must not update"); };
  try {
    await expect(handlers.get("wallet_overview")!({}, {})).resolves.toMatchObject({
      activity: [], historyError: null, historyStatusError: null,
      activitySync: { requested: false, report: null, error: null },
      historyStatus: { ledgers: [{
        state: "waiting_for_index", index: "qhbym-qaaaa-aaaaa-aaafq-cai",
        checkpoint: { tipExclusive: checkpoint.tip_exclusive, balance: checkpoint.balance, checkedAt: checkpoint.checked_at },
        lastAttemptAt: "1800000000000000001",
      }] },
    });
    expect(calls).toEqual(["wallet_read_v1", "wallet_read_v1", "wallet_history_page", "wallet_history_status"]);
  } finally {
    querySelfResponse = null;
    updateSelfResponse = null;
  }
});

test("refresh synchronizes before reading history and retains partial index results", async () => {
  const calls: string[] = [];
  const sync = {
    started_at: "1800000000000000001", finished_at: "1800000000000000002", skipped_overlap: false,
    ledgers: [{ ledger: fundingRequest.ledger, status: "waiting_for_index", records_added: "0", checkpoint, error: null }],
  };
  updateSelfResponse = (method) => {
    calls.push(method);
    if (method === "wallet_refresh_balances") return emptySnapshot;
    if (method === "wallet_history_sync") return sync;
    throw new Error(`Unexpected update ${method}`);
  };
  querySelfResponse = (method, args) => {
    calls.push(method);
    expect(calls.indexOf("wallet_history_sync")).toBeGreaterThan(0);
    if (method === "wallet_read_v1" && "catalog" in args[0]!) return { catalog: [] };
    if (method === "wallet_history_page") return { records: [], has_more: false };
    if (method === "wallet_history_status") return indexedStatus;
    throw new Error(`Unexpected query ${method}`);
  };
  try {
    await expect(handlers.get("wallet_refresh")!({}, {})).resolves.toMatchObject({
      activitySync: { requested: true, error: null, report: {
        startedAt: sync.started_at, finishedAt: sync.finished_at, skippedOverlap: false,
        results: [{ status: "waiting_for_index", recordsAdded: "0" }],
      } },
      historyStatus: { ledgers: [{ state: "waiting_for_index" }] },
    });
    expect(calls).toEqual(["wallet_refresh_balances", "wallet_history_sync", "wallet_read_v1", "wallet_history_page", "wallet_history_status"]);
  } finally {
    querySelfResponse = null;
    updateSelfResponse = null;
  }
});

test("history sync and status failures preserve refreshed balances and identify the stale cached activity", async () => {
  updateSelfResponse = (method) => {
    if (method === "wallet_refresh_balances") return emptySnapshot;
    if (method === "wallet_history_sync") throw new Error("Index permission required");
    throw new Error(`Unexpected update ${method}`);
  };
  querySelfResponse = (method, args) => {
    if (method === "wallet_read_v1" && "catalog" in args[0]!) return { catalog: [] };
    if (method === "wallet_history_page") return { records: [], has_more: false };
    if (method === "wallet_history_status") throw new Error("History status unavailable");
    throw new Error(`Unexpected query ${method}`);
  };
  try {
    await expect(handlers.get("wallet_refresh")!({}, {})).resolves.toMatchObject({
      configured: true, assets: [], activity: [], historyError: null,
      historyStatus: null, historyStatusError: "History status unavailable",
      activitySync: { requested: true, report: null, error: "Index permission required" },
    });
  } finally {
    querySelfResponse = null;
    updateSelfResponse = null;
  }
});

test("overlapping refreshes share one sync and preserve skipped-overlap evidence and page failures", async () => {
  const calls: string[] = [];
  updateSelfResponse = (method) => {
    calls.push(method);
    if (method === "wallet_refresh_balances") return emptySnapshot;
    if (method === "wallet_history_sync") return { skipped_overlap: true, ledgers: [] };
    throw new Error(`Unexpected update ${method}`);
  };
  querySelfResponse = (method, args) => {
    if (method === "wallet_read_v1" && "catalog" in args[0]!) return { catalog: [] };
    if (method === "wallet_history_page") throw new Error("History page unavailable");
    if (method === "wallet_history_status") return { ...indexedStatus, running: true };
    throw new Error(`Unexpected query ${method}`);
  };
  try {
    const results = await Promise.all([handlers.get("wallet_refresh")!({}, {}), handlers.get("wallet_refresh")!({}, {})]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toMatchObject({
      historyError: "History page unavailable", historyStatus: { running: true },
      activitySync: { requested: true, error: null, report: { skippedOverlap: true, results: [] } },
    });
    expect(calls).toEqual(["wallet_refresh_balances", "wallet_history_sync"]);
  } finally {
    querySelfResponse = null;
    updateSelfResponse = null;
  }
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
