export type NatValue = bigint | number;

const TRILLION_CYCLES = 1_000_000_000_000n;
const TRILLION_CYCLE_DISPLAY_SCALE = 10_000n;

const DECIMAL_UNITS = [
  { value: 1_000_000_000_000n, suffix: "T" },
  { value: 1_000_000_000n, suffix: "B" },
  { value: 1_000_000n, suffix: "M" },
  { value: 1_000n, suffix: "k" },
] as const;

const INSTRUCTION_UNITS = [
  { value: 1_000_000_000_000_000_000_000_000_000_000n, suffix: "Q" },
  { value: 1_000_000_000_000_000_000_000_000_000n, suffix: "R" },
  { value: 1_000_000_000_000_000_000_000_000n, suffix: "Y" },
  { value: 1_000_000_000_000_000_000_000n, suffix: "Z" },
  { value: 1_000_000_000_000_000_000n, suffix: "E" },
  { value: 1_000_000_000_000_000n, suffix: "P" },
  ...DECIMAL_UNITS,
] as const;

const BYTE_UNITS = [
  { value: 1_152_921_504_606_846_976n, suffix: "EiB" },
  { value: 1_125_899_906_842_624n, suffix: "PiB" },
  { value: 1_099_511_627_776n, suffix: "TiB" },
  { value: 1_073_741_824n, suffix: "GiB" },
  { value: 1_048_576n, suffix: "MiB" },
  { value: 1_024n, suffix: "KiB" },
] as const;

export function normalizeNat(value: NatValue, label = "value"): bigint {
  if (typeof value === "bigint") {
    if (value < 0n) throw new Error(`${label} must be non-negative`);
    return value;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} is not a safe Nat`);
  }
  return BigInt(value);
}

export function formatExactNat(value: NatValue): string {
  return normalizeNat(value).toLocaleString("en-US");
}

export function formatCycles(value: NatValue): string {
  const normalized = normalizeNat(value, "cycle count");
  const unit = INSTRUCTION_UNITS.find(
    (candidate) => normalized >= candidate.value,
  );
  if (!unit) return `${normalized.toLocaleString("en-US")} cycles`;
  return `${formatScaled(normalized, unit.value)} ${unit.suffix} cycles`;
}

export function formatTrillionCycles(value: NatValue): string {
  const normalized = normalizeNat(value, "cycle count");
  const rounded =
    (normalized * TRILLION_CYCLE_DISPLAY_SCALE + TRILLION_CYCLES / 2n) /
    TRILLION_CYCLES;
  const whole = rounded / TRILLION_CYCLE_DISPLAY_SCALE;
  const fraction = (rounded % TRILLION_CYCLE_DISPLAY_SCALE)
    .toString()
    .padStart(4, "0");
  return `${whole.toLocaleString("en-US")}.${fraction}TC`;
}

export function formatInstructions(value: NatValue): string {
  const normalized = normalizeNat(value, "instruction count");
  const unit = INSTRUCTION_UNITS.find(
    (candidate) => normalized >= candidate.value,
  );
  if (!unit) return normalized.toLocaleString("en-US");
  return `${formatScaled(normalized, unit.value)} ${unit.suffix}`;
}

export function formatBytes(value: NatValue): string {
  const normalized = normalizeNat(value, "byte value");
  const unit = BYTE_UNITS.find((candidate) => normalized >= candidate.value);
  if (!unit) return `${normalized.toLocaleString("en-US")} B`;
  return `${formatScaled(normalized, unit.value)} ${unit.suffix}`;
}

export function formatTimestamp(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(value);
}

function formatScaled(value: bigint, unit: bigint): string {
  const whole = value / unit;
  const hundredths = ((value % unit) * 100n) / unit;
  const fraction = hundredths.toString().padStart(2, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
