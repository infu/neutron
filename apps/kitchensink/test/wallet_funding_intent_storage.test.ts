import { expect, test } from "bun:test";
import {
  createWalletFundingDemoRequest,
  walletFundingDemoRequestExpired,
  type WalletFundingDemoKind,
  type WalletFundingDemoRequest,
} from "../src/wallet_funding_demo.ts";
import {
  WALLET_FUNDING_INTENT_STORAGE_KEY,
  WALLET_FUNDING_UNREADABLE_ERROR,
  runWalletFundingIntentAction,
} from "../src/wallet_funding_intent_storage.ts";

const NOW_MS = 1_700_000_000_000;

test("prepare persists and reuses an expired full intent across reloads", () => {
  const storage = new MemoryStorage();
  const first = runWalletFundingIntentAction(
    storage,
    { action: "prepare", kind: "direct" },
    creator(1),
  );
  expect(
    walletFundingDemoRequestExpired(first, NOW_MS + 240_000),
  ).toBe(true);

  const afterReload = runWalletFundingIntentAction(
    storage,
    { action: "prepare", kind: "direct" },
    creator(2),
  );
  expect(afterReload).toEqual(first);
});

test("complete atomically rotates only the matching terminal intent", () => {
  const storage = new MemoryStorage();
  const prepared = prepare(storage, "direct", 1);
  const wrongId = "ffffffffffffffffffffffffffffffff";
  expect(runWalletFundingIntentAction(storage, {
    action: "complete",
    kind: "direct",
    requestId: wrongId,
  })).toEqual(prepared);
  expect(prepare(storage, "direct", 2)).toEqual(prepared);

  const replacement = runWalletFundingIntentAction(
    storage,
    {
      action: "complete",
      kind: "direct",
      requestId: prepared.requestId,
    },
    creator(2),
  );
  expect(replacement.requestId).toBe("02".repeat(16));
  expect(prepare(storage, "direct", 3)).toEqual(replacement);
});

test("complete preserves the current intent when replacement fails", () => {
  const storage = new MemoryStorage();
  const prepared = prepare(storage, "direct", 1);
  const action = {
    action: "complete" as const,
    kind: "direct" as const,
    requestId: prepared.requestId,
  };

  expect(() => runWalletFundingIntentAction(storage, action, () => {
    throw new Error("request generation failed");
  })).toThrow("request generation failed");
  expect(prepare(storage, "direct", 2)).toEqual(prepared);

  storage.failNextSet();
  expect(() => runWalletFundingIntentAction(storage, action, creator(2)))
    .toThrow("storage write failed");
  expect(prepare(storage, "direct", 3)).toEqual(prepared);
});

test("only an explicit matching discard rotates an unresolved intent", () => {
  const storage = new MemoryStorage();
  const prepared = prepare(storage, "allowance", 1);
  expect(runWalletFundingIntentAction(
    storage,
    {
      action: "discard",
      kind: "allowance",
      requestId: "ffffffffffffffffffffffffffffffff",
    },
    creator(2),
  )).toEqual(prepared);

  const replacement = runWalletFundingIntentAction(
    storage,
    {
      action: "discard",
      kind: "allowance",
      requestId: prepared.requestId,
    },
    creator(2),
  );
  expect(replacement.requestId).not.toBe(prepared.requestId);
  expect(prepare(storage, "allowance", 3)).toEqual(replacement);
});

test("an explicit reset recovers one unreadable rail without touching the other", () => {
  const storage = new MemoryStorage();
  const allowance = prepare(storage, "allowance", 1);
  storage.setItem(`${WALLET_FUNDING_INTENT_STORAGE_KEY}.direct`, "{");

  expect(() => prepare(storage, "direct", 2)).toThrow(
    WALLET_FUNDING_UNREADABLE_ERROR,
  );
  const reset = runWalletFundingIntentAction(
    storage,
    { action: "reset", kind: "direct" },
    creator(2),
  );
  expect(reset.requestId).toBe("02".repeat(16));
  expect(prepare(storage, "allowance", 3)).toEqual(allowance);
});

test("a stale reset cannot replace a valid intent repaired by another tab", () => {
  const storage = new MemoryStorage();
  storage.setItem(`${WALLET_FUNDING_INTENT_STORAGE_KEY}.direct`, "{");
  expect(() => prepare(storage, "direct", 1)).toThrow(
    WALLET_FUNDING_UNREADABLE_ERROR,
  );

  const repaired = runWalletFundingIntentAction(
    storage,
    { action: "reset", kind: "direct" },
    creator(2),
  );
  const staleReset = runWalletFundingIntentAction(
    storage,
    { action: "reset", kind: "direct" },
    creator(3),
  );
  expect(staleReset).toEqual(repaired);
  expect(prepare(storage, "direct", 4)).toEqual(repaired);
});

test("stored intents use closed fixed-value parsing", () => {
  const valid = createWalletFundingDemoRequest("direct", options(1));
  const cases: unknown[] = [
    "{",
    { ...valid, extra: true },
    { ...valid, requestId: "ABC" },
    { ...valid, ledger: "aaaaa-aa" },
    { ...valid, amountAtoms: "2" },
    { ...valid, validUntilNs: "18446744073709551616" },
    createWalletFundingDemoRequest("allowance", options(2)),
    { ...valid, route: { ...valid.route, extra: true } },
  ];

  for (const value of cases) {
    const storage = new MemoryStorage();
    storage.setItem(
      `${WALLET_FUNDING_INTENT_STORAGE_KEY}.direct`,
      typeof value === "string" ? value : JSON.stringify(value),
    );
    expect(() => runWalletFundingIntentAction(
      storage,
      { action: "prepare", kind: "direct" },
      creator(3),
    )).toThrow();
  }

  const allowance = createWalletFundingDemoRequest("allowance", options(4));
  const storage = new MemoryStorage();
  storage.setItem(
    `${WALLET_FUNDING_INTENT_STORAGE_KEY}.allowance`,
    JSON.stringify({
      ...allowance,
      route: { ...allowance.route, expiresAtNs: "1" },
    }),
  );
  expect(() => runWalletFundingIntentAction(
    storage,
    { action: "prepare", kind: "allowance" },
    creator(5),
  )).toThrow();

  if (allowance.route.kind !== "allowance") {
    throw new Error("Expected an allowance fixture");
  }
  storage.setItem(
    `${WALLET_FUNDING_INTENT_STORAGE_KEY}.allowance`,
    JSON.stringify({
      ...allowance,
      route: {
        ...allowance.route,
        expiresAtNs: (
          BigInt(allowance.route.expiresAtNs) + 1n
        ).toString(),
      },
    }),
  );
  expect(() => runWalletFundingIntentAction(
    storage,
    { action: "prepare", kind: "allowance" },
    creator(5),
  )).toThrow("Invalid Wallet funding allowance expiration");
});

function prepare(
  storage: MemoryStorage,
  kind: WalletFundingDemoKind,
  byte: number,
): WalletFundingDemoRequest {
  return runWalletFundingIntentAction(
    storage,
    { action: "prepare", kind },
    creator(byte),
  );
}

function creator(byte: number) {
  return (kind: WalletFundingDemoKind) =>
    createWalletFundingDemoRequest(kind, options(byte));
}

function options(byte: number) {
  return {
    nowMs: NOW_MS,
    fillRandomValues(bytes: Uint8Array) {
      bytes.fill(byte);
    },
  };
}

class MemoryStorage {
  private readonly values = new Map<string, string>();
  private rejectNextSet = false;

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.rejectNextSet) {
      this.rejectNextSet = false;
      throw new Error("storage write failed");
    }
    this.values.set(key, value);
  }

  failNextSet(): void {
    this.rejectNextSet = true;
  }
}
