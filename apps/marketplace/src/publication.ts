import { decodeNeutronPackageArchive } from "neutron-compiler/src/package_decoder.js";
import { normalizeManifestDependencies, type NeutronManifest } from "neutron-tools/src/schema.js";
import { NEUTRON_APP_SOURCE_MEDIA_TYPE } from "neutron-tools/src/package_record.js";
import { randomId } from "./client.ts";
import type { PublicationInput } from "./view-types.ts";
import { validateListingText } from "./listing-text.ts";

export type ArtifactInput = { requestId: string; role: "package" | "source" | "icon" | "screenshot"; name: string; size: number; digest: number[]; mediaType: string; purpose: "package" | "source" | "image" };
export type PublicationPlan = { requestId: string; appId: string; title: string; summary: string; description: string; priceUsdMicros: string; artifacts: ArtifactInput[]; version: string | null; dependencies: Array<{ appId: string; minVersion: string }> };
export const UPLOAD_CHUNK_BYTES = 48 * 1024; // Leaves room for base64 and message metadata under the existing bus envelope.
export const NEUTRON_PACKAGE_MEDIA_TYPE = "application/vnd.neutron.package";
export async function preparePublication(input: PublicationInput): Promise<PublicationPlan> {
  validateListingText(input);
  if (!/^[a-z][a-z0-9_-]*$/.test(input.appId)) throw new Error("Enter the package's application ID.");
  const price = BigInt(input.priceUsdMicros);
  if (price !== 0n && (price < 1_000_000n || price > 50_000_000n)) throw new Error("Apps must be free or priced from $1 to $50.");
  const artifacts: ArtifactInput[] = [];
  let version: string | null = null;
  let dependencies: PublicationPlan["dependencies"] = [];
  const files: Array<{ role: ArtifactInput["role"]; file: File }> = [
    ...(input.packageFile ? [{ role: "package" as const, file: input.packageFile }] : []),
    ...(input.sourceFile ? [{ role: "source" as const, file: input.sourceFile }] : []),
    ...(input.iconFile ? [{ role: "icon" as const, file: input.iconFile }] : []),
    ...input.screenshotFiles.map(file => ({ role: "screenshot" as const, file })),
  ];
  for (const { role, file } of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (role === "package") {
      const archive = decodeNeutronPackageArchive(bytes);
      if (!archive["neutron.json"]) throw new Error("The archive contains no Neutron package manifest.");
      const manifest = JSON.parse(new TextDecoder().decode(archive["neutron.json"])) as Record<string, unknown>;
      if (manifest.id !== input.appId) throw new Error("The selected package belongs to a different application ID.");
      if (!Number.isSafeInteger(manifest.version) || Number(manifest.version) < 1) throw new Error("The selected package has no valid release version.");
      version = String(manifest.version);
      dependencies = Object.values(normalizeManifestDependencies(manifest as Pick<NeutronManifest, "id" | "dependencies">)).map(d => ({ appId: d.app, minVersion: String(d.min_version) }));
    }
    const image = role === "icon" || role === "screenshot";
    if (image && !["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"].includes(file.type)) throw new Error("Choose a supported image file for the icon or screenshots.");
    const mediaType = role === "package" ? NEUTRON_PACKAGE_MEDIA_TYPE : role === "source" ? NEUTRON_APP_SOURCE_MEDIA_TYPE : file.type;
    artifacts.push({ requestId: randomId(), role, name: file.name, size: file.size, digest: [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))], mediaType, purpose: image ? "image" : role as "package" | "source" });
  }
  if (input.sourceFile && !input.packageFile) throw new Error("Upload the offered source together with its exact package release.");
  return { requestId: randomId(), appId: input.appId, title: input.title, summary: input.summary, description: input.description, priceUsdMicros: String(price), artifacts, version, dependencies };
}
export function publicationFiles(input: PublicationInput): File[] { return [...(input.packageFile ? [input.packageFile] : []), ...(input.sourceFile ? [input.sourceFile] : []), ...(input.iconFile ? [input.iconFile] : []), ...input.screenshotFiles]; }
export function base64(bytes: Uint8Array): string { let text = ""; for (const byte of bytes) text += String.fromCharCode(byte); return btoa(text); }
export function unbase64(value: string): Uint8Array { return Uint8Array.from(atob(value), char => char.charCodeAt(0)); }
