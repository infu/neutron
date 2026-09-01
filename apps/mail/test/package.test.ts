import { expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import msgpack5 from "msgpack5";
import {
  NEUTRON_BROWSER_SURFACE_ORIGINS_MARKER_PATH,
  browserSurfaceOriginsPackageMarkerBytes,
} from "neutron-tools/src/package_surface_origins.ts";
import { physicalPublicIngressMethodName } from "neutron-tools/src/physical_names.js";
import type { NeutronManifest } from "neutron-tools/src/schema.js";
import { validate_neutron_conf } from "neutron-tools/src/validate_schema.js";

const manifestUrl = new URL("../neutron.json", import.meta.url);
const distUrl = new URL("../dist/", import.meta.url);

test(
  "Mail paid handlers use the kernel cycle proof and retain only self-mail caller rejection",
  async () => {
    const [backend, receive] = await Promise.all([
      readFile(new URL("../backend/main.mo", import.meta.url), "utf8"),
      readFile(new URL("../backend/mailbox/Receive.mo", import.meta.url), "utf8"),
    ]);
    expect(backend).not.toContain("Principal.isCanister(caller)");
    expect(receive).not.toContain("not Principal.isCanister(caller)");
    expect(backend).toContain("Principal.equal(caller, selfCanister)");
    expect(receive).toContain("Principal.equal(caller, selfCanister)");
  },
);

test("Mail declares ciphertext memory, Contacts V2, owner APIs, and only two public methods", async () => {
  const manifest = JSON.parse(await readFile(manifestUrl, "utf8")) as NeutronManifest;
  expect(validate_neutron_conf(manifest).errors).toEqual([]);
  expect(manifest).toMatchObject({
    format: 3,
    id: "mail",
    version: 305,
    update_source: "233tv-xiaaa-aaaay-aacta-cai",
    background: { path: "service.html" },
    tray: { path: "tray.html", icon: "static/icon.svg" },
    tiles: [{ id: "mail", path: "index.html", icon: "static/icon.svg" }],
    backend: {
      capabilities: {
        backend_calls: { api: 1 },
        vetkeys_public: { api: 1 },
      },
    },
    dependencies: {
      contacts: {
        app: "contacts",
        min_version: 101,
        functions: [
          "contacts_neutron_lookup_v2",
          "contacts_neutron_search_v2",
          "contacts_neutron_revision_v2",
        ],
      },
    },
    memory: { mail: { version: 1 } },
  });
  expect(manifest).not.toHaveProperty("init_arg");
  expect(Object.keys(manifest.func ?? {}).sort()).toEqual([
    "mail_cleanup",
    "mail_cleanup_preview",
    "mail_crypto_rewrap",
    "mail_crypto_rotate",
    "mail_crypto_setup",
    "mail_crypto_status",
    "mail_delete",
    "mail_get_encrypted",
    "mail_key_info_v1",
    "mail_list_encrypted",
    "mail_mark",
    "mail_prepare_recipient",
    "mail_pulse",
    "mail_receive_v1",
    "mail_recipients",
    "mail_retry",
    "mail_send_encrypted",
    "mail_settings_encrypted",
    "mail_settings_set_encrypted",
    "mail_status",
  ]);
  expect(manifest.capabilities?.preapproved_self_calls?.methods).toEqual([
    "mail_pulse",
    "mail_status",
    "mail_crypto_status",
    "mail_crypto_setup",
    "mail_crypto_rotate",
    "mail_crypto_rewrap",
    "mail_list_encrypted",
    "mail_get_encrypted",
    "mail_recipients",
    "mail_settings_encrypted",
    "mail_settings_set_encrypted",
    "mail_prepare_recipient",
    "mail_send_encrypted",
    "mail_retry",
    "mail_mark",
    "mail_delete",
    "mail_cleanup_preview",
    "mail_cleanup",
  ]);
  expect(manifest.func?.mail_recipients).toMatchObject({
    type: "query",
    async: false,
  });
  expect(manifest.func?.mail_settings_encrypted).toMatchObject({
    type: "query",
    async: false,
  });
  expect(manifest.func?.mail_settings_set_encrypted).toMatchObject({
    type: "update",
    async: false,
  });
  for (const method of [
    "mail_prepare_recipient",
    "mail_send_encrypted",
    "mail_retry",
  ] as const) {
    expect(manifest.func?.[method]).toMatchObject({
      type: "update",
      async: "async*",
    });
  }
  expect(manifest.func?.mail_key_info_v1).toMatchObject({
    type: "update",
    async: false,
    arg: ["caller"],
  });
  expect(manifest.func?.mail_receive_v1).toMatchObject({
    type: "update",
    async: false,
    arg: ["caller"],
  });
  const unauthorized = Object.entries(manifest.func ?? {})
    .filter(([, config]) => config.allow === "unauthorized")
    .map(([name]) => name)
    .sort();
  expect(unauthorized).toEqual([]);
  expect(manifest.capabilities?.public_ingress?.routes).toEqual([
    expect.objectContaining({
      protocol: "mail_v1",
      id: "key_info",
      handler: "mail_key_info_v1",
      mode: "update",
      caller: "canister",
      required_cycles: 50_000_000,
    }),
    expect.objectContaining({
      protocol: "mail_v1",
      id: "receive",
      handler: "mail_receive_v1",
      mode: "update",
      caller: "canister",
      required_cycles: 250_000_000,
    }),
  ]);
  expect(manifest.capabilities?.backend_calls).toMatchObject({
    api: 1,
    reservation_scopes: ["method"],
    install_reservations: [{
      kind: "method",
      method: physicalPublicIngressMethodName("mail", "mail_v1", "update"),
    }],
    max_concurrency: 4,
    max_cycles_per_call: 250_000_000,
    max_cycles_per_day: 1_000_000_000_000,
  });
  expect(manifest.capabilities?.vetkeys).toMatchObject({
    api: 1,
    description: "Encrypt and decrypt private Mail on demand in this browser",
    slots: [{ id: "mailbox", purpose: "Encrypt and decrypt private Mail" }],
  });
  expect(JSON.stringify(manifest.capabilities?.vetkeys)).not.toMatch(/unlock/iu);
  expect(manifest.capabilities?.persistent_browser_storage).toEqual({
    api: 1,
    surface: "background",
  });
});

test("Mail bundles private product surfaces, kernel-authorized tools, and badge recovery", async () => {
  const [main, service, tray, indexHtml, serviceHtml, agentTools, statusTool] = await Promise.all([
    readFile(new URL("../dist/web/main.js", import.meta.url), "utf8"),
    readFile(new URL("../dist/web/service.js", import.meta.url), "utf8"),
    readFile(new URL("../dist/web/tray.js", import.meta.url), "utf8"),
    readFile(new URL("../dist/web/index.html", import.meta.url), "utf8"),
    readFile(new URL("../dist/web/service.html", import.meta.url), "utf8"),
    readFile(new URL("../src/agent_tools.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/status_tool.ts", import.meta.url), "utf8"),
  ]);
  expect(main).toContain("Private Mail");
  expect(main).toContain("mail_list_encrypted");
  expect(main).toContain("mail_get_encrypted");
  expect(main).toContain("mail_cleanup_preview");
  expect(main).toContain("Set up private Mail");
  expect(main).not.toContain("Agent plaintext access");
  expect(main).not.toContain("OpenRouter");
  expect(service).toContain("mail_help");
  expect(service).toContain("mail_status");
  for (const tool of [
    "mail_plaintext_consent_status",
    "mail_plaintext_consent_grant",
    "mail_plaintext_consent_revoke",
  ]) {
    expect(service).not.toContain(tool);
  }
  expect(service).not.toContain("exact agent provider");
  expect(service).not.toContain("plaintext-provider consent");
  for (const providerField of ["providerAppId", "providerName", "modelName"]) {
    expect(main).not.toContain(providerField);
    expect(service).not.toContain(providerField);
  }
  for (const tool of [
    "mail_recipients",
    "mail_list",
    "mail_search",
    "mail_get",
    "mail_send",
    "mail_reply",
    "mail_retry",
    "mail_mark",
    "mail_delete",
    "mail_cleanup_preview",
    "mail_cleanup",
    "mail_settings",
  ]) {
    expect(service).toContain(tool);
  }
  expect(service).toContain("canister.update_self");
  expect(service).toContain("external_untrusted");
  expect(service).toContain("neutron-mail-crypto");
  expect(service).toContain("new Blob");
  expect(service).not.toContain("crypto_worker.js");
  expect(service).toContain("Secure WebCrypto AES-GCM is unavailable");
  expect(service).toContain("neutron-browser-secret-cache-v1");
  expect(service).toContain("neutron.mail.vetkey-cache.binding.v1");
  expect(service).toContain("indexedDB");
  expect(main).not.toContain("neutron-browser-secret-cache-v1");
  expect(tray).not.toContain("neutron-browser-secret-cache-v1");
  // Keep resident tool descriptors compatible with Neutron's deliberately
  // conservative JSON-schema pattern policy. RegExp literals used by Mail's
  // own parsers are unaffected by this descriptor-only assertion.
  expect(agentTools).not.toMatch(/pattern:\s*["']\^\(/u);
  expect(statusTool).not.toMatch(/pattern:\s*["']\^\(/u);
  expect(serviceHtml).toContain("worker-src blob:");
  expect(serviceHtml).not.toContain("worker-src 'self'");
  // esbuild may preserve 30000 or shorten the same numeric literal to 3e4.
  expect(service).toMatch(/(?:30000|3e4)/);
  expect(tray).toContain("Open Mail");
  expect(tray).toContain("Recent mail");
  expect(tray).toContain("Private message");
  expect(tray).toContain("mail_list_encrypted");
  expect(indexHtml).toContain("Content-Security-Policy");
});

test("Mail's external icon has an explicit light stroke for the dark tray", async () => {
  const icon = await readFile(
    new URL("../public/static/icon.svg", import.meta.url),
    "utf8",
  );
  expect(icon).toContain('stroke="#fff"');
  expect(icon).not.toContain("currentColor");
});

test("mail_pulse stays a scalar-only constant-cost mailbox query", async () => {
  const source = await readFile(
    new URL("../backend/mailbox/Store.mo", import.meta.url),
    "utf8",
  );
  const pulseStart = source.indexOf("public func pulse()");
  const statusStart = source.indexOf("public func status()", pulseStart);
  expect(pulseStart).toBeGreaterThan(-1);
  expect(statusStart).toBeGreaterThan(pulseStart);
  const pulse = source.slice(pulseStart, statusStart);
  expect(pulse).toContain("validHotState(mem)");
  for (const field of [
    "mail_revision",
    "contacts_revision",
    "cleanup_epoch",
    "inbox_count",
    "unread_count",
  ]) {
    expect(pulse).toContain(field);
  }
  expect(pulse).not.toMatch(/\b(?:for|while)\b/u);
  expect(pulse).not.toContain("scanStatusCounts");
  expect(pulse).not.toContain("validateState");

  const gateStart = source.indexOf("func validHotState(");
  const deepValidationStart = source.indexOf("func validateState(", gateStart);
  expect(gateStart).toBeGreaterThan(-1);
  expect(deepValidationStart).toBeGreaterThan(gateStart);
  const gate = source.slice(gateStart, deepValidationStart);
  expect(gate).not.toMatch(/\b(?:for|while)\b/u);
  expect(gate).not.toContain("validateState");
});

test("Mail's checked-in install artifact carries the complete generated method schema", async () => {
  const [sourceManifestText, distManifestText, schemaText, lockText, archive] =
    await Promise.all([
      readFile(manifestUrl, "utf8"),
      readFile(new URL("../dist/neutron.json", import.meta.url), "utf8"),
      readFile(new URL("../dist/schema.json", import.meta.url), "utf8"),
      readFile(new URL("../dist/neutron.lock.json", import.meta.url), "utf8"),
      readFile(new URL("../mail.v0.3.5.neutron", import.meta.url)),
    ]);
  const sourceManifest = JSON.parse(sourceManifestText) as NeutronManifest;
  const distManifest = JSON.parse(distManifestText) as NeutronManifest & {
    entry?: string;
  };
  const schema = JSON.parse(schemaText) as {
    methods: Record<string, {
      allow?: string;
      type?: string;
      output?: {
        properties?: Record<string, unknown>;
        required?: string[];
        additionalProperties?: boolean;
      };
    }>;
  };
  const lock = JSON.parse(lockText) as {
    app?: string;
    memory?: Record<string, { schemas?: Record<string, { entry?: string }> }>;
  };
  const methods = Object.keys(sourceManifest.func ?? {}).sort();

  expect(Object.keys(distManifest.func ?? {}).sort()).toEqual(methods);
  expect(distManifest.capabilities?.backend_calls).toEqual(
    sourceManifest.capabilities?.backend_calls,
  );
  expect(Object.keys(schema.methods).sort()).toEqual(methods);
  expect(
    Object.entries(schema.methods)
      .filter(([, method]) => method.allow === "unauthorized")
      .map(([name]) => name)
      .sort(),
  ).toEqual([]);
  expect(schema.methods.mail_status?.type).toBe("query");
  expect(schema.methods.mail_pulse?.type).toBe("query");
  const pulseFields = [
    "mail_revision",
    "contacts_revision",
    "cleanup_epoch",
    "inbox_count",
    "unread_count",
  ].sort();
  expect(Object.keys(schema.methods.mail_pulse?.output?.properties ?? {}).sort())
    .toEqual(pulseFields);
  expect([...(schema.methods.mail_pulse?.output?.required ?? [])].sort())
    .toEqual(pulseFields);
  expect(schema.methods.mail_pulse?.output?.additionalProperties).toBe(false);
  expect(schema.methods.mail_receive_v1?.type).toBe("update");
  expect(distManifest.entry).toMatch(/^[0-9a-f]{64}$/u);
  expect(lock.app).toBe("mail");
  expect(lock.memory?.mail?.schemas?.["1"]?.entry).toMatch(/^[0-9a-f]{64}$/u);
  expect(archive.byteLength).toBeGreaterThan(100_000);

  const packed = msgpack5().decode(archive) as Record<string, Uint8Array>;
  const distFiles = await readDistFiles(distUrl);
  distFiles.set(
    NEUTRON_BROWSER_SURFACE_ORIGINS_MARKER_PATH,
    Buffer.from(browserSurfaceOriginsPackageMarkerBytes()),
  );
  expect(Object.keys(packed).sort()).toEqual([...distFiles.keys()].sort());
  for (const [path, bytes] of distFiles) {
    const packedBytes = packed[path];
    if (!packedBytes || !gunzipSync(packedBytes).equals(bytes)) {
      throw new Error(`Packed Mail artifact is stale at dist/${path}`);
    }
  }
  const packedManifestBytes = packed["neutron.json"];
  const packedSchemaBytes = packed["schema.json"];
  expect(packedManifestBytes).toBeDefined();
  expect(packedSchemaBytes).toBeDefined();
  const packedManifest = JSON.parse(
    gunzipSync(packedManifestBytes!).toString("utf8"),
  ) as NeutronManifest & { entry?: string };
  const packedSchema = JSON.parse(
    gunzipSync(packedSchemaBytes!).toString("utf8"),
  ) as { methods?: Record<string, unknown> };
  expect(packedManifest.entry).toBe(distManifest.entry);
  expect(packedManifest.capabilities?.backend_calls).toEqual(
    sourceManifest.capabilities?.backend_calls,
  );
  expect(Object.keys(packedSchema.methods ?? {}).sort()).toEqual(methods);
});

async function readDistFiles(
  directory: URL,
  prefix = "",
  files = new Map<string, Buffer>(),
): Promise<Map<string, Buffer>> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = `${prefix}${entry.name}`;
    const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
    if (entry.isDirectory()) {
      await readDistFiles(url, `${path}/`, files);
    } else if (entry.isFile()) {
      files.set(path, await readFile(url));
    }
  }
  return files;
}
