import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import type { NeutronManifest } from "neutron-tools/src/schema.js";
import { validate_neutron_conf } from "neutron-tools/src/validate_schema.js";

const manifestUrl = new URL("../neutron.json", import.meta.url);
const serviceUrl = new URL("../src/service.ts", import.meta.url);

const VAULT_METHOD_CONTRACT = [
  "files_bootstrap_v2",
  "files_list_v2",
  "files_lookup_v2",
  "files_read_chunk_v2",
  "files_operation_status_v2",
  "files_vault_write_v2",
  "files_write_block_v2",
  "files_mutate_v2",
  "files_remove_v2",
  "files_abort_v2",
  "files_cleanup_v2",
] as const;

const PLAIN_METHOD_CONTRACT = [
  "files_plain_list_v3",
  "files_plain_stat_v3",
  "files_plain_read_chunk_v3",
  "files_plain_write_block_v3",
  "files_plain_mkdir_v3",
  "files_plain_move_v3",
  "files_plain_remove_v3",
  "files_plain_abort_v3",
  "files_plain_cleanup_v3",
] as const;

const METHOD_CONTRACT = [
  ...VAULT_METHOD_CONTRACT,
  ...PLAIN_METHOD_CONTRACT,
] as const;

const QUERY_METHODS = new Set<string>([
  ...VAULT_METHOD_CONTRACT.slice(0, 5),
  ...PLAIN_METHOD_CONTRACT.slice(0, 3),
]);

async function readManifest(): Promise<NeutronManifest> {
  return JSON.parse(await readFile(manifestUrl, "utf8")) as NeutronManifest;
}

test("Files manifest freezes the exact Vault V2 and plaintext V3 self-call surfaces", async () => {
  const manifest = await readManifest();
  expect(validate_neutron_conf(manifest)).toMatchObject({ valid: true });

  expect(manifest.capabilities?.preapproved_self_calls).toEqual({
    api: 1,
    methods: [...METHOD_CONTRACT],
  });

  expect(manifest.func).toEqual(
    Object.fromEntries(
      METHOD_CONTRACT.map((method) => [
        method,
        { type: QUERY_METHODS.has(method) ? "query" : "update", async: false },
      ]),
    ),
  );
  expect(Object.keys(manifest.func ?? {})).toHaveLength(20);
});

test("Files declares only its bounded certified Shared store", async () => {
  const manifest = await readManifest();

  expect(manifest.backend).toEqual({
    capabilities: {
      certified_assets: { api: 2 },
    },
  });
  expect(manifest.capabilities).not.toHaveProperty("http_routes");
  expect(manifest.capabilities?.certified_assets).toEqual({
    api: 2,
    max_entries: 768,
    max_committed_bytes: 201_326_592,
    max_object_bytes: 67_108_864,
    max_pending_stages: 1,
    max_staged_bytes: 67_108_864,
    max_batch_operations: 1,
    max_batch_bytes: 67_108_864,
    max_idempotency_receipts: 2_048,
    collections: [
      {
        id: "shares",
        mount: "shares",
        kind: "publication",
      },
    ],
  });
});

test("Files Vault key custody uses the persistent background surface", async () => {
  const manifest = await readManifest();

  expect(manifest.capabilities?.vetkeys).toEqual({
    api: 1,
    description: "Protect files kept in Vault",
    slots: [
      {
        id: "files_vault",
        purpose: "Keep Vault files protected",
      },
    ],
  });
  expect(manifest.capabilities?.persistent_browser_storage).toEqual({
    api: 1,
    surface: "background",
  });
  expect(manifest.capabilities?.background_ui_requests).toEqual({
    api: 1,
    categories: ["frontend_tool"],
  });
});

test("Files has no ingress, timer, or raw backend authority", async () => {
  const manifest = await readManifest();
  const capabilities = manifest.capabilities as Record<string, unknown>;
  const backendCapabilities = manifest.backend?.capabilities as Record<
    string,
    unknown
  >;

  expect(Object.keys(capabilities).sort()).toEqual(
    [
      "background_ui_requests",
      "certified_assets",
      "persistent_browser_storage",
      "preapproved_self_calls",
      "vetkeys",
    ].sort(),
  );
  for (const forbidden of [
    "backend_calls",
    "connections",
    "dedicated_resident_origin",
    "public_ingress",
    "scheduled_tasks",
    "stable_store",
  ]) {
    expect(capabilities).not.toHaveProperty(forbidden);
  }
  expect(backendCapabilities).not.toHaveProperty("vetkeys_public");
  expect(manifest).not.toHaveProperty("timers");
  expect(manifest).not.toHaveProperty("timer");
  for (const declaration of Object.values(manifest.func ?? {})) {
    expect(declaration).not.toHaveProperty("allow");
    expect(declaration).not.toHaveProperty("arg");
    expect(declaration).not.toHaveProperty("expose");
  }
});

test("Files release advances managed memory through one V1-to-V2 migration", async () => {
  const manifest = await readManifest();
  expect(manifest.memory).toEqual({
    files: {
      version: 2,
      schemas: {
        "1": { src: "memory/files/v1.mo" },
        "2": { src: "memory/files/v2.mo" },
      },
      migrations: [
        {
          from: 1,
          to: 2,
          src: "memory/files/v1_to_v2.mo",
        },
      ],
    },
  });
});

test("Files tool audit annotations, when declared inline, use only metadata_only", async () => {
  const service = await readFile(serviceUrl, "utf8");
  const auditValues = Array.from(
    service.matchAll(
      /["']neutron:audit["']\s*:\s*["']([^"']+)["']/gu,
    ),
    (match) => match[1],
  );

  expect(new Set(auditValues)).not.toContain("full");
  expect(new Set(auditValues)).not.toContain("none");
  if (auditValues.length > 0) {
    expect(new Set(auditValues)).toEqual(new Set(["metadata_only"]));
  }
});
