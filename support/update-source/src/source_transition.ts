import { readFile } from "node:fs/promises";
import { preparePackageInstall } from "neutron-compiler/src/install.ts";
import { isValidAppId } from "neutron-tools/src/app_ids.ts";
import { normalizeUpdateSourcePrincipal } from "neutron-tools/src/schema.ts";
import { readPackageAsset, readReleaseAsset, readSourceAsset, updateSourceOrigin, type CertifiedFetch } from "./http.ts";
import { sha256Hex, type InspectedUpdatePackage } from "./model.ts";

/** A reviewed, exact release set; never a persistent exception for an app ID. */
export type SourceTransition = Readonly<{
  fromSource: string;
  toSource: string;
  packages: readonly Readonly<{ id: string; version: number; sha256: string }>[];
}>;

export async function loadSourceTransition(filename: string): Promise<SourceTransition> {
  const bytes = await readFile(filename);
  // The sidecar names a subset of the existing bounded release catalog.
  if (bytes.byteLength > 256 * 1024) throw new Error("Source transition exceeds the release catalog byte limit");
  return parseSourceTransition(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
}

export function parseSourceTransition(value: unknown): SourceTransition {
  const row = record(value, ["format", "from_source", "to_source", "packages"], "Source transition");
  if (row.format !== 1) throw new Error("Source transition format must be 1");
  const fromSource = normalizeUpdateSourcePrincipal(row.from_source, "transition from_source");
  const toSource = normalizeUpdateSourcePrincipal(row.to_source, "transition to_source");
  if (fromSource === toSource) throw new Error("Source transition must name different sources");
  if (!Array.isArray(row.packages) || row.packages.length === 0) throw new Error("Source transition requires exact package entries");
  const packages = row.packages.map((value, index) => {
    const entry = record(value, ["id", "version", "sha256"], `Source transition packages[${index}]`);
    if (!isValidAppId(entry.id)) throw new Error("Source transition has an invalid app ID");
    if (typeof entry.version !== "number" || !Number.isSafeInteger(entry.version) || entry.version < 100) throw new Error("Source transition has an invalid release version");
    if (typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) throw new Error("Source transition requires a lowercase package SHA-256");
    return { id: entry.id, version: entry.version, sha256: entry.sha256 };
  });
  if (new Set(packages.map(({ id }) => id)).size !== packages.length) throw new Error("Source transition repeats an app ID");
  return { fromSource, toSource, packages };
}

export function assertTransitionScope(transition: SourceTransition, fromSource: string, ids: readonly string[]): void {
  // Validate programmatic callers as strictly as file input.
  parseSourceTransition({ format: 1, from_source: transition.fromSource, to_source: transition.toSource, packages: transition.packages });
  if (transition.fromSource !== fromSource) throw new Error("Source transition does not match the publication source");
  const available = new Set(ids);
  for (const item of transition.packages) {
    if (!available.has(item.id)) throw new Error(`Transition package '${item.id}' is absent from the selected catalog`);
  }
}

export function expectedPackageSource(transition: SourceTransition | undefined, id: string, ordinarySource: string): string {
  return transition?.packages.some((entry) => entry.id === id) ? transition.toSource : ordinarySource;
}

export function assertTransitionPackage(transition: SourceTransition, candidate: Pick<InspectedUpdatePackage, "bytes" | "record">): void {
  const expected = transition.packages.find(({ id }) => id === candidate.record.id);
  if (!expected) return;
  if (expected.version !== candidate.record.version || expected.sha256 !== candidate.record.sha256 || sha256Hex(candidate.bytes) !== expected.sha256) {
    throw new Error(`Transition package '${expected.id}' does not match its pinned version and digest`);
  }
  // Never trust an injected inspector or a source manifest instead of the bytes
  // that the old source is actually going to publish.
  const { manifest } = preparePackageInstall(candidate.bytes);
  if (manifest.id !== expected.id || manifest.version !== expected.version || manifest.update_source !== transition.toSource) {
    throw new Error(`Transition archive '${expected.id}' must name the exact new update source ${transition.toSource}`);
  }
}

/** Read-only preflight. No authenticated fetch, raw gateway, or origin override. */
export async function verifyTransitionTarget(
  transition: SourceTransition,
  candidates: readonly InspectedUpdatePackage[],
  options: { fetch?: CertifiedFetch; progress?: (message: string) => void } = {},
): Promise<void> {
  const origin = updateSourceOrigin({ canisterId: transition.toSource });
  for (const expected of transition.packages) {
    const candidate = candidates.find(({ record }) => record.id === expected.id);
    if (!candidate) throw new Error(`Transition package '${expected.id}' is absent from the publication`);
    assertTransitionPackage(transition, candidate);
    if (candidate.hostedSource && candidate.hostedSource.url !== `${origin}${candidate.hostedSource.path}`) {
      throw new Error(`Transition Complete App Source for '${expected.id}' must use the new source's canonical certified origin`);
    }
    options.progress?.(`Verifying approved public transition ${expected.id} at ${transition.toSource}`);
    const request = { origin, ...(options.fetch ? { fetch: options.fetch } : {}) };
    const release = await readReleaseAsset({ ...request, path: candidate.releasePath });
    if (release.status !== "found" || release.record.id !== expected.id || release.record.version !== expected.version || release.record.sha256 !== expected.sha256 || release.record.size !== candidate.record.size) {
      throw new Error(`New source does not advertise the exact approved transition release '${expected.id}'`);
    }
    const archive = await readPackageAsset({ ...request, path: candidate.packagePath, expectedDigest: expected.sha256, expectedSize: candidate.record.size });
    if (archive.status !== "found") throw new Error(`Transition package '${expected.id}' is not publicly downloadable at the new source`);
    if (candidate.hostedSource) {
      const source = await readSourceAsset({ ...request, path: candidate.hostedSource.path, expectedDigest: candidate.hostedSource.sha256, expectedSize: candidate.hostedSource.size });
      if (source.status !== "found") throw new Error(`Transition Complete App Source for '${expected.id}' is unavailable at the new source`);
    }
  }
}

function record(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(`${label} must contain exactly ${expected.join(", ")}`);
  return value as Record<string, unknown>;
}
