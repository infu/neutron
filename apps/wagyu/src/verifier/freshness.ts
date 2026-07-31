import type { MutableFreshnessPolicyV1 } from "./types.ts";

export const DEFAULT_MUTABLE_MAX_AGE_NS = 5n * 60n * 1_000_000_000n;
export const DEFAULT_FUTURE_SKEW_NS = 60n * 1_000_000_000n;

export function assertFreshCertificate(
  certificateTimeNs: bigint,
  policy: MutableFreshnessPolicyV1,
): void {
  if (certificateTimeNs <= 0n || policy.nowNs <= 0n) {
    throw new Error("Certificate freshness time is invalid");
  }
  const maxAge = policy.maxAgeNs ?? DEFAULT_MUTABLE_MAX_AGE_NS;
  const futureSkew = policy.maxFutureSkewNs ?? DEFAULT_FUTURE_SKEW_NS;
  if (maxAge < 0n || futureSkew < 0n) {
    throw new Error("Certificate freshness policy is invalid");
  }
  if (certificateTimeNs > policy.nowNs + futureSkew) {
    throw new Error("Certificate time is implausibly in the future");
  }
  if (
    certificateTimeNs <= policy.nowNs &&
    policy.nowNs - certificateTimeNs > maxAge
  ) {
    throw new Error("Mutable certified response is stale");
  }
}
