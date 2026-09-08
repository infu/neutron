/** Candid optional helpers. `[] | [T]` is unergonomic everywhere else. */

export function opt<T>(value: [] | [T] | undefined): T | undefined {
  return value === undefined || value.length === 0 ? undefined : value[0];
}

export function optOr<T>(value: [] | [T] | undefined, fallback: T): T {
  return opt(value) ?? fallback;
}

export function toOpt<T>(value: T | undefined | null): [] | [T] {
  return value === undefined || value === null ? [] : [value];
}

/** The variant tag of a Candid variant decoded as a single-key object. */
export function variantKey(value: object | undefined): string | undefined {
  if (!value) return undefined;
  const keys = Object.keys(value);
  return keys.length === 1 ? keys[0] : undefined;
}
