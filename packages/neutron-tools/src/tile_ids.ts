export const TILE_ID_MAX_LENGTH = 30;
export const TILE_ID_SCHEMA_PATTERN = "^[a-z_0-9]+$";
export const TILE_ID_PATTERN = new RegExp(TILE_ID_SCHEMA_PATTERN, "u");

export function isValidTileId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= TILE_ID_MAX_LENGTH &&
    TILE_ID_PATTERN.test(value)
  );
}
