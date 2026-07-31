import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  assertManifestFunctionExports,
  normalizeManifestBackground,
  normalizeManifestBackend,
  normalizeManifestCapabilities,
  normalizeManifestDependencies,
  normalizeManifestDisplayMetadata,
  normalizeManifestUpdateSource,
  normalizeManifestTray,
  normalizeManifestTiles,
  normalizeUntrustedText,
  normalizeUpdateSourcePrincipal,
  type NeutronCapabilitiesConfig,
  type NeutronManifest,
} from "../src/schema.ts";
import {
  CERTIFIED_HTTP_PATH_SEGMENTS_MAX_V2,
} from "../src/capabilities/catalog.ts";
import {
  assertNeutronManifest,
  createMemoryLock,
  mergeMemoryLock,
} from "../src/memory.ts";
import { validate_neutron_conf } from "../src/validate_schema.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");

function validateManifest(conf: unknown) {
  return validate_neutron_conf(
    conf && typeof conf === "object" && !Array.isArray(conf)
      ? { format: 3, ...(conf as Record<string, unknown>) }
      : conf,
  );
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

function genericCertifiedAssetsManifest(): NeutronManifest {
  return {
    format: 3,
    id: "route_app",
    name: "Route App",
    version: 100,
    background: { path: "service.html" },
    backend: { capabilities: { certified_assets: { api: 2 } } },
    func: {
      receive_webhook: { type: "internal", async: false },
    },
    capabilities: {
      http_routes: {
        api: 1,
        mounts: [
          {
            id: "webhook",
            surface: "shared_app_path",
            methods: ["POST"],
            mode: "http_post_update_handler",
            handler: "receive_webhook",
            max_request_bytes: 16_384,
            max_response_bytes: 4096,
            max_calls_per_hour: 60,
            forward_headers: ["content-type"],
          },
        ],
      },
      certified_assets: {
        api: 2,
        max_entries: 100_000,
        max_committed_bytes: 1_073_741_824,
        max_object_bytes: 1_048_576,
        max_pending_stages: 1,
        max_staged_bytes: 1_048_576,
        max_batch_operations: 16,
        max_batch_bytes: 1_048_576,
        max_idempotency_receipts: 4096,
        collections: [
          {
            id: "status",
            mount: "protocol",
            exact_path: "/v1/status",
            kind: "mutable_blob",
            max_object_bytes: 266_240,
          },
          {
            id: "posts",
            mount: "protocol",
            path_prefix: "/v1/objects/post/sha256/",
            kind: "immutable_blob",
            max_object_bytes: 1_044_480,
          },
          {
            id: "shares",
            mount: "shares",
            kind: "publication",
          },
        ],
      },
    },
  };
}

test("current kernel and sample app manifests validate", async () => {
  const manifests = [
    "apps/kernel/neutron.json",
    "apps/hello/neutron.json",
    "apps/kitchensink/neutron.json",
    "apps/gemma/neutron.json",
    "apps/mail/neutron.json",
    "apps/agent/neutron.json",
  ];

  for (const manifest of manifests) {
    const result = validateManifest(
      await readJson(path.join(repoRoot, manifest)),
    );
    expect(result.errors.map((error) => `${manifest}: ${error.stack}`)).toEqual(
      [],
    );
  }
});

test("schema rejects app ids the installer would reject", () => {
  const base = {
    id: "Bad",
    name: "Bad",
    version: 100,
    src: "main.mo",
  };

  expect(validateManifest(base).errors.length).toBeGreaterThan(0);
  expect(
    validateManifest({ ...base, id: "abc" }).errors.length,
  ).toBeGreaterThan(0);
  expect(validateManifest({ ...base, id: "good_app" }).errors.length).toBe(0);
  for (const id of ["_good_app", "good_app_", "good__app", "____"]) {
    expect(validateManifest({ ...base, id }).errors.length).toBeGreaterThan(0);
  }
});

test("schema rejects malformed manifest structures", () => {
  expect(validateManifest(null).errors.length).toBeGreaterThan(0);
  expect(validateManifest([]).errors.length).toBeGreaterThan(0);
  expect(validateManifest("bad").errors.length).toBeGreaterThan(0);
  expect(
    validateManifest({
      id: "good_app",
      name: "Good App",
    }).errors.length,
  ).toBeGreaterThan(0);
  expect(
    validateManifest({
      id: "../bad",
      name: "Good App",
      version: 100,
    }).errors.length,
  ).toBeGreaterThan(0);
  expect(
    validateManifest({
      id: "good_app",
      name: "Good App",
      version: 100,
      unexpected: true,
    }).errors.length,
  ).toBeGreaterThan(0);
  expect(
    validateManifest({
      id: "good_app",
      name: "Good App",
      version: 100,
      func: {
        run: {
          type: "update",
          allow: "owner",
        },
      },
    }).errors.length,
  ).toBeGreaterThan(0);
  expect(
    validateManifest({
      id: "good_app",
      name: "Good App",
      version: 100,
      func: {
        run: {
          type: "update",
          arg: ["caller", "bad-dash"],
        },
      },
    }).errors.length,
  ).toBeGreaterThan(0);
  expect(
    validateManifest({
      id: "good_app",
      name: "Good App",
      version: 100,
      memory: {
        app: {
          version: 0,
        },
      },
    }).errors.length,
  ).toBeGreaterThan(0);
});

test("manifest update sources are optional canonical non-system principals", () => {
  const updateSource = "rrkah-fqaaa-aaaaa-aaaaq-cai";
  const manifest: NeutronManifest = {
    format: 3,
    id: "good_app",
    name: "Good App",
    version: 100,
    src: "main.mo",
    update_source: updateSource,
  };

  expect(validateManifest(manifest).errors).toEqual([]);
  expect(normalizeManifestUpdateSource(manifest)).toBe(updateSource);
  expect(normalizeUpdateSourcePrincipal(updateSource)).toBe(updateSource);
  expect(() => assertNeutronManifest(manifest, "source")).not.toThrow();
  expect(normalizeManifestUpdateSource({})).toBeUndefined();

  for (const invalid of [
    "aaaaa-aa",
    "2vxsx-fae",
    "RRKAH-FQAAA-AAAAA-AAAAQ-CAI",
    "rrkahfqaaaaaaaaaqcai",
    "not-a-principal",
    "",
  ]) {
    const candidate = { ...manifest, update_source: invalid };
    expect(validateManifest(candidate).valid, invalid).toBe(false);
    expect(
      () => assertNeutronManifest(candidate as NeutronManifest, "source"),
      invalid,
    ).toThrow(/update_source principal/);
  }

  const userPrincipal =
    "pcofx-mj5y3-27jya-3jcsk-jzcy2-2y6yj-bvf32-ousik-tb3ks-uyjkz-rqe";
  expect(
    validateManifest({ ...manifest, update_source: userPrincipal }).valid,
  ).toBe(true);
  expect(() =>
    assertNeutronManifest(
      { ...manifest, update_source: userPrincipal },
      "source",
    ),
  ).toThrow(/canonical canister principal/);
});

test("manifest-derived capability collections have hard source bounds", () => {
  const base = { id: "good_app", name: "Good App", version: 100 };
  expect(
    validateManifest({
      ...base,
      func: Object.fromEntries(
        Array.from({ length: 257 }, (_, index) => [`method_${index}`, {}]),
      ),
    }).errors.length,
  ).toBeGreaterThan(0);
  expect(
    validateManifest({
      ...base,
      func: {
        method: {
          arg: Array.from({ length: 17 }, (_, index) => `resource_${index}`),
        },
      },
    }).errors.length,
  ).toBeGreaterThan(0);
  expect(
    validateManifest({
      ...base,
      memory: Object.fromEntries(
        Array.from({ length: 65 }, (_, index) => [`memory_${index}`, {}]),
      ),
    }).errors.length,
  ).toBeGreaterThan(0);
  expect(
    validateManifest({
      ...base,
      tiles: Array.from({ length: 33 }, (_, index) => ({
        id: `tile_${index}`,
        title: `Tile ${index}`,
      })),
    }).errors.length,
  ).toBeGreaterThan(0);
  expect(
    validateManifest({
      ...base,
      init_arg: Array.from({ length: 65 }, (_, index) => `resource_${index}`),
    }).errors.length,
  ).toBeGreaterThan(0);
});

test("ordinary app initializers are derived while the kernel initializer remains special", () => {
  const app = {
    format: 3 as const,
    id: "good_app",
    name: "Good App",
    version: 100,
    init_arg: ["memory_good_app"],
  };
  expect(validate_neutron_conf(app).valid).toBe(false);
  expect(() => assertNeutronManifest(app, "source")).toThrow(
    /cannot declare init_arg/,
  );

  const kernel: NeutronManifest = {
    format: 3,
    id: "kernel",
    name: "Kernel",
    version: 100,
    init_arg: ["memory_kernel"],
  };
  expect(validate_neutron_conf(kernel).valid).toBe(true);
  expect(() => assertNeutronManifest(kernel, "source")).not.toThrow();
});

test("format 3 and capability-specific API wrappers are the only accepted shape", () => {
  const base = {
    format: 3,
    id: "good_app",
    name: "Good App",
    version: 100,
    background: { path: "service.html" },
    func: { run: { type: "update" } },
  };
  expect(validate_neutron_conf(base).valid).toBe(true);
  for (const oldFormat of [undefined, 1, 2]) {
    const { format: _format, ...withoutFormat } = base;
    const candidate =
      oldFormat === undefined ? withoutFormat : { ...base, format: oldFormat };
    expect(validate_neutron_conf(candidate).valid).toBe(false);
    expect(() =>
      assertNeutronManifest(candidate as unknown as NeutronManifest, "source"),
    ).toThrow(/Unsupported package format/);
  }

  const formerShapes = [
    { connections: [] },
    { background: { path: "service.html", storage: "persistent" } },
    {
      capabilities: {
        backend_calls: {
          description: "Call peers",
          reservation_scopes: ["exact"],
          max_concurrency: 1,
        },
      },
    },
    {
      capabilities: {
        vetkeys: { description: "Private state", slots: [] },
      },
    },
    { capabilities: { scheduled_tasks: [] } },
    { capabilities: { preapproved_self_calls: ["run"] } },
    { capabilities: { agent_entrypoints: ["agent"] } },
    { capabilities: { background_ui_requests: ["frontend_tool"] } },
    {
      capabilities: {
        ethereum_provider: {
          chains: [1],
          methods: ["eth_chainId"],
        },
      },
    },
    { capabilities: {} },
    {
      capabilities: {
        persistent_browser_storage: { api: 2, surface: "background" },
      },
    },
  ];
  for (const oldShape of formerShapes) {
    expect(validate_neutron_conf({ ...base, ...oldShape }).valid).toBe(false);
    expect(() =>
      assertNeutronManifest(
        { ...base, ...oldShape } as unknown as NeutronManifest,
        "source",
      ),
    ).toThrow();
  }
});

test("untrusted display text normalization is Unicode-aware and bounded", () => {
  expect(
    normalizeUntrustedText("Cafe\u0301", "test text", {
      maximumLength: 5,
    }),
  ).toBe("Caf\u00e9");
  expect(
    normalizeUntrustedText("\ud83c\udf1f\ud83c\udf1f", "test text", {
      maximumLength: 2,
    }),
  ).toBe("\ud83c\udf1f\ud83c\udf1f");
  expect(() =>
    normalizeUntrustedText("\ud83c\udf1f\ud83c\udf1f\ud83c\udf1f", "test text", {
      maximumLength: 2,
    }),
  ).toThrow("Invalid test text");
  expect(
    normalizeManifestDisplayMetadata({
      name: "Good App",
      description: "Cafe\u0301",
    }),
  ).toEqual({ name: "Good App", description: "Caf\u00e9" });

});

test("schema and runtime reject invisible, bidi, control, and separator text", () => {
  const prohibited = [
    ["C0 control", "\n"],
    ["C1 control", "\u0085"],
    ["combining grapheme joiner", "\u034f"],
    ["Arabic letter mark", "\u061c"],
    ["Mongolian vowel separator", "\u180e"],
    ["zero-width space", "\u200b"],
    ["zero-width non-joiner", "\u200c"],
    ["zero-width joiner", "\u200d"],
    ["left-to-right mark", "\u200e"],
    ["right-to-left mark", "\u200f"],
    ["bidi embedding", "\u202a"],
    ["bidi override", "\u202e"],
    ["word joiner", "\u2060"],
    ["bidi isolate", "\u2066"],
    ["bidi isolate terminator", "\u2069"],
    ["byte-order mark", "\ufeff"],
    ["variation selector", "\ufe0f"],
    ["line separator", "\u2028"],
    ["paragraph separator", "\u2029"],
  ] as const;

  for (const [label, character] of prohibited) {
    const description = `No${character}access required`;
    const manifest = {
      id: "good_app",
      name: "Good App",
      version: 100,
      capabilities: {
        backend_calls: {
          api: 1 as const,
          description,
          reservation_scopes: ["exact" as const],
          max_concurrency: 1,
          max_cycles_per_call: 0,
          max_cycles_per_day: 0,
        },
      },
    };
    expect(
      validateManifest(manifest).valid,
      `${label} must fail JSON Schema`,
    ).toBe(false);
    expect(
      () => normalizeManifestCapabilities(manifest),
      `${label} must fail runtime normalization`,
    ).toThrow(/backend_calls description/);
  }

  const unsafe = "Kernel\u202everified";
  const displaySurfaces = [
    {
      id: "good_app",
      name: "Good App",
      version: 100,
      description: unsafe,
    },
    {
      id: "good_app",
      name: "Good App",
      version: 100,
      tiles: [{ id: "main", title: unsafe }],
    },
    {
      id: "good_app",
      name: "Good App",
      version: 100,
      tiles: [{ id: "main", title: "Main", description: unsafe }],
    },
    {
      id: "good_app",
      name: "Good App",
      version: 100,
      background: { path: "service.html", description: unsafe },
    },
  ];
  for (const manifest of displaySurfaces) {
    expect(validateManifest(manifest).valid).toBe(false);
  }
  expect(() =>
    normalizeManifestDisplayMetadata({
      name: "Good App",
      description: unsafe,
    }),
  ).toThrow(/manifest description/);
  expect(() =>
    normalizeManifestTiles({
      tiles: [{ id: "main", title: unsafe }],
    }),
  ).toThrow(/tile title/);
  expect(() =>
    normalizeManifestBackground({
      background: { path: "service.html", description: unsafe },
    }),
  ).toThrow(/background description/);
});

test("manifest function metadata supports local async computations", () => {
  const base = {
    id: "good_app",
    name: "Good App",
    version: 100,
    func: {
      run: {
        type: "update",
        async: "async*",
      },
    },
  };

  expect(validateManifest(base).errors).toEqual([]);
  expect(
    validateManifest({
      ...base,
      func: { run: { type: "update", async: "await*" } },
    }).errors.length,
  ).toBeGreaterThan(0);

  for (const name of ["", "1run", "m".repeat(129)]) {
    const invalid = {
      ...base,
      func: { [name]: { type: "query" as const } },
    };
    expect(validateManifest(invalid).valid).toBe(false);
    expect(() => assertManifestFunctionExports(invalid)).toThrow(
      "Invalid function name",
    );
  }
});

test("manifest app dependencies and internal exports normalize deterministically", () => {
  const provider = {
    id: "contacts",
    func: {
      list_contacts: { type: "internal" as const, expose: "apps" as const },
    },
  };
  expect(() => assertManifestFunctionExports(provider)).not.toThrow();

  const consumer = {
    id: "calendar",
    dependencies: {
      people: {
        app: "contacts",
        min_version: 102,
        functions: ["upsert_contact", "list_contacts"],
      },
    },
  };
  expect(normalizeManifestDependencies(consumer)).toEqual({
    people: {
      app: "contacts",
      min_version: 102,
      functions: ["list_contacts", "upsert_contact"],
    },
  });
  expect(
    validateManifest({
      id: "calendar",
      name: "Calendar",
      version: 100,
      dependencies: consumer.dependencies,
    }).errors,
  ).toEqual([]);
  const leadingDigitDependency = {
    ...consumer,
    dependencies: {
      people: {
        ...consumer.dependencies.people,
        functions: ["1list_contacts"],
      },
    },
  };
  expect(validateManifest({
    format: 3,
    name: "Calendar",
    version: 100,
    ...leadingDigitDependency,
  }).valid).toBe(false);
  expect(() => normalizeManifestDependencies(leadingDigitDependency)).toThrow(
    "Invalid function name",
  );
});

test("backend capability selection is closed, canonical, and declaration-bound", () => {
  const manifest: NeutronManifest = {
    format: 3,
    id: "private_mail",
    name: "Private Mail",
    version: 100,
    backend: {
      capabilities: {
        vetkeys_public: { api: 1 },
        backend_calls: { api: 1 },
      },
    },
    capabilities: {
      backend_calls: {
        api: 1,
        description: "Call approved peers",
        reservation_scopes: ["exact"],
        max_concurrency: 2,
        max_cycles_per_call: 0,
        max_cycles_per_day: 0,
      },
      vetkeys: {
        api: 1,
        description: "Recover private mail",
        slots: [{ id: "mailbox", purpose: "Private mail" }],
      },
    },
  };

  expect(validate_neutron_conf(manifest).valid).toBe(true);
  const normalized = normalizeManifestBackend(manifest);
  expect(Object.keys(normalized!.capabilities)).toEqual([
    "backend_calls",
    "vetkeys_public",
  ]);
  expect(normalized).toEqual({
    capabilities: {
      backend_calls: { api: 1 },
      vetkeys_public: { api: 1 },
    },
  });
  expect(
    normalizeManifestBackend({
      id: "throttled_jobs",
      backend: {
        capabilities: {
          deferred_timers: { api: 1 },
        },
      },
    }),
  ).toEqual({
    capabilities: {
      deferred_timers: { api: 1 },
    },
  });
  const { backend: _backend, ...withoutBackend } = manifest;
  expect(normalizeManifestBackend(withoutBackend)).toBeNull();

  const invalid = [
    {
      ...manifest,
      backend: { capabilities: {} },
    },
    {
      ...manifest,
      backend: {
        capabilities: { backend_calls: { api: 2 } },
      },
    },
    {
      ...manifest,
      backend: {
        capabilities: { backend_calls: { api: 1, target: "raw" } },
      },
    },
    {
      ...manifest,
      backend: {
        capabilities: { management_actor: { api: 1 } },
      },
    },
    {
      ...manifest,
      backend: {
        capabilities: { randomness: { api: 1 } },
      },
    },
    {
      ...manifest,
      backend: {
        capabilities: { vetkeys_public: { api: 1 } },
        surprise: true,
      },
    },
    {
      ...manifest,
      id: "kernel",
    },
  ];
  for (const candidate of invalid) {
    expect(validate_neutron_conf(candidate).valid).toBe(false);
    expect(() =>
      normalizeManifestBackend(candidate as unknown as NeutronManifest),
    ).toThrow();
  }
});

test("manifest dependency semantics reject unsafe declarations", () => {
  expect(() =>
    normalizeManifestDependencies({ id: "calendar", dependencies: {} }),
  ).toThrow(/cannot be empty/);

  expect(() =>
    normalizeManifestDependencies({
      id: "kernel",
      dependencies: {
        contacts: {
          app: "contacts",
          min_version: 100,
          functions: ["read"],
        },
      },
    }),
  ).toThrow(/Kernel cannot declare app dependencies/);

  expect(() =>
    normalizeManifestDependencies({
      id: "calendar",
      dependencies: {
        self: {
          app: "calendar",
          min_version: 100,
          functions: ["read"],
        },
      },
    }),
  ).toThrow(/cannot depend on itself/);

  expect(() =>
    normalizeManifestDependencies({
      id: "calendar",
      dependencies: {
        system: { app: "kernel", min_version: 100, functions: ["read"] },
      },
    }),
  ).toThrow(/cannot depend on kernel/);

  expect(() =>
    normalizeManifestDependencies({
      id: "calendar",
      dependencies: {
        "bad-alias": {
          app: "contacts",
          min_version: 100,
          functions: ["read"],
        },
      },
    }),
  ).toThrow(/Invalid dependency alias/);

  expect(() =>
    normalizeManifestDependencies({
      id: "calendar",
      dependencies: {
        contacts: {
          app: "contacts",
          min_version: 100,
          functions: ["read", "read"],
        },
      },
    }),
  ).toThrow(/Duplicate function read/);

  expect(() =>
    normalizeManifestDependencies({
      id: "calendar",
      dependencies: Object.fromEntries(
        Array.from({ length: 33 }, (_, index) => [
          `dep_${index}`,
          {
            app: `app_${index}`,
            min_version: 100,
            functions: ["read"],
          },
        ]),
      ),
    }),
  ).toThrow(/more than 32/);

  expect(() =>
    normalizeManifestDependencies({
      id: "calendar",
      dependencies: {
        contacts: {
          app: "contacts",
          min_version: 100,
          functions: Array.from({ length: 65 }, (_, index) => `read_${index}`),
        },
      },
    }),
  ).toThrow(/Invalid function list/);
});

test("only internal functions can be exposed to apps", () => {
  expect(() =>
    assertManifestFunctionExports({
      id: "contacts",
      func: { list_contacts: { type: "query", expose: "apps" } },
    }),
  ).toThrow(/only when it is internal/);
});

test("ordinary public access is capability-bound while kernel bootstrap stays explicit", () => {
  const legacyAny = {
    id: "legacy_app",
    name: "Legacy App",
    version: 100,
    func: { status: { type: "query", allow: "any" } },
  };
  expect(validateManifest(legacyAny).errors.length).toBeGreaterThan(0);
  expect(() =>
    assertManifestFunctionExports(legacyAny as unknown as NeutronManifest),
  ).toThrow(/unsupported allow value any/);

  const ordinaryBypass = {
    format: 3 as const,
    id: "private_app",
    name: "Private App",
    version: 100,
    func: { status: { type: "query" as const, allow: "unauthorized" as const } },
  };
  expect(validateManifest(ordinaryBypass).valid).toBe(false);
  expect(() => assertManifestFunctionExports(ordinaryBypass)).toThrow(
    /cannot bypass public_ingress/,
  );

  expect(() =>
    assertManifestFunctionExports({
      id: "private_app",
      func: {
        helper: { type: "internal", allow: "unauthorized" },
      },
    }),
  ).toThrow(/internal and cannot declare public access/);

  const kernelBootstrap: NeutronManifest = {
    format: 3,
    id: "kernel",
    name: "Kernel",
    version: 100,
    func: {
      status: { type: "query", allow: "unauthorized" },
    },
  };
  expect(validateManifest(kernelBootstrap).errors).toEqual([]);
  expect(() => assertManifestFunctionExports(kernelBootstrap)).not.toThrow();
});

test("memory_requires is no longer an accepted composition contract", () => {
  const manifest = {
    format: 3 as const,
    id: "calendar",
    name: "Calendar",
    version: 100,
    memory_requires: {
      contacts: {
        owner: "contacts",
        version: 1,
        schema: "a".repeat(64),
      },
    },
  };
  expect(validateManifest(manifest).valid).toBe(false);
  expect(() => assertNeutronManifest(manifest, "source")).toThrow(
    /memory_requires is unsupported/,
  );
});

test("schema accepts explicit launcher tiles", () => {
  expect(
    validateManifest({
      id: "good_app",
      name: "Good App",
      version: 100,
      tiles: [
        {
          id: "main",
          title: "Main",
          path: "index.html",
          icon: "static/icon.png",
        },
        {
          id: "tools_1",
          title: "Tools",
          path: "tools/index.html",
        },
      ],
    }).errors,
  ).toEqual([]);
});

test("schema accepts apps with no launcher tiles", () => {
  const base = {
    id: "headless_app",
    name: "Headless App",
    version: 100,
  };
  expect(validateManifest(base).errors).toEqual([]);
  expect(validateManifest({ ...base, tiles: [] }).errors).toEqual([]);
});

test("tile normalization preserves headless apps and validates declared tiles", () => {
  expect(normalizeManifestTiles({})).toEqual([]);
  expect(
    normalizeManifestTiles({
      tiles: [],
    }),
  ).toEqual([]);
  expect(
    normalizeManifestTiles({
      tiles: [{ id: "main", title: "Main" }],
    }),
  ).toEqual([
    {
      id: "main",
      title: "Main",
      path: "index.html",
      icon: "static/icon.png",
    },
  ]);

  expect(() =>
    normalizeManifestTiles({
      tiles: [
        { id: "main", title: "Main" },
        { id: "main", title: "Again" },
      ],
    }),
  ).toThrow("Duplicate tile id main");

  expect(() =>
    normalizeManifestTiles({
      tiles: [{ id: "main", title: "Main", path: "../index.html" }],
    }),
  ).toThrow(/Unsafe tile path/);
});

test("manifest supports one safe resident background process", () => {
  const manifest = {
    id: "good_app",
    name: "Good App",
    version: 100,
    description: "An app with a resident process",
    background: {
      path: "service.html",
      description: "Resident tool host",
    },
    capabilities: {
      persistent_browser_storage: {
        api: 1 as const,
        surface: "background" as const,
      },
    },
    tiles: [
      {
        id: "main",
        title: "Main",
        description: "Disposable client",
      },
    ],
  };
  expect(validateManifest(manifest).errors).toEqual([]);
  expect(normalizeManifestBackground(manifest)).toEqual(manifest.background);
  expect(normalizeManifestTiles(manifest)[0]?.description).toBe(
    "Disposable client",
  );

  expect(
    validateManifest({
      ...manifest,
      background: [{ path: "one.html" }, { path: "two.html" }],
    }).valid,
  ).toBe(false);
  expect(() =>
    normalizeManifestBackground({ background: { path: "../service.html" } }),
  ).toThrow(/Unsafe background path/);
  expect(
    validateManifest({
      ...manifest,
      background: { path: "service.html", storage: "shared" },
    }).valid,
  ).toBe(false);

  const ephemeral = {
    ...manifest,
    capabilities: {
      dedicated_resident_origin: {
        api: 1 as const,
        surface: "background" as const,
        mode: "credentialless_ephemeral_v1" as const,
      },
    },
  };
  expect(validateManifest(ephemeral).errors).toEqual([]);
  expect(normalizeManifestCapabilities(ephemeral)).toEqual({
    dedicated_resident_origin: {
      api: 1,
      surface: "background",
      mode: "credentialless_ephemeral_v1",
    },
  });
  expect(
    validateManifest({ ...ephemeral, background: undefined }).valid,
  ).toBe(false);
  const mutuallyExclusive = structuredClone(ephemeral) as any;
  mutuallyExclusive.capabilities.persistent_browser_storage = {
    api: 1,
    surface: "background",
  };
  expect(validateManifest(mutuallyExclusive).valid).toBe(false);
  expect(() =>
    normalizeManifestCapabilities(mutuallyExclusive),
  ).toThrow(/mutually exclusive/);
});

test("manifest tray is singular, bounded, and requires a background", () => {
  const manifest = {
    id: "mail_app",
    name: "Mail App",
    version: 100,
    background: { path: "service.html" },
    tray: {
      title: "Inbox",
      path: "tray/index.html",
      icon: "static/tray.png",
    },
  };

  expect(validateManifest(manifest).errors).toEqual([]);
  expect(normalizeManifestTray(manifest)).toEqual(manifest.tray);

  expect(
    validateManifest({
      ...manifest,
      background: undefined,
    }).valid,
  ).toBe(false);
  expect(() =>
    normalizeManifestTray({ tray: manifest.tray }),
  ).toThrow("Tray requires a background process");

  for (const tray of [
    { ...manifest.tray, title: "Unsafe\u200btitle" },
    { ...manifest.tray, html: "<main>not allowed</main>" },
  ]) {
    expect(validateManifest({ ...manifest, tray }).valid).toBe(false);
  }
  expect(() =>
    normalizeManifestTray({
      background: manifest.background,
      tray: { ...manifest.tray, path: "../tray.html" },
    }),
  ).toThrow(/Unsafe tray path/);
  expect(() =>
    normalizeManifestTray({
      background: manifest.background,
      tray: { ...manifest.tray, icon: "/static/tray.png" },
    }),
  ).toThrow(/Unsafe tray icon/);
});

test("agent and background attention capabilities are exact and resident-only", () => {
  const manifest: NeutronManifest = {
    format: 3,
    id: "agent_app",
    name: "Agent App",
    version: 100,
    background: { path: "service.html" },
    capabilities: {
      agent_entrypoints: { api: 1, entrypoints: ["agent_chat"] },
      background_ui_requests: {
        api: 1,
        categories: ["frontend_tool", "signed_canister_call"],
      },
    },
  };
  expect(validateManifest(manifest).errors).toEqual([]);
  expect(normalizeManifestCapabilities(manifest) as unknown).toEqual(
    manifest.capabilities!,
  );
  expect(() =>
    normalizeManifestCapabilities({
      capabilities: {
        agent_entrypoints: { api: 1, entrypoints: ["agent_chat"] },
      },
    }),
  ).toThrow("Invalid agent_entrypoints capability");
  expect(() =>
    normalizeManifestCapabilities({
      background: { path: "service.html" },
      capabilities: {
        background_ui_requests: {
          api: 1,
          categories: ["frontend_tool", "frontend_tool"],
        },
      },
    }),
  ).toThrow("Duplicate background UI request category");
});

test("vetKeys capabilities declare only bounded app-isolated slots", () => {
  const manifest = {
    format: 3 as const,
    id: "private_mail",
    name: "Private Mail",
    version: 100,
    capabilities: {
      vetkeys: {
        api: 1 as const,
        description: "Recover keys for private mail",
        slots: [
          {
            id: "mailbox",
            purpose: "Encrypt and decrypt private mail",
          },
          {
            id: "settings_2",
            purpose: "Protect private mail settings",
          },
        ],
      },
    },
  } satisfies NeutronManifest;

  expect(validateManifest(manifest).errors).toEqual([]);
  expect(normalizeManifestCapabilities(manifest).vetkeys).toEqual(
    manifest.capabilities.vetkeys,
  );

  for (const slots of [
    [],
    [
      { id: "one", purpose: "One" },
      { id: "two", purpose: "Two" },
      { id: "three", purpose: "Three" },
      { id: "four", purpose: "Four" },
      { id: "five", purpose: "Five" },
    ],
    [{ id: "Uppercase", purpose: "No" }],
    [{ id: "../other_app", purpose: "No" }],
    [{ id: "slot", purpose: "Invisible\u200bpurpose" }],
    [{ id: "slot", purpose: "Okay", limit: 99 }],
  ]) {
    const candidate = {
      ...manifest,
      capabilities: {
        vetkeys: {
          api: 1,
          description: "Private keys",
          slots,
        },
      },
    };
    expect(validateManifest(candidate).valid).toBe(false);
    expect(() => normalizeManifestCapabilities(candidate as any)).toThrow();
  }

  expect(() =>
    normalizeManifestCapabilities({
      ...manifest,
      capabilities: {
        vetkeys: {
          api: 1,
          description: "Private keys",
          slots: [
            { id: "mailbox", purpose: "Current" },
            { id: "mailbox", purpose: "Duplicate" },
          ],
        },
      },
    }),
  ).toThrow("Duplicate vetkeys slot mailbox");

  expect(() =>
    normalizeManifestCapabilities({
      id: "kernel",
      capabilities: manifest.capabilities,
    }),
  ).toThrow("Kernel cannot declare ordinary app capabilities");
});

test("manifest connection declarations are bounded, URL-free, and access-free", () => {
  const manifest = {
    background: { path: "service.html" },
    capabilities: {
      connections: {
        api: 1 as const,
        providers: [
          {
            provider: "openrouter",
            scopes: [],
          },
        ],
      },
    },
  };
  expect(normalizeManifestCapabilities(manifest).connections?.providers).toEqual(
    manifest.capabilities.connections.providers,
  );
  expect(
    validateManifest({
      id: "agent_app",
      name: "Agent App",
      version: 100,
      ...manifest,
    }).valid,
  ).toBe(true);
  expect(
    validateManifest({
      id: "agent_app",
      name: "Agent App",
      version: 100,
      capabilities: manifest.capabilities,
    }).valid,
  ).toBe(false);
  expect(
    validateManifest({
      id: "agent_app",
      name: "Agent App",
      version: 100,
      background: { path: "service.html" },
      capabilities: {
        connections: {
          api: 1,
          providers: [
            {
              provider: "openrouter",
              scopes: [],
              authorizationUrl: "https://evil.example/authorize",
            },
          ],
        },
      },
    }).valid,
  ).toBe(false);
  const legacyAccess = {
    id: "agent_app",
    name: "Agent App",
    version: 100,
    background: { path: "service.html" },
    capabilities: {
      connections: {
        api: 1,
        providers: [
          { provider: "openrouter", scopes: [], access: "backend_proxy" },
        ],
      },
    },
  };
  expect(validateManifest(legacyAccess).valid).toBe(false);
  expect(() => normalizeManifestCapabilities(legacyAccess as any)).toThrow(
    /Unknown connection provider field access/,
  );
  expect(() =>
    normalizeManifestCapabilities({
      background: { path: "service.html" },
      capabilities: {
        connections: {
          api: 1,
          providers: [
            { provider: "openrouter" },
            { provider: "openrouter" },
          ],
        },
      },
    }),
  ).toThrow(/Duplicate connection provider/);
});

test("manifest backend-call capability is explicit and bounded", () => {
  const capabilities: NeutronCapabilitiesConfig = {
    backend_calls: {
      api: 1,
      description: "Call approved ledger canisters",
      reservation_scopes: ["principal"],
      max_concurrency: 20,
      max_cycles_per_call: 100_000_000_000_000,
      max_cycles_per_day: 1_000_000_000_000_000,
    },
  };
  const manifest = {
    id: "wallet",
    name: "Wallet",
    version: 100,
    capabilities,
  };

  expect(validateManifest(manifest).errors).toEqual([]);
  expect(normalizeManifestCapabilities(manifest) as unknown).toEqual(
    capabilities,
  );
  const backendCalls = capabilities.backend_calls!;
  const installGrant = {
    ...manifest,
    capabilities: {
      backend_calls: {
        ...backendCalls,
        reservation_scopes: ["principal", "method"] as [
          "principal",
          "method",
        ],
        install_reservations: [
          { kind: "method" as const, method: "app_wallet__ledger_update" },
        ],
      },
    },
  };
  expect(validateManifest(installGrant).errors).toEqual([]);
  expect(
    normalizeManifestCapabilities(installGrant).backend_calls
      ?.install_reservations,
  ).toEqual([
    { kind: "method", method: "app_wallet__ledger_update" },
  ]);
  expect(() =>
    normalizeManifestCapabilities({
      ...manifest,
      capabilities: {
        backend_calls: {
          ...backendCalls,
          install_reservations: [
            { kind: "method", method: "app_wallet__ledger_update" },
          ],
        },
      },
    }),
  ).toThrow(/undeclared method scope/);
  const invalidCycleLimits = [
    {
      label: "per-call above the platform ceiling",
      patch: { max_cycles_per_call: 100_000_000_000_001 },
      schemaRejects: true,
    },
    {
      label: "daily above the platform ceiling",
      patch: { max_cycles_per_day: 1_000_000_000_000_001 },
      schemaRejects: true,
    },
    {
      label: "per-call above daily",
      patch: { max_cycles_per_call: 11, max_cycles_per_day: 10 },
      schemaRejects: false,
    },
    {
      label: "negative per-call",
      patch: { max_cycles_per_call: -1 },
      schemaRejects: true,
    },
  ];
  for (const { label, patch, schemaRejects } of invalidCycleLimits) {
    const invalid = {
      ...manifest,
      capabilities: {
        backend_calls: { ...capabilities.backend_calls, ...patch },
      },
    };
    // JSON Schema owns scalar bounds. The closed runtime normalizer additionally
    // owns the relation between the two independently valid integers.
    expect(validateManifest(invalid).valid, label).toBe(!schemaRejects);
    expect(
      () =>
        normalizeManifestCapabilities(
          invalid as unknown as Parameters<
            typeof normalizeManifestCapabilities
          >[0],
        ),
      label,
    ).toThrow(/backend_calls max_cycles/);
  }
  for (const missing of ["max_cycles_per_call", "max_cycles_per_day"] as const) {
    const backendCalls = {
      ...capabilities.backend_calls,
    } as Record<string, unknown>;
    delete backendCalls[missing];
    const invalid = {
      ...manifest,
      capabilities: { backend_calls: backendCalls },
    };
    expect(validateManifest(invalid).valid, `missing ${missing}`).toBe(false);
    expect(
      () =>
        normalizeManifestCapabilities(
          invalid as unknown as Parameters<
            typeof normalizeManifestCapabilities
          >[0],
        ),
      `missing ${missing}`,
    ).toThrow(new RegExp(`backend_calls ${missing}`));
  }
  expect(
    validateManifest({
      ...manifest,
      capabilities: {
        backend_calls: {
          api: 1,
          ...capabilities.backend_calls,
          reservation_scopes: ["principal", "principal"],
        },
      },
    }).valid,
  ).toBe(false);
  expect(
    validateManifest({
      ...manifest,
      capabilities: {
        backend_calls: {
          ...capabilities.backend_calls,
          max_concurrency: 21,
        },
      },
    }).valid,
  ).toBe(false);
  expect(() =>
    normalizeManifestCapabilities({
      capabilities: {
        backend_calls: {
          api: 1,
          description: "Bad\nmetadata",
          reservation_scopes: ["exact"],
          max_concurrency: 1,
          max_cycles_per_call: 0,
          max_cycles_per_day: 0,
        },
      },
    }),
  ).toThrow(/description/);
});

test("manifest randomness capability is explicit, closed, and not time-limited", () => {
  const manifest: NeutronManifest = {
    format: 3,
    id: "dice_app",
    name: "Dice App",
    version: 100,
    capabilities: {
      randomness: {
        api: 1,
      },
    },
  };

  expect(validateManifest(manifest).errors).toEqual([]);
  expect(normalizeManifestCapabilities(manifest).randomness).toEqual({
    api: 1,
  });
  expect(() =>
    normalizeManifestCapabilities({
      ...manifest,
      capabilities: {
        randomness: { api: 1, max_requests_per_hour: 1 } as never,
      },
    }),
  ).toThrow(/Unknown randomness capability field max_requests_per_hour/);
  expect(() =>
    normalizeManifestCapabilities({
      ...manifest,
      capabilities: {
        randomness: {
          api: 1,
          target: "aaaaa-aa",
        } as never,
      },
    }),
  ).toThrow(/Unknown randomness capability field target/);
});

test("chain-key signing declares only bounded domain-separated assertion slots", () => {
  const capability = {
    api: 1 as const,
    slots: [
      {
        id: "z_receipts",
        algorithm: "schnorr_ed25519" as const,
        purpose: "Sign receipt assertions",
        max_assertion_bytes: 4096,
      },
      {
        id: "a_identity",
        algorithm: "ecdsa_secp256k1" as const,
        purpose: "Sign identity assertions",
        max_assertion_bytes: 1024,
      },
    ],
  };
  const manifest: NeutronManifest = {
    format: 3,
    id: "assertion_app",
    name: "Assertion App",
    version: 100,
    backend: { capabilities: { chain_key_signing: { api: 1 } } },
    capabilities: { chain_key_signing: capability },
  };

  expect(validateManifest(manifest).errors).toEqual([]);
  expect(normalizeManifestCapabilities(manifest).chain_key_signing).toEqual({
    ...capability,
    slots: [capability.slots[1]!, capability.slots[0]!],
  });

  const candidate = (chain_key_signing: unknown, id = "assertion_app") => ({
    ...manifest,
    id,
    capabilities: { chain_key_signing },
  });
  const normalize = (value: unknown) =>
    normalizeManifestCapabilities(value as NeutronManifest);

  expect(() =>
    normalize(candidate({ ...capability, max_cycles_per_hour: 1 })),
  ).toThrow(/Unknown chain_key_signing capability field max_cycles_per_hour/);
  for (const slots of [
    [],
    Array.from({ length: 5 }, (_, index) => ({
      ...capability.slots[0],
      id: `slot_${index}`,
    })),
  ]) {
    const value = candidate({ ...capability, slots });
    expect(validateManifest(value).valid).toBe(false);
    expect(() => normalize(value)).toThrow(/chain_key_signing/);
  }

  const slot = capability.slots[0];
  const withSlot = (patch: Record<string, unknown>) =>
    candidate({ ...capability, slots: [{ ...slot, ...patch }] });
  for (const algorithm of ["ecdsa", "ed25519", "secp256k1", "raw"]) {
    expect(() => normalize(withSlot({ algorithm }))).toThrow(
      /chain_key_signing slot/,
    );
  }
  for (const max_assertion_bytes of [0, 4097]) {
    expect(() => normalize(withSlot({ max_assertion_bytes }))).toThrow(
      /chain_key_signing slot/,
    );
  }
  expect(() => normalize(withSlot({ max_assertions_per_hour: 1 }))).toThrow(
    /Unknown chain_key_signing slot field max_assertions_per_hour/,
  );
  expect(() =>
    normalize(
      candidate({
        ...capability,
        slots: [slot, { ...slot }],
      }),
    ),
  ).toThrow(/chain_key_signing slot/);
  expect(() => normalize(withSlot({ purpose: "x".repeat(161) }))).toThrow(
    /chain_key_signing purpose/,
  );
  expect(() => normalize(withSlot({ derivation_path: [] }))).toThrow(
    /Unknown chain_key_signing slot field derivation_path/,
  );
  expect(() => normalize(withSlot({ key_name: "key_1" }))).toThrow(
    /Unknown chain_key_signing slot field key_name/,
  );
  expect(() =>
    normalize(candidate({ ...capability, raw_signing: true })),
  ).toThrow(/Unknown chain_key_signing capability field raw_signing/);
  expect(() => normalize(candidate(capability, "kernel"))).toThrow(
    /Kernel cannot declare ordinary app capabilities/,
  );
});

test("HTTPS outcalls are exact, canonical, bounded, and declaration-selected", () => {
  const capability = {
    api: 1 as const,
    endpoints: [
      {
        id: "weather",
        url_prefix: "https://api.example.com/v1/forecast/",
        methods: ["post", "get"] as ("get" | "post")[],
        request_headers: ["authorization", "accept"],
        max_request_bytes: 65_536,
        max_response_bytes: 524_288,
        transform: "strip_headers" as const,
      },
      {
        id: "health",
        url_prefix: "https://status.example.com/",
        methods: ["head"] as "head"[],
        request_headers: [],
        max_request_bytes: 4096,
        max_response_bytes: 1,
        transform: "strip_headers" as const,
      },
    ],
  };
  const manifest: NeutronManifest = {
    format: 3,
    id: "weather_app",
    name: "Weather",
    version: 100,
    backend: { capabilities: { https_outcalls: { api: 1 } } },
    capabilities: { https_outcalls: capability },
  };

  expect(validateManifest(manifest).errors).toEqual([]);
  expect(normalizeManifestCapabilities(manifest).https_outcalls).toEqual({
    ...capability,
    endpoints: [
      capability.endpoints[1]!,
      {
        ...capability.endpoints[0]!,
        methods: ["get", "post"],
        request_headers: ["accept", "authorization"],
      },
    ],
  });

  const withCapability = (https_outcalls: unknown, id = "weather_app") => ({
    ...manifest,
    id,
    capabilities: { https_outcalls },
  });
  const normalize = (candidate: unknown) =>
    normalizeManifestCapabilities(candidate as NeutronManifest);

  expect(() =>
    normalize(withCapability({ ...capability, max_cycles_per_hour: 1 })),
  ).toThrow(/Unknown https_outcalls capability field max_cycles_per_hour/);
  for (const endpoints of [
    [],
    Array.from({ length: 9 }, (_, index) => ({
      ...capability.endpoints[0],
      id: `endpoint_${index}`,
    })),
  ]) {
    const candidate = withCapability({ ...capability, endpoints });
    expect(validateManifest(candidate).valid).toBe(false);
    expect(() => normalize(candidate)).toThrow(/https_outcalls/);
  }

  const one = capability.endpoints[0];
  const replaceEndpoint = (patch: Record<string, unknown>) =>
    withCapability({ ...capability, endpoints: [{ ...one, ...patch }] });
  for (const url_prefix of [
    "http://api.example.com/",
    "https://User@api.example.com/",
    "https://api.example.com:8443/",
    "https://api.example.com/?q=1",
    "https://api.example.com/#fragment",
    "https://127.0.0.1/",
    "https://2130706433/",
    "https://0x7f000001/",
    "https://[::1]/",
    "https://service.local/",
    "https://1.0.0.127.in-addr.arpa/",
    "https://api.example.com/a//b/",
    "https://api.example.com/a/../b/",
    "https://api.example.com/a/%2e%2e/b/",
    "https://api.example.com/a/%00/b/",
    "https://api.example.com/caf%C3%A9/",
    "https://API.example.com/",
    "https://api.example.com/no-trailing-slash",
  ]) {
    expect(() => normalize(replaceEndpoint({ url_prefix }))).toThrow(
      /HTTPS outcall/,
    );
  }

  for (const header of [
    "cookie",
    "set-cookie",
    "host",
    "origin",
    "idempotency-key",
    "ic-certificate",
    "ic-private",
    "proxy-custom",
    "sec-fetch-mode",
    "Authorization",
  ]) {
    expect(() =>
      normalize(replaceEndpoint({ request_headers: [header] })),
    ).toThrow(/request header/);
  }
  expect(() =>
    normalize(replaceEndpoint({ request_headers: ["accept", "accept"] })),
  ).toThrow(/Duplicate HTTPS outcall request header/);
  expect(() =>
    normalize(replaceEndpoint({ methods: ["get", "get"] })),
  ).toThrow(/Duplicate HTTPS outcall method/);
  expect(() =>
    normalize(replaceEndpoint({ methods: ["delete"] })),
  ).toThrow(/Invalid HTTPS outcall method/);
  expect(() =>
    normalize(
      replaceEndpoint({
        url_prefix: "https://api.example.com/",
        max_request_bytes: "https://api.example.com/".length - 1,
      }),
    ),
  ).toThrow(/URL prefix exceeds max_request_bytes/);

  const duplicateIds = withCapability({
    ...capability,
    endpoints: [one, { ...one }],
  });
  expect(() => normalize(duplicateIds)).toThrow(/Invalid HTTPS outcall endpoint/);
  expect(() =>
    normalize(replaceEndpoint({ max_calls_per_hour: 1 })),
  ).toThrow(/Unknown HTTPS outcall endpoint field max_calls_per_hour/);
  const aggregate = withCapability({
    ...capability,
    endpoints: [one, { ...one, id: "second" }],
  });
  expect(normalize(aggregate).https_outcalls?.endpoints).toHaveLength(2);

  expect(() => normalize(withCapability(capability, "kernel"))).toThrow(
    /Kernel cannot declare ordinary app capabilities/,
  );
  expect(() =>
    normalize(withCapability({ ...capability, target: "arbitrary" })),
  ).toThrow(/Unknown https_outcalls capability field target/);
});

test("manifest scheduled tasks are static and bounded", () => {
  const manifest: NeutronManifest = {
    format: 3,
    id: "wallet",
    name: "Wallet",
    version: 100,
    capabilities: {
      scheduled_tasks: {
        api: 1,
        tasks: [
          {
            id: "ledger_history",
            method: "wallet_history_tick",
            interval_seconds: 43_200,
            run_on_start: true,
            max_backend_calls: 100,
          },
        ],
      },
    },
  };
  expect(validateManifest(manifest).errors).toEqual([]);
  expect(normalizeManifestCapabilities(manifest) as unknown).toEqual(
    manifest.capabilities!,
  );
  const tenSecondTask: NeutronManifest = {
    ...manifest,
    capabilities: {
      scheduled_tasks: {
        api: 1,
        tasks: [{
          ...manifest.capabilities!.scheduled_tasks!.tasks[0]!,
          interval_seconds: 10,
        }],
      },
    },
  };
  expect(validateManifest(tenSecondTask).errors).toEqual([]);
  expect(normalizeManifestCapabilities(tenSecondTask) as unknown).toEqual(
    tenSecondTask.capabilities!,
  );
  const leadingDigitMethod = {
    capabilities: {
      scheduled_tasks: {
        api: 1 as const,
        tasks: [
          {
            ...manifest.capabilities!.scheduled_tasks!.tasks[0]!,
            method: "1wallet_history_tick",
          },
        ],
      },
    },
  };
  expect(validateManifest({ ...manifest, ...leadingDigitMethod }).valid).toBe(
    false,
  );
  expect(() => normalizeManifestCapabilities(leadingDigitMethod)).toThrow(
    "Invalid scheduled task",
  );
  expect(() =>
    normalizeManifestCapabilities({
      capabilities: {
        scheduled_tasks: {
          api: 1,
          tasks: [
            manifest.capabilities!.scheduled_tasks!.tasks[0]!,
            manifest.capabilities!.scheduled_tasks!.tasks[0]!,
          ],
        },
      },
    }),
  ).toThrow(/Duplicate scheduled task id/);
  expect(
    validateManifest({
      ...manifest,
      capabilities: {
        scheduled_tasks: {
          api: 1,
          tasks: [
            {
              ...manifest.capabilities!.scheduled_tasks!.tasks[0]!,
              interval_seconds: 9,
            },
          ],
        },
      },
    }).valid,
  ).toBe(false);
});

test("manifest preapproved self calls are exact and bounded", () => {
  const manifest = {
    id: "wallet",
    name: "Wallet",
    version: 100,
    capabilities: {
      preapproved_self_calls: {
        api: 1 as const,
        methods: ["wallet_snapshot", "wallet_refresh_metadata"],
      },
    },
  };

  expect(validateManifest(manifest).errors).toEqual([]);
  expect(normalizeManifestCapabilities(manifest)).toEqual({
    preapproved_self_calls: {
      api: 1,
      methods: ["wallet_refresh_metadata", "wallet_snapshot"],
    },
  });
  expect(
    validateManifest({
      ...manifest,
      capabilities: {
        preapproved_self_calls: {
          api: 1,
          methods: ["wallet_snapshot", "wallet_snapshot"],
        },
      },
    }).valid,
  ).toBe(false);
  expect(() =>
    normalizeManifestCapabilities({
      capabilities: {
        preapproved_self_calls: { api: 1, methods: ["1wallet_snapshot"] },
      },
    }),
  ).toThrow(/preapproved self-call method/);

  const api2 = {
    id: "files_calls",
    name: "Files Calls",
    version: 100,
    capabilities: {
      preapproved_self_calls: {
        api: 2 as const,
        methods: [
          {
            method: "write",
            mode: "update" as const,
            attachments: {
              input: { max_bytes: 1_900_000 },
              output: "none" as const,
            },
          },
        ],
      },
    },
  };
  expect(validateManifest(api2).valid).toBe(false);
  expect(() =>
    normalizeManifestCapabilities(
      api2 as unknown as Parameters<
        typeof normalizeManifestCapabilities
      >[0],
    ),
  ).toThrow(
    /Unsupported preapproved_self_calls capability API/,
  );
});

test("public ingress declarations use closed versioned route policies", () => {
  const manifest: NeutronManifest = {
    format: 3,
    id: "mail_protocol",
    name: "Mail Protocol",
    version: 100,
    func: {
      probe: { type: "query", async: false },
      deliver: { type: "update", async: false },
    },
    capabilities: {
      public_ingress: {
        api: 1,
        routes: [
          {
            protocol: "mail_v1",
            id: "probe",
            handler: "probe",
            mode: "query",
            caller: "any",
            max_request_bytes: 1,
            max_response_bytes: 4096,
          },
          {
            protocol: "mail_v1",
            id: "deliver",
            handler: "deliver",
            mode: "update",
            caller: "canister",
            max_request_bytes: 65_536,
            max_response_bytes: 1024,
            max_calls_per_hour: 120,
            max_calls_per_caller_per_hour: 12,
            required_cycles: 10_000_000,
          },
        ],
      },
    },
  };

  expect(validateManifest(manifest).errors).toEqual([]);
  expect(normalizeManifestCapabilities(manifest).public_ingress).toEqual({
    api: 1,
    routes: [
      {
        protocol: "mail_v1",
        id: "deliver",
        handler: "deliver",
        mode: "update",
        caller: "canister",
        max_request_bytes: 65_536,
        max_response_bytes: 1024,
        max_calls_per_hour: 120,
        max_calls_per_caller_per_hour: 12,
        required_cycles: 10_000_000,
      },
      {
        protocol: "mail_v1",
        id: "probe",
        handler: "probe",
        mode: "query",
        caller: "any",
        max_request_bytes: 1,
        max_response_bytes: 4096,
      },
    ],
  });

  const queryRate = structuredClone(manifest) as any;
  queryRate.capabilities.public_ingress.routes[0].max_calls_per_hour = 1;
  expect(validateManifest(queryRate).valid).toBe(false);
  expect(() => normalizeManifestCapabilities(queryRate)).toThrow(
    /Unknown public_ingress route field max_calls_per_hour/,
  );

  const queryCallerRate = structuredClone(manifest) as any;
  queryCallerRate.capabilities.public_ingress.routes[0]
    .max_calls_per_caller_per_hour = 1;
  expect(validateManifest(queryCallerRate).valid).toBe(false);
  expect(() => normalizeManifestCapabilities(queryCallerRate)).toThrow(
    /Unknown public_ingress route field max_calls_per_caller_per_hour/,
  );

  const excessiveCallerRate = structuredClone(manifest) as any;
  excessiveCallerRate.capabilities.public_ingress.routes[1]
    .max_calls_per_caller_per_hour = 121;
  expect(validateManifest(excessiveCallerRate).errors).toEqual([]);
  expect(() => normalizeManifestCapabilities(excessiveCallerRate)).toThrow(
    /Invalid public_ingress update caller rate/,
  );

  const missingUpdateRate = structuredClone(manifest) as any;
  delete missingUpdateRate.capabilities.public_ingress.routes[1]
    .max_calls_per_hour;
  expect(validateManifest(missingUpdateRate).valid).toBe(false);
  expect(() => normalizeManifestCapabilities(missingUpdateRate)).toThrow(
    /Invalid public_ingress update rate/,
  );

  const missingRequiredCycles = structuredClone(manifest) as any;
  delete missingRequiredCycles.capabilities.public_ingress.routes[1]
    .required_cycles;
  expect(validateManifest(missingRequiredCycles).valid).toBe(false);
  expect(() => normalizeManifestCapabilities(missingRequiredCycles)).toThrow(
    /Invalid public_ingress required cycles/,
  );

  const authenticatedUpdate = structuredClone(manifest) as any;
  authenticatedUpdate.capabilities.public_ingress.routes[1].caller =
    "authenticated";
  delete authenticatedUpdate.capabilities.public_ingress.routes[1]
    .required_cycles;
  expect(validateManifest(authenticatedUpdate).errors).toEqual([]);
  expect(
    normalizeManifestCapabilities(authenticatedUpdate).public_ingress?.routes[0],
  ).toMatchObject({
    mode: "update",
    caller: "authenticated",
    max_calls_per_hour: 120,
  });
  expect(
    normalizeManifestCapabilities(authenticatedUpdate).public_ingress?.routes[0],
  ).not.toHaveProperty("required_cycles");

  const paidAuthenticatedUpdate = structuredClone(manifest) as any;
  paidAuthenticatedUpdate.capabilities.public_ingress.routes[1].caller =
    "authenticated";
  expect(validateManifest(paidAuthenticatedUpdate).valid).toBe(false);
  expect(() => normalizeManifestCapabilities(paidAuthenticatedUpdate)).toThrow(
    /Unknown public_ingress route field required_cycles/,
  );

  const publicUpdate = structuredClone(manifest) as any;
  publicUpdate.capabilities.public_ingress.routes[1].caller = "any";
  delete publicUpdate.capabilities.public_ingress.routes[1].required_cycles;
  expect(validateManifest(publicUpdate).valid).toBe(false);
  expect(() => normalizeManifestCapabilities(publicUpdate)).toThrow(
    /Invalid public_ingress update caller/,
  );

  const paidQuery = structuredClone(manifest) as any;
  paidQuery.capabilities.public_ingress.routes[0].required_cycles = 1;
  expect(validateManifest(paidQuery).valid).toBe(false);
  expect(() => normalizeManifestCapabilities(paidQuery)).toThrow(
    /Unknown public_ingress route field required_cycles/,
  );

  const unknownPolicy = structuredClone(manifest) as any;
  unknownPolicy.capabilities.public_ingress.routes[0].origin = "trusted";
  expect(validateManifest(unknownPolicy).valid).toBe(false);
  expect(() => normalizeManifestCapabilities(unknownPolicy)).toThrow(
    /Unknown public_ingress route field origin/,
  );

  const kernelIngress = structuredClone(manifest) as any;
  kernelIngress.id = "kernel";
  expect(validateManifest(kernelIngress).valid).toBe(false);
  expect(() => normalizeManifestCapabilities(kernelIngress)).toThrow(
    /Kernel cannot declare ordinary app capabilities/,
  );
});

test("ethereum provider capability declares exact chains and RPC methods", () => {
  const manifest: NeutronManifest = {
    format: 3,
    id: "wallet",
    name: "Wallet",
    version: 100,
    capabilities: {
      ethereum_provider: {
        api: 1,
        chains: [1],
        methods: [
          "eth_requestAccounts",
          "eth_chainId",
          "eth_sendTransaction",
        ],
      },
    },
  };

  expect(validateManifest(manifest).errors).toEqual([]);
  expect(normalizeManifestCapabilities(manifest)).toEqual({
    ethereum_provider: {
      api: 1,
      chains: [1],
      methods: ["eth_chainId", "eth_requestAccounts", "eth_sendTransaction"],
    },
  });
  expect(() =>
    normalizeManifestCapabilities({
      capabilities: {
        ethereum_provider: {
          api: 1,
          chains: [1, 1],
          methods: ["eth_requestAccounts"],
        },
      },
    }),
  ).toThrow("Duplicate ethereum_provider chain 1");
  expect(() =>
    normalizeManifestCapabilities({
      capabilities: {
        ethereum_provider: {
          api: 1,
          chains: [1],
          methods: ["eth_sendTransaction"],
        },
      },
    }),
  ).toThrow("transactions require eth_requestAccounts");
  expect(
    validateManifest({
      ...manifest,
      capabilities: {
        ethereum_provider: {
          api: 1,
          chains: [1],
          methods: ["personal_sign"],
        },
      },
    }).valid,
  ).toBe(false);
});

test("certified assets use closed generic kinds and coexist with POST routes", () => {
  const manifest = genericCertifiedAssetsManifest();

  expect(validateManifest(manifest).errors).toEqual([]);
  expect(normalizeManifestCapabilities(manifest)).toEqual({
    http_routes: {
      api: 1,
      mounts: [
        {
          id: "webhook",
          surface: "shared_app_path",
          methods: ["POST"],
          mode: "http_post_update_handler",
          handler: "receive_webhook",
          max_request_bytes: 16_384,
          max_response_bytes: 4096,
          max_calls_per_hour: 60,
          forward_headers: ["content-type"],
        },
      ],
    },
    certified_assets: {
      api: 2,
      max_entries: 100_000,
      max_committed_bytes: 1_073_741_824,
      max_object_bytes: 1_048_576,
      max_pending_stages: 1,
      max_staged_bytes: 1_048_576,
      max_batch_operations: 16,
      max_batch_bytes: 1_048_576,
      max_idempotency_receipts: 4096,
      collections: [
        {
          id: "posts",
          mount: "protocol",
          kind: "immutable_blob",
          path_prefix: "/v1/objects/post/sha256/",
          max_object_bytes: 1_044_480,
        },
        {
          id: "shares",
          mount: "shares",
          kind: "publication",
        },
        {
          id: "status",
          mount: "protocol",
          kind: "mutable_blob",
          exact_path: "/v1/status",
          max_object_bytes: 266_240,
        },
      ],
    },
  });

  const routesOnly = structuredClone(manifest);
  delete routesOnly.capabilities!.certified_assets;
  delete routesOnly.backend;
  expect(validateManifest(routesOnly).errors).toEqual([]);
  expect(normalizeManifestCapabilities(routesOnly).certified_assets).toBeUndefined();

  const assetsOnly = structuredClone(manifest);
  delete assetsOnly.capabilities!.http_routes;
  expect(validateManifest(assetsOnly).errors).toEqual([]);
  expect(
    normalizeManifestCapabilities(assetsOnly).certified_assets?.collections,
  ).toHaveLength(3);

  const api2Route = structuredClone(manifest) as any;
  api2Route.capabilities.http_routes = {
    api: 2,
    mounts: [
      {
        id: "protocol",
        surface: "shared_app_path",
        authority_mode: "canister_gateway_v1",
        methods: ["GET"],
        mode: "certified_store",
        max_request_bytes: 0,
        store: "certified_assets",
      },
    ],
  };
  expect(validateManifest(api2Route).valid).toBe(false);
  expect(() => normalizeManifestCapabilities(api2Route)).toThrow(
    /Unsupported http_routes capability API/,
  );

  const duplicate = structuredClone(manifest);
  duplicate.capabilities!.certified_assets!.collections[1]!.id = "status";
  expect(() => normalizeManifestCapabilities(duplicate)).toThrow(
    /Duplicate certified_assets collection/,
  );

  const collidingPostMount = structuredClone(manifest);
  collidingPostMount.capabilities!.http_routes!.mounts[0]!.id = "protocol";
  expect(() => normalizeManifestCapabilities(collidingPostMount)).toThrow(
    /collides with a certified read mount/,
  );

  for (const [field, value] of Object.entries({
    path_rule: "body_sha256_hex_v1",
    mutation_rule: "immutable_digest_v1",
    body_source: "inline_or_staged",
    response_profiles: ["public_candid_immutable_v1"],
  })) {
    const legacy = structuredClone(manifest) as any;
    legacy.capabilities.certified_assets.collections[0][field] = value;
    expect(validateManifest(legacy).valid).toBe(false);
    expect(() => normalizeManifestCapabilities(legacy)).toThrow(
      new RegExp(`Unknown certified_assets collection field ${field}`),
    );
  }
  for (const [field, value] of Object.entries({
    lifecycle_group: "scope_v1",
    clear_mode: "lifecycle_group_only_v1",
  })) {
    const legacy = structuredClone(manifest) as any;
    legacy.capabilities.certified_assets[field] = value;
    expect(validateManifest(legacy).valid).toBe(false);
    expect(() => normalizeManifestCapabilities(legacy)).toThrow(
      new RegExp(`Unknown certified_assets capability field ${field}`),
    );
  }

  const oneReceipt = structuredClone(manifest);
  oneReceipt.capabilities!.certified_assets!.max_idempotency_receipts = 1;
  expect(validateManifest(oneReceipt).valid).toBe(false);
  expect(() => normalizeManifestCapabilities(oneReceipt)).toThrow(
    /certified_assets limits/,
  );

  const twoReceipts = structuredClone(manifest);
  twoReceipts.capabilities!.certified_assets!.max_idempotency_receipts = 2;
  expect(validateManifest(twoReceipts).errors).toEqual([]);
  expect(
    normalizeManifestCapabilities(twoReceipts).certified_assets
      ?.max_idempotency_receipts,
  ).toBe(2);
});

test("certified asset path schema matches the 14-segment proof bound", () => {
  expect(CERTIFIED_HTTP_PATH_SEGMENTS_MAX_V2).toBe(14);
  const path = (segments: number, trailingSlash: boolean) =>
    `/${Array.from({ length: segments }, (_, index) => `s${index}`).join("/")}${
      trailingSlash ? "/" : ""
    }`;
  const setPath = (
    field: "path_prefix" | "exact_path",
    segments: number,
  ) => {
    const manifest = genericCertifiedAssetsManifest();
    const collections =
      manifest.capabilities!.certified_assets!.collections;
    if (field === "path_prefix") {
      const collection = collections.find(
        (candidate) => candidate.kind === "immutable_blob",
      )!;
      if (collection.kind !== "immutable_blob") throw new Error("fixture");
      collection.path_prefix = path(segments, true);
    } else {
      const collection = collections.find(
        (candidate) =>
          candidate.kind === "mutable_blob" &&
          candidate.exact_path !== undefined,
      )!;
      if (
        collection.kind !== "mutable_blob" ||
        collection.exact_path === undefined
      ) {
        throw new Error("fixture");
      }
      collection.exact_path = path(segments, false);
    }
    return manifest;
  };

  for (const [field, accepted, rejected] of [
    ["path_prefix", 9, 10],
    ["exact_path", 10, 11],
  ] as const) {
    const boundary = setPath(field, accepted);
    expect(validateManifest(boundary).errors).toEqual([]);
    expect(() => normalizeManifestCapabilities(boundary)).not.toThrow();

    const tooDeep = setPath(field, rejected);
    expect(validateManifest(tooDeep).valid).toBe(false);
    expect(() => normalizeManifestCapabilities(tooDeep)).toThrow(
      new RegExp(field),
    );
  }
});

test("bounded POST app routes validate without certified storage", () => {
  const manifest: NeutronManifest = {
    format: 3,
    id: "post_route_app",
    name: "POST Route App",
    version: 100,
    func: { ingest: { type: "internal", async: false } },
    capabilities: {
      http_routes: {
        api: 1,
        mounts: [
          {
            id: "ingest",
            surface: "app_host",
            prefix: "/api/ingest",
            methods: ["POST"],
            mode: "http_post_update_handler",
            handler: "ingest",
            max_request_bytes: 16_384,
            max_response_bytes: 4096,
            max_calls_per_hour: 60,
            forward_headers: ["x-signature", "content-type"],
          },
        ],
      },
    },
  };

  expect(validateManifest(manifest).errors).toEqual([]);
  expect(normalizeManifestCapabilities(manifest)).toEqual({
    http_routes: {
      api: 1,
      mounts: [
        {
          id: "ingest",
          surface: "app_host",
          prefix: "/api/ingest",
          methods: ["POST"],
          mode: "http_post_update_handler",
          handler: "ingest",
          max_request_bytes: 16_384,
          max_response_bytes: 4096,
          max_calls_per_hour: 60,
          forward_headers: ["content-type", "x-signature"],
        },
      ],
    },
  });

  for (const header of [
    "idempotency-key",
    "content-encoding",
    "origin",
    "ic-private",
    "proxy-private",
    "sec-fetch-site",
  ]) {
    const forbiddenHeader = structuredClone(manifest);
    const forbiddenMount = forbiddenHeader.capabilities!.http_routes!.mounts[0]!;
    if (forbiddenMount.mode !== "http_post_update_handler") throw new Error("fixture");
    forbiddenMount.forward_headers = [header];
    expect(validateManifest(forbiddenHeader).valid).toBe(false);
    expect(() => normalizeManifestCapabilities(forbiddenHeader)).toThrow(
      /forwarded headers/,
    );
  }

  const extraField = structuredClone(manifest) as any;
  extraField.capabilities.http_routes.mounts[0].cors = true;
  expect(validateManifest(extraField).valid).toBe(false);
  expect(() => normalizeManifestCapabilities(extraField)).toThrow(
    /Unknown HTTP route mount field/,
  );
});

test("shared POST paths derive their prefix", () => {
  const post: NeutronManifest = {
    format: 3,
    id: "shared_post_app",
    name: "Shared Post App",
    version: 100,
    func: { ingest: { type: "internal", async: false } },
    capabilities: {
      http_routes: {
        api: 1,
        mounts: [
          {
            id: "ingest",
            surface: "shared_app_path",
            methods: ["POST"],
            mode: "http_post_update_handler",
            handler: "ingest",
            max_request_bytes: 16_384,
            max_response_bytes: 4096,
            max_calls_per_hour: 60,
            forward_headers: ["x-signature", "content-type"],
          },
        ],
      },
    },
  };
  expect(validateManifest(post).errors).toEqual([]);
  expect(normalizeManifestCapabilities(post)).toEqual({
    http_routes: {
      api: 1,
      mounts: [
        {
          id: "ingest",
          surface: "shared_app_path",
          methods: ["POST"],
          mode: "http_post_update_handler",
          handler: "ingest",
          max_request_bytes: 16_384,
          max_response_bytes: 4096,
          max_calls_per_hour: 60,
          forward_headers: ["content-type", "x-signature"],
        },
      ],
    },
  });

  const authoredSharedPrefix = structuredClone(post) as any;
  authoredSharedPrefix.capabilities.http_routes.mounts[0].prefix = "/public";
  expect(validateManifest(authoredSharedPrefix).valid).toBe(false);
  expect(() => normalizeManifestCapabilities(authoredSharedPrefix)).toThrow(
    /Unknown HTTP route mount field prefix/,
  );
});

test("format 3 keeps source and packaged memory roots context-specific", () => {
  const source = {
    format: 3 as const,
    id: "good_app",
    name: "Good App",
    version: 101,
    src: "main.mo",
    memory: {
      state: {
        version: 2,
        schemas: {
          "1": { src: "memory/state/v1.mo" },
          "2": { src: "memory/state/v2.mo" },
        },
        migrations: [{ from: 1, to: 2, src: "memory/state/v1_to_v2.mo" }],
      },
    },
  };
  expect(() => assertNeutronManifest(source, "source")).not.toThrow();
  expect(() => assertNeutronManifest(source, "package")).toThrow(
    /entry must be a 64-character/,
  );

  const packaged = structuredClone(source) as any;
  packaged.entry = "a".repeat(64);
  packaged.memory.state.schemas["1"].entry = "1".repeat(64);
  packaged.memory.state.schemas["1"].hash = "4".repeat(64);
  packaged.memory.state.schemas["2"].entry = "2".repeat(64);
  packaged.memory.state.schemas["2"].hash = "5".repeat(64);
  packaged.memory.state.migrations[0].entry = "3".repeat(64);
  expect(() => assertNeutronManifest(packaged, "package")).not.toThrow();
  expect(() => assertNeutronManifest(packaged, "source")).toThrow(
    /entry is generated/,
  );

  for (const memoryId of ["", "1state", "m".repeat(129)]) {
    const invalid = {
      ...source,
      memory: { [memoryId]: source.memory.state },
    };
    expect(validateManifest(invalid).valid).toBe(false);
    expect(() => assertNeutronManifest(invalid, "source")).toThrow(
      "Invalid memory id",
    );
  }
});

test("format 3 rejects invalid migration graph metadata", () => {
  const manifest = {
    format: 3 as const,
    id: "good_app",
    name: "Good App",
    version: 100,
    src: "main.mo",
    memory: {
      state: {
        version: 1,
        schemas: { "1": { src: "memory/state/v1.mo" } },
        migrations: [{ from: 1, to: 1, src: "memory/state/bad.mo" }],
      },
    },
  };
  expect(() => assertNeutronManifest(manifest, "source")).toThrow(
    /not forward-only/,
  );
});

test("migration consume metadata accepts unique memory ids only", () => {
  const manifest = {
    format: 3 as const,
    id: "good_app",
    name: "Good App",
    version: 101,
    src: "main.mo",
    memory: {
      state: {
        version: 2,
        schemas: {
          "1": { src: "memory/state/v1.mo" },
          "2": { src: "memory/state/v2.mo" },
        },
        migrations: [
          {
            from: 1,
            to: 2,
            consume: ["state_aux"],
            src: "memory/state/v1_to_v2.mo",
          },
        ],
      },
      state_aux: {
        version: 1,
        schemas: { "1": { src: "memory/state_aux/v1.mo" } },
        migrations: [],
        retired: true,
      },
    },
  };
  expect(() => assertNeutronManifest(manifest, "source")).not.toThrow();

  manifest.memory.state.migrations[0]!.consume = ["state", "state"];
  expect(() => assertNeutronManifest(manifest, "source")).toThrow(
    /Invalid consumed memory/,
  );
});

test("memory lineage locks track schema source independently of imports", () => {
  const manifest = {
    format: 3 as const,
    id: "good_app",
    name: "Good App",
    version: 100,
    entry: "a".repeat(64),
    memory: {
      state: {
        version: 1,
        schemas: {
          "1": { entry: "1".repeat(64), hash: "4".repeat(64) },
        },
        migrations: [],
      },
    },
  };
  const original = createMemoryLock(manifest);
  const dependencyChanged = structuredClone(manifest);
  dependencyChanged.memory.state.schemas["1"]!.entry = "2".repeat(64);
  expect(() =>
    mergeMemoryLock(original, createMemoryLock(dependencyChanged)),
  ).not.toThrow();

  const sourceChanged = structuredClone(manifest);
  sourceChanged.memory.state.schemas["1"]!.hash = "5".repeat(64);
  expect(() =>
    mergeMemoryLock(original, createMemoryLock(sourceChanged)),
  ).toThrow(/schema state v1 changed/);
});

test("memory lineage locks include consumed-root order", () => {
  const manifest = {
    format: 3 as const,
    id: "good_app",
    name: "Good App",
    version: 101,
    entry: "a".repeat(64),
    memory: {
      state: {
        version: 2,
        schemas: {
          "1": { entry: "1".repeat(64), hash: "4".repeat(64) },
          "2": { entry: "2".repeat(64), hash: "5".repeat(64) },
        },
        migrations: [
          {
            from: 1,
            to: 2,
            consume: ["state_aux"],
            entry: "3".repeat(64),
          },
        ],
      },
    },
  };
  const original = createMemoryLock(manifest);
  const changed = structuredClone(manifest);
  changed.memory.state.migrations[0]!.consume = ["different_aux"];
  expect(() => mergeMemoryLock(original, createMemoryLock(changed))).toThrow(
    /migration state 1->2 changed/,
  );
});

test("stable_store declarations are closed, canonical, and strictly bounded", () => {
  const store = {
    id: "notes",
    purpose: "Keep durable notes",
    schema_version: 101,
    max_entries: 64,
    max_key_bytes: 64,
    max_value_bytes: 4096,
    max_bytes: 65_536,
  };
  const manifest = (stable_store: unknown, id = "store_app") => ({
    format: 3 as const,
    id,
    name: "Store App",
    version: 100,
    backend: { capabilities: { stable_store: { api: 1 as const } } },
    capabilities: { stable_store },
  });
  const normalize = (stable_store: unknown, id?: string) =>
    normalizeManifestCapabilities(
      manifest(stable_store, id) as NeutronManifest,
    ).stable_store;

  expect(normalize({ api: 1, stores: [store] })).toEqual({
    api: 1,
    stores: [store],
  });
  expect(
    normalize({
      api: 1,
      stores: [
        { ...store, id: "z_store" },
        { ...store, id: "a_store", schema_version: 1 },
      ],
    })?.stores.map(({ id }) => id),
  ).toEqual(["a_store", "z_store"]);

  for (const invalid of [
    { api: 1, stores: [] },
    { api: 1, stores: Array.from({ length: 9 }, (_, index) => ({ ...store, id: `store_${index}` })) },
    { api: 1, stores: [{ ...store, id: "Bad" }] },
    { api: 1, stores: [{ ...store, schema_version: 0 }] },
    { api: 1, stores: [{ ...store, schema_version: 65_536 }] },
    { api: 1, stores: [{ ...store, max_entries: 4097 }] },
    { api: 1, stores: [{ ...store, max_key_bytes: 257 }] },
    { api: 1, stores: [{ ...store, max_value_bytes: 262_145 }] },
    { api: 1, stores: [{ ...store, max_bytes: 16_777_217 }] },
    { api: 1, stores: [{ ...store, max_key_bytes: 64, max_value_bytes: 4096, max_bytes: 4095 }] },
    { api: 1, stores: [{ ...store }, { ...store }] },
  ]) {
    expect(() => normalize(invalid)).toThrow(/stable_store/);
  }
  expect(() =>
    normalize({
      api: 1,
      stores: [
        { ...store, id: "first", max_entries: 4096 },
        { ...store, id: "second", max_entries: 4096 },
        { ...store, id: "third", max_entries: 1 },
      ],
    }),
  ).toThrow(/aggregate limit/);
  expect(() =>
    normalize({
      api: 1,
      stores: [
        { ...store, id: "first", max_bytes: 16_777_216 },
        { ...store, id: "second", max_bytes: 16_777_216 },
        { ...store, id: "third", max_bytes: 65_536 },
      ],
    }),
  ).toThrow(/aggregate limit/);
  expect(() =>
    normalize({ api: 1, stores: [{ ...store, raw_region: true }] }),
  ).toThrow(/Unknown stable_store store field raw_region/);
  expect(() =>
    normalize({ api: 1, stores: [{ ...store, purpose: "hidden\u202evalue" }] }),
  ).toThrow(/stable_store purpose/);
  expect(() => normalize({ api: 1, stores: [store] }, "kernel")).toThrow(
    /Kernel cannot declare ordinary app capabilities/,
  );

  const invalidSchema = validateManifest(manifest({
    api: 1,
    stores: [{ ...store, stable_memory_offset: 0 }],
  }));
  expect(invalidSchema.errors.length).toBeGreaterThan(0);
});
