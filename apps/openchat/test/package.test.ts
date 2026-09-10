import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { type NeutronManifest } from "neutron-tools/src/schema.js";
import { validate_neutron_conf } from "neutron-tools/src/validate_schema.js";
import { AGENT_TOOLS, TOOLS } from "../src/shared/protocol.ts";
import { ocErrorCode, ocErrorMessage, parseOcError } from "../src/oc/view.ts";
import { unpackNeutronPackage, preparePackageInstall } from "neutron-compiler/src/install.ts";
import { packageArchiveFilename } from "neutron-tools/src/package_archive.js";

const manifestUrl = new URL("../neutron.json", import.meta.url);

async function readManifest(): Promise<NeutronManifest> {
  return JSON.parse(await readFile(manifestUrl, "utf8")) as NeutronManifest;
}

test("the imported successor remains backend-free and keeps both existing browser surfaces", async () => {
  const manifest = await readManifest();
  const bytes = await readFile(new URL(`../${packageArchiveFilename(manifest.id, manifest.version)}`, import.meta.url));
  const files = unpackNeutronPackage(bytes);
  const prepared = await preparePackageInstall(bytes);
  const prior = JSON.parse(await readFile(new URL("./fixtures/history/121.json", import.meta.url), "utf8"));
  expect(prior).toMatchObject({ id: "openchat", version: 121 });
  expect(manifest.version).toBeGreaterThan(prior.version);
  expect(prepared.manifest.version).toBe(manifest.version);
  expect(prepared.manifest.memory ?? {}).toEqual(prior.memory ?? {});
  expect(prepared.manifest.func ?? {}).toEqual({});
  expect(prepared.manifest.background).toEqual(prior.background);
  expect(prepared.manifest.tiles).toEqual(prior.tiles);
  expect(prepared.manifest.capabilities?.persistent_browser_storage).toEqual(prior.capabilities.persistent_browser_storage);
  for (const path of ["web/index.html", "web/service.html", "web/main.js", "web/service.js"]) {
    expect(files[path]?.byteLength).toBeGreaterThan(0);
  }
});

test("openchat manifest validates against the shared schema", async () => {
  const manifest = await readManifest();
  const result = validate_neutron_conf(manifest);
  expect(result.valid).toBe(true);
});

test("openchat manifest is a backend-free resident + tiles app", async () => {
  const manifest = await readManifest();
  expect(manifest).toMatchObject({
    format: 3,
    id: "openchat",
    update_source: "233tv-xiaaa-aaaay-aacta-cai",
    src: "main.mo",
    background: { path: "service.html" },
    capabilities: { persistent_browser_storage: { api: 1, surface: "background" } },
  });
  // Version bumps every build (patch), so assert shape not an exact value.
  expect(typeof manifest.version).toBe("number");
  expect(manifest.version).toBeGreaterThanOrEqual(100);
  // Backend-free: no memory, no backend capabilities, no exposed methods.
  expect(manifest).not.toHaveProperty("memory");
  expect(manifest).not.toHaveProperty("backend");
  expect(manifest.func ?? {}).toEqual({});
  const tileIds = (manifest.tiles ?? []).map((t) => t.id);
  expect(tileIds).toEqual(["chats", "browse"]);
});

test("the agent tool set is a subset of all tools and covers the core actions", () => {
  const all = new Set<string>(Object.values(TOOLS));
  for (const name of AGENT_TOOLS) expect(all.has(name)).toBe(true);
  // The agent can do what the UI can: read, send, DM, search, join.
  expect(AGENT_TOOLS).toContain(TOOLS.listChats);
  expect(AGENT_TOOLS).toContain(TOOLS.readMessages);
  expect(AGENT_TOOLS).toContain(TOOLS.sendMessage);
  expect(AGENT_TOOLS).toContain(TOOLS.dmUser);
  expect(AGENT_TOOLS).toContain(TOOLS.joinGroup);
  // The agent can also drive the UI to a chat, like a user navigating.
  expect(AGENT_TOOLS).toContain(TOOLS.showChat);
  // Onboarding and the internal nav hand-off stay tile-only, never agent tools.
  expect(AGENT_TOOLS).not.toContain(TOOLS.signInStart);
  expect(AGENT_TOOLS).not.toContain(TOOLS.signOut);
  expect(AGENT_TOOLS).not.toContain(TOOLS.takePendingNav);
});

test("OCError decodes from its serde tuple [code, message?] (not a map)", () => {
  // This is the shape OpenChat sends over msgpack; reading it as an object gave
  // the bogus 'error 0'. code must come from index 0, message from index 1.
  expect(parseOcError([253, null])).toEqual({ code: 253, message: "" });
  expect(parseOcError([500, "boom"])).toEqual({ code: 500, message: "boom" });
  expect(ocErrorCode([253, null])).toBe(253);
  expect(ocErrorMessage([253, null])).toContain("Diamond");
  expect(ocErrorMessage([500, "boom"])).toBe("boom");
  expect(ocErrorMessage([0, null])).not.toBe("error 0");
});
