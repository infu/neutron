/** Reserve the approval fee and the pool deposit's ledger fee, as in the quote. */
export function spendableBalance(balanceAtoms: bigint, feeAtoms: bigint): bigint {
  const reserve = feeAtoms * 2n;
  return balanceAtoms > reserve ? balanceAtoms - reserve : 0n;
}

/** Round down in atomic units so a percentage never exceeds its chosen budget. */
export function amountAtPercent(spendableAtoms: bigint, percentage: number): bigint {
  if (spendableAtoms < 0n || !Number.isInteger(percentage) || percentage < 0 || percentage > 100) throw new Error("Choose a percentage between 0 and 100.");
  return spendableAtoms * BigInt(percentage) / 100n;
}

/** Manual amounts map back to the nearest slider step without converting the balance to Number. */
export function percentForAmount(amountAtoms: bigint | null, spendableAtoms: bigint | null): number {
  if (amountAtoms === null || amountAtoms <= 0n || spendableAtoms === null || spendableAtoms <= 0n) return 0;
  if (amountAtoms >= spendableAtoms) return 100;
  return Number((amountAtoms * 100n + spendableAtoms / 2n) / spendableAtoms);
}
