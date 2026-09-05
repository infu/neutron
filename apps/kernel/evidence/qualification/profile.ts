/**
 * Source-owned release-evidence budget. These values bound only the synthetic
 * qualification workload; they do not change any Kernel runtime limit.
 */
export const QUALIFICATION_INSTALL_WASM_MAX_CHUNKS_BOUND = 100;
export const QUALIFICATION_MAX_ROUNDS_PER_AWAITED_INGRESS = 100;
export const QUALIFICATION_FRESH_SETUP_FIXED_AWAITED_INGRESSES = 13;
export const QUALIFICATION_RESET_SETUP_FIXED_AWAITED_INGRESSES = 11;
export const QUALIFICATION_ACTIVE_BOUNDARY_AWAITED_INGRESSES = 10;

export const CERTIFIED_ASSETS_RELEASE_QUALIFICATION_PROFILE = {
  // This covers fixture packaging, uncached compilation, fresh installs, and
  // the complete runtime/gateway workload on a shared build host. It is a
  // local process watchdog, not a Kernel runtime or qualification metric.
  maximum_wall_seconds: 300,
  operational_sample_concurrency: 3,
  // Two transport installations may each upload the compiler's maximum 100
  // Wasm chunks. Fresh setup adds 13 fixed awaited ingresses and the probe /
  // reset path adds 11. PocketIC caps each awaited ingress at 100 rounds.
  maximum_setup_implicit_round_drift_ns:
    (
      2 * QUALIFICATION_INSTALL_WASM_MAX_CHUNKS_BOUND +
      QUALIFICATION_FRESH_SETUP_FIXED_AWAITED_INGRESSES +
      QUALIFICATION_RESET_SETUP_FIXED_AWAITED_INGRESSES
    ) * QUALIFICATION_MAX_ROUNDS_PER_AWAITED_INGRESS,
  // Pinned PocketIC advances a fixed clock by 1ns for each implicitly timed
  // executed round. The largest active gap has ten awaited ingresses: one
  // maintenance page, eight remaining commits, and the overflow probe.
  maximum_implicit_round_drift_ns_per_boundary:
    QUALIFICATION_ACTIVE_BOUNDARY_AWAITED_INGRESSES *
    QUALIFICATION_MAX_ROUNDS_PER_AWAITED_INGRESS,
  bounded_physical_sample: {
    entries: 256,
    batch_operations: 16,
    idempotency_receipts: 8,
    receipt_expiry_crossings: 1,
  },
} as const;
