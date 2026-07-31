export function formatTokenAmount(value: string, decimals: number): string {
  const digits = BigInt(value).toString();
  const safeDecimals = Number.isInteger(decimals)
    ? Math.max(0, Math.min(decimals, 255))
    : 0;
  if (safeDecimals === 0) return groupDigits(digits);
  const padded = digits.padStart(safeDecimals + 1, "0");
  const whole = padded.slice(0, -safeDecimals);
  const fraction = padded.slice(-safeDecimals).replace(/0+$/, "");
  return fraction ? `${groupDigits(whole)}.${fraction}` : groupDigits(whole);
}

export function parseTokenAmount(value: string, decimals: number): string {
  const text = value.trim();
  const safeDecimals = Number.isInteger(decimals)
    ? Math.max(0, Math.min(decimals, 255))
    : 0;
  if (!/^(?:(?:0|[1-9][0-9]*)(?:\.[0-9]*)?|\.[0-9]+)$/.test(text)) {
    throw new Error("Enter a valid token amount");
  }
  const [whole = "0", fraction = ""] = text.split(".");
  if (fraction.length > safeDecimals) {
    throw new Error(`Amount supports at most ${safeDecimals} decimal places`);
  }
  const units =
    BigInt(whole || "0") * 10n ** BigInt(safeDecimals) +
    BigInt(fraction.padEnd(safeDecimals, "0") || "0");
  if (units === 0n) throw new Error("Amount must be greater than zero");
  return units.toString();
}

type TransferToken = {
  balance: string | null;
  decimals: number | null;
  fee: string | null;
};

export function parseTransferAmount(
  value: string,
  token: TransferToken,
): string {
  if (token.decimals === null) {
    throw new Error("Token decimals are not available");
  }
  const amount = parseTokenAmount(value, token.decimals);
  if (
    token.balance !== null &&
    BigInt(amount) + BigInt(token.fee ?? "0") > BigInt(token.balance)
  ) {
    throw new Error("Amount and fee exceed the available balance");
  }
  return amount;
}

export function maxTransferAmount(token: TransferToken): string | null {
  if (token.balance === null || token.decimals === null) return null;
  const available = BigInt(token.balance) - BigInt(token.fee ?? "0");
  if (available <= 0n) return null;
  return formatTokenAmount(available.toString(), token.decimals).replaceAll(
    ",",
    "",
  );
}

function groupDigits(value: string): string {
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
