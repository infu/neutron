import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";
import * as transfers from "../src/transfers.ts";
import { parseWalletSnapshotResult } from "../src/wallet_data.ts";

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
afterEach(() => {
  if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

// Execute the actual React component's three recovery controllers. React state
// setters and Kernel transport are fixtures; cache and operation parsing are real.
// This catches throwing cache reads placed before backend recovery or receipt
// acknowledgement without adding a production-only component export.
const source = readFileSync(new URL("../src/index.tsx", import.meta.url), "utf8");
const start = source.indexOf("  const refreshPendingTransfers = async () => {");
const end = source.indexOf("  const submitTransfer = async", start);
if (start < 0 || end < 0) throw new Error("Wallet recovery controllers were not found");
const controllerSource = transformSync(source.slice(start, end), { loader: "tsx", target: "es2022" }).code;

type WireOperation = {
  request_id: Uint8Array; ledger: string; amount: string; destination: string; native: boolean;
  status: Record<string, unknown>; message?: string; settlement?: Record<string, unknown>;
};

for (const native of [false, true]) test(`actual ${native ? "native settlement" : "send"} recovery ignores a corrupt optional cache without replacing its intent`, async () => {
  const owner = native ? "corrupt-native-recovery" : "corrupt-send-recovery";
  const cacheKey = `wallet:transfers:v2:${owner}`;
  const storage = new Map([[cacheKey, "broken-json"]]);
  let cacheWrites = 0;
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { cacheWrites++; storage.set(key, value); },
  } });
  const id = "12".repeat(16);
  const receipt = { block_index: "91", duplicate: false, native, amount: "1000000" };
  const initial: WireOperation = {
    request_id: transfers.transferIdBytes(id), ledger: "ryjl3-tyaaa-aaaaa-aaaba-cai", amount: "1000000",
    destination: native ? `0x${"11".repeat(20)}` : "aaaaa-aa", native,
    status: native ? { succeeded: receipt } : { pending: null },
    ...(native ? { settlement: { checked_at: "1", status: { pending: "Native payment pending" } } } : { message: "Reply lost" }),
  };
  let acknowledged = false;
  let backendReads = 0;
  let warning: string | null = null;
  const notices: (string | null)[] = [];
  const seenReceipts: unknown[] = [];
  const methods: string[] = [];
  const pending: transfers.WalletTransferOperation[] = [];
  const bindings = {
    ...transfers,
    snapshot: { owner, configured: true, ledgers: [] },
    pendingTransfers: pending,
    setPendingTransfers: (value: transfers.WalletTransferOperation[]) => pending.splice(0, pending.length, ...value),
    setTransferCacheWarning: (value: string | null) => { warning = value; },
    setError: (value: string | null) => notices.push(value),
    setTransferBusy: (_value: boolean) => {},
    setTransferReceipt: (value: unknown) => seenReceipts.push(value),
    setSnapshot: (_value: unknown) => {},
    useEffect: () => {},
    errorMessage: (error: unknown) => String(error),
    asTransferReceipt: (value: unknown) => value,
    parseWalletSnapshotResult,
    publishWalletInvalidation: () => {},
    querySelf: async (method: string, args: unknown[]) => {
      expect(method).toBe("wallet_transfers_pending_v2");
      expect(args).toEqual([null]);
      backendReads++;
      return acknowledged ? [] : [initial];
    },
    updateSelf: async (method: string, args: unknown[]) => {
      methods.push(method);
      if (method === "wallet_refresh_balances") return { owner: "aaaaa-aa", configured: true, ledgers: [] };
      expect(args).toEqual([transfers.transferIdBytes(id)]);
      if (method === "wallet_transfer_acknowledge_v2") { acknowledged = true; return null; }
      expect(method).toBe(native ? "wallet_transfer_refresh_v2" : "wallet_transfer_resume_v2");
      return { ...initial, status: { succeeded: receipt }, ...(native ? {
        settlement: { checked_at: "2", status: { confirmed: { transaction_hash: `0x${"ab".repeat(32)}` } } },
      } : {}) };
    },
  };
  const controllers = new Function(...Object.keys(bindings), `${controllerSource}\nreturn { refreshPendingTransfers, resumeSavedTransfer };`)(...Object.values(bindings)) as {
    refreshPendingTransfers: () => Promise<void>; resumeSavedTransfer: (id: string) => Promise<void>;
  };
  await controllers.refreshPendingTransfers();
  expect(backendReads).toBe(1);
  expect(pending).toHaveLength(1);
  expect(pending[0]!.requestId).toBe(id);
  expect(String(warning)).toContain("kept unchanged");
  await controllers.resumeSavedTransfer(id);
  expect(methods).toEqual([native ? "wallet_transfer_refresh_v2" : "wallet_transfer_resume_v2", "wallet_refresh_balances", "wallet_transfer_acknowledge_v2"]);
  expect(acknowledged).toBe(true);
  expect(backendReads).toBe(2);
  expect(pending).toEqual([]);
  expect(seenReceipts).toEqual([receipt]);
  expect(notices.filter(Boolean)).toEqual([]);
  expect(String(warning)).toContain("fresh sends remain blocked");
  expect(cacheWrites).toBe(0);
  expect(storage.get(cacheKey)).toBe("broken-json");
  expect(() => transfers.saveWalletTransfer(owner, { amount: "1000000" })).toThrow();
  expect(cacheWrites).toBe(0);
});
