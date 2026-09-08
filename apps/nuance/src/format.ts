// Small presentation helpers.
//
// Two different time units are in play and mixing them silently would produce
// nonsense dates: Nuance timestamps are milliseconds since the epoch carried as
// decimal text, while this app's own draft timestamps come from Motoko's
// `Time.now()` and are nanoseconds.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function ago(deltaMs: number): string {
  if (!Number.isFinite(deltaMs) || deltaMs < 0) return "";
  if (deltaMs < MINUTE) return "just now";
  if (deltaMs < HOUR) return `${Math.floor(deltaMs / MINUTE)}m`;
  if (deltaMs < DAY) return `${Math.floor(deltaMs / HOUR)}h`;
  if (deltaMs < 30 * DAY) return `${Math.floor(deltaMs / DAY)}d`;
  const months = Math.floor(deltaMs / (30 * DAY));
  if (months < 12) return `${months}mo`;
  return `${Math.floor(months / 12)}y`;
}

/// Nuance publish dates: milliseconds as decimal text.
export function relativeFromMillis(value: string): string {
  const millis = Number(value);
  if (!Number.isFinite(millis) || millis <= 0) return "";
  return ago(Date.now() - millis);
}

/// App draft timestamps: nanoseconds as decimal text.
export function relativeFromNanos(value: string): string {
  const nanos = Number(value);
  if (!Number.isFinite(nanos) || nanos <= 0) return "";
  return ago(Date.now() - nanos / 1_000_000);
}

/// Candid Nat arrives as a decimal string; render it, or a dash when absent.
export function count(value: string | undefined): string {
  if (!value) return "0";
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}m`;
}

export function toNumber(value: string | undefined): number {
  const n = Number(value ?? "0");
  return Number.isFinite(n) ? n : 0;
}

export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

/// Nuance list projections already end in "..." because the bucket truncates
/// titles at 60 characters. Strip that so the UI does not show a double ellipsis
/// next to its own truncation.
export function tidyListTitle(value: string): string {
  return value.endsWith("...") ? `${value.slice(0, -3)}…` : value;
}

export function articleUrl(handle: string, postId: string, bucket: string, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `https://nuance.xyz/${handle.toLowerCase()}/${postId}-${bucket}/${slug}`;
}
