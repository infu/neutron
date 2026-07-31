export const APP_VERSION_COMPONENT_BASE = 100;
export const APP_VERSION_MIN = APP_VERSION_COMPONENT_BASE;

export type AppVersionParts = {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
};

/**
 * App releases use a compact, naturally ordered SemVer subset:
 * major * 10_000 + minor * 100 + patch. Minor and patch are 0..99.
 * The first supported release is 0.1.0 (100). Memory and protocol versions
 * deliberately do not use this encoding.
 */
export function packAppVersion({
  major,
  minor,
  patch,
}: AppVersionParts): number {
  assertVersionComponent(major, "major", Number.MAX_SAFE_INTEGER);
  assertVersionComponent(minor, "minor", APP_VERSION_COMPONENT_BASE - 1);
  assertVersionComponent(patch, "patch", APP_VERSION_COMPONENT_BASE - 1);
  const packed =
    major * APP_VERSION_COMPONENT_BASE * APP_VERSION_COMPONENT_BASE +
    minor * APP_VERSION_COMPONENT_BASE +
    patch;
  assertAppVersion(packed);
  return packed;
}

export function unpackAppVersion(version: number | bigint): AppVersionParts {
  const normalized = normalizeAppVersion(version);
  const major = Math.floor(
    normalized / (APP_VERSION_COMPONENT_BASE * APP_VERSION_COMPONENT_BASE),
  );
  const remainder = normalized %
    (APP_VERSION_COMPONENT_BASE * APP_VERSION_COMPONENT_BASE);
  const minor = Math.floor(remainder / APP_VERSION_COMPONENT_BASE);
  const patch = remainder % APP_VERSION_COMPONENT_BASE;
  return { major, minor, patch };
}

export function formatAppVersion(version: number | bigint): string {
  const { major, minor, patch } = unpackAppVersion(version);
  return `${major}.${minor}.${patch}`;
}

export function formatAppVersionLabel(version: number | bigint): string {
  return `v${formatAppVersion(version)}`;
}

export function parseAppVersion(value: string): number {
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.exec(
    value,
  );
  if (!match) throw new Error("App version must use canonical major.minor.patch form");
  return packAppVersion({
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  });
}

export function isAppVersion(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= APP_VERSION_MIN
  );
}

export function normalizeAppVersion(
  value: number | bigint,
  label = "app version",
): number {
  const normalized =
    typeof value === "bigint" && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value;
  assertAppVersion(normalized, label);
  return normalized;
}

export function assertAppVersion(
  value: unknown,
  label = "app version",
): asserts value is number {
  if (!isAppVersion(value)) {
    throw new Error(`${label} must be a packed release version at or above 0.1.0`);
  }
}

function assertVersionComponent(
  value: number,
  label: string,
  maximum: number,
): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error(`App version ${label} must be an integer from 0 to ${maximum}`);
  }
}
