export function nextStartedTileRuntime(
  current: string | null,
  runtime: string | null,
  active: boolean,
): string | null {
  if (runtime === null) return null;
  if (current === runtime) return current;
  return active ? runtime : null;
}
