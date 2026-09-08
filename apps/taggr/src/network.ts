// Host derivation shared by the tile and the resident background.
//
// Kept free of `@dfinity/agent` so the tile can build image URLs without
// pulling the canister client into its bundle.

/**
 * True when this surface is served by a local replica rather than the IC.
 * The frame's own host carries the deployment, so nothing needs configuring.
 */
export const isLocalHost = (hostname = globalThis.location?.hostname ?? ""): boolean =>
  hostname === "localhost" ||
  hostname.endsWith(".localhost") ||
  hostname === "127.0.0.1" ||
  hostname.endsWith(".127.0.0.1");

/**
 * Taggr keeps post attachments in per-user bucket canisters and serves them as
 * raw HTTP byte ranges, exactly as its own frontend does in
 * `common.tsx#bucketImageUrl`:
 *
 *   https://<bucket>.raw.icp0.io/image?offset=<offset>&len=<len>
 *
 * These are ordinary image URLs, so a tile renders them with `<img>` and needs
 * no canister call. The app frame's CSP sets no `default-src`, so `img-src` is
 * unconstrained.
 */
export const bucketImageUrl = (
  input: { bucket: string; offset: number; len: number },
  location = globalThis.location,
): string => {
  const host = location?.hostname ?? "";
  if (isLocalHost(host)) {
    const port = location?.port ? `:${location.port}` : "";
    const protocol = location?.protocol ?? "http:";
    return `${protocol}//${input.bucket}.raw.localhost${port}/image?offset=${input.offset}&len=${input.len}`;
  }
  return `https://${input.bucket}.raw.icp0.io/image?offset=${input.offset}&len=${input.len}`;
};

/** Taggr stores a realm logo as bare base64 PNG bytes. */
export const realmLogoUrl = (logo: string): string | null => {
  const trimmed = logo.trim();
  if (trimmed.length === 0) return null;
  // Reject anything that is not plain base64 so a malformed record cannot turn
  // into some other URL scheme in an `<img src>`.
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) return null;
  return `data:image/png;base64,${trimmed}`;
};

/**
 * Taggr has no user avatars — the `User` record carries no image field and its
 * own client renders handles alone. This derives a stable monogram colour from
 * the handle so a dense feed still has a visual anchor. It is a local display
 * affordance, not data from the network.
 */
export const handleHue = (handle: string): number => {
  let hash = 0;
  for (let index = 0; index < handle.length; index += 1) {
    hash = (hash * 31 + handle.charCodeAt(index)) % 360;
  }
  return hash;
};

export const handleMonogram = (handle: string): string =>
  (handle.trim()[0] ?? "?").toUpperCase();
