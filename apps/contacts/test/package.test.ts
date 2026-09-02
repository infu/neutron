import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  preparePackageInstall,
  unpackNeutronPackage,
} from "neutron-compiler/src/install.ts";
import { generateAppMethodSchemaArtifact } from "neutron-scripts/src/method_schema.js";
import type { NeutronManifest } from "neutron-tools/src/schema.js";
import { validate_neutron_conf } from "neutron-tools/src/validate_schema.js";

const manifestUrl = new URL("../neutron.json", import.meta.url);
const backendUrl = new URL("../backend/main.mo", import.meta.url);
const memoryV1Url = new URL("../backend/memory/contacts/v1.mo", import.meta.url);
const memoryV2Url = new URL("../backend/memory/contacts/v2.mo", import.meta.url);
const migrationUrl = new URL(
  "../backend/memory/contacts/v1_to_v2.mo",
  import.meta.url,
);
const packageUrl = new URL("../contacts.v0.3.6.neutron", import.meta.url);

async function manifest(): Promise<NeutronManifest> {
  return JSON.parse(await readFile(manifestUrl, "utf8")) as NeutronManifest;
}

function internetComputerPropertySchemas(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value.flatMap(internetComputerPropertySchemas);
  }
  if (value === null || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  return [
    ...(Object.prototype.hasOwnProperty.call(record, "internet_computer")
      ? [record.internet_computer]
      : []),
    ...Object.values(record).flatMap(internetComputerPropertySchemas),
  ];
}

test("Contacts V2 declares one migrated private memory and five resident tools", async () => {
  const value = await manifest();
  expect(validate_neutron_conf(value).errors).toEqual([]);
  expect(value).toMatchObject({
    format: 3,
    id: "contacts",
    version: 306,
    update_source: "233tv-xiaaa-aaaay-aacta-cai",
    capabilities: {
      preapproved_self_calls: {
        api: 1,
        methods: [
          "contacts_revision",
          "contacts_search",
          "contacts_get",
          "contacts_resolve",
          "contacts_save",
          "contacts_remove",
        ],
      },
    },
    memory: {
      contacts: {
        version: 2,
        schemas: {
          "1": { src: "memory/contacts/v1.mo" },
          "2": { src: "memory/contacts/v2.mo" },
        },
        migrations: [
          {
            from: 1,
            to: 2,
            src: "memory/contacts/v1_to_v2.mo",
          },
        ],
      },
    },
  });
  expect(value).not.toHaveProperty("init_arg");
  expect(value.background).not.toHaveProperty("persistent_storage");
  expect(value.func?.contacts_discover_v1).toMatchObject({
    type: "internal",
    expose: "apps",
  });
  for (const method of [
    "contacts_neutron_lookup_v2",
    "contacts_neutron_search_v2",
    "contacts_neutron_revision_v2",
  ]) {
    expect(value.func?.[method]).toMatchObject({
      type: "internal",
      async: false,
      expose: "apps",
    });
  }
});

test("Contacts public variants generate method schemas", async () => {
  const artifact = generateAppMethodSchemaArtifact(
    await manifest(),
    await readFile(backendUrl, "utf8"),
  );
  expect(artifact.methods.contacts_save?.output).toMatchObject({
    type: "object",
    properties: {
      book_revision: {
        type: "string",
        description: "bigint as string",
      },
      contact: { type: "object" },
      duplicate_contact_ids: {
        type: "array",
        items: {
          type: "string",
          description: "bigint as string",
        },
      },
    },
    required: ["book_revision", "contact", "duplicate_contact_ids"],
  });
  expect(artifact.methods.contacts_search?.input).toMatchObject({
    type: "array",
    minItems: 1,
    maxItems: 1,
  });
  expect(JSON.stringify(artifact.methods.contacts_save)).toContain("neutron");
  expect(JSON.stringify(artifact.methods.contacts_save)).toContain("principal");
  const accountStringSchema = {
    type: "string",
    description: "icrc1 account or 'id[-sub]' shorthand",
  };
  // icblast advertises its string adapter for both schema directions. Kernel
  // uses that adapter for input, while its API-1 live output projection stays
  // structural; contacts_self_call.test.ts covers that deliberate asymmetry.
  expect(
    internetComputerPropertySchemas(artifact.methods.contacts_save?.input),
  ).toEqual([accountStringSchema]);
  expect(
    internetComputerPropertySchemas(artifact.methods.contacts_save?.output),
  ).toEqual([accountStringSchema]);
});

test("Contacts keeps V1 immutable and V2 memory self-contained", async () => {
  const [v1, v2, migration] = await Promise.all([
    readFile(memoryV1Url, "utf8"),
    readFile(memoryV2Url, "utf8"),
    readFile(migrationUrl, "utf8"),
  ]);
  for (const memory of [v1, v2]) {
    expect(memory).toMatch(/^import Map "mo:core\/Map";$/m);
    expect(memory).not.toMatch(/^import\s+\w+\s+"(?:\.{1,2}\/|\/)/m);
    expect(memory).toContain("contacts : Map.Map<Nat, Contact>");
  }
  expect(v1).not.toContain("#neutron");
  expect(v2).toContain("#neutron : Principal");
  expect(v2).toContain("neutron_index : Map.Map<Principal, Nat>");
  expect(migration).toContain('import V1 "./v1"');
  expect(migration).toContain('import V2 "./v2"');
});

test("Contacts V2 package contains tile, resident, schemas, and Motoko roots", async () => {
  const unpacked = unpackNeutronPackage(await readFile(packageUrl));
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
  const prepared = preparePackageInstall(unpacked);
  expect(prepared.manifest.background).toBeDefined();
  expect(prepared.files.some((file) => file.path.startsWith("mo/"))).toBe(true);
  const frontend = unpacked["web/main.js"];
  expect(frontend).toBeDefined();
  expect(new TextDecoder().decode(frontend!)).toContain("prefill_new_contact");
});
