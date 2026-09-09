import { describe, expect, test } from "bun:test";
import { addLedgerToWallet, parseTokenInfo, readTokenInfo, readWalletTool, walletSetupRequired } from "../src/wallet.ts";

const REPLY = {
  ledger: "ryjl3-tyaaa-aaaaa-aaaba-cai",
  account: "ryjl3-tyaaa-aaaaa-aaaba-cai",
  name: "Internet Computer",
  symbol: "ICP",
  decimals: 8,
  feeAtoms: "10000",
  balanceAtoms: "123456789",
  observedAtNs: "1788000000000000000",
};

test("token setup is distinguished from a failed network read", () => {
  expect(walletSetupRequired("Wallet reply: Ledger is not selected in Wallet")).toBe(true);
  expect(walletSetupRequired("Ledger is not selected")).toBe(true);
  expect(walletSetupRequired("Network unavailable")).toBe(false);
  expect(walletSetupRequired(null)).toBe(false);
});

test("token setup uses Wallet's reviewed additive selection and validates its exact result", async () => {
  const calls: unknown[] = [];
  const client = { callTool: async (call: unknown) => { calls.push(call); return { ledger: REPLY.ledger, selected: true }; } };
  await addLedgerToWallet(client as never, REPLY.ledger);
  expect(calls).toEqual([{ target: "app:wallet:background", name: "wallet_add_ledger_v1", arguments: { ledger: REPLY.ledger } }]);
  const bad = { callTool: async () => ({ ledger: "xevnm-gaaaa-aaaar-qafnq-cai", selected: true }) };
  await expect(addLedgerToWallet(bad as never, REPLY.ledger)).rejects.toThrow("did not confirm");
  await expect(readTokenInfo({ callTool: async () => REPLY } as never, REPLY.ledger)).resolves.toMatchObject({ ledger: REPLY.ledger });
});

describe("parseTokenInfo", () => {
  test("reads the fields a swap depends on", () => {
    const info = parseTokenInfo(REPLY);
    expect(info.decimals).toBe(8);
    expect(info.feeAtoms).toBe(10_000n);
    expect(info.balanceAtoms).toBe(123_456_789n);
    expect(info.symbol).toBe("ICP");
  });

  test("keeps amounts exact beyond Number.MAX_SAFE_INTEGER", () => {
    const info = parseTokenInfo({
      ...REPLY,
      balanceAtoms: "123456789012345678901",
    });
    expect(info.balanceAtoms).toBe(123_456_789_012_345_678_901n);
  });

  test("refuses a reply with no usable decimals", () => {
    // Guessing precision is how an amount silently becomes the wrong amount.
    expect(() => parseTokenInfo({ ...REPLY, decimals: "8" })).toThrow();
    expect(() => parseTokenInfo({ ...REPLY, decimals: 1.5 })).toThrow();
    expect(() => parseTokenInfo(null)).toThrow();
  });

  test("does not treat an unavailable fee or balance as a successful zero observation", () => {
    for (const field of ["feeAtoms", "balanceAtoms", "observedAtNs"] as const) {
      for (const value of ["not-a-number", "", null, -1, "1.1", "01"]) {
        expect(() => parseTokenInfo({ ...REPLY, [field]: value })).toThrow();
      }
    }
    expect(parseTokenInfo({ ...REPLY, feeAtoms: "0", balanceAtoms: "0" }).balanceAtoms).toBe(0n);
  });

  test("requires usable account identity and ledger precision", () => {
    for (const decimals of [-1, 256]) expect(() => parseTokenInfo({ ...REPLY, decimals })).toThrow();
    for (const field of ["ledger", "account", "symbol"] as const) {
      expect(() => parseTokenInfo({ ...REPLY, [field]: "" })).toThrow();
    }
  });

  test("matches the Wallet reply to the requested ledger through the supplied client", async () => {
    const requested: unknown[] = [];
    const client = { callTool: async (call: unknown) => { requested.push(call); return REPLY; } };
    const info = await readTokenInfo(client as never, REPLY.ledger);
    expect(info.ledger).toBe(REPLY.ledger);
    expect(requested).toEqual([{ target: "app:wallet:background", name: "wallet_token_info_v1", arguments: { ledger: REPLY.ledger } }]);
    await expect(readTokenInfo(client as never, "xevnm-gaaaa-aaaar-qafnq-cai")).rejects.toThrow("another ledger");
  });

  test("accepts a missing name", () => {
    expect(parseTokenInfo({ ...REPLY, name: null }).name).toBeNull();
  });

  test("pair reads share one owner-request slot even through different clients", async () => {
    let active = false;
    const calls: string[] = [];
    const callTool = async (call: { arguments: { ledger: string } }) => {
      if (active) throw new Error("Another app request is active");
      active = true;
      calls.push(call.arguments.ledger);
      try {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return { ...REPLY, ledger: call.arguments.ledger };
      } finally { active = false; }
    };
    const ledgers = [REPLY.ledger, "xevnm-gaaaa-aaaar-qafnq-cai"];
    const infos = await Promise.all(ledgers.map((ledger) => readTokenInfo({ callTool } as never, ledger)));
    expect(infos.map((info) => info.ledger)).toEqual(ledgers);
    expect(calls).toEqual(ledgers);
  });

  test("a rejected Wallet read does not block a later token or retry the failed one", async () => {
    const calls: string[] = [];
    const client = { callTool: async (call: { arguments: { ledger: string } }) => {
      calls.push(call.arguments.ledger);
      if (call.arguments.ledger === REPLY.ledger) throw new Error("Owner declined access");
      return { ...REPLY, ledger: call.arguments.ledger };
    } };
    const results = await Promise.allSettled([
      readTokenInfo(client as never, REPLY.ledger),
      readTokenInfo(client as never, "xevnm-gaaaa-aaaar-qafnq-cai"),
    ]);
    expect(results[0]).toMatchObject({ status: "rejected", reason: new Error("Owner declined access") });
    expect(results[1]).toMatchObject({ status: "fulfilled", value: { ledger: "xevnm-gaaaa-aaaar-qafnq-cai" } });
    expect(calls).toEqual([REPLY.ledger, "xevnm-gaaaa-aaaar-qafnq-cai"]);
  });

  test("leaving the view skips queued reads but lets a dispatched request finish", async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const controller = new AbortController();
    const calls: string[] = [];
    const client = { callTool: async (call: { arguments: { ledger: string } }) => {
      calls.push(call.arguments.ledger);
      started.resolve();
      await release.promise;
      return { ...REPLY, ledger: call.arguments.ledger };
    } };
    const first = readTokenInfo(client as never, REPLY.ledger, controller.signal);
    await started.promise;
    const stale = readTokenInfo(client as never, "xevnm-gaaaa-aaaar-qafnq-cai", controller.signal);
    controller.abort();
    release.resolve();
    const results = await Promise.allSettled([first, stale]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(calls).toEqual([REPLY.ledger]);
    await expect(readTokenInfo(client as never, REPLY.ledger)).resolves.toMatchObject({ ledger: REPLY.ledger });
  });

  test("payout evidence shares the metadata consent queue and a declined read releases it", async () => {
    const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const calls: string[] = [];
    const client = { callTool: async (call: { name: string }) => {
      calls.push(call.name);
      if (call.name === "wallet_token_info_v1") { started.resolve(); await release.promise; return REPLY; }
      if (call.name === "wallet_account_transactions_v1") throw new Error("History access declined");
      return { blockIndex: "123", ledgerVerified: true };
    } };
    const info = readTokenInfo(client as never, REPLY.ledger);
    await started.promise;
    const history = readWalletTool(client as never, "wallet_account_transactions_v1", { ledger: REPLY.ledger });
    const transaction = readWalletTool(client as never, "wallet_transaction_v1", { ledger: REPLY.ledger, blockIndex: "123" });
    expect(calls).toEqual(["wallet_token_info_v1"]);
    release.resolve();
    const results = await Promise.allSettled([info, history, transaction]);
    expect(results.map(result => result.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
    expect(calls).toEqual(["wallet_token_info_v1", "wallet_account_transactions_v1", "wallet_transaction_v1"]);
  });
});
