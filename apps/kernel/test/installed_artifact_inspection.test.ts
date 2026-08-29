import { expect, test } from "bun:test";
import { compareCanonicalText } from "neutron-tools/src/canonical.js";
import { hashContent } from "neutron-tools/src/hash.js";
import {
  KERNEL_INSTALLED_ARTIFACT_INVENTORY_PATH,
  createKernelInstalledArtifactInventory,
  kernelInstalledArtifactPath,
  kernelPackagePathRequiresInlineText,
} from "neutron-tools/src/installed_artifacts.js";
import {
  InstalledArtifactInspector,
  type InstalledArtifactBinding,
  type InstalledArtifactInspectionEnvironment,
  type InstalledArtifactRead,
} from "../src/source_inspection/installed_artifacts.ts";

const encoder = new TextEncoder();
const APP_ID = "alpha";
const APP_PREFIX = `/app/${APP_ID}/`;
const APP_MANIFEST_PATH = `${APP_PREFIX}pkg/neutron.json`;

type FixtureAsset = Uint8Array | "too_large" | Readonly<{ error: Error }>;

type FilesResult = {
  appId: string;
  appVersion: number;
  installationUid: string;
  sourceRevision: string;
  artifacts: Array<{
    path: string;
    area: string;
    readability: string;
    bytes?: number;
    sha256?: string;
  }>;
  complete: boolean;
  nextCursor: string | null;
};

type ReadResult = {
  appId: string;
  sourceRevision: string;
  path: string;
  area: string;
  kind: "text" | "binary" | "unavailable";
  sha256?: string;
  totalBytes?: number;
  startByte?: number;
  endByte?: number;
  text?: string;
  reason?: string;
  complete: boolean;
  nextCursor: string | null;
};

type SearchResult = {
  appId: string;
  sourceRevision: string;
  matches: Array<{
    path: string;
    area: string;
    characterOffset: number;
    preview: string;
    sha256: string;
  }>;
  scannedFiles: number;
  scannedBytes: number;
  skippedBinaryFiles: number;
  skippedLargeFiles: number;
  skippedUnavailableFiles: number;
  truncatedFiles: number;
  complete: boolean;
  nextCursor: string | null;
};

class InspectionFixture {
  readonly assets = new Map<string, FixtureAsset>();
  readonly listings = new Map<string, readonly string[]>();
  readonly bindings = new Map<string, InstalledArtifactBinding>();
  readonly listCalls: string[] = [];
  readonly readCalls: Array<{
    path: string;
    maximumBytes: number;
    signal: AbortSignal | undefined;
  }> = [];
  readInterceptor:
    | ((
        path: string,
        maximumBytes: number,
        signal: AbortSignal | undefined,
      ) => Promise<InstalledArtifactRead | null>)
    | null = null;

  readonly environment: InstalledArtifactInspectionEnvironment = {
    currentBinding: (appId) => this.bindings.get(appId) ?? null,
    listStatic: async (prefix, signal) => {
      this.listCalls.push(prefix);
      if (signal?.aborted) throw signal.reason;
      return this.listings.get(prefix) ?? [];
    },
    readAsset: async (path, maximumBytes, signal) => {
      this.readCalls.push({ path, maximumBytes, signal });
      const intercepted = await this.readInterceptor?.(
        path,
        maximumBytes,
        signal,
      );
      if (intercepted) return intercepted;
      const value = this.assets.get(path);
      if (value === undefined) return { status: "missing" };
      if (value === "too_large") return { status: "too_large" };
      if ("error" in value) throw value.error;
      if (value.byteLength > maximumBytes) return { status: "too_large" };
      return { status: "ok", content: value };
    },
  };

  readonly inspector = new InstalledArtifactInspector(this.environment);

  bind(
    appId: string,
    overrides: Partial<InstalledArtifactBinding> = {},
  ): InstalledArtifactBinding {
    const binding = Object.freeze({
      appId,
      version: 100,
      installationUid: "1",
      capabilityPlanFingerprint: "c".repeat(64),
      runtimeIdentity: "runtime-one",
      ...overrides,
    });
    this.bindings.set(appId, binding);
    return binding;
  }
}

type Module = Readonly<{
  content: Uint8Array;
  hash: string;
  path: string;
}>;

function motoko(content: string): Module {
  const bytes = encode(content);
  const hash = hashContent(bytes);
  return Object.freeze({ content: bytes, hash, path: `/mo/${hash}.mo` });
}

function installModule(fixture: InspectionFixture, module: Module): void {
  fixture.assets.set(module.path, module.content);
}

function encode(value: string): Uint8Array {
  return encoder.encode(value);
}

function json(value: unknown): Uint8Array {
  return encode(`${JSON.stringify(value)}\n`);
}

function manifest(input: {
  id?: string;
  name?: string;
  version?: number;
  entry: string;
  memory?: unknown;
}): Uint8Array {
  return json({
    format: 3,
    id: input.id ?? APP_ID,
    name: input.name ?? "Alpha",
    version: input.version ?? 100,
    entry: input.entry,
    ...(input.memory === undefined ? {} : { memory: input.memory }),
  });
}

function ordinaryFixture(
  options: {
    entry?: Module;
    manifestMemory?: unknown;
    frontend?: Readonly<Record<string, FixtureAsset>>;
    extraListedPaths?: readonly string[];
  } = {},
): {
  fixture: InspectionFixture;
  entry: Module;
} {
  const fixture = new InspectionFixture();
  fixture.bind(APP_ID);
  const entry = options.entry ?? motoko("module { public let value = 1 }");
  installModule(fixture, entry);
  fixture.assets.set(
    APP_MANIFEST_PATH,
    manifest({ entry: entry.hash, memory: options.manifestMemory }),
  );
  const frontend = options.frontend ?? {
    [`${APP_PREFIX}index.html`]: encode("<main>Alpha</main>"),
    [`${APP_PREFIX}main.js`]: encode("console.log('alpha')"),
  };
  for (const [path, value] of Object.entries(frontend)) {
    fixture.assets.set(path, value);
  }
  const packageInfoPath = `${APP_PREFIX}pkg/info.json`;
  fixture.assets.set(packageInfoPath, json({ installed: true }));
  fixture.listings.set(APP_PREFIX, [
    `${APP_PREFIX}_route/private`,
    packageInfoPath,
    ...Object.keys(frontend),
    APP_MANIFEST_PATH,
    ...(options.extraListedPaths ?? []),
  ]);
  return { fixture, entry };
}

async function initialFiles(
  fixture: InspectionFixture,
  appId = APP_ID,
  overrides: Record<string, unknown> = {},
): Promise<FilesResult> {
  return (await fixture.inspector.list({
    appId,
    sourceRevision: null,
    cursor: null,
    ...overrides,
  })) as unknown as FilesResult;
}

test("ordinary inspection is app-scoped, excludes route storage, and walks one shared backend graph", async () => {
  const shared = motoko("module { public let shared = 1 }");
  const branch = motoko(
    `import Shared "${shared.hash}";\nmodule { public let branch = Shared.shared }`,
  );
  const entry = motoko(
    [
      `import Branch "${branch.hash}";`,
      `import Shared "${shared.hash}";`,
      `import SharedAgain "${shared.hash}";`,
      "module { public let value = Branch.branch + Shared.shared + SharedAgain.shared }",
    ].join("\n"),
  );
  const optionalSchema = "e".repeat(64);
  const optionalMigration = "f".repeat(64);
  const retired = motoko("module { public let retired = true }");
  const { fixture } = ordinaryFixture({
    entry,
    manifestMemory: {
      state: {
        version: 2,
        schemas: {
          "1": { entry: optionalSchema, hash: "1".repeat(64) },
          // Reusing the app entry as the current schema root exercises the
          // visited-root fence without inventing an impossible hash cycle.
          "2": { entry: entry.hash, hash: "2".repeat(64) },
        },
        migrations: [{ from: 1, to: 2, entry: optionalMigration }],
      },
      retired_state: {
        version: 1,
        retired: true,
        schemas: {
          "1": { entry: retired.hash, hash: "3".repeat(64) },
          "2": { entry: optionalSchema, hash: "4".repeat(64) },
        },
        migrations: [],
      },
    },
  });
  installModule(fixture, shared);
  installModule(fixture, branch);
  installModule(fixture, retired);
  fixture.assets.set("/app/bravo/main.js", encode("sibling secret"));
  const orphan = motoko("module { public let orphan = true }");
  installModule(fixture, orphan);

  const result = await initialFiles(fixture);
  const paths = result.artifacts.map(({ path }) => path);

  expect(fixture.listCalls).toEqual([APP_PREFIX]);
  expect(paths).toEqual([...paths].sort(compareCanonicalText));
  expect(paths).toContain(`${APP_PREFIX}main.js`);
  expect(paths).toContain(APP_MANIFEST_PATH);
  expect(paths).toContain(entry.path);
  expect(paths).toContain(branch.path);
  expect(paths).toContain(retired.path);
  expect(paths.filter((path) => path === shared.path)).toHaveLength(1);
  expect(paths).not.toContain(orphan.path);
  expect(paths.some((path) => path.includes("/_route"))).toBe(false);
  expect(paths.some((path) => path.startsWith("/app/bravo/"))).toBe(false);
  expect(paths).not.toContain(`/mo/${optionalSchema}.mo`);
  expect(paths).not.toContain(`/mo/${optionalMigration}.mo`);
  expect(
    fixture.readCalls.filter(({ path }) => path === `/mo/${optionalSchema}.mo`),
  ).toHaveLength(1);
  expect(
    fixture.readCalls.some(({ path }) => path === "/app/bravo/main.js"),
  ).toBe(false);
  expect(fixture.readCalls.some(({ path }) => path === orphan.path)).toBe(
    false,
  );

  const escaped = ordinaryFixture({
    extraListedPaths: ["/app/bravo/main.js"],
  }).fixture;
  await expect(initialFiles(escaped)).rejects.toThrow(
    "escaped its app subtree",
  );
});

test("only one cold installed-artifact catalog build is admitted", async () => {
  const { fixture } = ordinaryFixture();
  let markStarted!: () => void;
  let releaseBuild!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseBuild = resolve;
  });
  fixture.readInterceptor = async (path) => {
    if (path !== APP_MANIFEST_PATH) return null;
    markStarted();
    await released;
    return null;
  };

  const first = initialFiles(fixture);
  await started;
  await expect(initialFiles(fixture)).rejects.toMatchObject({
    code: "UI_BUSY",
  });
  releaseBuild();
  await expect(first).resolves.toMatchObject({ appId: APP_ID });
});

test("Kernel inventory owns packaged files and adds only the closed runtime artifacts", async () => {
  const fixture = new InspectionFixture();
  fixture.bind("kernel");
  const entry = motoko("module { public let kernel = true }");
  installModule(fixture, entry);
  const manifestBytes = manifest({
    id: "kernel",
    name: "Kernel",
    entry: entry.hash,
  });
  const packaged = new Map<string, Uint8Array>([
    ["web/index.html", encode("<main>Kernel</main>")],
    ["web/main.js", encode("console.log('kernel')")],
    [
      "web/system/browser-origin-cleanup.html",
      encode("<script>parent.postMessage('ready', '*')</script>"),
    ],
    ["legal/NOTICE.txt", encode("notice")],
    ["neutron.json", manifestBytes],
  ]);
  const inventoryFiles = [...packaged].map(([packagePath, content]) => ({
    package_path: packagePath,
    bytes: content.byteLength,
    sha256: hashContent(content),
    ...(kernelPackagePathRequiresInlineText(packagePath)
      ? { inline_text: new TextDecoder().decode(content) }
      : {}),
  }));
  inventoryFiles.sort((left, right) =>
    compareCanonicalText(left.package_path, right.package_path),
  );
  const inventory = createKernelInstalledArtifactInventory({
    version: 100,
    artifacts: inventoryFiles,
  });
  for (const [packagePath, content] of packaged) {
    if (kernelPackagePathRequiresInlineText(packagePath)) continue;
    fixture.assets.set(kernelInstalledArtifactPath(packagePath), content);
  }
  fixture.assets.set(KERNEL_INSTALLED_ARTIFACT_INVENTORY_PATH, json(inventory));
  fixture.assets.set("/pkg/neutron.did", encode("service : {}"));
  fixture.assets.set("/pkg/neutron.most", encode("type Stable = {}"));
  fixture.assets.set("/system/staging/private", encode("not inspectable"));

  const result = await initialFiles(fixture, "kernel");
  const byPath = new Map(result.artifacts.map((file) => [file.path, file]));

  expect(fixture.listCalls).toEqual([]);
  expect(byPath.get("/")?.area).toBe("frontend");
  expect(byPath.get("/main.js")?.area).toBe("frontend");
  expect(byPath.get("/system/browser-origin-cleanup.html")).toMatchObject({
    area: "frontend",
    readability: "text",
  });
  expect(byPath.get("/pkg/legal/NOTICE.txt")?.area).toBe("package");
  expect(byPath.get(KERNEL_INSTALLED_ARTIFACT_INVENTORY_PATH)?.area).toBe(
    "package",
  );
  expect(byPath.get("/pkg/neutron.did")?.area).toBe("runtime");
  expect(byPath.get("/pkg/neutron.most")?.area).toBe("runtime");
  expect(byPath.get("/pkg/neutron.json")).toMatchObject({
    bytes: manifestBytes.byteLength,
    sha256: hashContent(manifestBytes),
  });
  expect(byPath.has("/system/staging/private")).toBe(false);

  const cleanup = (await fixture.inspector.read({
    appId: "kernel",
    sourceRevision: result.sourceRevision,
    path: "/system/browser-origin-cleanup.html",
    cursor: null,
  })) as unknown as ReadResult;
  expect(cleanup).toMatchObject({
    area: "frontend",
    kind: "text",
    text: "<script>parent.postMessage('ready', '*')</script>",
    complete: true,
    nextCursor: null,
  });
  expect(
    fixture.readCalls.some(
      ({ path }) => path === "/system/browser-origin-cleanup.html",
    ),
  ).toBe(false);

  const runtime = (await fixture.inspector.read({
    appId: "kernel",
    sourceRevision: result.sourceRevision,
    path: "/pkg/neutron.did",
    cursor: null,
  })) as unknown as ReadResult;
  expect(runtime).toMatchObject({
    area: "runtime",
    kind: "text",
    text: "service : {}",
    complete: true,
    nextCursor: null,
  });

  fixture.assets.set("/main.js", encode("console.log('changed and longer')"));
  await expect(
    fixture.inspector.read({
      appId: "kernel",
      sourceRevision: result.sourceRevision,
      path: "/main.js",
      cursor: null,
    }),
  ).rejects.toThrow("failed integrity verification");
});

test("required backend roots fail closed when missing, oversized, or digest-mismatched", async () => {
  const missingHash = "a".repeat(64);
  const missing = ordinaryFixture({
    entry: {
      hash: missingHash,
      path: `/mo/${missingHash}.mo`,
      content: encode("not installed"),
    },
  }).fixture;
  missing.assets.delete(`/mo/${missingHash}.mo`);
  await expect(initialFiles(missing)).rejects.toThrow(
    "Required installed backend module",
  );

  const oversizedHash = "b".repeat(64);
  const oversized = ordinaryFixture({
    entry: {
      hash: oversizedHash,
      path: `/mo/${oversizedHash}.mo`,
      content: encode("not installed"),
    },
  }).fixture;
  oversized.assets.set(`/mo/${oversizedHash}.mo`, "too_large");
  await expect(initialFiles(oversized)).rejects.toThrow(
    "Required installed backend module",
  );

  const claimedHash = "d".repeat(64);
  const badDigest = ordinaryFixture({
    entry: {
      hash: claimedHash,
      path: `/mo/${claimedHash}.mo`,
      content: encode("wrong bytes"),
    },
  }).fixture;
  await expect(initialFiles(badDigest)).rejects.toThrow("wrong digest");

  const entry = motoko("module { public let entry = true }");
  const currentSchema = "9".repeat(64);
  const requiredSchema = ordinaryFixture({
    entry,
    manifestMemory: {
      state: {
        version: 1,
        schemas: {
          "1": { entry: currentSchema, hash: "8".repeat(64) },
        },
        migrations: [],
      },
    },
  }).fixture;
  await expect(initialFiles(requiredSchema)).rejects.toThrow(
    `/mo/${currentSchema}.mo`,
  );
});

test("source.files paginates canonically and binds cursors to exact arguments", async () => {
  const { fixture } = ordinaryFixture({
    frontend: {
      [`${APP_PREFIX}z.js`]: encode("z"),
      [`${APP_PREFIX}a.js`]: encode("a"),
      [`${APP_PREFIX}m.css`]: encode("m"),
    },
  });
  const first = await initialFiles(fixture, APP_ID, { limit: 1 });
  expect(first.complete).toBe(false);
  expect(first.nextCursor).toBeString();

  await expect(
    fixture.inspector.list({
      appId: APP_ID,
      sourceRevision: null,
      cursor: first.nextCursor,
      limit: 1,
    }),
  ).rejects.toMatchObject({
    code: "INVALID_REQUEST",
    message: "source.files continuation requires the returned sourceRevision",
  });

  await expect(
    fixture.inspector.list({
      appId: APP_ID,
      sourceRevision: first.sourceRevision,
      cursor: first.nextCursor,
      area: "frontend",
      limit: 1,
    }),
  ).rejects.toMatchObject({
    code: "INVALID_REQUEST",
    message: "source.files cursor does not match this request",
  });

  const paths: string[] = [];
  let cursor: string | null = null;
  do {
    const page = (await fixture.inspector.list({
      appId: APP_ID,
      sourceRevision: cursor === null ? null : first.sourceRevision,
      cursor,
      limit: 2,
    })) as unknown as FilesResult;
    paths.push(...page.artifacts.map(({ path }) => path));
    cursor = page.nextCursor;
    if (page.complete) expect(cursor).toBeNull();
  } while (cursor !== null);

  expect(paths).toEqual([...paths].sort(compareCanonicalText));
  expect(new Set(paths).size).toBe(paths.length);
});

test("source.read preserves UTF-8 boundaries and paginates a long minified line", async () => {
  const content = `A🙂B${"x".repeat(60_000)}TARGET`;
  const path = `${APP_PREFIX}main.js`;
  const { fixture } = ordinaryFixture({
    frontend: { [path]: encode(content) },
  });
  const listed = await initialFiles(fixture);

  const first = (await fixture.inspector.read({
    appId: APP_ID,
    sourceRevision: listed.sourceRevision,
    path,
    cursor: null,
    maxBytes: 4,
  })) as unknown as ReadResult;
  expect(first).toMatchObject({
    kind: "text",
    startByte: 0,
    endByte: 1,
    text: "A",
    complete: false,
  });
  const emoji = (await fixture.inspector.read({
    appId: APP_ID,
    sourceRevision: listed.sourceRevision,
    path,
    cursor: first.nextCursor,
    maxBytes: 4,
  })) as unknown as ReadResult;
  expect(emoji).toMatchObject({
    kind: "text",
    startByte: 1,
    endByte: 5,
    text: "🙂",
  });
  await expect(
    fixture.inspector.read({
      appId: APP_ID,
      sourceRevision: listed.sourceRevision,
      path,
      cursor: first.nextCursor,
      maxBytes: 5,
    }),
  ).rejects.toMatchObject({
    code: "INVALID_REQUEST",
    message: "source.read cursor does not match this request",
  });

  const longFirst = (await fixture.inspector.read({
    appId: APP_ID,
    sourceRevision: listed.sourceRevision,
    path,
    cursor: null,
    maxBytes: 49_152,
  })) as unknown as ReadResult;
  expect(longFirst.kind).toBe("text");
  expect(longFirst.complete).toBe(false);
  expect(longFirst.text?.includes("\n")).toBe(false);
  const longSecond = (await fixture.inspector.read({
    appId: APP_ID,
    sourceRevision: listed.sourceRevision,
    path,
    cursor: longFirst.nextCursor,
    maxBytes: 49_152,
  })) as unknown as ReadResult;
  expect(longSecond).toMatchObject({ kind: "text" });
  expect(`${longFirst.text}${longSecond.text}`).toBe(content);
  expect(longSecond.complete).toBe(true);
  expect(fixture.readCalls.filter((call) => call.path === path)).toHaveLength(
    1,
  );
});

test("source.read and source.search preserve BOM and chunk-leading U+FEFF", async () => {
  const path = `${APP_PREFIX}bom.js`;
  const content = "\uFEFFABCD\uFEFFZ";
  const { fixture } = ordinaryFixture({
    frontend: { [path]: encode(content) },
  });
  const listed = await initialFiles(fixture);

  const chunks: string[] = [];
  let cursor: string | null = null;
  do {
    const page = (await fixture.inspector.read({
      appId: APP_ID,
      sourceRevision: listed.sourceRevision,
      path,
      cursor,
      maxBytes: 4,
    })) as unknown as ReadResult;
    expect(page.kind).toBe("text");
    chunks.push(page.text ?? "");
    cursor = page.nextCursor;
  } while (cursor !== null);
  expect(chunks).toEqual(["\uFEFFA", "BCD", "\uFEFFZ"]);
  expect(chunks.join("")).toBe(content);

  const searched = (await fixture.inspector.search({
    appId: APP_ID,
    sourceRevision: listed.sourceRevision,
    query: "\uFEFFZ",
    cursor: null,
    pathPrefix: path,
  })) as unknown as SearchResult;
  expect(searched.matches).toEqual([
    expect.objectContaining({ characterOffset: 5 }),
  ]);
});

test("source.read and source.search classify invalid UTF-8 and NUL as binary", async () => {
  const invalidPath = `${APP_PREFIX}invalid.dat`;
  const nulPath = `${APP_PREFIX}nul.js`;
  const { fixture } = ordinaryFixture({
    frontend: {
      [invalidPath]: Uint8Array.of(0xc3, 0x28),
      [nulPath]: encode("before\0after"),
    },
  });
  const listed = await initialFiles(fixture);

  for (const path of [invalidPath, nulPath]) {
    const result = (await fixture.inspector.read({
      appId: APP_ID,
      sourceRevision: listed.sourceRevision,
      path,
      cursor: null,
    })) as unknown as ReadResult;
    expect(result).toMatchObject({
      path,
      kind: "binary",
      complete: true,
      nextCursor: null,
    });
    expect(result.text).toBeUndefined();
  }

  const searched = (await fixture.inspector.search({
    appId: APP_ID,
    sourceRevision: listed.sourceRevision,
    query: "before",
    cursor: null,
    area: "frontend",
  })) as unknown as SearchResult;
  expect(searched.matches).toEqual([]);
  expect(searched.skippedBinaryFiles).toBe(2);
  expect(searched.complete).toBe(true);
});

test("source.search is literal, ASCII-insensitive only, and cursor-bound", async () => {
  const path = `${APP_PREFIX}case.js`;
  const secondPath = `${APP_PREFIX}case2.js`;
  const text = "Alpha alpha ALPHA .* αLPHA ΑLPHA";
  const { fixture } = ordinaryFixture({
    frontend: {
      [path]: encode(text),
      [secondPath]: encode("alpha in another file"),
    },
  });
  const listed = await initialFiles(fixture);
  const allCaseMatches = (await fixture.inspector.search({
    appId: APP_ID,
    sourceRevision: listed.sourceRevision,
    query: "alpha",
    cursor: null,
    area: "frontend",
    pathPrefix: path,
    caseSensitive: false,
  })) as unknown as SearchResult;
  expect(
    allCaseMatches.matches.map(({ characterOffset }) => characterOffset),
  ).toEqual([0, 6, 12]);
  expect(allCaseMatches.truncatedFiles).toBe(0);

  const first = (await fixture.inspector.search({
    appId: APP_ID,
    sourceRevision: listed.sourceRevision,
    query: "alpha",
    cursor: null,
    area: "frontend",
    pathPrefix: APP_PREFIX,
    caseSensitive: false,
    limit: 1,
  })) as unknown as SearchResult;
  expect(first.matches).toEqual([
    expect.objectContaining({ path, characterOffset: 0 }),
  ]);
  expect(first.truncatedFiles).toBe(1);
  expect(first.complete).toBe(false);

  await expect(
    fixture.inspector.search({
      appId: APP_ID,
      sourceRevision: listed.sourceRevision,
      query: "ALPHA",
      cursor: first.nextCursor,
      area: "frontend",
      pathPrefix: APP_PREFIX,
      caseSensitive: false,
      limit: 1,
    }),
  ).rejects.toMatchObject({
    code: "INVALID_REQUEST",
    message: "source.search cursor does not match this request",
  });

  const second = (await fixture.inspector.search({
    appId: APP_ID,
    sourceRevision: listed.sourceRevision,
    query: "alpha",
    cursor: first.nextCursor,
    area: "frontend",
    pathPrefix: APP_PREFIX,
    caseSensitive: false,
    limit: 1,
  })) as unknown as SearchResult;
  expect(second.matches).toEqual([
    expect.objectContaining({ path: secondPath, characterOffset: 0 }),
  ]);
  expect(second.complete).toBe(true);
  expect(second.nextCursor).toBeNull();

  const literal = (await fixture.inspector.search({
    appId: APP_ID,
    sourceRevision: listed.sourceRevision,
    query: ".*",
    cursor: null,
    pathPrefix: path,
  })) as unknown as SearchResult;
  expect(literal.matches).toHaveLength(1);
  expect(literal.matches[0]?.preview).toContain(".*");

  const asciiSuffixOnly = (await fixture.inspector.search({
    appId: APP_ID,
    sourceRevision: listed.sourceRevision,
    query: "αlpha",
    cursor: null,
    pathPrefix: path,
    caseSensitive: false,
  })) as unknown as SearchResult;
  expect(asciiSuffixOnly.matches).toHaveLength(1);
  const nonAsciiCase = (await fixture.inspector.search({
    appId: APP_ID,
    sourceRevision: listed.sourceRevision,
    query: "αlpha",
    cursor: null,
    pathPrefix: `${APP_PREFIX}missing`,
    caseSensitive: false,
  })) as unknown as SearchResult;
  expect(nonAsciiCase.matches).toEqual([]);
});

test("source.search bounds dense matches per file without rescanning it", async () => {
  const path = `${APP_PREFIX}dense.js`;
  const { fixture } = ordinaryFixture({
    frontend: { [path]: encode("x ".repeat(100)) },
  });
  const listed = await initialFiles(fixture);
  const result = (await fixture.inspector.search({
    appId: APP_ID,
    sourceRevision: listed.sourceRevision,
    query: "x",
    cursor: null,
    pathPrefix: path,
    limit: 8,
  })) as unknown as SearchResult;

  expect(result.matches).toHaveLength(8);
  expect(result.truncatedFiles).toBe(1);
  expect(result.complete).toBe(true);
  expect(result.nextCursor).toBeNull();
  expect(fixture.readCalls.filter((call) => call.path === path)).toHaveLength(
    1,
  );
});

test("source.search paginates maximum-length matching paths without omissions", async () => {
  const frontend: Record<string, FixtureAsset> = {};
  for (let index = 0; index < 30; index += 1) {
    // `web/` plus this relative path is the manual-package 4,096-byte limit;
    // the installed app prefix legitimately makes the HTTP path longer.
    frontend[
      `${APP_PREFIX}${String(index).padStart(2, "0")}-${"x".repeat(4_086)}.js`
    ] = encode("needle");
  }
  const { fixture } = ordinaryFixture({ frontend });
  const listed = await initialFiles(fixture);
  const paths: string[] = [];
  let cursor: string | null = null;
  do {
    const page = (await fixture.inspector.search({
      appId: APP_ID,
      sourceRevision: listed.sourceRevision,
      query: "needle",
      cursor,
      area: "frontend",
      limit: 8,
    })) as unknown as SearchResult;
    paths.push(...page.matches.map(({ path }) => path));
    expect(page.truncatedFiles).toBe(0);
    cursor = page.nextCursor;
  } while (cursor !== null);

  expect(paths).toEqual(Object.keys(frontend).sort(compareCanonicalText));
});

test("large and unavailable ordinary artifacts are bounded without hiding traversal state", async () => {
  const largePath = `${APP_PREFIX}large.js`;
  const unavailablePath = `${APP_PREFIX}offline.js`;
  const textPath = `${APP_PREFIX}readable.js`;
  const { fixture } = ordinaryFixture({
    frontend: {
      [largePath]: "too_large",
      [unavailablePath]: { error: new Error("gateway unavailable") },
      [textPath]: encode("const visible = true"),
    },
  });
  const listed = await initialFiles(fixture);

  const large = (await fixture.inspector.read({
    appId: APP_ID,
    sourceRevision: listed.sourceRevision,
    path: largePath,
    cursor: null,
  })) as unknown as ReadResult;
  expect(large).toMatchObject({
    kind: "unavailable",
    complete: true,
    nextCursor: null,
  });
  expect(large.reason).toContain("safe read limit");

  const largePage = (await fixture.inspector.search({
    appId: APP_ID,
    sourceRevision: listed.sourceRevision,
    query: "visible",
    cursor: null,
    area: "frontend",
  })) as unknown as SearchResult;
  expect(largePage).toMatchObject({
    matches: [],
    skippedLargeFiles: 1,
    complete: false,
  });

  const finalPage = (await fixture.inspector.search({
    appId: APP_ID,
    sourceRevision: listed.sourceRevision,
    query: "visible",
    cursor: largePage.nextCursor,
    area: "frontend",
  })) as unknown as SearchResult;
  expect(finalPage.matches.map(({ path }) => path)).toEqual([textPath]);
  expect(finalPage.skippedUnavailableFiles).toBe(1);
  expect(finalPage.complete).toBe(true);
  expect(finalPage.nextCursor).toBeNull();
});

test("source.search yields after a bounded number of unavailable files", async () => {
  const frontend: Record<string, FixtureAsset> = {};
  for (let index = 0; index < 129; index += 1) {
    frontend[`${APP_PREFIX}${String(index).padStart(3, "0")}.js`] = {
      error: new Error("gateway unavailable"),
    };
  }
  const readablePath = `${APP_PREFIX}zzz-readable.js`;
  frontend[readablePath] = encode("const finalNeedle = true");
  const { fixture } = ordinaryFixture({ frontend });
  const listed = await initialFiles(fixture);

  const first = (await fixture.inspector.search({
    appId: APP_ID,
    sourceRevision: listed.sourceRevision,
    query: "finalNeedle",
    cursor: null,
    area: "frontend",
  })) as unknown as SearchResult;
  expect(first).toMatchObject({
    matches: [],
    skippedUnavailableFiles: 32,
    complete: false,
  });
  expect(first.nextCursor).not.toBeNull();

  let cursor = first.nextCursor;
  let skipped = first.skippedUnavailableFiles;
  const matches = [...first.matches];
  while (cursor !== null) {
    const page = (await fixture.inspector.search({
      appId: APP_ID,
      sourceRevision: listed.sourceRevision,
      query: "finalNeedle",
      cursor,
      area: "frontend",
    })) as unknown as SearchResult;
    expect(page.skippedUnavailableFiles).toBeLessThanOrEqual(32);
    skipped += page.skippedUnavailableFiles;
    matches.push(...page.matches);
    cursor = page.nextCursor;
  }
  expect(matches.map(({ path }) => path)).toEqual([readablePath]);
  expect(skipped).toBe(129);
});

test("runtime cache changes preserve the public revision while target changes cancel it", async () => {
  const { fixture } = ordinaryFixture();
  const first = await initialFiles(fixture);
  const original = fixture.bindings.get(APP_ID)!;
  fixture.bindings.set(
    APP_ID,
    Object.freeze({ ...original, runtimeIdentity: "runtime-two" }),
  );

  const unchanged = (await fixture.inspector.list({
    appId: APP_ID,
    sourceRevision: first.sourceRevision,
    cursor: null,
  })) as unknown as FilesResult;
  expect(unchanged.sourceRevision).toBe(first.sourceRevision);
  expect(fixture.listCalls).toEqual([APP_PREFIX, APP_PREFIX]);

  fixture.readInterceptor = async (path) => {
    if (path !== `${APP_PREFIX}main.js`) return null;
    fixture.bindings.set(
      APP_ID,
      Object.freeze({ ...original, runtimeIdentity: "runtime-three" }),
    );
    return null;
  };
  await expect(
    fixture.inspector.read({
      appId: APP_ID,
      sourceRevision: unchanged.sourceRevision,
      path: `${APP_PREFIX}main.js`,
      cursor: null,
    }),
  ).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
  fixture.readInterceptor = null;

  const beforeAnchorChange = (await fixture.inspector.list({
    appId: APP_ID,
    sourceRevision: unchanged.sourceRevision,
    cursor: null,
  })) as unknown as FilesResult;
  fixture.readInterceptor = async (path) => {
    if (path !== APP_MANIFEST_PATH) return null;
    fixture.bindings.set(
      APP_ID,
      Object.freeze({ ...original, runtimeIdentity: "runtime-four" }),
    );
    return null;
  };
  await expect(
    fixture.inspector.list({
      appId: APP_ID,
      sourceRevision: beforeAnchorChange.sourceRevision,
      cursor: null,
    }),
  ).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
  fixture.readInterceptor = null;

  fixture.bindings.set(
    APP_ID,
    Object.freeze({ ...original, installationUid: "2" }),
  );
  await expect(
    fixture.inspector.list({
      appId: APP_ID,
      sourceRevision: first.sourceRevision,
      cursor: null,
    }),
  ).rejects.toMatchObject({
    code: "REQUEST_CANCELLED",
    message: "Installed artifacts changed; restart with source.files",
  });
});

test("cancellation reaches an in-flight installed-artifact read", async () => {
  const path = `${APP_PREFIX}main.js`;
  const content = encode("const pending = true");
  const { fixture } = ordinaryFixture({ frontend: { [path]: content } });
  const listed = await initialFiles(fixture);
  let markStarted!: () => void;
  let releaseRead!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  fixture.readInterceptor = async (candidate) => {
    if (candidate !== path) return null;
    markStarted();
    await released;
    return { status: "ok", content };
  };
  const controller = new AbortController();
  const pending = fixture.inspector.read(
    {
      appId: APP_ID,
      sourceRevision: listed.sourceRevision,
      path,
      cursor: null,
    },
    controller.signal,
  );
  await started;
  controller.abort();
  releaseRead();

  await expect(pending).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
  expect(fixture.readCalls.find((call) => call.path === path)?.signal).toBe(
    controller.signal,
  );
});
