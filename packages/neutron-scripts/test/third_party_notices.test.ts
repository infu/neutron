import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import {
  THIRD_PARTY_NOTICE_INDEX_PATH,
  THIRD_PARTY_NOTICE_MATERIAL_BUNDLE_PATH,
  buildThirdPartyNoticeBundle,
} from "../src/third_party_notices.ts";

const canonicalApacheLicensePath = path.resolve(import.meta.dir, "../LICENSE");

type Fixture = Readonly<{
  repositoryRoot: string;
  appRoot: string;
  apacheLicensePath: string;
}>;

async function createBaseFixture(): Promise<Fixture> {
  const repositoryRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "neutron-third-party-notices-"),
  );
  const appRoot = path.join(repositoryRoot, "apps", "demo");
  const apacheLicensePath = path.join(repositoryRoot, "legal", "Apache-2.0.txt");
  await Promise.all([
    fs.mkdir(appRoot, { recursive: true }),
    fs.mkdir(path.dirname(apacheLicensePath), { recursive: true }),
  ]);
  await fs.writeFile(
    apacheLicensePath,
    await fs.readFile(canonicalApacheLicensePath),
  );
  return { repositoryRoot, appRoot, apacheLicensePath };
}

async function writePackage(
  packageRoot: string,
  manifest: Record<string, unknown>,
  legalFiles: Readonly<Record<string, string>> = {},
): Promise<void> {
  await fs.mkdir(packageRoot, { recursive: true });
  await fs.writeFile(
    path.join(packageRoot, "package.json"),
    JSON.stringify(manifest),
  );
  for (const [relativePath, contents] of Object.entries(legalFiles)) {
    const filePath = path.join(packageRoot, ...relativePath.split("/"));
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, contents);
  }
}

async function createCompleteFixture(
  dependencyOrder: readonly string[],
): Promise<Fixture & Readonly<{ exactInputs: readonly string[] }>> {
  const fixture = await createBaseFixture();
  const nodeModules = path.join(fixture.repositoryRoot, "node_modules");
  const mitLicense = "MIT fixture license\nCopyright Example\n";
  const betaNotice = "Beta installed NOTICE\n";
  const mopsNotice = "Mops installed NOTICE\n";
  const appNotice = "App-specific exact notice\n";
  const appDependencyLicense = "App-root dependency license\n";
  const governingLicense = "Bare governing app license must not be a notice\n";
  const apacheLicense = await fs.readFile(fixture.apacheLicensePath, "utf8");

  await writePackage(fixture.appRoot, {
    name: "demo-app",
    version: "1.0.0",
    dependencies: Object.fromEntries(
      dependencyOrder.map((name) => [name, "1.0.0"]),
    ),
  });
  const packageDefinitions: Record<
    string,
    Readonly<{
      manifest: Record<string, unknown>;
      legal: Readonly<Record<string, string>>;
    }>
  > = {
    alpha: {
      manifest: {
        name: "alpha",
        version: "1.0.0",
        license: "MIT",
        author: { name: "Alpha Author", url: "https://example.invalid/alpha" },
        repository: { url: "https://example.invalid/alpha.git" },
        dependencies: { shared: "1.0.0" },
        optionalDependencies: { "missing-optional": "1.0.0" },
        peerDependencies: {
          "ambient-peer": "1.0.0",
          "required-peer": "1.0.0",
        },
        peerDependenciesMeta: { "ambient-peer": { optional: true } },
      },
      legal: { LICENSE: mitLicense },
    },
    beta: {
      manifest: {
        name: "beta",
        version: "1.0.0",
        license: "MIT",
        author: "  Beta\n\tAuthor  ",
        dependencies: { shared: "1.0.0" },
      },
      legal: { LICENSE: mitLicense, NOTICE: betaNotice },
    },
    shared: {
      manifest: {
        name: "shared",
        version: "1.0.0",
        license: "Apache-2.0",
        author: "",
        repository: "https://example.invalid/shared.git",
      },
      // This intentionally exercises the audited Apache-only fallback.
      legal: {},
    },
    "required-peer": {
      manifest: {
        name: "required-peer",
        version: "1.0.0",
        license: "MIT",
      },
      legal: { LICENSE: mitLicense },
    },
  };
  for (const name of [...dependencyOrder, "required-peer", "shared"]) {
    const definition = packageDefinitions[name]!;
    await writePackage(
      path.join(nodeModules, name),
      definition.manifest,
      definition.legal,
    );
  }

  const mopsRoot = path.join(fixture.appRoot, ".mops", "core@1.0.0");
  await fs.mkdir(path.join(mopsRoot, "src"), { recursive: true });
  await Promise.all([
    fs.writeFile(
      path.join(mopsRoot, "mops.toml"),
      `[package]\nname = "core"\nversion = "1.0.0"\nlicense = "Apache-2.0"\nrepository = "https://example.invalid/core"\n`,
    ),
    fs.writeFile(
      path.join(mopsRoot, "LICENSE"),
      `${apacheLicense}\nLLVM EXCEPTIONS TO THE APACHE 2.0 LICENSE\n`,
    ),
    fs.writeFile(path.join(mopsRoot, "NOTICE"), mopsNotice),
    fs.writeFile(
      path.join(fixture.appRoot, "THIRD_PARTY_NOTICES.md"),
      appNotice,
    ),
    fs.writeFile(
      path.join(fixture.appRoot, "LICENSE.Dependency-1.0"),
      appDependencyLicense,
    ),
    fs.writeFile(path.join(fixture.appRoot, "LICENSE"), governingLicense),
  ]);

  return {
    ...fixture,
    exactInputs: [
      mitLicense,
      betaNotice,
      mopsNotice,
      appNotice,
      appDependencyLicense,
    ],
  };
}

function sha256(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

test("notice bundle is deterministic, deduplicated, and preserves exact inputs", async () => {
  const first = await createCompleteFixture(["beta", "alpha"]);
  const second = await createCompleteFixture(["alpha", "beta"]);
  try {
    const firstBundle = await buildThirdPartyNoticeBundle({
      appRoot: first.appRoot,
      repositoryRoot: first.repositoryRoot,
      apacheLicensePath: first.apacheLicensePath,
      mopsSourcesOutput: "--package core .mops/core@1.0.0/src\n",
    });
    const secondBundle = await buildThirdPartyNoticeBundle({
      appRoot: second.appRoot,
      repositoryRoot: second.repositoryRoot,
      apacheLicensePath: second.apacheLicensePath,
      mopsSourcesOutput: "--package core .mops/core@1.0.0/src\n",
    });

    expect(firstBundle.noticePaths).toEqual(secondBundle.noticePaths);
    for (const noticePath of firstBundle.noticePaths) {
      expect(firstBundle.files[noticePath]).toEqual(secondBundle.files[noticePath]);
    }
    expect(firstBundle.noticePaths[0]).toBe(THIRD_PARTY_NOTICE_INDEX_PATH);
    expect(firstBundle.components.map(({ name }) => name)).toEqual([
      "core",
      "alpha",
      "beta",
      "required-peer",
      "shared",
    ]);
    expect(
      firstBundle.components.some(({ name }) => name === "ambient-peer"),
    ).toBe(false);
    expect(
      firstBundle.components.find(({ name }) => name === "core")
        ?.selectedLicense,
    ).toBe("Apache-2.0 WITH LLVM-exception");
    expect(
      firstBundle.components.find(({ name }) => name === "beta")?.author,
    ).toBe("Beta Author");
    expect(
      firstBundle.components.find(({ name }) => name === "shared")?.author,
    ).toBeUndefined();

    const exactMaterials = new TextDecoder().decode(
      firstBundle.files[THIRD_PARTY_NOTICE_MATERIAL_BUNDLE_PATH],
    );
    expect(exactMaterials).toContain(first.exactInputs[0]!);
    expect(
      firstBundle.components
        .filter(({ name }) => name === "alpha" || name === "beta")
        .every(({ materials }) =>
          materials.some(
            ({ path: materialPath, sha256: materialSha256 }) =>
              materialPath === THIRD_PARTY_NOTICE_MATERIAL_BUNDLE_PATH &&
              materialSha256 === sha256(first.exactInputs[0]!),
          ),
        ),
    ).toBe(true);
    expect(firstBundle.noticePaths).toEqual([
      THIRD_PARTY_NOTICE_INDEX_PATH,
      THIRD_PARTY_NOTICE_MATERIAL_BUNDLE_PATH,
    ]);
    for (const exactInput of first.exactInputs) {
      expect(exactMaterials).toContain(
        `BEGIN MATERIAL sha256=${sha256(exactInput)} bytes=${new TextEncoder().encode(exactInput).byteLength}`,
      );
      expect(exactMaterials).toContain(exactInput);
    }

    const index = new TextDecoder().decode(
      firstBundle.files[THIRD_PARTY_NOTICE_INDEX_PATH],
    );
    expect(index).toContain("Remote services, downloaded models");
    expect(index).toContain('"application/THIRD_PARTY_NOTICES.md"');
    expect(index).toContain('"application/LICENSE.Dependency-1.0"');
    expect(exactMaterials).not.toContain(
      sha256("Bare governing app license must not be a notice\n"),
    );
    expect(index.split("\n").length).toBeLessThanOrEqual(675);
  } finally {
    await Promise.all([
      fs.rm(first.repositoryRoot, { recursive: true, force: true }),
      fs.rm(second.repositoryRoot, { recursive: true, force: true }),
    ]);
  }
});

test("notice bundle fails closed when a non-Apache package omits its license", async () => {
  const fixture = await createBaseFixture();
  try {
    await writePackage(fixture.appRoot, {
      name: "demo-app",
      version: "1.0.0",
      dependencies: { unlicensed: "1.0.0" },
    });
    await writePackage(
      path.join(fixture.repositoryRoot, "node_modules", "unlicensed"),
      { name: "unlicensed", version: "1.0.0", license: "MIT" },
    );

    await expect(
      buildThirdPartyNoticeBundle({
        ...fixture,
        mopsSourcesOutput: "",
      }),
    ).rejects.toThrow(/unlicensed has no installed LICENSE or COPYING file/);
  } finally {
    await fs.rm(fixture.repositoryRoot, { recursive: true, force: true });
  }
});

test("notice bundle rejects an unaudited or copyleft dependency expression", async () => {
  const fixture = await createBaseFixture();
  try {
    await writePackage(fixture.appRoot, {
      name: "demo-app",
      version: "1.0.0",
      dependencies: { copyleft: "1.0.0" },
    });
    await writePackage(
      path.join(fixture.repositoryRoot, "node_modules", "copyleft"),
      { name: "copyleft", version: "1.0.0", license: "GPL-3.0-only" },
      { LICENSE: "GPL fixture text\n" },
    );

    await expect(
      buildThirdPartyNoticeBundle({
        ...fixture,
        mopsSourcesOutput: "",
      }),
    ).rejects.toThrow(/unaudited license expression "GPL-3.0-only"/);
  } finally {
    await fs.rm(fixture.repositoryRoot, { recursive: true, force: true });
  }
});

test("notice bundle records the permissive branch selected from a dual license", async () => {
  const fixture = await createBaseFixture();
  try {
    await writePackage(fixture.appRoot, {
      name: "demo-app",
      version: "1.0.0",
      dependencies: { dual: "1.0.0" },
    });
    await writePackage(
      path.join(fixture.repositoryRoot, "node_modules", "dual"),
      {
        name: "dual",
        version: "1.0.0",
        license: "(AFL-2.1 OR BSD-3-Clause)",
      },
      { LICENSE: "Exact dual-license fixture\n" },
    );

    const bundle = await buildThirdPartyNoticeBundle({
      ...fixture,
      mopsSourcesOutput: "",
    });
    expect(bundle.components).toHaveLength(1);
    expect(bundle.components[0]?.selectedLicense).toBe("BSD-3-Clause");
    expect(
      new TextDecoder().decode(bundle.files[THIRD_PARTY_NOTICE_INDEX_PATH]),
    ).toContain('selected compatible branch "BSD-3-Clause"');
  } finally {
    await fs.rm(fixture.repositoryRoot, { recursive: true, force: true });
  }
});

test("notice bundle rejects a Mops package without an exact installed license", async () => {
  const fixture = await createBaseFixture();
  try {
    await writePackage(fixture.appRoot, {
      name: "demo-app",
      version: "1.0.0",
    });
    const mopsRoot = path.join(fixture.appRoot, ".mops", "core@1.0.0");
    await fs.mkdir(path.join(mopsRoot, "src"), { recursive: true });
    await fs.writeFile(
      path.join(mopsRoot, "mops.toml"),
      `[package]\nname = "core"\nversion = "1.0.0"\nlicense = "Apache-2.0"\n`,
    );

    await expect(
      buildThirdPartyNoticeBundle({
        ...fixture,
        mopsSourcesOutput: "--package core .mops/core@1.0.0/src",
      }),
    ).rejects.toThrow(/core has no installed LICENSE or COPYING file/);
  } finally {
    await fs.rm(fixture.repositoryRoot, { recursive: true, force: true });
  }
});

test("notice bundle rejects Font Awesome icons without complete CC-BY material", async () => {
  const fixture = await createBaseFixture();
  try {
    await writePackage(fixture.appRoot, {
      name: "demo-app",
      version: "1.0.0",
    });
    await fs.mkdir(path.join(fixture.appRoot, "src"));
    await fs.writeFile(
      path.join(fixture.appRoot, "src", "index.tsx"),
      'import { FaChessKing } from "react-icons/fa6";\n',
    );

    await expect(
      buildThirdPartyNoticeBundle({
        ...fixture,
        mopsSourcesOutput: "",
      }),
    ).rejects.toThrow(/Font Awesome 6 icons under CC-BY-4.0/);
  } finally {
    await fs.rm(fixture.repositoryRoot, { recursive: true, force: true });
  }
});

test("notice bundle rejects malformed Mops source output", async () => {
  const fixture = await createBaseFixture();
  try {
    await writePackage(fixture.appRoot, {
      name: "demo-app",
      version: "1.0.0",
    });
    await expect(
      buildThirdPartyNoticeBundle({
        ...fixture,
        mopsSourcesOutput: "warning: stale cache",
      }),
    ).rejects.toThrow(/Malformed mops sources output/);
  } finally {
    await fs.rm(fixture.repositoryRoot, { recursive: true, force: true });
  }
});

test("notice bundle traverses required npm peers and skips optional peers", async () => {
  const fixture = await createBaseFixture();
  const agentRoot = path.join(
    fixture.repositoryRoot,
    "node_modules",
    "@dfinity",
    "agent",
  );
  const candidRoot = path.join(
    fixture.repositoryRoot,
    "node_modules",
    "@dfinity",
    "candid",
  );
  try {
    await writePackage(fixture.appRoot, {
      name: "demo-app",
      version: "1.0.0",
      dependencies: { "@dfinity/agent": "1.0.0" },
    });
    await writePackage(
      agentRoot,
      {
        name: "@dfinity/agent",
        version: "1.0.0",
        license: "Apache-2.0",
        peerDependencies: {
          "@dfinity/candid": "1.0.0",
          typescript: ">=5",
        },
        peerDependenciesMeta: { typescript: { optional: true } },
      },
      { LICENSE: "Agent Apache fixture\n" },
    );
    await writePackage(
      candidRoot,
      {
        name: "@dfinity/candid",
        version: "1.0.0",
        license: "Apache-2.0",
      },
      { LICENSE: "Candid Apache fixture\n" },
    );

    const bundle = await buildThirdPartyNoticeBundle({
      ...fixture,
      mopsSourcesOutput: "",
    });
    expect(bundle.components.map(({ name }) => name)).toEqual([
      "@dfinity/agent",
      "@dfinity/candid",
    ]);
    expect(bundle.components.some(({ name }) => name === "typescript")).toBe(
      false,
    );

    await fs.rm(candidRoot, { recursive: true, force: true });
    await expect(
      buildThirdPartyNoticeBundle({
        ...fixture,
        mopsSourcesOutput: "",
      }),
    ).rejects.toThrow(/Required npm dependency @dfinity\/candid is not installed/);
  } finally {
    await fs.rm(fixture.repositoryRoot, { recursive: true, force: true });
  }
});

test("notice bundle captures exact Ionicons 5.5.4 MIT and copyright material", async () => {
  const fixture = await createBaseFixture();
  const reactIconsRoot = path.join(
    fixture.repositoryRoot,
    "node_modules",
    "react-icons",
  );
  const ioniconsHash =
    "c89dabc60b2e4e1a04b33bd7010b5a56bb4725ffe8c00d793a5ae009fbbfebd8";
  try {
    await writePackage(fixture.appRoot, {
      name: "demo-app",
      version: "1.0.0",
      dependencies: { "react-icons": "5.7.0" },
    });
    await fs.mkdir(path.join(fixture.appRoot, "src"));
    await fs.writeFile(
      path.join(fixture.appRoot, "src", "index.tsx"),
      'import { IoAdd } from "react-icons/io5";\n',
    );
    await writePackage(
      reactIconsRoot,
      {
        name: "react-icons",
        version: "5.7.0",
        license: "MIT",
        peerDependencies: { react: "*" },
      },
      { LICENSE: "React Icons MIT fixture\n" },
    );
    await fs.writeFile(
      path.join(reactIconsRoot, "README.md"),
      "| [Ionicons 5](https://ionicons.com/) | [MIT](https://github.com/ionic-team/ionicons/blob/master/LICENSE) | 5.5.4 | 1332 |\n",
    );
    await writePackage(
      path.join(fixture.repositoryRoot, "node_modules", "react"),
      { name: "react", version: "19.0.0", license: "MIT" },
      { LICENSE: "React MIT fixture\n" },
    );

    const bundle = await buildThirdPartyNoticeBundle({
      ...fixture,
      mopsSourcesOutput: "",
    });
    const exactMaterials = new TextDecoder().decode(
      bundle.files[THIRD_PARTY_NOTICE_MATERIAL_BUNDLE_PATH],
    );
    expect(exactMaterials).toContain(`sha256=${ioniconsHash} bytes=1099`);
    expect(exactMaterials).toContain(
      "Copyright (c) 2015-present Ionic (http://ionic.io/)",
    );
    expect(bundle.noticePaths).toContain(
      THIRD_PARTY_NOTICE_MATERIAL_BUNDLE_PATH,
    );
    expect(
      bundle.components
        .find(({ name }) => name === "react-icons")
        ?.materials.some(
          ({ sourcePath, sha256: materialHash, path: bundledPath }) =>
            sourcePath === "upstream/ionic-team/ionicons@v5.5.4/LICENSE" &&
            materialHash === ioniconsHash &&
            bundledPath === THIRD_PARTY_NOTICE_MATERIAL_BUNDLE_PATH,
        ),
    ).toBe(true);

    await fs.writeFile(
      path.join(reactIconsRoot, "README.md"),
      "| [Ionicons 5](https://ionicons.com/) | [MIT](license) | 5.6.0 | 1332 |\n",
    );
    await expect(
      buildThirdPartyNoticeBundle({
        ...fixture,
        mopsSourcesOutput: "",
      }),
    ).rejects.toThrow(/does not bind io5 to audited Ionicons 5\.5\.4/);
  } finally {
    await fs.rm(fixture.repositoryRoot, { recursive: true, force: true });
  }
});

test("notice bundle rejects bidirectional package metadata with component identity", async () => {
  const fixture = await createBaseFixture();
  try {
    await writePackage(fixture.appRoot, {
      name: "demo-app",
      version: "1.0.0",
      dependencies: { deceptive: "1.0.0" },
    });
    await writePackage(
      path.join(fixture.repositoryRoot, "node_modules", "deceptive"),
      {
        name: "deceptive",
        version: "1.0.0",
        license: "MIT",
        author: "safe\u202eevil",
      },
      { LICENSE: "MIT fixture license\n" },
    );

    await expect(
      buildThirdPartyNoticeBundle({
        ...fixture,
        mopsSourcesOutput: "",
      }),
    ).rejects.toThrow(
      /npm deceptive@1\.0\.0 has invalid package metadata: Invalid author metadata/,
    );
  } finally {
    await fs.rm(fixture.repositoryRoot, { recursive: true, force: true });
  }
});
