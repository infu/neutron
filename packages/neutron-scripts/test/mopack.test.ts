import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NEUTRON_PACKAGE_ARCHIVE_ONLY_FEATURE } from "neutron-tools/src/schema.js";
import { packageMotoko } from "../src/mopack.ts";

test("mopack rejects an unknown top-level manifest field", async () => {
  const cwd = await fs.mkdtemp(
    path.join(os.tmpdir(), "neutron-mopack-schema-"),
  );
  try {
    await fs.writeFile(
      path.join(cwd, "neutron.json"),
      JSON.stringify({
        format: 3,
        id: "test_app",
        name: "Test App",
        version: 100,
        src: "main.mo",
        unexpected: true,
      }),
    );

    await expect(packageMotoko({ cwd, packages: {} })).rejects.toThrow(
      /Invalid neutron\.json:.*additional property.*unexpected/,
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("mopack rejects an unknown manifest function field", async () => {
  const cwd = await fs.mkdtemp(
    path.join(os.tmpdir(), "neutron-mopack-schema-"),
  );
  try {
    await fs.writeFile(
      path.join(cwd, "neutron.json"),
      JSON.stringify({
        format: 3,
        id: "test_app",
        name: "Test App",
        version: 100,
        src: "main.mo",
        func: {
          run: {
            type: "update",
            unexpected: true,
          },
        },
      }),
    );

    await expect(packageMotoko({ cwd, packages: {} })).rejects.toThrow(
      /Invalid neutron\.json:.*additional property.*unexpected/,
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("mopack removes a stale packaged lock for apps without managed memory", async () => {
  const cwd = await fs.mkdtemp(
    path.join(os.tmpdir(), "neutron-mopack-memoryless-"),
  );
  const rootLockPath = path.join(cwd, "neutron.lock.json");
  const distLockPath = path.join(cwd, "dist", "neutron.lock.json");
  const staleLock = `${JSON.stringify({
    format: 2,
    app: "old_app",
    memory: {
      old_state: {
        schemas: {
          "1": {
            hash: "stale",
            entry: "stale",
          },
        },
      },
    },
  })}\n`;

  try {
    await fs.mkdir(path.join(cwd, "backend"), { recursive: true });
    await fs.mkdir(path.join(cwd, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(cwd, "neutron.json"),
      JSON.stringify({
        format: 3,
        id: "test_app",
        name: "Test App",
        version: 100,
        src: "main.mo",
      }),
    );
    await fs.writeFile(
      path.join(cwd, "backend", "main.mo"),
      "module { public class Init() {} }",
    );
    await fs.writeFile(rootLockPath, staleLock);
    await fs.writeFile(distLockPath, staleLock);

    const packaged = await packageMotoko({ cwd, packages: {} });

    await expect(fs.stat(distLockPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await fs.readFile(rootLockPath, "utf8")).toBe(staleLock);
    expect(packaged.package_features).toEqual([
      NEUTRON_PACKAGE_ARCHIVE_ONLY_FEATURE,
    ]);
    expect(
      JSON.parse(await fs.readFile(path.join(cwd, "neutron.json"), "utf8")),
    ).not.toHaveProperty("package_features");
    const packagedManifest = JSON.parse(
      await fs.readFile(path.join(cwd, "dist", "neutron.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(packagedManifest.package_features).toEqual([
      NEUTRON_PACKAGE_ARCHIVE_ONLY_FEATURE,
    ]);
    const legacyClosedFields = new Set([
      "background",
      "backend",
      "capabilities",
      "dependencies",
      "description",
      "entry",
      "format",
      "func",
      "id",
      "init_arg",
      "memory",
      "name",
      "src",
      "tiles",
      "tray",
      "update_source",
      "version",
    ]);
    expect(
      Object.keys(packagedManifest).filter(
        (field) => !legacyClosedFields.has(field),
      ),
    ).toEqual(["package_features"]);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("mopack leaves Kernel packages unmarked for legacy bootstrap", async () => {
  const cwd = await fs.mkdtemp(
    path.join(os.tmpdir(), "neutron-mopack-kernel-feature-"),
  );
  try {
    await fs.mkdir(path.join(cwd, "backend"), { recursive: true });
    await fs.writeFile(
      path.join(cwd, "neutron.json"),
      JSON.stringify({
        format: 3,
        id: "kernel",
        name: "Kernel",
        version: 100,
        src: "main.mo",
      }),
    );
    await fs.writeFile(
      path.join(cwd, "backend", "main.mo"),
      "module { public class Init() {} }",
    );

    const packaged = await packageMotoko({ cwd, packages: {} });
    expect(packaged.package_features).toBeUndefined();
    expect(
      JSON.parse(
        await fs.readFile(path.join(cwd, "dist", "neutron.json"), "utf8"),
      ),
    ).not.toHaveProperty("package_features");
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("mopack leaves update-source app manifests readable by legacy Kernels", async () => {
  const cwd = await fs.mkdtemp(
    path.join(os.tmpdir(), "neutron-mopack-https-source-"),
  );
  try {
    await fs.mkdir(path.join(cwd, "backend"), { recursive: true });
    await fs.writeFile(
      path.join(cwd, "neutron.json"),
      JSON.stringify({
        format: 3,
        id: "test_app",
        name: "Test App",
        version: 100,
        src: "main.mo",
        update_source: "233tv-xiaaa-aaaay-aacta-cai",
      }),
    );
    await fs.writeFile(
      path.join(cwd, "backend", "main.mo"),
      "module { public class Init() {} }",
    );

    const packaged = await packageMotoko({ cwd, packages: {} });

    expect(packaged.package_features).toBeUndefined();
    expect(
      JSON.parse(
        await fs.readFile(path.join(cwd, "dist", "neutron.json"), "utf8"),
      ),
    ).not.toHaveProperty("package_features");
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("mopack preserves explicit embedded-source support", async () => {
  const cwd = await fs.mkdtemp(
    path.join(os.tmpdir(), "neutron-mopack-embedded-source-"),
  );
  try {
    await fs.mkdir(path.join(cwd, "backend"), { recursive: true });
    await fs.writeFile(
      path.join(cwd, "neutron.json"),
      JSON.stringify({
        format: 3,
        id: "test_app",
        name: "Test App",
        version: 100,
        src: "main.mo",
        update_source: "233tv-xiaaa-aaaay-aacta-cai",
      }),
    );
    await fs.writeFile(
      path.join(cwd, "backend", "main.mo"),
      "module { public class Init() {} }",
    );

    const packaged = await packageMotoko({
      cwd,
      packages: {},
      sourceDelivery: "embedded",
    });

    expect(packaged.package_features).toEqual([
      NEUTRON_PACKAGE_ARCHIVE_ONLY_FEATURE,
    ]);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("mopack includes historical schemas and migration roots not imported by the app", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "neutron-mopack-"));
  try {
    await fs.mkdir(path.join(cwd, "backend", "memory", "state"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(cwd, "neutron.json"),
      JSON.stringify({
        format: 3,
        id: "test_app",
        name: "Test App",
        version: 100,
        src: "main.mo",
        memory: {
          state: {
            version: 3,
            schemas: {
              "1": { src: "memory/state/v1.mo" },
              "2": { src: "memory/state/v2.mo" },
              "3": { src: "memory/state/v3.mo" },
            },
            migrations: [
              { from: 1, to: 2, src: "memory/state/v1_to_v2.mo" },
              { from: 2, to: 3, src: "memory/state/v2_to_v3.mo" },
            ],
          },
        },
      }),
    );
    await fs.writeFile(
      path.join(cwd, "backend", "main.mo"),
      'import V3 "./memory/state/v3"; module { public class Init(_mem : V3.Mem) {} }',
    );
    for (const version of [1, 2, 3]) {
      await fs.writeFile(
        path.join(cwd, "backend", "memory", "state", `v${version}.mo`),
        `module { public type Mem = { var value : Nat }; public func init() : Mem { { var value = ${version} } } }`,
      );
    }
    await fs.writeFile(
      path.join(cwd, "backend", "memory", "state", "v1_to_v2.mo"),
      'import V1 "./v1"; import V2 "./v2"; module { public func migrate(old : V1.Mem) : V2.Mem { old } }',
    );
    await fs.writeFile(
      path.join(cwd, "backend", "memory", "state", "v2_to_v3.mo"),
      'import V2 "./v2"; import V3 "./v3"; module { public func migrate(old : V2.Mem) : V3.Mem { old } }',
    );

    const manifest = await packageMotoko({ cwd, packages: {} });
    const memory = manifest.memory!.state!;
    const roots = [
      manifest.entry,
      ...Object.values(memory.schemas!).map((schema) => schema.entry),
      ...memory.migrations!.map((edge) => edge.entry),
    ];
    expect(roots.every((entry) => typeof entry === "string")).toBe(true);
    const packagedFiles = await fs.readdir(path.join(cwd, "dist", "mo"));
    for (const entry of roots) expect(packagedFiles).toContain(`${entry}.mo`);
    expect(
      JSON.parse(
        await fs.readFile(path.join(cwd, "neutron.lock.json"), "utf8"),
      ),
    ).toMatchObject({
      format: 2,
      app: "test_app",
      memory: {
        state: {
          schemas: {
            "1": {
              hash: memory.schemas!["1"]!.hash,
              entry: memory.schemas!["1"]!.entry,
            },
          },
        },
      },
    });

    await fs.writeFile(
      path.join(cwd, "backend", "memory", "state", "v1.mo"),
      "module { public type Mem = { var value : Nat }; public func init() : Mem { { var value = 99 } } }",
    );
    await expect(packageMotoko({ cwd, packages: {} })).rejects.toThrow(
      /Locked schema state v1 changed/,
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("mopack rejects local imports in a memory schema", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "neutron-mopack-schema-"));
  try {
    await fs.mkdir(path.join(cwd, "backend", "memory", "state"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(cwd, "neutron.json"),
      JSON.stringify({
        format: 3,
        id: "test_app",
        name: "Test App",
        version: 100,
        src: "main.mo",
        memory: {
          state: {
            version: 1,
            schemas: { "1": { src: "memory/state/v1.mo" } },
            migrations: [],
          },
        },
      }),
    );
    await fs.writeFile(
      path.join(cwd, "backend", "main.mo"),
      "module { public class Init() {} }",
    );
    await fs.writeFile(
      path.join(cwd, "backend", "memory", "state", "v1.mo"),
      'import Types "../../Types"; module { public type Mem = Types.Mem; public func init() : Mem { Types.init() } }',
    );

    await expect(packageMotoko({ cwd, packages: {} })).rejects.toThrow(
      /cannot import local module/,
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("memory schema identity excludes package dependency contents", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "neutron-mopack-package-schema-"));
  const packageRoot = path.join(cwd, "dependency");
  try {
    await fs.mkdir(path.join(cwd, "backend", "memory", "state"), {
      recursive: true,
    });
    await fs.mkdir(packageRoot);
    await fs.writeFile(
      path.join(cwd, "neutron.json"),
      JSON.stringify({
        format: 3,
        id: "test_app",
        name: "Test App",
        version: 100,
        src: "main.mo",
        memory: {
          state: {
            version: 1,
            schemas: { "1": { src: "memory/state/v1.mo" } },
            migrations: [],
          },
        },
      }),
    );
    await fs.writeFile(
      path.join(cwd, "backend", "main.mo"),
      "module { public class Init() {} }",
    );
    await fs.writeFile(
      path.join(cwd, "backend", "memory", "state", "v1.mo"),
      'import Types "mo:dependency/Types"; module { public type Mem = Types.Mem; public func init() : Mem { Types.init() } }',
    );
    await fs.writeFile(
      path.join(packageRoot, "Types.mo"),
      "module { public type Mem = { var value : Nat }; public let revision = 1; public func init() : Mem { { var value = 0 } } }",
    );

    const first = await packageMotoko({
      cwd,
      packages: { dependency: packageRoot },
    });
    const firstSchema = first.memory!.state!.schemas!["1"]!;
    await fs.writeFile(
      path.join(packageRoot, "Types.mo"),
      "module { public type Mem = { var value : Nat }; public let revision = 2; public func init() : Mem { { var value = 0 } } }",
    );
    const second = await packageMotoko({
      cwd,
      packages: { dependency: packageRoot },
    });
    const secondSchema = second.memory!.state!.schemas!["1"]!;

    expect(secondSchema.hash).toBe(firstSchema.hash);
    expect(secondSchema.entry).not.toBe(firstSchema.entry);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("mopack fails ordinary apps that construct actors", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "neutron-mopack-danger-"));
  try {
    await fs.mkdir(path.join(cwd, "backend"), { recursive: true });
    await fs.writeFile(
      path.join(cwd, "neutron.json"),
      JSON.stringify({
        format: 3,
        id: "test_app",
        name: "Test App",
        version: 100,
        src: "main.mo",
      }),
    );
    await fs.writeFile(
      path.join(cwd, "backend", "main.mo"),
      'module { public class Init() { let target : actor {} = actor ("aaaaa-aa") } }',
    );

    await expect(packageMotoko({ cwd, packages: {} })).rejects.toThrow(
      /Disallowed Motoko code/,
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("mopack rejects source-level capability escapes", async () => {
  const cwd = await fs.mkdtemp(
    path.join(os.tmpdir(), "neutron-mopack-capability-"),
  );
  const fixtures = [
    {
      finding: "actorOfPrincipal",
      source:
        'import { actorOfPrincipal = convert } "mo:prim"; module { public let use = convert }',
    },
    {
      finding: "cyclesTransfer",
      source:
        "module { func run() : async () {}; public func use() : async () { let context = { cycles = 1 }; await (context with) run() } }",
    },
    {
      finding: "regionMemory",
      source:
        'import { regionNew = allocate } "mo:prim"; module { public let use = allocate }',
    },
    {
      finding: "systemEnvironment",
      source:
        'import { envVar = read } "mo:prim"; module { public let use = read }',
    },
    {
      finding: "systemCallerInfo",
      source:
        'import Prim "mo:prim"; module { public let use = Prim.callerInfoData }',
    },
    {
      finding: "systemCandidLimits",
      source:
        'import { setCandidLimits = configure } "mo:prim"; module { public let use = configure }',
    },
    {
      finding: "systemCapability",
      source:
        "module { public func use<system, Value>(value : Value) : Value { value } }",
    },
  ];

  try {
    await fs.mkdir(path.join(cwd, "backend"), { recursive: true });
    await fs.writeFile(
      path.join(cwd, "neutron.json"),
      JSON.stringify({
        format: 3,
        id: "test_app",
        name: "Test App",
        version: 100,
        src: "main.mo",
      }),
    );

    for (const fixture of fixtures) {
      await fs.writeFile(path.join(cwd, "backend", "main.mo"), fixture.source);
      await expect(packageMotoko({ cwd, packages: {} })).rejects.toThrow(
        new RegExp(`Disallowed Motoko code.*${fixture.finding}`),
      );
    }

    await fs.writeFile(
      path.join(cwd, "backend", "main.mo"),
      [
        "module {",
        "  type Metrics = { cyclesBalance : Nat; regionSize : Nat };",
        "  let toActor = 1;",
        '  let sample = { call_raw = false; envVar = "local" };',
        "  func createActor(setTimer : Text) : Text { setTimer };",
        "  func setCandidLimits(value : Nat) : Nat { value };",
        "}",
      ].join("\n"),
    );
    await expect(packageMotoko({ cwd, packages: {} })).resolves.toBeDefined();
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("mopack scans managed schemas and migration roots", async () => {
  const cwd = await fs.mkdtemp(
    path.join(os.tmpdir(), "neutron-mopack-memory-danger-"),
  );
  const memoryDirectory = path.join(cwd, "backend", "memory");
  const safeSchema =
    "module { public type Mem = { var value : Nat }; public func init() : Mem { { var value = 0 } } }";
  const safeMigration =
    'import V1 "./v1"; import V2 "./v2"; module { public func migrate(old : V1.Mem) : V2.Mem { old } }';

  try {
    await fs.mkdir(memoryDirectory, { recursive: true });
    await fs.writeFile(
      path.join(cwd, "neutron.json"),
      JSON.stringify({
        format: 3,
        id: "test_app",
        name: "Test App",
        version: 100,
        src: "main.mo",
        memory: {
          state: {
            version: 2,
            schemas: {
              "1": { src: "memory/v1.mo" },
              "2": { src: "memory/v2.mo" },
            },
            migrations: [
              { from: 1, to: 2, src: "memory/v1_to_v2.mo" },
            ],
          },
        },
      }),
    );
    await fs.writeFile(
      path.join(cwd, "backend", "main.mo"),
      'import V2 "./memory/v2"; module { public class Init(_memory : V2.Mem) {} }',
    );
    await fs.writeFile(path.join(memoryDirectory, "v1.mo"), safeSchema);
    await fs.writeFile(path.join(memoryDirectory, "v2.mo"), safeSchema);
    await fs.writeFile(
      path.join(memoryDirectory, "v1_to_v2.mo"),
      safeMigration,
    );

    await fs.writeFile(
      path.join(memoryDirectory, "v1.mo"),
      "module { public type Mem = { remote : actor {} }; public func init() : Mem { loop {} } }",
    );
    await expect(packageMotoko({ cwd, packages: {} })).rejects.toThrow(
      /Disallowed Motoko code.*actor/,
    );

    await fs.writeFile(path.join(memoryDirectory, "v1.mo"), safeSchema);
    await fs.writeFile(
      path.join(memoryDirectory, "v1_to_v2.mo"),
      "module { func run() : async () {}; public func migrate(value : Nat) : async Nat { let context = { cycles = 1 }; await (context with) run(); value } }",
    );
    await expect(packageMotoko({ cwd, packages: {} })).rejects.toThrow(
      /Disallowed Motoko code.*cyclesTransfer/,
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
