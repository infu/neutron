// All rights reserved. See ../LICENSE.
// Shared evidence checks for archive publication and metadata-only promotion.
import { REPOSITORY_LIMITS } from "neutron-tools/src/repository.ts";
import { parseRepositoryChannelsDescriptor, repositoryChannelsPath } from "neutron-tools/src/release_channels.ts";
import { RELEASE_CACHE_CONTROL, sha256Hex } from "../../update-source/src/model.ts";
import { assertGatewayCertificationV2, readCertifiedAsset, type CertifiedFetch } from "../../update-source/src/http.ts";

export const TRUSTED_PUBLISHER_CALLER = "y7t6r-gtsqz-45ogs-2k3gk-l6hic-2h7wm-zosg6-uldzf-l4ams-2jaky-wqe";
export type PublicationEvidenceOptions = { fetch?: CertifiedFetch };

export async function verifyChannelSupport(canister: string, options: PublicationEvidenceOptions, origin: string): Promise<void> {
  const asset = await readCertifiedAsset({ origin, path: repositoryChannelsPath(), maximumBytes: REPOSITORY_LIMITS.releaseJsonBytes, expectedContentType: "application/json", expectedCacheControl: RELEASE_CACHE_CONTROL, accept: "application/json", cache: "no-cache", ...(options.fetch ? { fetch: options.fetch } : {}) });
  if (asset.status !== "found") throw new Error("The marketplace has no certified release-channel descriptor. Deploy channel support before publishing beta releases.");
  const descriptor = parseRepositoryChannelsDescriptor(asset.bytes);
  if (descriptor.source !== canister) throw new Error("Certified release-channel descriptor identifies a different source.");
  if (asset.etag.replace(/^W\//, "").replace(/^\"|\"$/g, "").toLowerCase() !== sha256Hex(asset.bytes)) throw new Error("Certified release-channel descriptor ETag differs from its SHA-256.");
}

/** Preserve authenticated private cache headers. The old public-source reader
 * requires immutable public caching, which a paid artifact must never use. */
export async function verifyArtifact(input: { origin: string; path: string; digest: string; size: number; mediaType: string }, options: PublicationEvidenceOptions) {
  const response = await (options.fetch ?? fetch)(`${input.origin}${input.path}`, { method: "GET", credentials: "omit", redirect: "error", cache: "no-store", headers: { Accept: input.mediaType, "Accept-Encoding": "identity" }, signal: AbortSignal.timeout(30_000) });
  if (response.url && new URL(response.url).origin !== input.origin) throw new Error("Certified artifact returned from a different origin.");
  assertGatewayCertificationV2(response, input.path);
  if (response.status !== 200) throw new Error(`Certified artifact '${input.path}' returned HTTP ${response.status}.`);
  if (response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== input.mediaType) throw new Error("Certified artifact has an unexpected media type.");
  const cache = new Set((response.headers.get("cache-control") ?? "").toLowerCase().split(",").map(value => value.trim()));
  if (!(cache.has("private") && cache.has("no-store")) && !(cache.has("public") && cache.has("immutable"))) throw new Error("Certified artifact has an unexpected cache policy.");
  if (response.headers.get("content-encoding") && response.headers.get("content-encoding") !== "identity") throw new Error("Certified artifact is not identity encoded.");
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        total += value.length;
        if (total > input.size) { await reader.cancel(); throw new Error("Certified artifact exceeds its expected size."); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
  }
  const body = Uint8Array.from(Buffer.concat(chunks));
  if (total !== input.size || sha256Hex(body) !== input.digest) throw new Error("Certified artifact bytes differ from their expected size or SHA-256.");
  if (response.headers.get("etag")?.replace(/^W\//, "").replace(/^\"|\"$/g, "").toLowerCase() !== input.digest) throw new Error("Certified artifact ETag differs from its SHA-256.");
}
