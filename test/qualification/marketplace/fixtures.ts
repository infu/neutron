import assert from "node:assert/strict";
import { fixtureArchive, sha256 } from "../../../support/marketplace/test/lifecycle/archives.ts";

export type InstallFixture = { id: string; title: string; version: number; sha256: string; bytes: number };

/** Publish two real, free packages to the owned disposable protocol. These
 * packages have independent managed counter roots and embedded legal/source
 * envelopes; neither contains production state or needs a Wallet payment. */
export async function publishInstallFixtures(
  actor: Record<string, (...args: any[]) => Promise<any>>,
  source: string,
): Promise<InstallFixture[]> {
  async function call(name: string, request: unknown) {
    const result = await actor[name]!(request);
    assert.ok(result && "ok" in result, `Fixture ${name} failed: ${JSON.stringify(result, (_key, value) => typeof value === "bigint" ? String(value) : value)}`);
    return result.ok;
  }
  const fixtures: InstallFixture[] = [];
  for (const [id, title] of [["paid_alpha", "Fixture Alpha"], ["paid_beta", "Fixture Beta"]] as const) {
    const version = 100, requestId = `browser-free-${id}-${version}`;
    await call("listing_save", { appId: id, title, summary: "Disposable free install fixture", description: "Local browser qualification only. A real package with its own managed counter.", priceUsdMicros: 0n, iconArtifact: [], screenshots: [], expectedRevision: [], feeVersion: 1n });
    const pkg = await fixtureArchive(id, version, source);
    const digest = Uint8Array.from(Buffer.from(sha256(pkg.archive), "hex"));
    await call("upload_begin", { requestId, appId: id, digest, size: BigInt(pkg.archive.length), mediaType: "application/octet-stream", purpose: { package: null }, feeVersion: 1n });
    for (let offset = 0; offset < pkg.archive.length; offset += 64_000) await call("upload_chunk", { requestId, offset: BigInt(offset), bytes: pkg.archive.slice(offset, offset + 64_000), feeVersion: 1n });
    const uploaded = await call("upload_finish", { requestId, feeVersion: 1n });
    const candidate = await call("candidate_submit", { requestId, appId: id, version: BigInt(version), artifactId: uploaded.artifactId[0], sourceArtifactId: [], dependencies: [], feeVersion: 1n });
    await call("trusted_publish_batch", { requestId: `publish-${requestId}`, candidates: [{ candidateId: candidate.id, expectedDigest: candidate.digest, expectedSourceDigest: candidate.sourceDigest }], analysis: "Disposable fixture package source inspected for the installed browser regression." });
    fixtures.push({ id, title, version, sha256: sha256(pkg.archive), bytes: pkg.archive.length });
  }
  await call("rates_refresh", { feeVersion: 1n });
  return fixtures;
}
