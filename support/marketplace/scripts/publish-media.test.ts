// All rights reserved. See ../LICENSE.
import { expect, test } from "bun:test";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { decode, encode } from "./operator-wire.ts";
import { MediaDetailReply, type MediaDetailValue } from "./media-wire.ts";
import { Listing, ListingReply, TRUSTED_FIRST_PARTY_PUBLISHER, UploadBegin, UploadChunk, UploadFinish, UploadReply } from "./publisher.ts";
import { mediaRequestId, prepareMedia, publishMedia, type MediaEnvironment, type MediaPlan } from "./publish-media.ts";

const caller = Principal.fromText(TRUSTED_FIRST_PARTY_PUBLISHER), canister = "sj2r4-haaaa-aaaay-aadgq-cai";
const hex = (value: Uint8Array) => Buffer.from(value).toString("hex");
const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
type Upload = { requestId: string; appId: string; digest: Uint8Array; size: bigint; uploadedBytes: bigint; state: Record<string, null>; artifactId: bigint[]; mediaType: string; bytes: Uint8Array };
async function fixture(run: (f: { directory: string; manifest: string; plan: MediaPlan; options: { requestId: string; journal: string; execute: true } }) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), "marketplace-media-test-"));
  try {
    await writeFile(path.join(directory, "icon.svg"), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16"/></svg>');
    await writeFile(path.join(directory, "screen.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]));
    const manifest = path.join(directory, "media.json");
    await writeFile(manifest, JSON.stringify({ format: 1, apps: [{ appId: "alpha", icon: "icon.svg", screenshots: ["screen.png"] }] }));
    const plan = await prepareMedia(manifest, canister);
    await run({ directory, manifest, plan, options: { requestId: mediaRequestId(plan), journal: path.join(directory, "journal.json"), execute: true } });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
function mock() {
  let app: MediaDetailValue = { app: { appId: "alpha", publisher: caller, title: "Existing title", summary: "Original summary", description: "Original detailed description", priceUsdMicros: 7_000_000n, revision: 6n, version: [123n], visible: true, iconArtifact: [], iconUrl: [], screenshots: [], screenshotArtifacts: [] },
    candidate: [{ id: 14n, appId: "alpha", version: 123n, publisher: caller, requestId: "package-123", listingRevision: 1n, artifactId: 8n, sourceArtifactId: [9n], digest: new Uint8Array(32).fill(7), sourceDigest: [new Uint8Array(32).fill(8)], dependencies: [], state: { approved: null }, published: true, createdAtNs: 1n, updatedAtNs: 2n }] };
  const uploads = new Map<string, Upload>(), assets = new Map<bigint, Upload>();
  const updates: { method: string; args: string; cycles: bigint }[] = [], queries: string[] = [];
  let loseMethod: string | undefined, corruptImage = false, callback: (() => void) | undefined;
  const url = (id: bigint) => `https://${canister}.icp0.io/repo/v1/media/${hex(assets.get(id)!.digest)}`;
  const ok = (type: IDL.Type, value: unknown) => encode(type, { ok: value });
  const environment: MediaEnvironment = {
    caller, target: { canister, identity: "blast:0", network: "https://icp-api.io" }, feeVersion: 1n,
    transport: {
      callerPrincipal: async () => caller.toText(),
      query: async (_target, method, bytes) => {
        queries.push(method); if (method !== "app_detail" || decode(IDL.Text, bytes) !== app.app.appId) throw new Error("Unexpected query");
        return ok(MediaDetailReply, app);
      },
      update: async (_target, requestedCaller, method, bytes, cycles) => {
        expect(requestedCaller).toBe(caller.toText()); updates.push({ method, args: hex(bytes), cycles }); let response: Uint8Array;
        if (method === "upload_begin") {
          const v = decode<any>(UploadBegin, bytes); let saved = uploads.get(v.requestId);
          if (!saved) { saved = { ...v, bytes: new Uint8Array(), uploadedBytes: 0n, artifactId: [], state: { uploading: null } }; uploads.set(v.requestId, saved!); }
          else expect([saved.appId, hex(saved.digest), saved.size, saved.mediaType]).toEqual([v.appId, hex(v.digest), v.size, v.mediaType]);
          response = ok(UploadReply, saved);
        } else if (method === "upload_chunk") {
          const v = decode<any>(UploadChunk, bytes), saved = uploads.get(v.requestId)!;
          if (v.offset === saved.uploadedBytes) { saved.bytes = Uint8Array.from(Buffer.concat([saved.bytes, v.bytes])); saved.uploadedBytes += BigInt(v.bytes.length); }
          else expect(hex(saved.bytes.slice(Number(v.offset), Number(v.offset) + v.bytes.length))).toBe(hex(v.bytes));
          response = ok(UploadReply, saved);
        } else if (method === "upload_finish") {
          const v = decode<any>(UploadFinish, bytes), saved = uploads.get(v.requestId)!;
          expect(digest(saved.bytes)).toBe(hex(saved.digest));
          if (!saved.artifactId.length) { saved.artifactId = [100n + BigInt(assets.size)]; saved.state = { attached: null }; assets.set(saved.artifactId[0]!, saved); }
          response = ok(UploadReply, saved); callback?.(); callback = undefined;
        } else if (method === "listing_save") {
          const v = decode<any>(Listing, bytes);
          const same = [app.app.title, app.app.summary, app.app.description, app.app.priceUsdMicros, app.app.iconArtifact, app.app.screenshotArtifacts];
          const requested = [v.title, v.summary, v.description, v.priceUsdMicros, v.iconArtifact, Array.from(v.screenshots)];
          if (JSON.stringify(same, (_k, value) => typeof value === "bigint" ? String(value) : value) !== JSON.stringify(requested, (_k, value) => typeof value === "bigint" ? String(value) : value)) {
            if (v.expectedRevision[0] !== app.app.revision) return encode(ListingReply, { err: { code: "listing", message: "The listing changed." } });
            app = { ...app, app: { ...app.app, title: v.title, summary: v.summary, description: v.description, priceUsdMicros: v.priceUsdMicros, revision: app.app.revision + 1n, iconArtifact: v.iconArtifact, iconUrl: v.iconArtifact.map(url), screenshotArtifacts: Array.from(v.screenshots), screenshots: Array.from(v.screenshots, url) } };
          }
          response = ok(ListingReply, { appId: app.app.appId, revision: app.app.revision });
        } else throw new Error(`Unexpected mutation: ${method}`);
        if (method === loseMethod) { loseMethod = undefined; throw new Error("Injected lost response after commit"); }
        return response;
      },
    },
    // The production environment performs v2 HTTP certification before this
    // fetch contract. These tests isolate byte/type verification and retries.
    fetch: (async input => {
      const selected = [...assets.values()].find(asset => String(input).endsWith(hex(asset.digest)));
      return selected ? new Response(corruptImage ? new Uint8Array([0]) : selected.bytes, { status: 200, headers: { "Content-Type": selected.mediaType } }) : new Response(null, { status: 404 });
    }) as typeof fetch,
  };
  return { environment, updates, queries, uploads, assets, app: () => app, changeApp: (next: MediaDetailValue) => { app = next; }, lose: (method: string) => { loseMethod = method; }, corrupt: () => { corruptImage = true; }, afterFinish: (fn: () => void) => { callback = fn; } };
}

test("review is query-only and execution changes only media, with exact no-op repeat", () => fixture(async f => {
  const m = mock(), baseline = m.app();
  const reviewed = await publishMedia(f.plan, { ...f.options, execute: false }, m.environment);
  expect(reviewed.status).toBe("review_only"); expect(reviewed.results[0]?.status).toBe("change_needed"); expect(m.updates).toEqual([]);
  const published = await publishMedia(f.plan, f.options, m.environment);
  expect(published.status).toBe("publication_verified"); expect(published.packagesChanged).toBe(false); expect(published.cycles).toBe("0");
  expect(m.app().candidate).toEqual(baseline.candidate);
  for (const key of ["publisher", "title", "summary", "description", "priceUsdMicros", "version", "visible"] as const) expect(m.app().app[key]).toEqual(baseline.app[key]);
  expect(m.app().app.revision).toBe(7n); expect(m.app().app.iconArtifact).toHaveLength(1); expect(m.app().app.screenshotArtifacts).toHaveLength(1);
  expect(m.updates.map(u => u.method)).toEqual(["upload_begin", "upload_chunk", "upload_finish", "upload_begin", "upload_chunk", "upload_finish", "listing_save"]);
  expect(m.updates.every(u => u.cycles === 0n)).toBe(true);
  const count = m.updates.length, repeated = await publishMedia(f.plan, f.options, m.environment);
  expect(repeated.updateCalls).toBe(0); expect(repeated.results[0]?.status).toBe("unchanged"); expect(m.updates).toHaveLength(count);
}));

for (const method of ["upload_begin", "upload_chunk", "upload_finish", "listing_save"]) test(`lost ${method} response resumes exact bytes without duplicate uploads or listing revision`, () => fixture(async f => {
  const m = mock(); m.lose(method);
  await expect(publishMedia(f.plan, f.options, m.environment)).rejects.toThrow("same manifest, request ID and journal");
  const dispatched = m.updates.at(-1)!;
  expect(JSON.parse(await readFile(f.options.journal, "utf8")).steps.at(-1).outcome).toBe("unknown");
  m.environment.feeVersion = 2n;
  await publishMedia(f.plan, f.options, m.environment);
  expect(m.updates.filter(u => u.method === dispatched.method && u.args === dispatched.args)).toHaveLength(2);
  expect(m.uploads.size).toBe(2); expect(m.assets.size).toBe(2); expect(m.app().app.revision).toBe(7n);
  expect((await publishMedia(f.plan, f.options, m.environment)).updateCalls).toBe(0);
}));

test("changed bytes or manifest intent cannot reuse a reviewed journal", () => fixture(async f => {
  const m = mock(); await publishMedia(f.plan, { ...f.options, execute: false }, m.environment);
  f.plan.apps[0]!.icon!.bytes[0] ^= 1;
  await expect(publishMedia(f.plan, f.options, m.environment)).rejects.toThrow("Prepared image bytes changed");
  f.plan = await prepareMedia(f.manifest, canister); f.plan.apps[0]!.screenshots = [];
  await expect(publishMedia(f.plan, f.options, m.environment)).rejects.toThrow("different images");
  expect(m.updates).toEqual([]);
}));

test("concurrent metadata edit stops before overwriting price or release", () => fixture(async f => {
  const m = mock(); await publishMedia(f.plan, { ...f.options, execute: false }, m.environment);
  m.changeApp({ ...m.app(), app: { ...m.app().app, priceUsdMicros: 8_000_000n, revision: 7n } });
  await expect(publishMedia(f.plan, f.options, m.environment)).rejects.toThrow("metadata or release changed");
  expect(m.updates).toEqual([]); expect(m.app().app.priceUsdMicros).toBe(8_000_000n);
}));

test("metadata changes during uploads retain images but never send listing_save", () => fixture(async f => {
  const m = mock(); m.afterFinish(() => m.changeApp({ ...m.app(), app: { ...m.app().app, title: "Concurrent title", revision: 7n } }));
  await expect(publishMedia(f.plan, f.options, m.environment)).rejects.toThrow("uploaded images were retained");
  expect(m.updates.some(u => u.method === "listing_save")).toBe(false); expect(m.app().app.title).toBe("Concurrent title");
}));

test("other owner, changed release and changed postflight bytes are never reported as success", () => fixture(async f => {
  const m = mock(); m.changeApp({ ...m.app(), app: { ...m.app().app, publisher: Principal.fromText("3rurp-vyaaa-aaaay-aacua-cai") } });
  await expect(publishMedia(f.plan, f.options, m.environment)).rejects.toThrow("does not belong"); expect(m.updates).toEqual([]);
  const good = mock(); good.corrupt();
  await expect(publishMedia(f.plan, f.options, good.environment)).rejects.toThrow("differs from the exact reviewed bytes");
  expect(good.app().app.revision).toBe(7n);
}));

test("omitted images are preserved, and repeated selected bytes share one upload", () => fixture(async f => {
  const m = mock(); await publishMedia(f.plan, f.options, m.environment);
  const before = m.app(), same = f.plan.apps[0]!.screenshots![0]!;
  const plan: MediaPlan = { canister, apps: [{ appId: "alpha", icon: same }] };
  const count = m.updates.length;
  await publishMedia(plan, { ...f.options, requestId: mediaRequestId(plan), journal: path.join(f.directory, "second.json") }, m.environment);
  expect(m.app().app.screenshotArtifacts).toEqual(before.app.screenshotArtifacts); expect(m.app().app.screenshots).toEqual(before.app.screenshots);
  expect(m.updates.slice(count).map(u => u.method)).toEqual(["listing_save"]);
}));

test("manifest accepts only media fields and resolves paths from its own directory", () => fixture(async f => {
  expect(f.plan.apps[0]!.icon!.file).toBe(path.join(f.directory, "icon.svg"));
  await writeFile(f.manifest, JSON.stringify({ format: 1, apps: [{ appId: "alpha", title: "Unwanted metadata", icon: "icon.svg" }] }));
  await expect(prepareMedia(f.manifest)).rejects.toThrow("Unknown media app field: title");
}));
