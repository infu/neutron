import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import {
  generateAppMethodSchemaArtifact,
  validateAppMethodArgs,
} from "neutron-scripts/src/method_schema.js";
import { type NeutronManifest } from "neutron-tools/src/schema.js";
import { validate_neutron_conf } from "neutron-tools/src/validate_schema.js";
import { normalizeToolDescriptor } from "neutron-tools/src/protocol.ts";
import { unpackNeutronPackage } from "neutron-compiler/src/install.js";
import { packageArchiveFilename } from "neutron-tools/src/package_archive.js";
import {
  hashContent,
  removeCommentsAndEmptyLines,
} from "neutron-scripts/src/walk.js";

import { ALLOWED_TAGS, loadableImage, safeHref } from "../src/html";
import { createApi, isConflict, isErr, mergeRows, DRAFT_TOPIC } from "../src/api";
import { TOOL_DESCRIPTORS, jsonSafe } from "../src/tools";
import { count, relativeFromMillis, tidyListTitle, toNumber } from "../src/format";

const manifestUrl = new URL("../neutron.json", import.meta.url);
const backendUrl = new URL("../backend/main.mo", import.meta.url);
const clientUrl = new URL("../backend/nuance/Client.mo", import.meta.url);
const browserClientUrl = new URL("../src/nuance/client.ts", import.meta.url);
const lockUrl = new URL("../neutron.lock.json", import.meta.url);
const schemaV1Url = new URL("../backend/memory/nuance/v1.mo", import.meta.url);
const htmlUrl = new URL("../dist/web/index.html", import.meta.url);
const cssUrl = new URL("../dist/web/main.css", import.meta.url);
const archiveManifest = JSON.parse(await readFile(manifestUrl, "utf8"));
const archiveUrl = new URL(`../${packageArchiveFilename(archiveManifest.id, archiveManifest.version)}`, import.meta.url);

async function readManifest(): Promise<NeutronManifest> {
  return JSON.parse(await readFile(manifestUrl, "utf8")) as NeutronManifest;
}

// ------------------------------------------------------------------ manifest

test("manifest validates and declares the tile, background, and memory root", async () => {
  const manifest = await readManifest();
  expect(validate_neutron_conf(manifest).valid).toBe(true);

  expect(manifest).toMatchObject({
    format: 3,
    id: "nuance",
    name: "Nuance",
    src: "main.mo",
    tiles: [{ id: "main", path: "index.html", icon: "static/icon.svg" }],
    background: { path: "service.html" },
    memory: { nuance: { version: 2 } },
  });

  // Ordinary apps never declare positional constructor resources.
  expect(manifest).not.toHaveProperty("init_arg");
  expect(manifest.update_source).toBe("233tv-xiaaa-aaaay-aacta-cai");
});

test("every backend method is reachable without a per-call dialog", async () => {
  const manifest = await readManifest();
  const funcs = Object.keys(manifest.func ?? {}).sort();
  const preapproved = [
    ...(manifest.capabilities?.preapproved_self_calls?.methods ?? []),
  ].sort();

  // The tile and the resident background both drive the backend through
  // preapproved self calls. A method missing from this list would open an owner
  // dialog, which no agent turn can satisfy.
  expect(preapproved).toEqual(funcs);
  expect(preapproved.length).toBeLessThanOrEqual(32);
});

test("backend capability selection matches the declared authority", async () => {
  const manifest = await readManifest();
  expect(manifest.backend?.capabilities).toEqual({ backend_calls: { api: 1 } });

  const declared = manifest.capabilities?.backend_calls;
  expect(declared?.api).toBe(1);
  // Nuance accepts no cycles on any method this app calls.
  expect(declared?.max_cycles_per_call).toBe(0);
  expect(declared?.max_cycles_per_day).toBe(0);
});

test("install reservations cover exactly the canisters the client calls", async () => {
  const manifest = await readManifest();
  const client = await readFile(clientUrl, "utf8");

  const reserved = new Set(
    (manifest.capabilities?.backend_calls?.install_reservations ?? []).map(
      (entry) => (entry as { principal: string }).principal,
    ),
  );

  // Every canister id compiled into the client must be reserved, or the call
  // fails closed at runtime with no way for the owner to see why.
  // Canister ids are four five-character groups plus a three-character tail.
  const ids = [
    ...client.matchAll(/"([a-z0-9]{5}(?:-[a-z0-9]{5}){3}-[a-z0-9]{3})"/g),
  ].map((match) => match[1] as string);
  expect(ids.length).toBeGreaterThan(0);
  for (const id of ids) {
    expect(reserved.has(id)).toBe(true);
  }
  // ...and nothing is reserved that the client never calls.
  expect(reserved.size).toBe(new Set(ids).size);
});

// --------------------------------------------------------------- read path

// Nuance's whole read surface is public `query`. Routing a read through this
// canister turned a free browser query into a replicated inter-canister update
// the owner paid for, so reads were moved into the page. These tests keep them
// there: a read method reappearing in the backend is a silent cycle regression
// that nothing else would catch.

test("the backend exposes no Nuance read method", async () => {
  const manifest = await readManifest();
  const backend = await readFile(backendUrl, "utf8");
  const declared = Object.keys(manifest.func ?? {});

  for (const method of [
    "nuance_feed",
    "nuance_article",
    "nuance_comments",
    "nuance_search",
    "nuance_related",
    "nuance_tags",
    "nuance_whoami",
    "nuance_refresh_buckets",
  ]) {
    expect(declared).not.toContain(method);
    expect(backend).not.toContain(`${method}(`);
  }

  // What remains needs the Neutron's own principal, or is durable app state.
  // `nuance_my_posts` is the one read left: Nuance scopes it to the caller.
  expect(declared).toContain("nuance_my_posts");
  expect(declared).toContain("nuance_publish");
  expect(declared).toContain("nuance_comment");
});

test("every Nuance read is issued from the browser instead", async () => {
  const browser = await readFile(browserClientUrl, "utf8");
  for (const method of [
    "getLatestPosts",
    "getPopularToday",
    "getPostsByPostIds",
    "getPost",
    "getPostComments",
    "getAllTags",
    "searchPost",
    "getRelatedPosts",
    "getUsersByPrincipals",
  ]) {
    expect(browser).toContain(method);
  }
});

test("browser reads are anonymous and carry no Neutron identity", async () => {
  const browser = await readFile(browserClientUrl, "utf8");
  // No identity is attached to the agent, so Nuance sees an anonymous reader.
  expect(browser).not.toMatch(/\bidentity\s*:/);
  // Mainnet: fetching a root key would mean trusting a local replica's own
  // claim about itself.
  expect(browser).not.toContain("fetchRootKey");
});

// ------------------------------------------------------------ memory lineage

/// The hash of memory schema v1 as it shipped in v0.1.4, the first release
/// installed anywhere. It is a permanent contract: an installation holding v1
/// compares this against the incoming package and refuses it on any difference.
const RELEASED_SCHEMA_V1 =
  "d6e05b198cc93289c36a5a2cff5d65330a35b2fd5ba0bd48e993ce17fec1f07f";

test("the released v1 schema is byte-frozen and reachable by migration", async () => {
  // Editing v1.mo in place is the mistake this pins. It packages and tests
  // perfectly and then fails only on a real upgrade, with
  // "Memory nuance v1 schema hash changed" -- by which point the owner cannot
  // install the fix either, because the fix carries the same wrong hash.
  const source = await readFile(schemaV1Url, "utf8");
  expect(hashContent(removeCommentsAndEmptyLines(source))).toBe(RELEASED_SCHEMA_V1);

  // Comments are stripped before hashing, so only code may not change.
  const lock = JSON.parse(await readFile(lockUrl, "utf8")) as {
    memory: { nuance: { schemas: Record<string, { hash: string }> } };
  };
  expect(lock.memory.nuance.schemas["1"]?.hash).toBe(RELEASED_SCHEMA_V1);

  const manifest = await readManifest();
  const memory = manifest.memory?.nuance;
  expect(memory?.version).toBe(2);
  // Every version an installation might hold must still be carried, or that
  // installation has no path forward.
  expect(Object.keys(memory?.schemas ?? {}).sort()).toEqual(["1", "2"]);
  expect(memory?.migrations).toEqual([
    { from: 1, to: 2, src: "memory/nuance/v1_to_v2.mo" },
  ]);

  // The backend must run on the current schema, not a retired one.
  const backend = await readFile(backendUrl, "utf8");
  expect(backend).toContain('import Memory "./memory/nuance/v2"');
});

// -------------------------------------------------------------------- schema

test("method schemas describe the collaborative draft contract", async () => {
  const manifest = await readManifest();
  const backend = await readFile(backendUrl, "utf8");
  const artifact = generateAppMethodSchemaArtifact(manifest, backend);

  expect(artifact.methods.nuance_state?.type).toBe("query");
  expect(artifact.methods.nuance_draft_read?.type).toBe("query");
  expect(artifact.methods.nuance_draft_patch?.type).toBe("update");

  // A patch must carry the revision it was built against; that is the whole
  // compare-and-swap contract.
  const patchInput = artifact.methods.nuance_draft_patch?.input as {
    prefixItems: { required?: string[] }[];
  };
  expect(patchInput.prefixItems[0]?.required).toContain("expectedRevision");
  expect(patchInput.prefixItems[0]?.required).toContain("ops");

  expect(
    validateAppMethodArgs(artifact, "nuance_state", [null]).valid,
  ).toBe(true);
  expect(
    validateAppMethodArgs(artifact, "nuance_toggle_bookmark", [
      ["18318", "434go-diaaa-aaaaf-qakwq-cai", "Title", "brian"],
    ]).valid,
  ).toBe(true);
  // Four arguments, not one: a positional mistake must not reach the canister.
  expect(
    validateAppMethodArgs(artifact, "nuance_toggle_bookmark", ["18318"]).valid,
  ).toBe(false);
});

// --------------------------------------------------------------- wire shapes

// icblast unwraps a two-tag `{ok, err}` variant: success arrives bare and `err`
// is thrown. Reading such a reply as `{ ok }` silently yields `undefined` with no
// error anywhere -- which is exactly how the first build shipped a blank feed and
// a TypeError on opening an article. These tests pin both shapes.

test("two-tag results are unwrapped by the kernel, so the api layer re-wraps them", async () => {
  const draft = { id: "d1", title: "T", revision: "3" };
  const caller = {
    query: async () => draft as never,
    update: async () => draft as never,
  };
  const api = createApi(caller);

  const result = await api.draftRead("d1");
  expect(isErr(result)).toBe(false);
  if (!isErr(result)) {
    expect(result.ok.id).toBe("d1");
    expect(result.ok.revision).toBe("3");
  }
});

test("a thrown err payload becomes a readable message, not an unhandled rejection", async () => {
  // icblast throws the decoded payload itself, which here is a bare string.
  const thrower = {
    query: async () => {
      throw "No access to Nuance shard abc.";
    },
    update: async () => {
      throw "No access to Nuance shard abc.";
    },
  };
  const api = createApi(thrower as never);

  const result = await api.draftRead("d1");
  expect(isErr(result)).toBe(true);
  if (isErr(result)) expect(result.err).toBe("No access to Nuance shard abc.");

  // The same adapter must cover a real Error and an object payload.
  const errored = createApi({
    query: async () => {
      throw new Error("transport failed");
    },
    update: async () => {
      throw new Error("transport failed");
    },
  } as never);
  const second = await errored.publish("d1", false);
  expect(isErr(second)).toBe(true);
  if (isErr(second)) expect(second.err).toBe("transport failed");
});

test("three-tag draft results keep their conflict arm", async () => {
  const conflict = { conflict: { id: "d1", revision: "7" } };
  const api = createApi({
    query: async () => conflict as never,
    update: async () => conflict as never,
  } as never);

  const result = await api.draftSet({
    id: "d1",
    expectedRevision: "6",
    title: "",
    subtitle: "",
    tagIds: [],
    body: "",
    editor: "human",
  });
  expect(isConflict(result)).toBe(true);
  expect(isErr(result)).toBe(false);
});

test("the packaged schema records the unwrapped shape for two-tag results", async () => {
  const manifest = await readManifest();
  const backend = await readFile(backendUrl, "utf8");
  const artifact = generateAppMethodSchemaArtifact(manifest, backend);

  // `nuance_draft_read` returns `{ #ok : DraftView; #err : Text }`. If the
  // derived schema ever grows an `ok` wrapper, icblast stopped unwrapping and the
  // api layer above must change with it.
  const output = artifact.methods.nuance_draft_read?.output as {
    type?: string;
    properties?: Record<string, unknown>;
  };
  expect(output.type).toBe("object");
  expect(output.properties).toHaveProperty("revision");
  expect(output.properties).not.toHaveProperty("ok");
});

// ------------------------------------------------------------ sandbox rules

test("no source file uses a form or a submit button", async () => {
  // App tiles run in `sandbox="allow-scripts allow-same-origin"`. Without
  // `allow-forms` the browser blocks submission outright: pressing Enter in an
  // input never reaches onSubmit, it just logs
  // "Blocked form submission ... the 'allow-forms' permission is not set".
  // Keyboard submission has to be wired explicitly instead.
  const dir = new URL("../src/", import.meta.url);
  const files = (await readdir(dir)).filter(
    (name) => name.endsWith(".ts") || name.endsWith(".tsx"),
  );
  expect(files.length).toBeGreaterThan(5);

  const offenders: string[] = [];
  for (const file of files) {
    const source = await readFile(new URL(file, dir), "utf8");
    for (const [index, line] of source.split("\n").entries()) {
      // Skip prose: the rule itself is documented in comments.
      const code = line.replace(/\/\/.*$/, "");
      if (/<form[\s>]/.test(code) || /type=["']submit["']/.test(code)) {
        offenders.push(`${file}:${index + 1}: ${line.trim()}`);
      }
    }
  }
  expect(offenders).toEqual([]);
});

test("no source file uses a sandbox-blocked browser API", async () => {
  // The same sandbox has no allow-modals, allow-popups, or allow-downloads.
  const dir = new URL("../src/", import.meta.url);
  const files = (await readdir(dir)).filter(
    (name) => name.endsWith(".ts") || name.endsWith(".tsx"),
  );

  const blocked = /\b(?:window\.)?(?:alert|confirm|prompt)\s*\(|window\.open\s*\(|target=["']_blank["']|\sdownload=/;
  const offenders: string[] = [];
  for (const file of files) {
    const source = await readFile(new URL(file, dir), "utf8");
    for (const [index, line] of source.split("\n").entries()) {
      const code = line.replace(/\/\/.*$/, "");
      if (blocked.test(code)) offenders.push(`${file}:${index + 1}: ${line.trim()}`);
    }
  }
  expect(offenders).toEqual([]);
});

// -------------------------------------------------------------- SDK contracts

// Every one of these is a rule the SDK enforces at runtime by throwing. A
// violation in the resident background throws at module scope and takes down
// every agent tool at once, with nothing in the UI to explain it.

test("agent tool descriptors satisfy the SDK's own validator", () => {
  expect(TOOL_DESCRIPTORS.length).toBe(13);

  const seen = new Set<string>();
  for (const descriptor of TOOL_DESCRIPTORS) {
    // Throws on a bad name, an oversized title/description, or a non-object
    // schema -- the exact checks `exposeTool` runs.
    const normalized = normalizeToolDescriptor({
      name: descriptor.name,
      title: descriptor.title,
      description: descriptor.description,
      inputSchema: descriptor.inputSchema,
      ...(descriptor.outputSchema ? { outputSchema: descriptor.outputSchema } : {}),
    });
    expect(normalized.name).toBe(descriptor.name);
    expect(seen.has(descriptor.name)).toBe(false);
    seen.add(descriptor.name);
  }

  // The read-then-patch discipline only reaches an agent through this text.
  const patch = TOOL_DESCRIPTORS.find((d) => d.name === "nuance_draft_patch");
  expect(patch?.description).toContain("expectedRevision");
  expect(patch?.description).toContain("conflict");
});

test("the app state topic matches the SDK's accepted pattern", () => {
  // `publishAppStateChange` and `onAppStateChange` both reject anything else,
  // and a colon in the topic is what first broke the editor.
  expect(DRAFT_TOPIC).toMatch(/^[a-z][a-z0-9_.-]{0,63}$/u);
});

test("undefined is stripped from tool results", () => {
  // Candid `opt` decodes to an absent-or-undefined property; `undefined` is not
  // JSON and would fail validation at the message-bus boundary.
  const cleaned = jsonSafe({
    id: "d1",
    sourcePostId: undefined,
    nested: { keep: 1, drop: undefined },
    list: [{ a: undefined, b: "x" }],
  });
  expect(cleaned).toEqual({
    id: "d1",
    nested: { keep: 1 },
    list: [{ b: "x" }],
  } as never);
  expect("sourcePostId" in (cleaned as object)).toBe(false);
});

// ------------------------------------------------------------------ sanitiser

test("link and image sources are filtered before they can reach the DOM", () => {
  expect(safeHref("https://example.com/a")).toBe("https://example.com/a");
  expect(safeHref("http://example.com/a")).toBe("http://example.com/a");
  expect(safeHref("/relative")).toBe("https://nuance.xyz/relative");

  // The cases that matter: anything that can execute or exfiltrate.
  expect(safeHref("javascript:alert(1)")).toBeNull();
  expect(safeHref("JavaScript:alert(1)")).toBeNull();
  expect(safeHref("data:text/html;base64,PHNjcmlwdD4=")).toBeNull();
  expect(safeHref("vbscript:msgbox(1)")).toBeNull();
  expect(safeHref("")).toBeNull();
  expect(safeHref(null)).toBeNull();
});

test("images load only from the IC gateway hosts Nuance stores media on", () => {
  expect(
    loadableImage("https://wkeve-6yaaa-aaaaf-qahcq-cai.raw.icp0.io/storage?contentId=x"),
  ).toContain("icp0.io");
  expect(loadableImage("https://something.ic0.app/a.png")).toContain("ic0.app");

  // A third-party image would report every reader's IP on open.
  expect(loadableImage("https://tracker.example/pixel.gif")).toBeNull();
  expect(loadableImage("http://insecure.icp0.io/a.png")).toBeNull();
  expect(loadableImage("javascript:alert(1)")).toBeNull();
  // Suffix matching must not be fooled by a lookalike host.
  expect(loadableImage("https://evil-icp0.io/a.png")).toBeNull();
  expect(loadableImage("https://icp0.io.evil.example/a.png")).toBeNull();
});

test("cover images survive the two-phase read", () => {
  // Nuance returns `headerImage` even in list mode, where it strips the body, so
  // a feed thumbnail costs no extra request. Losing it in the merge would leave
  // the whole feed imageless with nothing failing.
  const rows = mergeRows(
    [
      {
        postId: "1",
        bucketCanisterId: "b",
        handle: "a",
        claps: "0",
        views: "0",
        created: "0",
        modified: "0",
        publishedDate: "0",
        isDraft: false,
        tags: [],
      },
    ] as never,
    [
      {
        postId: "1",
        title: "T",
        subtitle: "",
        handle: "a",
        wordCount: "10",
        headerImage:
          "https://wkeve-6yaaa-aaaaf-qahcq-cai.raw.icp0.io/storage?contentId=x",
      },
    ] as never,
  );
  expect(rows[0]?.headerImage).toContain("raw.icp0.io");
  // The policy that decides whether it is rendered is the body-image policy.
  expect(loadableImage(rows[0]?.headerImage ?? null)).not.toBeNull();
});

test("the tag allowlist excludes every executable element", () => {
  for (const tag of ["script", "style", "iframe", "object", "embed", "form", "link", "meta"]) {
    expect(ALLOWED_TAGS.has(tag)).toBe(false);
  }
  for (const tag of ["p", "h2", "ul", "li", "a", "strong", "blockquote"]) {
    expect(ALLOWED_TAGS.has(tag)).toBe(true);
  }
});

// ------------------------------------------------------------------- format

test("candid numbers and Nuance timestamps are read in the right units", () => {
  expect(toNumber("42")).toBe(42);
  expect(toNumber(undefined)).toBe(0);
  expect(toNumber("not a number")).toBe(0);

  expect(count("0")).toBe("0");
  expect(count("999")).toBe("999");
  expect(count("1500")).toBe("1.5k");
  expect(count("2000000")).toBe("2.0m");

  // Nuance publish dates are milliseconds, not nanoseconds. Reading them as
  // nanoseconds would render every article as decades old.
  const twoHoursAgo = String(Date.now() - 2 * 60 * 60 * 1000);
  expect(relativeFromMillis(twoHoursAgo)).toBe("2h");
  expect(relativeFromMillis("0")).toBe("");
  expect(relativeFromMillis("")).toBe("");
});

test("Nuance's own 60-character list truncation is not doubled up", () => {
  expect(tidyListTitle("A truncated title...")).toBe("A truncated title…");
  expect(tidyListTitle("A whole title")).toBe("A whole title");
});

// ------------------------------------------------------------------- bundle

test("the tile bundles the shared design system and no remote references", async () => {
  const html = await readFile(htmlUrl, "utf8");
  const css = await readFile(cssUrl, "utf8");
  const main = await readFile(new URL("../dist/web/main.js", import.meta.url), "utf8");

  expect(html).toContain("./main.css");
  expect(css).toContain(".nt-app");
  expect(css).toContain("--nt-bg-panel");
  expect(css).not.toMatch(/gradient\s*\(/i);
  expect(css).not.toMatch(/border-radius\s*:\s*(?:[6-9]|\d{2,})px/i);

  // App bundles must be self-contained; nothing may be fetched at runtime.
  expect(main).not.toMatch(/https:\/\/react\.dev/);
  expect(main).not.toMatch(/<script\s+src="https?:/i);
});

test("the resident background is built as its own entrypoint", async () => {
  const service = await readFile(new URL("../dist/web/service.js", import.meta.url), "utf8");
  const serviceHtml = await readFile(
    new URL("../dist/web/service.html", import.meta.url),
    "utf8",
  );

  expect(serviceHtml).toContain("./service.js");
  // The agent tools live here, and each must be discoverable by name.
  for (const tool of [
    "nuance_browse",
    "nuance_read",
    "nuance_search",
    "nuance_comments",
    "nuance_recent_since",
    "nuance_whoami",
    "nuance_draft_list",
    "nuance_draft_read",
    "nuance_draft_new",
    "nuance_draft_patch",
    "nuance_draft_load",
    "nuance_post",
    "nuance_reply",
  ]) {
    expect(service).toContain(tool);
  }
  // React must not be dragged into the resident bundle: it is mounted for the
  // whole session.
  expect(service).not.toContain("react-dom");
});

// ------------------------------------------------------------------ archive

test("the packaged archive contains only expected paths", async () => {
  const bytes = await readFile(archiveUrl);
  const files = unpackNeutronPackage(new Uint8Array(bytes));
  const paths = Object.keys(files).sort();

  expect(paths).toContain("neutron.json");
  expect(paths).toContain("neutron.lock.json");
  expect(paths).toContain("web/index.html");
  expect(paths).toContain("web/main.js");
  expect(paths).toContain("web/main.css");
  expect(paths).toContain("web/service.html");
  expect(paths).toContain("web/service.js");
  expect(paths).toContain("web/static/icon.svg");
  expect(paths).toContain(".neutron/browser-surface-origins.v1.json");

  const allowed =
    /^(neutron\.json|neutron\.lock\.json|schema\.json|\.neutron\/browser-surface-origins\.v1\.json|web\/.+|mo\/[0-9a-f]{64}\.mo|legal\/.+)$/;
  for (const path of paths) {
    expect(path).toMatch(allowed);
  }
});
