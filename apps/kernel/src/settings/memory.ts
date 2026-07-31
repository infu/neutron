import { normalizeNat, type NatValue } from "./format.ts";

export type HeapMemorySummary = {
  limitBytes: bigint;
  pressureBasisPoints: number;
  pressurePercent: number;
  usedBytes: bigint;
};

export function summarizeHeapMemory(
  heapBytes: NatValue,
  wasmMemoryLimitBytes: NatValue,
): HeapMemorySummary {
  const usedBytes = normalizeNat(heapBytes, "heap memory");
  const limitBytes = normalizePositiveLimit(
    wasmMemoryLimitBytes,
    "canister-memory limit",
  );
  const pressureBasisPoints = Math.min(
    10_000,
    usageBasisPoints(usedBytes, limitBytes),
  );
  return {
    limitBytes,
    pressureBasisPoints,
    pressurePercent: pressureBasisPoints / 100,
    usedBytes,
  };
}

export function formatMemoryPressure(basisPoints: number): string {
  if (!Number.isInteger(basisPoints) || basisPoints < 0) {
    throw new Error("Memory pressure must be non-negative basis points");
  }
  if (basisPoints === 0) return "0%";
  if (basisPoints < 10) return "<0.1%";
  const percent = basisPoints / 100;
  return percent < 10 ? `${percent.toFixed(1)}%` : `${Math.round(percent)}%`;
}

function normalizePositiveLimit(value: NatValue, label: string): bigint {
  const normalized = normalizeNat(value, label);
  if (normalized === 0n) throw new Error(`${label} must be positive`);
  return normalized;
}

function usageBasisPoints(used: bigint, limit: bigint): number {
  const basisPoints = (used * 10_000n) / limit;
  return Number(basisPoints > 10_000n ? 10_000n : basisPoints);
}
