// All rights reserved. See ../LICENSE.
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { UPLOAD_CHUNK_BYTES } from "../../update-source/src/model.ts";
import { type CertifiedFetch, updateSourceOrigin } from "../../update-source/src/http.ts";
import { createFirstPartyMediaEnvironment } from "./first-party-transport.ts";
import { MediaDetail, MediaDetailReply, type MediaAppValue, type MediaDetailValue } from "./media-wire.ts";
import { decode, encode, json, unwrap, type Target } from "./operator-wire.ts";
import { Listing, ListingReply, TRUSTED_FIRST_PARTY_PUBLISHER, UploadBegin, UploadChunk, UploadFinish, UploadReply, type Transport } from "./publisher.ts";
import { lockPublisherJournal, savePublisherJournal } from "./publisher-journal.ts";

const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const hex = (value: Uint8Array) => Buffer.from(value).toString("hex");
const unhex = (value: string) => Uint8Array.from(Buffer.from(value, "hex"));
const defaultCanister = "sj2r4-haaaa-aaaay-aadgq-cai";
const root = path.resolve(import.meta.dir, "../../..");
const mediaTypes: Record<string, string> = { ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };
type Outcome<T> = { ok: T } | { err: { code: string; message: string } };
type Upload = { requestId: string; appId: string; digest: Uint8Array; size: bigint; uploadedBytes: bigint; state: Record<string, null>; artifactId: [] | [bigint] };
export type MediaFile = { file: string; sha256: string; size: number; mediaType: string; bytes: Uint8Array };
export type MediaSelection = { appId: string; icon?: MediaFile; screenshots?: MediaFile[] };
export type MediaPlan = { canister: string; apps: MediaSelection[] };
type Step = { key: string; method: string; argsHex: string; replyHex?: string; attempts: number; outcome: "prepared" | "unknown" | "complete" | "rejected"; error?: string };
type Journal = { format: "marketplace-media-publish-v1"; fingerprint: string; requestId: string; canister: string; caller: string; baselines: Record<string, string>; steps: Step[] };
export type MediaOptions = { requestId: string; journal: string; execute?: boolean };
export type MediaEnvironment = { caller: Principal; target: Target; transport: Transport; feeVersion: bigint; fetch: CertifiedFetch };

function keys(value: unknown, allowed: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unknown ${label} field: ${key}`);
  return value as Record<string, unknown>;
}
async function imageFile(value: unknown, directory: string): Promise<MediaFile> {
  if (typeof value !== "string" || !value.trim()) throw new Error("Image paths must be nonempty strings.");
  const file = path.resolve(directory, value), mediaType = mediaTypes[path.extname(file).toLowerCase()];
  if (!mediaType) throw new Error(`Unsupported image extension: ${file}`);
  const bytes = Uint8Array.from(await readFile(file));
  if (!bytes.length) throw new Error(`Image is empty: ${file}`);
  return { file, mediaType, bytes, size: bytes.length, sha256: hash(bytes) };
}
export async function prepareMedia(filename: string, canister = defaultCanister): Promise<MediaPlan> {
  const file = path.resolve(filename), input = keys(JSON.parse(await readFile(file, "utf8")), ["format", "apps"], "media manifest");
  if (input.format !== 1 || !Array.isArray(input.apps) || !input.apps.length) throw new Error("Use media manifest format 1 with a nonempty apps array.");
  const p = Principal.fromText(canister);
  if (p.isAnonymous() || p.toText() !== canister) throw new Error("Select the canonical marketplace canister principal.");
  const apps: MediaSelection[] = [], seen = new Set<string>();
  for (const entry of input.apps) {
    const item = keys(entry, ["appId", "icon", "screenshots"], "media app");
    if (typeof item.appId !== "string" || !/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(item.appId)) throw new Error("Supply an appId for every media selection.");
    if (seen.has(item.appId)) throw new Error(`Repeated media app: ${item.appId}`);
    seen.add(item.appId);
    if (!("icon" in item) && !("screenshots" in item)) throw new Error(`Select an icon or screenshots for ${item.appId}.`);
    if ("screenshots" in item && !Array.isArray(item.screenshots)) throw new Error("screenshots must be an array of local image paths.");
    apps.push({ appId: item.appId,
      ...("icon" in item ? { icon: await imageFile(item.icon, path.dirname(file)) } : {}),
      ...("screenshots" in item ? { screenshots: await Promise.all((item.screenshots as unknown[]).map(value => imageFile(value, path.dirname(file)))) } : {}),
    });
  }
  return { canister, apps };
}
const files = (app: MediaSelection) => [...(app.icon ? [app.icon] : []), ...(app.screenshots ?? [])];
const describeFile = ({ file, sha256, size, mediaType }: MediaFile) => ({ file, sha256, size, mediaType, path: `/repo/v1/media/${sha256}` });
const imageUrl = (canister: string, file: MediaFile) => `${updateSourceOrigin({ canisterId: canister })}/repo/v1/media/${file.sha256}`;
export function mediaRequestId(plan: MediaPlan): string {
  return hash(json({ canister: plan.canister, caller: TRUSTED_FIRST_PARTY_PUBLISHER, apps: plan.apps.map(app => ({ appId: app.appId,
    icon: app.icon ? { sha256: app.icon.sha256, size: app.icon.size, mediaType: app.icon.mediaType } : null,
    screenshots: app.screenshots?.map(file => ({ sha256: file.sha256, size: file.size, mediaType: file.mediaType })) ?? null,
  })) }));
}
function preserved(detail: MediaDetailValue): string {
  const { appId, publisher, title, summary, description, priceUsdMicros, version, visible } = detail.app;
  return json({ appId, publisher, title, summary, description, priceUsdMicros, version, visible, candidate: detail.candidate });
}
function desiredMedia(app: MediaAppValue, selection: MediaSelection, canister: string): boolean {
  return (!selection.icon || app.iconUrl[0] === imageUrl(canister, selection.icon)) &&
    (selection.screenshots === undefined || json(app.screenshots) === json(selection.screenshots.map(file => imageUrl(canister, file))));
}
function checkUpload(value: Upload, appId: string, file: MediaFile, requestId: string, minimum: number) {
  if (value.requestId !== requestId || value.appId !== appId || hex(value.digest) !== file.sha256 || value.size !== BigInt(file.size) ||
      value.uploadedBytes < BigInt(minimum) || value.uploadedBytes > value.size || "aborted" in value.state) throw new Error("The image upload receipt differs from its exact request or bytes.");
}

export async function publishMedia(plan: MediaPlan, options: MediaOptions, environment: MediaEnvironment) {
  if (environment.caller.toText() !== TRUSTED_FIRST_PARTY_PUBLISHER || !environment.transport.callerPrincipal ||
      await environment.transport.callerPrincipal() !== TRUSTED_FIRST_PARTY_PUBLISHER || environment.target.canister !== plan.canister) throw new Error("Media publication requires the verified existing Blast ID 0 and selected marketplace.");
  if (!options.requestId.trim()) throw new Error("Retain a nonempty media publication request ID.");
  for (const app of plan.apps) for (const file of files(app)) if (file.bytes.length !== file.size || hash(file.bytes) !== file.sha256) throw new Error("Prepared image bytes changed; restore the reviewed files before resuming.");
  const fingerprint = hash(json({ requestId: options.requestId, selection: mediaRequestId(plan), network: environment.target.network }));
  const journalFile = path.resolve(options.journal);
  await mkdir(path.dirname(journalFile), { recursive: true });
  const release = await lockPublisherJournal(journalFile);
  try {
    let journal: Journal;
    try {
      journal = JSON.parse(await readFile(journalFile, "utf8"));
      if (journal.format !== "marketplace-media-publish-v1" || journal.fingerprint !== fingerprint) throw new Error("This journal belongs to different images, selection, request ID or network. Restore its exact inputs to resume.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      journal = { format: "marketplace-media-publish-v1", fingerprint, requestId: options.requestId, canister: plan.canister, caller: TRUSTED_FIRST_PARTY_PUBLISHER, baselines: {}, steps: [] };
    }
    const save = () => savePublisherJournal(journalFile, journal);
    const readApp = async (appId: string): Promise<MediaDetailValue> => unwrap(decode<Outcome<MediaDetailValue>>(MediaDetailReply,
      await environment.transport.query(environment.target, "app_detail", encode(IDL.Text, appId))));
    const current = new Map<string, MediaDetailValue>();
    // Inspect the whole selection before the first upload. A typo or another
    // publisher's app must not leave half of a reviewed batch uploaded.
    for (const selection of plan.apps) {
      const detail = await readApp(selection.appId);
      if (detail.app.appId !== selection.appId || detail.app.publisher.toText() !== TRUSTED_FIRST_PARTY_PUBLISHER) throw new Error(`Listing ${selection.appId} does not belong to the verified first-party publisher.`);
      if (!journal.baselines[selection.appId]) journal.baselines[selection.appId] = hex(encode(MediaDetail, detail));
      const baseline = decode<MediaDetailValue>(MediaDetail, unhex(journal.baselines[selection.appId]!));
      if (preserved(detail) !== preserved(baseline)) throw new Error(`Listing metadata or release changed for ${selection.appId}. No metadata was overwritten; review a new media request.`);
      current.set(selection.appId, detail);
    }
    await save();
    let updates = 0;
    async function step<T>(key: string, method: string, inputType: IDL.Type, input: object, outputType: IDL.Type): Promise<T> {
      let saved = journal.steps.find(step => step.key === key);
      if (saved?.outcome === "complete" && saved.replyHex) return unwrap(decode<Outcome<T>>(outputType, unhex(saved.replyHex)));
      if (saved?.method !== undefined && saved.method !== method) throw new Error("Saved media step differs from the original method.");
      if (!saved) { saved = { key, method, argsHex: hex(encode(inputType, { ...input, feeVersion: environment.feeVersion })), attempts: 0, outcome: "prepared" }; journal.steps.push(saved); }
      saved.attempts++; saved.outcome = "unknown"; delete saved.error;
      await save();
      let reply: Uint8Array;
      try { updates++; reply = await environment.transport.update(environment.target, TRUSTED_FIRST_PARTY_PUBLISHER, method, unhex(saved.argsHex), 0n); }
      catch (error) {
        saved.error = error instanceof Error ? error.message : String(error); await save();
        throw new Error(`${method} reply unavailable. Resume the same manifest, request ID and journal; do not replace image bytes. ${saved.error}`);
      }
      saved.replyHex = hex(reply); await save();
      const outcome = decode<Outcome<T>>(outputType, reply);
      if ("err" in outcome) { saved.outcome = "rejected"; saved.error = `${outcome.err.code}: ${outcome.err.message}`; await save(); throw new Error(saved.error); }
      saved.outcome = "complete"; await save(); return outcome.ok;
    }
    const results = [];
    for (const selection of plan.apps) {
      const baseline = decode<MediaDetailValue>(MediaDetail, unhex(journal.baselines[selection.appId]!));
      const before = current.get(selection.appId)!;
      const beforeUpdates = updates;
      const needsChange = !desiredMedia(before.app, selection, plan.canister);
      const listingKey = `${selection.appId}:listing`;
      const savedListing = journal.steps.find(step => step.key === listingKey);
      if (needsChange && !savedListing && before.app.revision !== baseline.app.revision) throw new Error(`Listing revision changed for ${selection.appId}. Review its new media before replacing it.`);
      if (savedListing?.outcome === "complete" && needsChange) throw new Error(`Published media changed for ${selection.appId}; the saved publication will not overwrite a later edit.`);
      if (options.execute && (needsChange || savedListing?.outcome === "unknown")) {
        const artifacts = new Map<string, bigint>();
        if (before.app.iconUrl[0] && before.app.iconArtifact[0] !== undefined) artifacts.set(before.app.iconUrl[0], before.app.iconArtifact[0]);
        before.app.screenshots.forEach((url, i) => { if (before.app.screenshotArtifacts[i] !== undefined) artifacts.set(url, before.app.screenshotArtifacts[i]!); });
        for (const file of files(selection)) {
          const url = imageUrl(plan.canister, file);
          if (artifacts.has(url)) continue;
          const requestId = `media:${options.requestId}:${selection.appId}:${file.sha256}`, key = `${selection.appId}:image:${file.sha256}`;
          const begun = await step<Upload>(`${key}:begin`, "upload_begin", UploadBegin, { requestId, appId: selection.appId, digest: unhex(file.sha256), size: BigInt(file.size), mediaType: file.mediaType, purpose: { image: null } }, UploadReply);
          checkUpload(begun, selection.appId, file, requestId, 0);
          for (let offset = 0; offset < file.size; offset += UPLOAD_CHUNK_BYTES) {
            const bytes = file.bytes.slice(offset, offset + UPLOAD_CHUNK_BYTES);
            const chunk = await step<Upload>(`${key}:chunk:${offset}`, "upload_chunk", UploadChunk, { requestId, offset: BigInt(offset), bytes }, UploadReply);
            checkUpload(chunk, selection.appId, file, requestId, offset + bytes.length);
          }
          const finished = await step<Upload>(`${key}:finish`, "upload_finish", UploadFinish, { requestId }, UploadReply);
          checkUpload(finished, selection.appId, file, requestId, file.size);
          if (!("attached" in finished.state) || finished.artifactId[0] === undefined) throw new Error("Image upload has no completed artifact receipt.");
          artifacts.set(url, finished.artifactId[0]);
        }
        const fresh = await readApp(selection.appId);
        if (preserved(fresh) !== preserved(baseline)) throw new Error(`Listing metadata or release changed for ${selection.appId}; uploaded images were retained, and its metadata was not overwritten.`);
        const app = baseline.app;
        await step(`${selection.appId}:listing`, "listing_save", Listing, {
          appId: app.appId, title: app.title, summary: app.summary, description: app.description, priceUsdMicros: app.priceUsdMicros,
          iconArtifact: selection.icon ? [artifacts.get(imageUrl(plan.canister, selection.icon))!] : app.iconArtifact,
          screenshots: selection.screenshots === undefined ? app.screenshotArtifacts : selection.screenshots.map(file => artifacts.get(imageUrl(plan.canister, file))!),
          expectedRevision: [app.revision],
        }, ListingReply);
      }
      const after = options.execute ? await readApp(selection.appId) : before;
      if (options.execute) {
        if (preserved(after) !== preserved(baseline) || !desiredMedia(after.app, selection, plan.canister)) throw new Error(`Media postflight for ${selection.appId} did not match the reviewed images and preserved listing/release.`);
        for (const file of new Map(files(selection).map(file => [file.sha256, file])).values()) {
          const response = await environment.fetch(imageUrl(plan.canister, file), { method: "GET", credentials: "omit", redirect: "error", cache: "no-store", headers: { Accept: file.mediaType }, signal: AbortSignal.timeout(30_000) });
          if (response.status !== 200 || response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== file.mediaType) throw new Error(`Published image ${file.sha256} did not return its expected media type and HTTP status.`);
          const downloaded = new Uint8Array(await response.arrayBuffer());
          if (downloaded.length !== file.size || hash(downloaded) !== file.sha256) throw new Error(`Published image ${file.sha256} differs from the exact reviewed bytes.`);
        }
      }
      results.push({ appId: selection.appId, status: options.execute ? updates > beforeUpdates ? "updated" : "unchanged" : needsChange ? "change_needed" : "unchanged",
        revisionBefore: before.app.revision, revisionAfter: after.app.revision,
        preserved: { publisher: after.app.publisher, title: after.app.title, summary: after.app.summary, description: after.app.description, priceUsdMicros: after.app.priceUsdMicros, version: after.app.version, visible: after.app.visible, candidate: after.candidate },
        icon: selection.icon ? describeFile(selection.icon) : null, screenshots: selection.screenshots?.map(describeFile) ?? null,
        iconUrl: after.app.iconUrl[0] ?? null, iconArtifact: after.app.iconArtifact[0] ?? null, screenshotUrls: after.app.screenshots, screenshotArtifacts: Array.from(after.app.screenshotArtifacts),
      });
    }
    return { format: "marketplace-media-publication-v1", status: options.execute ? "publication_verified" : "review_only", canister: plan.canister, caller: TRUSTED_FIRST_PARTY_PUBLISHER,
      requestId: options.requestId, fingerprint, journal: journalFile, cycles: "0", updateCalls: updates, packagesChanged: false, results };
  } finally { await release(); }
}

const HELP = `Publish existing first-party app icons and screenshots without changing packages.

bun support/marketplace/scripts/publish-media.ts --manifest FILE [--canister PRINCIPAL] [--host URL] [--root-key FILE] [--request ID] [--journal FILE] [--execute]

Manifest: {"format":1,"apps":[{"appId":"wallet","icon":"icon.svg","screenshots":["overview.png"]}]}
Paths resolve relative to the manifest. Omitted icon/screenshots preserve current
media; screenshots:[] explicitly clears screenshots. Other listing fields cannot
be supplied. The existing Blast ID 0 must own every selected listing.

Without --execute, reads listings and saves a local exact-byte review journal.
--execute uploads images and edits listing media with zero attached cycles. No
package is rebuilt, submitted, audited, upgraded, or republished. The listing's
metadata, owner and release are checked before and after publication. Images
are read back through certified HTTP and checked against their exact digests.

Reuse the same manifest, image bytes, request ID and journal after interruption.
Repeat --execute after success: every result must be unchanged, updateCalls:0.
Default source: ${defaultCanister}; host: https://icp-api.io.
`;
export async function main(argv = process.argv.slice(2), dependencies: { environment?: typeof createFirstPartyMediaEnvironment; write?: (value: string) => void } = {}) {
  const { values } = parseArgs({ args: argv, options: { manifest: { type: "string" }, canister: { type: "string" }, host: { type: "string" }, "root-key": { type: "string" }, request: { type: "string" }, journal: { type: "string" }, execute: { type: "boolean" }, help: { type: "boolean" } } });
  const write = dependencies.write ?? ((value: string) => { process.stdout.write(value); });
  if (values.help) { write(HELP); return; }
  if (!values.manifest) throw new Error("Supply --manifest with the selected app images.");
  const plan = await prepareMedia(values.manifest, values.canister ?? defaultCanister), requestId = values.request ?? mediaRequestId(plan);
  const environment = await (dependencies.environment ?? createFirstPartyMediaEnvironment)({ canister: plan.canister, host: values.host ?? "https://icp-api.io", ...(values["root-key"] ? { rootKeyFile: values["root-key"] } : {}) },
    new Map(plan.apps.flatMap(app => files(app).map(file => [`/repo/v1/media/${file.sha256}`, file.size] as const))));
  write(json(await publishMedia(plan, { requestId, journal: values.journal ?? path.join(root, ".neutron/marketplace-media", `${mediaRequestId(plan)}.json`), execute: values.execute === true }, environment)));
}
if (import.meta.main) main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
