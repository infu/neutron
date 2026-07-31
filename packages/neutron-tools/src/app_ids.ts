export const APP_ID_MIN_LENGTH = 4;
export const APP_ID_MAX_LENGTH = 30;
export const APP_ID_SCHEMA_PATTERN = "^[a-z0-9]+(?:_[a-z0-9]+)*$";
export const APP_ID_PATTERN = new RegExp(APP_ID_SCHEMA_PATTERN, "u");
/** Equivalent edge check for model-facing schemas that prohibit regex groups. */
export const APP_ID_SAFE_SCHEMA_PATTERN = "^[a-z0-9][a-z0-9_]*[a-z0-9]$";
export const APP_ID_REPEATED_SEPARATOR_PATTERN = "__";

/**
 * Canonical authored app id. Single underscores may separate non-empty
 * lowercase alphanumeric segments; leading, trailing, and repeated
 * underscores are forbidden so `__` remains a compiler-owned separator.
 */
export function isValidAppId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= APP_ID_MIN_LENGTH &&
    value.length <= APP_ID_MAX_LENGTH &&
    APP_ID_PATTERN.test(value)
  );
}
