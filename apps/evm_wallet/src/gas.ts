/** An estimate describes one observed state. Contract execution can need more
 * gas by inclusion time. Keep simple 21,000-gas transfers exact, otherwise
 * include 20% headroom in both the simulated limit and reviewed maximum fee.
 * Explicit caller limits are handled separately and are never increased.
 * Keep this calculation identical to backend/evm/Gas.mo.
 */
export function automaticGasLimit(estimate: bigint): bigint {
  return estimate <= 21_000n ? estimate : estimate + (estimate + 4n) / 5n;
}
