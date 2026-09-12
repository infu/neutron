/** User-approved text sizes, measured as Unicode code points (Motoko Text.size). */
export const TITLE_LIMIT = 160;
export const MESSAGE_LIMIT = 16_000;

export function characterCount(value: string): number {
  let count = 0;
  for (const _character of value) count++;
  return count;
}

export function textLimitError(value: string, limit: number, label: string): string {
  const excess = characterCount(value) - limit;
  return excess > 0
    ? `${label} must be ${limit.toLocaleString("en-US")} characters or fewer. Remove ${excess.toLocaleString("en-US")} ${excess === 1 ? "character" : "characters"} to continue.`
    : "";
}
