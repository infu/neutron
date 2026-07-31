import { assertAppVersion, formatAppVersion } from "./version.ts";

/** Exact archive filename emitted by neutron-scripts for an app manifest. */
export function packageArchiveFilename(id: string, version: number): string {
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("Package id must be a non-empty string");
  }
  assertAppVersion(version, "package version");
  const sanitizedId = id.replace(/[^a-z0-9]/gi, "_");
  return `${sanitizedId}.v${formatAppVersion(version)}.neutron`;
}
