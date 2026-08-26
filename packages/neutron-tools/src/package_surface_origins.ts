/**
 * Reserved package metadata emitted by the current packer for ordinary apps.
 * Older assemblers may publish it below the app's inert `/pkg` subtree; the
 * v26 compiler uses it only as evidence that the package was built for
 * installation-owned browser-surface origins.
 */
export const NEUTRON_BROWSER_SURFACE_ORIGINS_MARKER_PATH =
  ".neutron/browser-surface-origins.v1.json" as const;

const NEUTRON_BROWSER_SURFACE_ORIGINS_MARKER_TEXT = '{"format":1}\n';
const textEncoder = new TextEncoder();

export function browserSurfaceOriginsPackageMarkerBytes(): Uint8Array {
  return textEncoder.encode(NEUTRON_BROWSER_SURFACE_ORIGINS_MARKER_TEXT);
}

/** Absence is legacy; presence must match the one canonical marker exactly. */
export function parseBrowserSurfaceOriginsPackageMarker(
  value: Uint8Array | undefined,
): boolean {
  if (value === undefined) return false;
  if (!(value instanceof Uint8Array)) {
    throw new Error(
      `Invalid ${NEUTRON_BROWSER_SURFACE_ORIGINS_MARKER_PATH} package marker`,
    );
  }
  const expected = browserSurfaceOriginsPackageMarkerBytes();
  if (
    value.byteLength !== expected.byteLength ||
    value.some((byte, index) => byte !== expected[index])
  ) {
    throw new Error(
      `Invalid ${NEUTRON_BROWSER_SURFACE_ORIGINS_MARKER_PATH} package marker`,
    );
  }
  return true;
}
