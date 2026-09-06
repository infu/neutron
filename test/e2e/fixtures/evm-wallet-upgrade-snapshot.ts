import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { IDL } from "@dfinity/candid";
import { extractPublicTypeAliases, motokoTypeToIdl } from "neutron-scripts/src/method_schema.js";

type Value = null | boolean | number | string | Value[] | { [key: string]: Value };
export type WalletSnapshotRefreshChange = { path: string; before: string; after: string };
let snapshotType: Promise<IDL.Type> | null = null;

/** Decode the actual unchanged Wallet315/316 public snapshot definition. */
export async function decodeWalletUpgradeSnapshot(replyBase64: string): Promise<Value> {
  snapshotType ??= readFile(new URL("../../../apps/wallet/backend/main.mo", import.meta.url), "utf8").then((source) => {
    const aliases = extractPublicTypeAliases(source);
    if (!aliases.WalletSnapshot) throw new Error("WalletSnapshot public type is missing");
    return motokoTypeToIdl(aliases.WalletSnapshot, IDL, aliases);
  });
  const decoded = IDL.decode([await snapshotType], new Uint8Array(Buffer.from(replyBase64, "base64")));
  assert.equal(decoded.length, 1);
  return normalize(decoded[0]);
}

/**
 * Only successful resident balance/native-deposit refresh timestamps may move.
 * Owners, ledger configuration, balances, addresses, fees, errors, deposits and
 * all other snapshot fields remain exact. Missing/new values are not ignored.
 */
export function assertWalletSnapshotCacheRefresh(before: Value, after: Value): WalletSnapshotRefreshChange[] {
  const changes: WalletSnapshotRefreshChange[] = [];
  function compare(left: Value | undefined, right: Value | undefined, path: string): void {
    if (JSON.stringify(left) === JSON.stringify(right)) return;
    const timestamp = /^\/ledgers\/[0-9]+\/(?:balance_updated_at\/0|native_refresh_updated_at\/0|native_deposit_progress\/0\/checked_at)$/u.test(path);
    if (timestamp && typeof left === "string" && typeof right === "string" && /^[0-9]+$/u.test(left) && /^[0-9]+$/u.test(right)) {
      assert(BigInt(right) >= BigInt(left), `Wallet cache time moved backward at ${path}`);
      changes.push({ path, before: left, after: right });
      return;
    }
    if (left !== null && right !== null && typeof left === "object" && typeof right === "object") {
      assert.equal(Array.isArray(left), Array.isArray(right), `Wallet snapshot shape changed at ${path}`);
      const a = left as Record<string, Value>, b = right as Record<string, Value>;
      assert.deepEqual(Object.keys(a), Object.keys(b), `Wallet snapshot fields changed at ${path}`);
      for (const key of Object.keys(a)) compare(a[key], b[key], `${path}/${key}`);
      return;
    }
    assert.deepEqual(right, left, `Wallet state changed beyond resident refresh time at ${path}`);
  }
  compare(before, after, "");
  return changes;
}

function normalize(value: unknown): Value {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return Array.from(value);
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    if ("toText" in value && typeof value.toText === "function") return value.toText() as string;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)]));
  }
  throw new Error("Unexpected Wallet snapshot value");
}
