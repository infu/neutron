// All rights reserved. See ../LICENSE.
import { IDL } from "@dfinity/candid";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { MediaDetailReply, type MediaDetailValue } from "./media-wire.ts";
import { call, decode, encode, natural, result, unwrap, type Run, type Target } from "./operator-wire.ts";

const tag = IDL.Record({ id: IDL.Text, name: IDL.Text });
export const StorefrontConfig = IDL.Record({ tags: IDL.Vec(tag), featured: IDL.Vec(IDL.Text), revision: IDL.Nat });
export const Presentation = IDL.Record({ title: IDL.Text, subtitle: IDL.Text, tags: IDL.Vec(IDL.Text), coverArtifact: IDL.Opt(IDL.Nat64), revision: IDL.Nat });
export const StorefrontInput = IDL.Record({ tags: IDL.Vec(tag), featured: IDL.Vec(IDL.Text), expectedRevision: IDL.Nat });
export const PresentationInput = IDL.Record({ appId: IDL.Text, title: IDL.Text, subtitle: IDL.Text, tags: IDL.Vec(IDL.Text), coverArtifact: IDL.Opt(IDL.Nat64), expectedRevision: IDL.Nat });
type Config = { tags: { id: string; name: string }[]; featured: string[]; revision: bigint };
type Saved = { tags: string[]; revision: bigint };
export async function readStorefront(target: Target, run?: Run): Promise<Config> {
  const args = IDL.Record({ mode: IDL.Variant({ stable: IDL.Null, beta: IDL.Null }), search: IDL.Text, tag: IDL.Opt(IDL.Text) });
  const response = await call(target, "storefront_query", encode(args, { mode: { stable: null }, search: "", tag: [] }), true, run);
  return unwrap(decode<{ ok: { config: Config }; err: never }>(result(IDL.Record({ config: StorefrontConfig })), response)).config;
}
export async function readPresentation(target: Target, appId: string, run?: Run): Promise<Saved | null> {
  const response = await call(target, "admin_storefront_app_get", encode(IDL.Text, appId), true, run);
  return unwrap(decode<{ ok: Saved[]; err: never }>(result(IDL.Opt(Presentation)), response))[0] ?? null;
}
export function editInput(value: any, app: boolean) {
  const input = { ...value, expectedRevision: natural(String(value.expectedRevision), "expectedRevision"), ...(app ? { coverArtifact: value.coverArtifact === null ? [] : [natural(String(value.coverArtifact), "coverArtifact")] } : {}) };
  // Use the actual wire contract to reject incomplete or mistyped reviews.
  encode(app ? PresentationInput : StorefrontInput, input);
  return input;
}
/** Query-only preparation. Review the emitted fixed revisions and image IDs;
 * execution uses these same files and cannot overwrite an intervening edit. */
export async function prepareStorefront(filename: string, target: Target, run?: Run) {
  const file = path.resolve(filename), manifest = JSON.parse(await readFile(file, "utf8"));
  if (manifest.format !== 1 || !Array.isArray(manifest.apps) || !Array.isArray(manifest.tags) || !Array.isArray(manifest.featured)) throw Error("Use storefront manifest format 1 with tags, featured and apps arrays.");
  const current = await readStorefront(target, run);
  const config = { tags: manifest.tags, featured: manifest.featured, expectedRevision: String(current.revision) };
  editInput(config, false);
  const known = new Set(manifest.tags.map((tag: { id: string }) => tag.id));
  const seen = new Set<string>(), apps = [];
  for (const app of manifest.apps) {
    if (typeof app.appId !== "string" || !/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(app.appId) || seen.has(app.appId)) throw Error("Use distinct existing app IDs in the storefront manifest.");
    seen.add(app.appId);
    const detail = unwrap(decode<{ ok: MediaDetailValue; err: never }>(MediaDetailReply, await call(target, "app_detail", encode(IDL.Text, app.appId), true, run)));
    const previous = await readPresentation(target, app.appId, run);
    let coverArtifact: string | null = null;
    if (app.cover !== undefined) {
      if (typeof app.cover !== "string") throw Error("Cover must be a local image path.");
      const bytes = await readFile(path.resolve(path.dirname(file), app.cover));
      const hash = createHash("sha256").update(bytes).digest("hex");
      const index = detail.app.screenshots.findIndex(url => new URL(url).pathname === `/repo/v1/media/${hash}`);
      if (index < 0 || detail.app.screenshotArtifacts[index] === undefined) throw Error(`Publish and verify ${app.appId}'s selected cover through the existing media workflow before preparing storefront metadata.`);
      coverArtifact = String(detail.app.screenshotArtifacts[index]);
    }
    // Config removal prunes tag assignments atomically before app edits.
    const pruned = previous?.tags.some(id => !known.has(id)) ? 1n : 0n;
    const input = { appId: app.appId, title: app.title, subtitle: app.subtitle, tags: app.tags, coverArtifact, expectedRevision: String((previous?.revision ?? 0n) + pruned) };
    editInput(input, true);
    if (app.tags.some((id: string) => !known.has(id))) throw Error(`Unknown tag in ${app.appId}.`);
    apps.push(input);
  }
  return { config, apps };
}
