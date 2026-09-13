// All rights reserved. See ../LICENSE.
import { expect, test } from "bun:test";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { main } from "./operator.ts";
import { encode, decode, result } from "./operator-wire.ts";
import { MediaDetailReply } from "./media-wire.ts";
import { StorefrontConfig, Presentation, PresentationInput, editInput, prepareStorefront } from "./storefront.ts";

const target = { canister: "sj2r4-haaaa-aaaay-aadgq-cai", identity: "admin", network: "ic" };
const flags = ["--canister", target.canister, "--identity", target.identity, "--network", target.network];
test("storefront preparation binds the uploaded cover and the post-config app revision without making updates", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "storefront-review-"));
  try {
    const cover = new TextEncoder().encode("fixture cover"), hash = createHash("sha256").update(cover).digest("hex");
    const manifest = { format: 1, tags: [{ id: "games", name: "Games" }], featured: ["alpha"], apps: [{ appId: "alpha", title: "A short headline", subtitle: "An inviting subtitle", tags: ["games"], cover: "cover.webp" }] };
    await writeFile(path.join(directory, "cover.webp"), cover);
    await writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest));
    const methods: string[] = [];
    const run = async (args: string[]) => {
      const method = args[3]!; methods.push(method); expect(args).toContain("--query");
      if (method === "storefront_query") return Buffer.from(encode(result(IDL.Record({ config: StorefrontConfig })), { ok: { config: { tags: [{ id: "retired", name: "Old tag" }], featured: [], revision: 4n } } })).toString("hex");
      if (method === "admin_storefront_app_get") return Buffer.from(encode(result(IDL.Opt(Presentation)), { ok: [{ title: "Earlier headline", subtitle: "Earlier subtitle", tags: ["retired"], coverArtifact: [], revision: 7n }] })).toString("hex");
      if (method === "app_detail") return Buffer.from(encode(MediaDetailReply, { ok: { app: {
        appId: "alpha", publisher: Principal.fromText(target.canister), title: "Alpha", summary: "Unchanged excerpt", description: "Unchanged description", priceUsdMicros: 1_000_000n, revision: 3n, version: [100n], visible: true, iconUrl: [], iconArtifact: [], screenshots: [`https://${target.canister}.icp0.io/repo/v1/media/${hash}`], screenshotArtifacts: [9007199254740993n],
      }, candidate: [] } })).toString("hex");
      throw Error(`Unexpected method ${method}`);
    };
    const plan = await prepareStorefront(path.join(directory, "manifest.json"), target, run);
    expect(plan.config.expectedRevision).toBe("4");
    expect(plan.apps[0]).toMatchObject({ coverArtifact: "9007199254740993", expectedRevision: "8", title: "A short headline" });
    expect(methods).toEqual(["storefront_query", "app_detail", "admin_storefront_app_get"]);
    await writeFile(path.join(directory, "cover.webp"), "different bytes");
    await expect(prepareStorefront(path.join(directory, "manifest.json"), target, run)).rejects.toThrow("Publish and verify");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("admin presentation defaults to review and sends the exact file only on explicit execution", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "storefront-edit-"));
  try {
    const input = { appId: "alpha", title: "A short headline", subtitle: "An inviting subtitle", tags: [], coverArtifact: null, expectedRevision: "12" };
    const file = path.join(directory, "alpha.json"); await writeFile(file, JSON.stringify(input));
    let calls = 0, output = "";
    const run = async (args: string[]) => {
      calls++; expect(args[3]).toBe("admin_storefront_app_set"); expect(args).not.toContain("--query");
      const bytes = await readFile(args[args.indexOf("--args-file") + 1]!);
      expect(decode(PresentationInput, bytes)).toEqual(editInput(input, true));
      return Buffer.from(encode(result(Presentation), { ok: { ...editInput(input, true), revision: 13n } })).toString("hex");
    };
    await main(["admin-presentation", "--input", file, ...flags], { run, write: value => output += value });
    expect(calls).toBe(0); expect(JSON.parse(output).input.expectedRevision).toBe("12");
    await main(["admin-presentation", "--input", file, ...flags, "--execute"], { run, write: () => {} });
    expect(calls).toBe(1);
    expect(() => editInput({ ...input, expectedRevision: "-1" }, true)).toThrow("unsigned decimal");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
