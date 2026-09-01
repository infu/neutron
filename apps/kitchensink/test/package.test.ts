import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  preparePackageInstall,
  unpackNeutronPackage,
} from "neutron-compiler/src/install.ts";
import {
  generateAppMethodSchemaArtifact,
  validateAppMethodArgs,
} from "neutron-scripts/src/method_schema.js";
import { normalizeToolDescriptor } from "neutron-tools/src/app.ts";
import {
  buildCapabilityPlan,
  getCapabilityPlanEntry,
} from "neutron-tools/src/capabilities/plan.ts";
import {
  NEUTRON_BROWSER_SURFACE_ORIGINS_MARKER_PATH,
  browserSurfaceOriginsPackageMarkerBytes,
} from "neutron-tools/src/package_surface_origins.ts";
import { type NeutronManifest } from "neutron-tools/src/schema.js";
import { validate_neutron_conf } from "neutron-tools/src/validate_schema.js";
import { trayDemoSnapshotSchema } from "../src/tray_demo.ts";
import { counterIncrementInputSchema } from "../src/tile_tools.ts";

const manifestUrl = new URL("../neutron.json", import.meta.url);
const backendUrl = new URL("../backend/main.mo", import.meta.url);
const frontendUrl = new URL("../src/index.tsx", import.meta.url);
const capabilityFrontendUrl = new URL("../src/capability_lab.tsx", import.meta.url);
const derivedFrontendUrl = new URL("../src/derived_capabilities.tsx", import.meta.url);
const platformFrontendUrl = new URL("../src/platform_pages.tsx", import.meta.url);
const walletFundingDemoUrl = new URL("../src/wallet_funding_demo.ts", import.meta.url);
const contactsManifestUrl = new URL("../../contacts/neutron.json", import.meta.url);
const serviceUrl = new URL("../src/service.ts", import.meta.url);
const trayFrontendUrl = new URL("../src/tray.tsx", import.meta.url);
const htmlUrl = new URL("../dist/web/index.html", import.meta.url);
const cssUrl = new URL("../dist/web/main.css", import.meta.url);
const trayHtmlUrl = new URL("../dist/web/tray.html", import.meta.url);
const trayCssUrl = new URL("../dist/web/tray.css", import.meta.url);
const packageUrl = new URL("../kitchensink.v0.3.6.neutron", import.meta.url);
const decoder = new TextDecoder();

async function readManifest(): Promise<NeutronManifest> {
  return JSON.parse(await readFile(manifestUrl, "utf8")) as NeutronManifest;
}

async function readBackend(): Promise<string> {
  return readFile(backendUrl, "utf8");
}

function assertAllowedPackagePath(path: string): void {
  const allowed =
    path === NEUTRON_BROWSER_SURFACE_ORIGINS_MARKER_PATH ||
    path === "neutron.json" ||
    path === "neutron.lock.json" ||
    path === "schema.json" ||
    path === "web/index.html" ||
    path === "web/main.css" ||
    path === "web/main.js" ||
    path === "web/service.html" ||
    path === "web/service.js" ||
    path === "web/tray.html" ||
    path === "web/tray.css" ||
    path === "web/tray.js" ||
    path === "web/static/icon.svg" ||
    path === "web/static/tray-demo.svg" ||
    path === "legal/APPLICATION-NOTICE.txt" ||
    path === "legal/package-record.v1.json" ||
    path === "legal/LICENSE.APP.txt" ||
    path === "legal/THIRD_PARTY_NOTICES.md" ||
    path === "legal/third-party/EXACT-MATERIALS.v1.txt" ||
    /^legal\/third-party\/[a-f0-9]{64}\.txt$/u.test(path) ||
    /^mo\/[a-f0-9]{64}\.mo$/.test(path);

  expect(allowed, `unexpected package path ${path}`).toBe(true);
  expect(path).not.toMatch(/(?:^|\/)(?:node_modules|\.sass-cache)(?:\/|$)/);
  expect(path).not.toMatch(/\.(?:scss|map|neutron)$/);
}

function assertNoUnsafeResourceReferences(path: string, text: string): void {
  expect(text, `${path} has source map leakage`).not.toContain(
    "sourceMappingURL",
  );
  expect(text, `${path} has dynamic worker/script loading`).not.toMatch(
    /new\s+Worker\s*\(|importScripts\s*\(/,
  );
  if (path.endsWith(".html") || path.endsWith(".css")) {
    expect(text, `${path} has remote URL`).not.toMatch(
      /https?:\/\/|\/\/[^/\s]/i,
    );
    expect(text, `${path} has unsafe script URL`).not.toMatch(/javascript:/i);
    expect(text, `${path} has data/blob URL`).not.toMatch(/\b(?:data|blob):/i);
    expect(text, `${path} has root-relative resource`).not.toMatch(
      /\b(?:href|src)=["']\/|url\(\s*["']?\//,
    );
    expect(text, `${path} has remote modulepreload`).not.toMatch(
      /rel=["']modulepreload["'][^>]+(?:https?:|\/\/)/,
    );
  }

  if (path.endsWith(".svg")) {
    const withoutSvgNamespace = text.replace(
      /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g,
      "",
    );
    expect(withoutSvgNamespace, `${path} has remote SVG reference`).not.toMatch(
      /https?:\/\/|\/\/[^/\s]/,
    );
    expect(text, `${path} has unsafe SVG URL`).not.toMatch(
      /(?:javascript|data|blob):/i,
    );
    expect(text, `${path} has SVG script`).not.toMatch(/<script|\son[a-z]+=/i);
    expect(text, `${path} has external SVG href`).not.toMatch(
      /\b(?:href|xlink:href)=["'](?:https?:|\/\/|\/)/,
    );
  }

  if (path.endsWith(".js")) {
    const withoutNamespaces = text
      .replaceAll("http://www.w3.org/2000/svg", "")
      .replaceAll("http://www.w3.org/1998/Math/MathML", "");
    expect(
      withoutNamespaces,
      `${path} has remote JS resource literal`,
    ).not.toMatch(
      /(?:import\s*\(|fetch\s*\(|new\s+Worker\s*\(|EventSource\s*\(|WebSocket\s*\(|\.src\s*=|\.href\s*=)\s*["'](?:https?:|\/\/)/i,
    );
    expect(withoutNamespaces, `${path} has remote React preload`).not.toMatch(
      /\b(?:preconnect|prefetchDNS|preinit|preinitModule|preload|preloadModule)\s*\(\s*["'](?:https?:|\/\/)/i,
    );
    expect(text, `${path} has remote import`).not.toMatch(
      /import\s*\(\s*["'](?:https?:|\/\/)/,
    );
  }
}

test("kitchen sink declares the complete closed capability lab", async () => {
  const manifest = await readManifest();
  const result = validate_neutron_conf(manifest);

  expect(result.valid).toBe(true);
  expect(manifest).toMatchObject({
    id: "kitchensink",
    name: "Kitchen Sink",
    version: 306,
    update_source: "233tv-xiaaa-aaaay-aacta-cai",
    src: "main.mo",
    tiles: [
      { id: "main", title: "Kitchen Sink", path: "index.html" },
      { id: "companion", title: "Shared Counter", path: "index.html" },
    ],
    background: {
      path: "service.html",
      description: "Resident Kitchen Sink tray demo",
    },
    tray: {
      title: "Kitchen Sink Tray Demo",
      path: "tray.html",
      icon: "static/tray-demo.svg",
    },
    backend: {
      capabilities: {
        backend_calls: { api: 1 },
        https_outcalls: { api: 1 },
        randomness: { api: 1 },
        chain_key_signing: { api: 1 },
        certified_assets: { api: 2 },
        stable_store: { api: 1 },
      },
    },
  });
  expect(manifest).not.toHaveProperty("init_arg");
  expect(manifest.background).not.toHaveProperty("storage");
  expect(manifest.dependencies).toEqual({
    contacts: {
      app: "contacts",
      min_version: 101,
      functions: ["contacts_neutron_revision_v2"],
    },
  });
  expect(new Set(Object.keys(manifest.capabilities ?? {}))).toEqual(new Set([
    "public_ingress",
    "backend_calls",
    "https_outcalls",
    "randomness",
    "chain_key_signing",
    "vetkeys",
    "scheduled_tasks",
    "preapproved_self_calls",
    "agent_entrypoints",
    "background_ui_requests",
    "ethereum_provider",
    "connections",
    "persistent_browser_storage",
    "certified_assets",
    "stable_store",
  ]));
  expect(manifest.capabilities?.backend_calls).toMatchObject({
    max_concurrency: 1,
    max_cycles_per_call: 1_000_000,
    max_cycles_per_day: 10_000_000,
  });
  expect(manifest.capabilities?.public_ingress?.routes).toEqual([
    expect.objectContaining({
      protocol: "demo_v1",
      id: "status",
      handler: "public_status",
      mode: "query",
      caller: "any",
    }),
  ]);
  expect(manifest.capabilities?.https_outcalls).toEqual({
    api: 1,
    endpoints: [{
      id: "example",
      url_prefix: "https://example.com/",
      methods: ["get", "head"],
      request_headers: ["accept"],
      max_request_bytes: 4_096,
      max_response_bytes: 32_768,
      transform: "strip_headers",
    }],
  });
  expect(manifest.capabilities?.chain_key_signing).toEqual({
    api: 1,
    slots: [{
      id: "receipt_assertions",
      algorithm: "ecdsa_secp256k1",
      purpose: "Sign Kitchen Sink receipt assertions",
      max_assertion_bytes: 4_096,
    }],
  });
  expect(manifest.capabilities?.stable_store).toEqual({
    api: 1,
    stores: [{
      id: "notes",
      purpose: "Kitchen Sink revisioned UTF-8 notes demo",
      schema_version: 1,
      max_entries: 24,
      max_key_bytes: 96,
      max_value_bytes: 4_096,
      max_bytes: 32_768,
    }],
  });
  expect(manifest.capabilities?.preapproved_self_calls?.methods).toEqual(
    expect.arrayContaining([
      "read_counter",
      "random_bytes",
      "chain_key_public_key",
      "chain_key_sign_receipt",
      "https_example",
      "scheduled_status",
      "dependency_status",
      "function_resource_snapshot",
      "asset_status",
      "certified_assets_usage",
      "stable_notes_create",
      "stable_notes_load",
      "stable_notes_update",
      "stable_notes_list",
      "stable_notes_usage",
      "stable_notes_delete",
      "stable_notes_clear_page",
    ]),
  );
  expect(manifest.capabilities?.scheduled_tasks?.tasks).toEqual([
    expect.objectContaining({
      id: "daily_tick",
      method: "scheduled_tick",
      interval_seconds: 86_400,
      run_on_start: true,
    }),
  ]);
  expect(manifest.func?.dependency_status).toEqual({
    type: "query",
    async: false,
  });
  expect(manifest.func?.function_resource_snapshot).toEqual({
    type: "query",
    async: false,
    arg: ["caller", "canister_principal", "memory_kitchensink"],
  });

  const plan = buildCapabilityPlan(manifest);
  expect(getCapabilityPlanEntry(plan, "app_calls")?.config).toEqual({
    dependencies: [{
      alias: "contacts",
      app: "contacts",
      min_version: 101,
      methods: ["contacts_neutron_revision_v2"],
    }],
  });
  expect(
    getCapabilityPlanEntry(plan, "function_resources")?.config.functions,
  ).toContainEqual({
    method: "function_resource_snapshot",
    mode: "query",
    resources: [
      { kind: "caller" },
      { kind: "canister_principal" },
      { kind: "stable_memory", id: "kitchensink" },
    ],
  });

  const contactsManifest = JSON.parse(
    await readFile(contactsManifestUrl, "utf8"),
  ) as NeutronManifest;
  expect(
    getCapabilityPlanEntry(
      buildCapabilityPlan(contactsManifest),
      "app_exports",
    )?.config.methods,
  ).toContainEqual({
    method: "contacts_neutron_revision_v2",
    mode: "update",
  });
  expect(manifest.capabilities).not.toHaveProperty("http_routes");
  expect(manifest.capabilities?.certified_assets).toEqual({
    api: 2,
    max_entries: 8,
    max_committed_bytes: 16_384,
    max_object_bytes: 4_096,
    max_pending_stages: 1,
    max_staged_bytes: 4_096,
    max_batch_operations: 2,
    max_batch_bytes: 4_096,
    max_idempotency_receipts: 32,
    collections: [
      {
        id: "publication_demo",
        mount: "publication_demo",
        kind: "publication",
        max_object_bytes: 2_048,
      },
      {
        id: "immutable_blob_demo",
        mount: "blob_demo",
        kind: "immutable_blob",
        path_prefix: "/v1/immutable/",
        max_object_bytes: 2_048,
      },
      {
        id: "mutable_blob_demo",
        mount: "blob_demo",
        kind: "mutable_blob",
        path_prefix: "/v1/mutable/",
        max_object_bytes: 2_048,
      },
    ],
  });
});

test("kitchen sink bundles the shared design system stylesheet", async () => {
  const html = await readFile(htmlUrl, "utf8");
  const css = await readFile(cssUrl, "utf8");
  const trayHtml = await readFile(trayHtmlUrl, "utf8");
  const trayCss = await readFile(trayCssUrl, "utf8");

  expect(html).toContain("./main.css");
  expect(trayHtml).toContain("./tray.css");
  expect(css).toContain(".nt-app");
  expect(css).toContain("--nt-accent");
  expect(css).toContain("nt-alert--danger");
  expect(css).toContain("nt-alert--critical");
  expect(css).toContain("nt-copy-field");
  expect(css).toContain("nt-json");
  expect(css).toContain("nt-disclosure-trigger");
  expect(css).toContain("nt-settings-row");
  expect(css).not.toMatch(/gradient\s*\(/i);
  expect(css).not.toMatch(/border-radius\s*:\s*(?:[6-9]|\d{2,})px/i);
  expect(trayCss).toContain(".nt-app");
  expect(trayCss).toContain("ks-tray-notification");
  expect(trayCss).not.toMatch(/gradient\s*\(/i);
  expect(trayCss).not.toMatch(/border-radius\s*:\s*(?:[6-9]|\d{2,})px/i);
});

test("kitchen sink workbench exposes one page per capability and scoped tile tools", async () => {
  const backend = await readBackend();
  const frontend = await readFile(frontendUrl, "utf8");
  const capabilityFrontend = await readFile(capabilityFrontendUrl, "utf8");
  const derivedFrontend = await readFile(derivedFrontendUrl, "utf8");
  const platformFrontend = await readFile(platformFrontendUrl, "utf8");
  const walletFundingDemo = await readFile(walletFundingDemoUrl, "utf8");

  for (const demo of [
    "overview",
    "public_ingress",
    "backend_calls",
    "https_outcalls",
    "randomness",
    "chain_key_signing",
    "vetkeys",
    "scheduled_tasks",
    "stable_store",
    "self_calls",
    "agent_entrypoints",
    "background_requests",
    "ethereum",
    "connections",
    "storage",
    "certified_reads",
    "certified_assets",
    "composition",
    "memory",
    "bus",
    "wallet_funding",
    "tray",
    "schemas",
    "data",
    "design",
  ]) {
    expect(frontend).toContain(`id: "${demo}"`);
  }
  expect(frontend).toContain('exposeTool("tile_snapshot"');
  expect(frontend).toContain('exposeTool("counter_increment"');
  expect(frontend).toContain("toolContext.kernel.querySelf<string>");
  expect(frontend).toContain("toolContext.kernel.updateSelf<string>");
  expect(frontend).not.toContain('name: "canister.query_self"');
  expect(frontend).not.toContain('name: "canister.update_self"');
  expect(frontend).toContain('workspace: String(context.workspace ?? "unknown")');
  expect(frontend).toContain('["write", "network"]');
  expect(frontend).toContain("publishAppStateChange(COUNTER_TOPIC, Number(counter))");
  expect(frontend).toContain("publishAppStateChange(COUNTER_TOPIC, Number(next))");
  expect(frontend).not.toContain("publishAppStateChange(COUNTER_TOPIC, Date.now())");
  expect(frontend).toContain("Promise.allSettled");
  expect(frontend).not.toContain("setInterval");
  expect(capabilityFrontend).toContain("function BackendCallsPage");
  expect(capabilityFrontend).toContain("function HttpsOutcallsPage");
  expect(capabilityFrontend).toContain("function ChainKeySigningPage");
  expect(capabilityFrontend).toContain("function StableStorePage");
  expect(capabilityFrontend).toContain("function PublicIngressPage");
  expect(capabilityFrontend).toContain("function CertifiedReadsPage");
  expect(capabilityFrontend).toContain("function CertifiedAssetsPage");
  expect(capabilityFrontend).toContain('requestAgentMode("capability_agent_demo")');
  expect(capabilityFrontend).toContain("function publicationDemoBaseUrl");
  expect(capabilityFrontend).toContain("function immutableBlobBasePath");
  expect(capabilityFrontend).toContain("function mutableBlobPath");
  expect(capabilityFrontend).toContain("New publication token");
  expect(capabilityFrontend).toContain("Review immutable publish");
  expect(capabilityFrontend).toContain("Review inline/CAS put");
  expect(capabilityFrontend).toContain('updateSelf<string>("https_example"');
  expect(capabilityFrontend).toContain('updateSelf<JsonValue>("chain_key_public_key"');
  expect(capabilityFrontend).toContain('updateSelf<JsonValue>("chain_key_sign_receipt"');
  expect(capabilityFrontend).toContain("This is an assertion receipt, not a wallet or transaction-signing API");
  expect(capabilityFrontend).toContain("Unavailable local keys and network failures remain visible errors");
  expect(capabilityFrontend).toContain("unexpected authority binding");
  expect(capabilityFrontend).toContain("signature domain does not match the public key domain");
  expect(capabilityFrontend).toContain("Compare-and-swap (CAS)");
  expect(capabilityFrontend).toContain('querySelf<JsonValue>("stable_notes_list"');
  expect(capabilityFrontend).toContain('updateSelf<JsonValue>("stable_notes_clear_page"');
  expect(derivedFrontend).toContain('querySelf<JsonValue>("dependency_status"');
  expect(derivedFrontend).toContain('querySelf<JsonValue>("function_resource_snapshot"');
  expect(derivedFrontend).toContain("caller → canister_principal → memory_kitchensink");
  expect(derivedFrontend).toContain('"min_version": 101');
  expect(derivedFrontend).toContain("contacts@0.1.1");
  expect(backend).toContain("query_params = []");
  expect(backend).toContain("NeutronCapabilities.ChainKeySigningV1");
  expect(backend).toContain('chainKeySigning.public_key("receipt_assertions")');
  expect(backend).toContain("chainKeySigning.sign_assertion({");
  expect(backend).toContain("Kitchen Sink receipt assertion v1");
  expect(backend).toContain("NeutronCapabilities.StableStoreV1");
  expect(backend).toContain("NeutronCapabilities.CertifiedAssetsV2");
  expect(backend).not.toContain("CertifiedAssetsV1");
  expect(backend).toContain("certifiedAssets.begin_stage({");
  expect(backend).toContain("certifiedAssets.put_chunk({");
  expect(backend).toContain("certifiedAssets.stage_status(stage.stage_id)");
  expect(backend).toContain("case (#ok(#consumed(_)))");
  expect(backend).toContain("case (#ok(#consumed(terminal)))");
  expect(backend).toContain("body = #stage(stage.stage_id)");
  expect(backend).toContain("body = #inline(body)");
  expect(backend).toContain("condition = #absent");
  expect(backend).toContain("content_tag = identity.content_tag");
  expect(backend).toContain("#allocate_publication({");
  expect(backend).toContain("#derive_body_sha256({");
  expect(backend).toContain('collection = "publication_demo"');
  expect(backend).toContain('collection = "immutable_blob_demo"');
  expect(backend).toContain('collection = "mutable_blob_demo"');
  expect(backend).toContain("locator = #key32({ key = MUTABLE_BLOB_KEY })");
  expect(backend).not.toContain("Files");
  expect(backend).not.toContain("Wagyu");
  expect(backend).not.toContain("clear_mount");
  expect(backend).not.toContain("post_demo");
  expect(backend).toContain('store = "notes"');
  expect(backend).toContain("condition = #if_absent");
  expect(backend).toContain("condition = #if_revision(revision)");
  expect(backend).toContain("expected_revision = ?revision");
  expect(backend).toContain("limit = 2");
  expect(backend).toContain("app_calls : AppCalls");
  expect(backend).toContain("appCalls.contacts.contacts_neutron_revision_v2(())");
  expect(backend).toContain("minimum_version = 101");
  expect(backend).toContain("/*caller,canister_principal,memory_kitchensink*/");
  expect(backend).toContain("counter = kitchensinkMemory.counter");
  expect(backend).not.toContain("sign_with_ecdsa");
  expect(backend).not.toContain("sign_with_schnorr");
  expect(backend).not.toMatch(/\bquery\s*=/);
  expect(capabilityFrontend).toContain("A local PocketIC network may not provide an HTTPS adapter");
  expect(capabilityFrontend).not.toContain("fetch(");
  expect(capabilityFrontend).toContain("foreignToolEndpoints");
  expect(platformFrontend).toContain("openAppTile({");
  expect(platformFrontend).toContain("function TrayPage()");
  expect(platformFrontend).toContain("new TrayDemoClient()");
  expect(platformFrontend).toContain("BigInt(next.revision) >= BigInt(current.revision)");
  expect(platformFrontend).toContain("function WalletFundingPage()");
  expect(platformFrontend).toContain("Kitchen Sink stops after Wallet returns");
  expect(platformFrontend).toContain('view: "approvals"');
  expect(walletFundingDemo).toContain('WALLET_FUNDING_TARGET = "app:wallet:background"');
  expect(walletFundingDemo).toContain('WALLET_FUNDING_TOOL = "wallet_fund_v1"');
  expect(walletFundingDemo).toContain('ICP_LEDGER = "ryjl3-tyaaa-aaaaa-aaaba-cai"');
  expect(walletFundingDemo).toContain('NEUTRINITE_GOVERNANCE = "eqsml-lyaaa-aaaaq-aacdq-cai"');
  expect(walletFundingDemo).toContain('ICP_SWAP_AMOUNT_ATOMS = "1000000"');
  expect(walletFundingDemo).not.toContain("icrc1_transfer");
  expect(walletFundingDemo).not.toContain("icrc2_approve");
  expect(walletFundingDemo).not.toContain("icrc2_transfer_from");
  expect(backend).not.toContain("icrc2_transfer_from");
});

test("kitchen sink resident service owns bounded tray state", async () => {
  const service = await readFile(serviceUrl, "utf8");
  const trayFrontend = await readFile(trayFrontendUrl, "utf8");

  expect(service).toContain("let notifications: TrayDemoNotification[] = []");
  expect(service).toContain("setTrayState({ badge: unread > 0 ? unread : null })");
  expect(service).toContain("TRAY_DEMO_NOTIFICATION_LIMIT");
  expect(service).toContain("TRAY_DEMO_TOOLS.snapshot");
  expect(service).toContain("TRAY_DEMO_TOOLS.add");
  expect(service).toContain("TRAY_DEMO_TOOLS.markRead");
  expect(service).toContain("TRAY_DEMO_TOOLS.markAllRead");
  expect(service).toContain("publishAppStateChange(TRAY_DEMO_TOPIC, publishRevision)");
  for (const tool of [
    "capability_agent_demo",
    "capability_background_ui",
    "capability_storage_status",
    "capability_storage_write",
    "capability_storage_clear",
    "capability_connection_status",
    "capability_connection_connect",
    "capability_connection_disconnect",
  ]) {
    expect(service).toContain(`"${tool}"`);
  }
  expect(service).toContain("requireOwnTile(context)");
  expect(service).toContain("if (!context.signal)");
  expect(service).toContain("requiredCrossAppEndpoint(args.target)");
  expect(service).toContain("queueTraySync(committedRevision)");
  expect(service).toContain("sensitive.credential = \"\"");
  expect(service).not.toContain("credential: sensitive.credential");
  expect(trayFrontend).toContain("dismissTray");
  expect(trayFrontend).toContain('event.key !== "Escape"');
  expect(trayFrontend).toContain("onAppStateChange(TRAY_DEMO_TOPIC");
  expect(trayFrontend).toContain("BigInt(next.revision) < BigInt(current.revision)");
  expect(trayFrontend).toContain('data-tid="kitchen-tray"');
});

test("background UI demo exposes both declared request categories", async () => {
  const capabilityLab = await readFile(
    new URL("../src/capability_lab.tsx", import.meta.url),
    "utf8",
  );
  expect(capabilityLab).toContain('name: "capability_background_ui"');
  expect(capabilityLab).toContain('name: "capability_connection_connect"');
  expect(capabilityLab).toContain("Request peer tool");
  expect(capabilityLab).toContain("Request connection");
});

test("kitchen sink exposed schemas pass shared tool hardening", () => {
  expect(() =>
    normalizeToolDescriptor({
      name: "tray_demo_snapshot",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      outputSchema: trayDemoSnapshotSchema,
    }),
  ).not.toThrow();

  expect(() =>
    normalizeToolDescriptor({
      name: "counter_increment",
      inputSchema: counterIncrementInputSchema,
    }),
  ).not.toThrow();
});

test("kitchen sink package contains self-contained frontend assets", async () => {
  const bytes = await readFile(packageUrl);
  const unpacked = unpackNeutronPackage(bytes);
  const paths = Object.keys(unpacked).sort();

  expect(paths).toContain("web/main.css");
  expect(paths).toContain("web/index.html");
  expect(paths).toContain("web/main.js");
  expect(paths).toContain("web/service.html");
  expect(paths).toContain("web/service.js");
  expect(paths).toContain("web/tray.html");
  expect(paths).toContain("web/tray.css");
  expect(paths).toContain("web/tray.js");
  expect(paths).toContain("web/static/tray-demo.svg");
  expect(paths).toContain("schema.json");
  expect(unpacked[NEUTRON_BROWSER_SURFACE_ORIGINS_MARKER_PATH]).toEqual(
    browserSurfaceOriginsPackageMarkerBytes(),
  );

  for (const path of paths) {
    assertAllowedPackagePath(path);
    if (
      path.endsWith(".html") ||
      path.endsWith(".css") ||
      path.endsWith(".js") ||
      path.endsWith(".svg") ||
      path.endsWith(".json")
    ) {
      assertNoUnsafeResourceReferences(path, decoder.decode(unpacked[path]));
    }
  }

  const prepared = preparePackageInstall(unpacked);
  expect(prepared.files.map((file) => file.path)).toContain(
    "app/kitchensink/main.css",
  );
  expect(prepared.files.map((file) => file.path)).toContain(
    "app/kitchensink/tray.css",
  );
  expect(prepared.manifest.background).toMatchObject({ path: "service.html" });
  expect(prepared.manifest.tray).toMatchObject({ path: "tray.html" });
});

test("kitchen sink emits wrapper-accurate app method schemas", async () => {
  const manifest = await readManifest();
  const backend = await readBackend();
  const artifact = generateAppMethodSchemaArtifact(manifest, backend);

  expect(artifact.methods.public_status).toMatchObject({
    type: "query",
    input: {
      type: "array",
      minItems: 1,
      maxItems: 1,
      prefixItems: [{ type: "null" }],
    },
  });
  expect(artifact.methods.read_profile).toMatchObject({
    input: {
      type: "array",
      minItems: 1,
      maxItems: 1,
      prefixItems: [{ type: "null" }],
    },
  });
  expect(artifact.methods.save_profile).toMatchObject({
    type: "update",
    input: {
      type: "array",
      minItems: 1,
      maxItems: 1,
      prefixItems: [
        {
          type: "array",
          minItems: 4,
          maxItems: 4,
          prefixItems: [
            { type: "string" },
            { type: "string" },
            { type: "string" },
            { type: "boolean" },
          ],
        },
      ],
    },
    output: {
      type: "string",
    },
  });
  expect(artifact.methods.add).toMatchObject({
    input: {
      type: "array",
      minItems: 1,
      maxItems: 1,
      prefixItems: [
        {
          type: "array",
          minItems: 2,
          maxItems: 2,
          prefixItems: [
            { type: "string", description: "bigint as string" },
            { type: "string", description: "bigint as string" },
          ],
        },
      ],
    },
    output: {
      type: "string",
      description: "bigint as string",
    },
  });
  expect(artifact.methods.bump_counter).toMatchObject({
    input: {
      type: "array",
      minItems: 1,
      maxItems: 1,
      prefixItems: [{ type: "string", description: "bigint as string" }],
    },
  });
  expect(artifact.methods.read_counter).toMatchObject({
    type: "query",
    input: {
      type: "array",
      minItems: 1,
      maxItems: 1,
      prefixItems: [{ type: "null" }],
    },
    output: {
      type: "string",
      description: "bigint as string",
    },
  });
  expect(artifact.methods.chain_key_public_key).toMatchObject({
    type: "update",
    input: {
      type: "array",
      minItems: 1,
      maxItems: 1,
      prefixItems: [{ type: "null" }],
    },
    output: {
      type: "object",
      additionalProperties: false,
      required: expect.arrayContaining([
        "ok",
        "error",
        "slot",
        "algorithm",
        "public_key_hex",
        "key_fingerprint_hex",
        "signing_domain_hex",
        "namespace_version",
        "message_format",
      ]),
    },
  });
  expect(artifact.methods.chain_key_sign_receipt).toMatchObject({
    type: "update",
    input: {
      type: "array",
      minItems: 1,
      maxItems: 1,
      prefixItems: [{ type: "null" }],
    },
    output: {
      type: "object",
      additionalProperties: false,
      required: expect.arrayContaining([
        "ok",
        "error",
        "assertion_text",
        "slot",
        "algorithm",
        "digest_hex",
        "signature_hex",
        "signing_domain_hex",
        "message_format",
      ]),
    },
  });
  expect(artifact.methods.scheduled_status).toMatchObject({
    type: "query",
    output: {
      type: "object",
      required: expect.arrayContaining([
        "interval_seconds",
        "last_counter",
        "runs",
        "task_id",
      ]),
      properties: {
        interval_seconds: {
          type: "string",
          description: "bigint as string",
        },
        last_counter: {
          type: "string",
          description: "bigint as string",
        },
        runs: {
          type: "string",
          description: "bigint as string",
        },
        task_id: { type: "string" },
      },
    },
  });
  expect(artifact.methods.stable_notes_list).toMatchObject({
    type: "query",
    input: {
      type: "array",
      prefixItems: [{
        type: "array",
        prefixItems: [
          { type: "string" },
          { type: "boolean" },
          { type: "string" },
          { type: "string" },
        ],
      }],
    },
    output: {
      type: "object",
      required: expect.arrayContaining([
        "entries",
        "has_more",
        "next_namespace_uid",
        "next_after",
        "observed_revision",
      ]),
    },
  });

  expect(
    validateAppMethodArgs(artifact, "save_profile", [
      ["Ada", "ada@example.test", "Notes", true],
    ]).valid,
  ).toBe(true);
  expect(
    validateAppMethodArgs(artifact, "save_profile", [
      "Ada",
      "ada@example.test",
      "Notes",
      true,
    ]).valid,
  ).toBe(false);
  expect(validateAppMethodArgs(artifact, "public_status", [null]).valid).toBe(
    true,
  );
  expect(validateAppMethodArgs(artifact, "public_status", []).valid).toBe(
    false,
  );
  expect(validateAppMethodArgs(artifact, "add", [["21", "21"]]).valid).toBe(
    true,
  );
  expect(validateAppMethodArgs(artifact, "add", [[21, 21]]).valid).toBe(false);
  expect(validateAppMethodArgs(artifact, "bump_counter", ["1"]).valid).toBe(
    true,
  );
  expect(validateAppMethodArgs(artifact, "bump_counter", [1]).valid).toBe(
    false,
  );
  expect(
    validateAppMethodArgs(artifact, "stable_notes_create", [
      ["notes/alpha", "value"],
    ]).valid,
  ).toBe(true);
  expect(
    validateAppMethodArgs(artifact, "stable_notes_create", [
      "notes/alpha",
      "value",
    ]).valid,
  ).toBe(false);
  expect(
    validateAppMethodArgs(artifact, "stable_notes_list", [
      ["notes/", false, "0", ""],
    ]).valid,
  ).toBe(true);
});
