/**
 * Source-owned release-evidence budget. These values bound only the synthetic
 * qualification workload; they do not change any Kernel runtime limit.
 */
export const CERTIFIED_ASSETS_RELEASE_QUALIFICATION_PROFILE = {
  maximum_wall_seconds: 180,
  bounded_physical_sample: {
    entries: 256,
    batch_operations: 16,
    idempotency_receipts: 8,
    receipt_expiry_crossings: 1,
  },
} as const;
