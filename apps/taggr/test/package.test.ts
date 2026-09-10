import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  preparePackageInstall,
  unpackNeutronPackage,
} from "neutron-compiler/src/install.ts";
import { packageArchiveFilename } from "neutron-tools/src/package_archive.ts";
import type { NeutronManifest } from "neutron-tools/src/schema.js";
import { validate_neutron_conf } from "neutron-tools/src/validate_schema.js";

const manifestUrl = new URL("../neutron.json", import.meta.url);
const backendUrl = new URL("../backend/main.mo", import.meta.url);
const serviceUrl = new URL("../src/service.ts", import.meta.url);
const clientUrl = new URL("../src/taggr_client.ts", import.meta.url);
const manifest = async (): Promise<NeutronManifest> =>
  JSON.parse(await readFile(manifestUrl, "utf8")) as NeutronManifest;

/**
 * The archive is named from the manifest, so this also checks that the packed
 * file on disk is the one this manifest describes rather than a stale build.
 */
const packageUrl = async (): Promise<URL> => {
  const value = await manifest();
  return new URL(`../${packageArchiveFilename(value.id, value.version)}`, import.meta.url);
};

const source = async (url: URL): Promise<string> => readFile(url, "utf8");

/** Names every tool the resident background exposes, with its annotations. */
const exposedTools = (service: string): Array<{ name: string; sameApp: boolean }> =>
  [...service.matchAll(/exposeTool\(\s*"([^"]+)",\s*\{([\s\S]*?)\n  \},/g)].map((match) => ({
    name: match[1]!,
    sameApp: (match[2] ?? "").includes("annotations: SAME_APP"),
  }));

describe("manifest", () => {
  test("is one tile, one resident, and one store for the account key", async () => {
    const value = await manifest();
    expect(validate_neutron_conf(value).errors).toEqual([]);
    expect(value).toMatchObject({
      format: 3,
      id: "taggr",
      name: "Taggr",
      src: "main.mo",
      background: { path: "service.html" },
    });
    expect(value.tiles).toHaveLength(1);
    expect(value.tiles?.[0]).toMatchObject({ id: "taggr", path: "index.html" });
    expect(value).not.toHaveProperty("backend");
    expect(value).not.toHaveProperty("init_arg");
    expect(value.update_source).toBe("sj2r4-haaaa-aaaay-aadgq-cai");
  });

  test("keeps the Taggr key in one versioned store", async () => {
    const value = await manifest();
    expect(Object.keys(value.memory ?? {})).toEqual(["identity"]);
    expect(value.memory?.identity).toMatchObject({
      version: 1,
      schemas: { "1": { src: "memory/identity/v1.mo" } },
    });
  });

  test("declares background storage and the self calls that reach the store", async () => {
    const value = await manifest();
    expect(Object.keys(value.capabilities ?? {}).sort()).toEqual([
      "persistent_browser_storage",
      "preapproved_self_calls",
    ]);
    expect(value.capabilities?.persistent_browser_storage).toEqual({
      api: 1,
      surface: "background",
    });
    // Exactly the methods the store needs, and nothing that reaches the network.
    expect(value.capabilities?.preapproved_self_calls).toEqual({
      api: 1,
      methods: [
        "taggr_state_read",
        "taggr_identity_initialize",
        "taggr_identity_write",
        "taggr_identity_clear",
        "taggr_settings_write",
      ],
    });
  });

  test("every preapproved method is one this app's own backend declares", async () => {
    const value = await manifest();
    const declared = Object.keys(value.func ?? {});
    const preapproved = (
      value.capabilities?.preapproved_self_calls as { methods?: string[] } | undefined
    )?.methods;
    expect(preapproved).toEqual(declared);
    // A read must stay a query: it runs on every background start.
    expect(value.func?.taggr_state_read).toMatchObject({ type: "query" });
    for (const name of ["taggr_identity_initialize", "taggr_identity_write", "taggr_identity_clear", "taggr_settings_write"]) {
      expect(value.func?.[name]).toMatchObject({ type: "update" });
    }
  });

  test("asks for no kernel-mediated authority beyond its own memory", async () => {
    const value = await manifest();
    // The app signs its own Taggr calls, so it needs no backend-call
    // reservations and no owner-approved broker. `preapproved_self_calls` is a
    // frontend capability over this app's own methods; it reaches nothing else.
    for (const capability of [
      "backend_calls",
      "https_outcalls",
      "public_ingress",
      "http_routes",
      "scheduled_tasks",
      "vetkeys",
      "chain_key_signing",
      "certified_assets",
      "connections",
      "ethereum_provider",
      "agent_entrypoints",
      "background_ui_requests",
    ]) {
      expect(value.capabilities).not.toHaveProperty(capability);
    }
  });

  test("the Motoko module only keeps the key; it reaches nothing", async () => {
    const backend = await source(backendUrl);
    // No capability handle is injected, so the backend cannot call out at all.
    expect(backend).not.toContain("mo:neutron-capabilities");
    expect(backend).not.toMatch(/capabilities\s*:/);
    expect(backend).toContain("stable_memory");
  });

  test("the stored key is the raw Ed25519 seed and nothing else", async () => {
    const schema = await source(new URL("../backend/memory/identity/v1.mo", import.meta.url));
    expect(schema).toContain("var secret_key : ?Blob");
    // A persistent schema may not import app-local modules, which could drift.
    expect(schema).not.toMatch(/^import .*"\.\//m);
  });
});

describe("the network client", () => {
  test("targets the IC boundary node in production and the gateway locally", async () => {
    const client = await source(clientUrl);
    expect(client).toContain('"https://icp-api.io"');
    expect(client).toContain("shouldFetchRootKey: local");
  });

  test("sends Uint8Array arguments, which agent-js v3 requires", async () => {
    const client = await source(clientUrl);
    expect(client).toContain("new TextEncoder().encode(payload)");
    // An ArrayBuffer here signs one representation and transmits another.
    expect(client).not.toMatch(/\.buffer as ArrayBuffer/);
  });

  test("reads are non-replicated queries and writes are updates", async () => {
    const client = await source(clientUrl);
    expect(client).toMatch(/const query = async[\s\S]*?agent\.query\(/);
    expect(client).toMatch(/const callRaw = async[\s\S]*?agent\.call\(/);
  });
});

describe("agent surface", () => {
  test("exposes the documented read, browse, discover, and write tools", async () => {
    const tools = exposedTools(await source(serviceUrl))
      .filter((tool) => tool.name.startsWith("taggr_"))
      .map((tool) => tool.name)
      .sort();
    expect(tools).toEqual([
      "taggr_feed",
      "taggr_post",
      "taggr_react",
      "taggr_realms",
      "taggr_search",
      "taggr_status",
      "taggr_tags",
      "taggr_thread",
      "taggr_user",
      "taggr_user_posts",
    ]);
  });

  test("every tile-only control is hidden from other apps", async () => {
    for (const tool of exposedTools(await source(serviceUrl))) {
      if (tool.name.startsWith("ui_")) {
        expect(tool.sameApp, `${tool.name} must be same_app`).toBe(true);
      } else {
        expect(tool.sameApp, `${tool.name} is agent-facing`).toBe(false);
      }
    }
  });

  test("the controls that can move the account also check the caller", async () => {
    const service = await source(serviceUrl);
    // `same_app` visibility is the kernel's filter; these two additionally
    // refuse anything that is not this app's own tile.
    expect(service).toMatch(/"ui_configure"[\s\S]*?requireOwnTile\(context/);
    expect(service).toMatch(/"ui_identity"[\s\S]*?requireOwnTile\(context/);
    expect(service).toContain("context.agentMode === true || context.caller?.appId !== APP_ID");
  });

  test("the Wallet funding request is built in the background, never the tile", async () => {
    const service = await source(serviceUrl);
    // Wallet's provider lane suspends this app's call and opens Wallet's own
    // tile; the request must therefore originate from a live app surface that
    // holds the identity, which is the background.
    expect(service).toContain("WALLET_FUNDING_TOOL");
    expect(service).toMatch(/"ui_register_with_icp"[\s\S]*?requireOwnTile\(context/);
    const tile = await source(new URL("../src/tile_client.ts", import.meta.url));
    expect(tile).not.toContain("wallet_fund_v1");
  });

  test("both writing tools check for an account before acting", async () => {
    const service = await source(serviceUrl);
    const writers = service.split('exposeTool(\n  "taggr_post"')[1] ?? "";
    expect([...writers.matchAll(/await requireAccount\(\)/g)]).toHaveLength(2);
  });
});

describe("archive", () => {
  const packagePaths = async (): Promise<Record<string, Uint8Array>> =>
    unpackNeutronPackage(await readFile(await packageUrl()));

  test("contains the tile, the resident, and the hashed Motoko root", async () => {
    const unpacked = await packagePaths();
    expect(Object.keys(unpacked)).toEqual(
      expect.arrayContaining([
        "neutron.json",
        "schema.json",
        "web/index.html",
        "web/main.css",
        "web/main.js",
        "web/service.html",
        "web/service.js",
        "web/static/icon.svg",
      ]),
    );
    // The store carries the account key, so its lineage is locked: an upgrade
    // that changed the schema without a migration would strand the key.
    expect(Object.keys(unpacked)).toContain("neutron.lock.json");
    const prepared = preparePackageInstall(unpacked);
    expect(prepared.manifest.id).toBe("taggr");
    expect(prepared.files.some((file) => file.path.startsWith("mo/"))).toBe(true);
  });

  test("ships only expected paths and no build leftovers", async () => {
    for (const path of Object.keys(await packagePaths())) {
      const allowed =
        path === ".neutron/browser-surface-origins.v1.json" ||
        path === "neutron.json" ||
        path === "schema.json" ||
        path === "web/index.html" ||
        path === "web/main.css" ||
        path === "web/main.js" ||
        path === "web/service.html" ||
        path === "web/service.js" ||
        path === "web/static/icon.svg" ||
        path === "neutron.lock.json" ||
        path.startsWith("legal/") ||
        /^mo\/[a-f0-9]{64}\.mo$/.test(path);
      expect(allowed, `unexpected package path ${path}`).toBe(true);
      expect(path).not.toMatch(/(?:^|\/)(?:node_modules|\.sass-cache)(?:\/|$)/);
      expect(path).not.toMatch(/\.(?:scss|map|neutron)$/);
    }
  });

  // Mirrors the Kitchen Sink reference scan. This app deliberately talks to the
  // IC boundary node at runtime, so the bundles name that host; what must not
  // appear is a resource *loaded* from a remote origin.
  test("loads no remote or unsafe resource", async () => {
    const unpacked = await packagePaths();
    const decoder = new TextDecoder();
    for (const path of [
      "web/index.html",
      "web/service.html",
      "web/main.css",
      "web/main.js",
      "web/service.js",
      "web/static/icon.svg",
    ]) {
      const bytes = unpacked[path];
      expect(bytes, `${path} is missing`).toBeDefined();
      const text = decoder.decode(bytes!);

      expect(text, `${path} leaks a source map`).not.toContain("sourceMappingURL");
      expect(text, `${path} loads a worker or script`).not.toMatch(
        /new\s+Worker\s*\(|importScripts\s*\(/,
      );

      if (path.endsWith(".html") || path.endsWith(".css")) {
        expect(text, `${path} has a remote URL`).not.toMatch(/https?:\/\/|\/\/[^/\s]/i);
        expect(text, `${path} has a javascript: URL`).not.toMatch(/javascript:/i);
        expect(text, `${path} has a data or blob URL`).not.toMatch(/\b(?:data|blob):/i);
        expect(text, `${path} has a root-relative resource`).not.toMatch(
          /\b(?:href|src)=["']\/|url\(\s*["']?\//,
        );
      }

      if (path.endsWith(".svg")) {
        const withoutNamespace = text.replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, "");
        expect(withoutNamespace, `${path} has a remote SVG reference`).not.toMatch(
          /https?:\/\/|\/\/[^/\s]/,
        );
        expect(text, `${path} has a script or handler`).not.toMatch(/<script|\son[a-z]+=/i);
      }

      if (path.endsWith(".js")) {
        const withoutNamespaces = text
          .replaceAll("http://www.w3.org/2000/svg", "")
          .replaceAll("http://www.w3.org/1998/Math/MathML", "")
          .replaceAll("http://www.w3.org/1999/xlink", "")
          .replaceAll("http://www.w3.org/XML/1998/namespace", "");
        expect(withoutNamespaces, `${path} attaches a remote script or stylesheet`).not.toMatch(
          /(?:new\s+Worker\s*\(|EventSource\s*\(|WebSocket\s*\(|\.src\s*=|\.href\s*=)\s*["'](?:https?:|\/\/)/i,
        );
        expect(withoutNamespaces, `${path} preloads a remote origin`).not.toMatch(
          /\b(?:preconnect|prefetchDNS|preinit|preinitModule|preload|preloadModule)\s*\(\s*["'](?:https?:|\/\/)/i,
        );
        expect(text, `${path} imports from a remote origin`).not.toMatch(
          /import\s*\(\s*["'](?:https?:|\/\/)/,
        );
        // The build rewrites React's invariant documentation URL.
        expect(text, `${path} keeps React's remote error URL`).not.toContain(
          "https://react.dev/errors/",
        );
      }
    }
  });

  test("only the resident bundle carries the identity and the network client", async () => {
    const unpacked = await packagePaths();
    const decoder = new TextDecoder();
    const service = decoder.decode(unpacked["web/service.js"]!);
    const tile = decoder.decode(unpacked["web/main.js"]!);

    expect(service).toContain("taggr.identity.v1");
    expect(service).toContain("icp-api.io");
    // A tile frame is credentialless: it must neither hold the key nor call the
    // network, or the account would be lost on the next reload.
    expect(tile).not.toContain("taggr.identity.v1");
    expect(tile).not.toContain("icp-api.io");
  });
});
