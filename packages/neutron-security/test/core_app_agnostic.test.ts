import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";
import { checkCoreAppAgnostic } from "../src/core_app_agnostic.ts";

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(
    workspaces
      .splice(0)
      .map((workspace) => fs.rm(workspace, { recursive: true, force: true })),
  );
});

test("derives app identities and private methods from manifests", async () => {
  const workspace = await fixtureWorkspace();
  await fs.writeFile(
    path.join(workspace, "apps/kernel/src/bad.ts"),
    [
      'import "../../sample/private.ts";',
      'const physical = "app_sample__sample_private";',
      'const privateMethod = "sample_private";',
      'const branch = appId === "sample";',
      'const removed = "files_publication_v2";',
      'import { exec } from "neutron-tools/app";',
      'type RootJson = import("neutron-tools").JsonValue;',
    ].join("\n"),
  );

  expect(await checkCoreAppAgnostic(workspace)).toEqual([
    {
      file: "apps/kernel/src/bad.ts",
      line: 1,
      rule: "app_import",
      value: "apps/sample",
    },
    {
      file: "apps/kernel/src/bad.ts",
      line: 2,
      rule: "app_method",
      value: "app_sample__",
    },
    {
      file: "apps/kernel/src/bad.ts",
      line: 3,
      rule: "app_method",
      value: "sample_private",
    },
    {
      file: "apps/kernel/src/bad.ts",
      line: 4,
      rule: "app_identity_branch",
      value: "sample",
    },
    {
      file: "apps/kernel/src/bad.ts",
      line: 5,
      rule: "removed_vocabulary",
      value: "files_publication_v2",
    },
    {
      file: "apps/kernel/src/bad.ts",
      line: 6,
      rule: "kernel_sdk_boundary",
      value: "neutron-tools/app",
    },
    {
      file: "apps/kernel/src/bad.ts",
      line: 7,
      rule: "kernel_sdk_boundary",
      value: "neutron-tools",
    },
  ]);
});

test("allows generic dynamic app handling", async () => {
  const workspace = await fixtureWorkspace();
  await fs.writeFile(
    path.join(workspace, "apps/kernel/src/generic.ts"),
    [
      'import type { JsonValue } from "neutron-tools/protocol";',
      'import { expose } from "neutron-tools/kernel";',
      "export function scope(appId: string, method: string) {",
      "  return { appId, method };",
      "}",
    ].join("\n"),
  );
  expect(await checkCoreAppAgnostic(workspace)).toEqual([]);
});

test("recognizes Motoko imports, equality, cases, and map membership", async () => {
  const workspace = await fixtureWorkspace();
  await writeFixtureSource(workspace, "apps/kernel/backend/bad.mo", [
    'import Sample "../../sample/private";',
    'let equality = appId == "sample";',
    "let selected = switch (appId) {",
    '  case ("sample") true;',
    "  case (_) false;",
    "};",
    'let mapped = Map.get(routes, Text.compare, "sample");',
  ]);

  expect(await checkCoreAppAgnostic(workspace)).toEqual([
    {
      file: "apps/kernel/backend/bad.mo",
      line: 1,
      rule: "app_import",
      value: "apps/sample",
    },
    {
      file: "apps/kernel/backend/bad.mo",
      line: 2,
      rule: "app_identity_branch",
      value: "sample",
    },
    {
      file: "apps/kernel/backend/bad.mo",
      line: 4,
      rule: "app_identity_branch",
      value: "sample",
    },
    {
      file: "apps/kernel/backend/bad.mo",
      line: 7,
      rule: "app_identity_branch",
      value: "sample",
    },
  ]);
});

test("recognizes inclusion allowlists and direct map lookups", async () => {
  const workspace = await fixtureWorkspace();
  await writeFixtureSource(workspace, "packages/neutron-scripts/src/bad.ts", [
    'const arrayAllowed = ["sample"].includes(appId);',
    'const setAllowed = new Set(["sample"]).has(appId);',
    'const direct = handlers.get("sample");',
    'const dispatch = new Map([["sample", handler]]);',
  ]);

  expect(await checkCoreAppAgnostic(workspace)).toEqual([
    {
      file: "packages/neutron-scripts/src/bad.ts",
      line: 1,
      rule: "app_identity_branch",
      value: "sample",
    },
    {
      file: "packages/neutron-scripts/src/bad.ts",
      line: 2,
      rule: "app_identity_branch",
      value: "sample",
    },
    {
      file: "packages/neutron-scripts/src/bad.ts",
      line: 3,
      rule: "app_identity_branch",
      value: "sample",
    },
    {
      file: "packages/neutron-scripts/src/bad.ts",
      line: 4,
      rule: "app_identity_branch",
      value: "sample",
    },
  ]);
});

test("rejects literal, parenthesized, computed, call, equality, map, and allowlist dispatch", async () => {
  const workspace = await fixtureWorkspace();
  await writeFixtureSource(workspace, "packages/neutron-cli/src/dispatch.ts", [
    'const literal = "sample";',
    'const parenthesized = ((("sample")));',
    'const computed = handlers["sample"];',
    'const called = dispatch("sample");',
    'const equality = (app.id) === ("sample");',
    'const mapped = new Map([["sample", handler]]);',
    'const allowed = ["other", "sample"].includes(appId);',
  ]);

  expect(await checkCoreAppAgnostic(workspace)).toEqual(
    Array.from({ length: 7 }, (_, index) => ({
      file: "packages/neutron-cli/src/dispatch.ts",
      line: index + 1,
      rule: "app_identity_branch",
      value: "sample",
    })),
  );
});

test("rejects app names, packages, static paths, fs segments, and archives", async () => {
  const workspace = await fixtureWorkspace();
  await writeFixtureSource(
    workspace,
    "packages/neutron-cli/src/references.ts",
    [
      'import "../../../apps/sample/backend/main";',
      "const template = `../../../apps/sample/neutron.json`;",
      'const fsPath = path.join(root, "apps", "sample", "neutron.json");',
      'const packageName = "neutron-sample";',
      'const displayName = "Sample App";',
      'const archive = "sample.v0.1.0.neutron";',
    ],
  );

  expect(await checkCoreAppAgnostic(workspace)).toEqual([
    {
      file: "packages/neutron-cli/src/references.ts",
      line: 1,
      rule: "app_import",
      value: "apps/sample",
    },
    {
      file: "packages/neutron-cli/src/references.ts",
      line: 2,
      rule: "app_import",
      value: "apps/sample",
    },
    {
      file: "packages/neutron-cli/src/references.ts",
      line: 3,
      rule: "app_identity_branch",
      value: "sample",
    },
    {
      file: "packages/neutron-cli/src/references.ts",
      line: 4,
      rule: "app_import",
      value: "neutron-sample",
    },
    {
      file: "packages/neutron-cli/src/references.ts",
      line: 5,
      rule: "app_identity_branch",
      value: "Sample App",
    },
    {
      file: "packages/neutron-cli/src/references.ts",
      line: 6,
      rule: "app_import",
      value: "sample.v0.1.0.neutron",
    },
  ]);
});

test("permits only the reviewed Kernel Agent role discriminator", async () => {
  const workspace = await fixtureWorkspace();
  await writeFixtureSource(
    workspace,
    "apps/agent/neutron.json",
    JSON.stringify({ id: "agent" }),
  );
  await writeFixtureSource(
    workspace,
    "apps/kernel/src/install_offers/service.ts",
    [
      'const delegated = requester.kind === "agent";',
      'const requester = { kind: "agent" };',
      'const coupled = { app: "agent" };',
    ],
  );
  await writeFixtureSource(workspace, "apps/kernel/src/agent_bad.ts", [
    'const appSpecific = appId === "agent";',
    'const unreviewedRole = requester.kind === "agent";',
  ]);

  expect(await checkCoreAppAgnostic(workspace)).toEqual([
    {
      file: "apps/kernel/src/agent_bad.ts",
      line: 1,
      rule: "app_identity_branch",
      value: "agent",
    },
    {
      file: "apps/kernel/src/agent_bad.ts",
      line: 2,
      rule: "app_identity_branch",
      value: "agent",
    },
    {
      file: "apps/kernel/src/install_offers/service.ts",
      line: 3,
      rule: "app_identity_branch",
      value: "agent",
    },
  ]);
});

test("recognizes quoted, template, bare, and physical private methods", async () => {
  const workspace = await fixtureWorkspace();
  await writeFixtureSource(workspace, "apps/kernel/src/private_methods.ts", [
    'const quoted = "sample_private";',
    "const template = `sample_private`;",
    "const handlers = { sample_private: implementation };",
    "Sample.sample_private();",
    "const physical = app_sample__sample_private;",
    'const shortComputed = handlers["add"];',
    'const shortCall = dispatch("echo");',
    "const scoped = NeutronModule_a6_sample;",
  ]);

  expect(await checkCoreAppAgnostic(workspace)).toEqual([
    {
      file: "apps/kernel/src/private_methods.ts",
      line: 1,
      rule: "app_method",
      value: "sample_private",
    },
    {
      file: "apps/kernel/src/private_methods.ts",
      line: 2,
      rule: "app_method",
      value: "sample_private",
    },
    {
      file: "apps/kernel/src/private_methods.ts",
      line: 3,
      rule: "app_method",
      value: "sample_private",
    },
    {
      file: "apps/kernel/src/private_methods.ts",
      line: 4,
      rule: "app_method",
      value: "sample_private",
    },
    {
      file: "apps/kernel/src/private_methods.ts",
      line: 5,
      rule: "app_method",
      value: "app_sample__",
    },
    {
      file: "apps/kernel/src/private_methods.ts",
      line: 6,
      rule: "app_method",
      value: "add",
    },
    {
      file: "apps/kernel/src/private_methods.ts",
      line: 7,
      rule: "app_method",
      value: "echo",
    },
    {
      file: "apps/kernel/src/private_methods.ts",
      line: 8,
      rule: "app_method",
      value: "a6_sample",
    },
  ]);
});

test("rejects removed app-shaped prefixes and compatibility vocabulary", async () => {
  const workspace = await fixtureWorkspace();
  await writeFixtureSource(workspace, "apps/kernel/backend/removed.mo", [
    "let oldFiles = files_unknown_v9;",
    "let oldWagyu = wagyu_unknown_v9;",
    "let oldCandid = public_candid_unknown_v9;",
    "let oldType : FilesPresentation = value;",
    'let oldNetwork = "wagyu.network-id.v1";',
    "let oldCommit = kernel_install_commit_checked;",
  ]);

  expect(await checkCoreAppAgnostic(workspace)).toEqual([
    {
      file: "apps/kernel/backend/removed.mo",
      line: 1,
      rule: "removed_vocabulary",
      value: "files_unknown_v9",
    },
    {
      file: "apps/kernel/backend/removed.mo",
      line: 2,
      rule: "removed_vocabulary",
      value: "wagyu_unknown_v9",
    },
    {
      file: "apps/kernel/backend/removed.mo",
      line: 3,
      rule: "removed_vocabulary",
      value: "public_candid_unknown_v9",
    },
    {
      file: "apps/kernel/backend/removed.mo",
      line: 4,
      rule: "removed_vocabulary",
      value: "FilesPresentation",
    },
    {
      file: "apps/kernel/backend/removed.mo",
      line: 5,
      rule: "removed_vocabulary",
      value: "wagyu.network-id.v1",
    },
    {
      file: "apps/kernel/backend/removed.mo",
      line: 6,
      rule: "removed_vocabulary",
      value: "kernel_install_commit_checked",
    },
  ]);
});

test("covers public, Kernel, CLI, compiler, provision, and release roots", async () => {
  const workspace = await fixtureWorkspace();
  const files = [
    "apps/kernel/moassemble.ts",
    "packages/neutron-cli/src/index.ts",
    "packages/neutron-compiler/generate.ts",
    "packages/neutron-motoko-capabilities/src/lib.mo",
    "packages/neutron-motoko-wasm/compiler/compiler-worker.js",
    "packages/neutron-motoko-wasm/scripts/generate.ts",
    "packages/neutron-provision/src/deploy.ts",
    "packages/neutron-scripts/src/generate.ts",
    "packages/neutron-tools/src/protocol.ts",
    "support/dispenser/production_deploy.ts",
    "support/update-source/scripts/publish.ts",
  ];
  await Promise.all(
    files.map((file) =>
      writeFixtureSource(
        workspace,
        file,
        'const coupled = appId === "sample";',
      ),
    ),
  );

  expect(
    (await checkCoreAppAgnostic(workspace)).map(({ file }) => file),
  ).toEqual(files);
});

test("excludes tests, generated build output, and declarative catalogs", async () => {
  const workspace = await fixtureWorkspace();
  const source = 'const coupled = appId === "sample";';
  await Promise.all([
    writeFixtureSource(workspace, "apps/kernel/test/bad.ts", source),
    writeFixtureSource(
      workspace,
      "packages/neutron-scripts/test/bad.ts",
      source,
    ),
    writeFixtureSource(workspace, "support/dispenser/build/bad.js", source),
    writeFixtureSource(
      workspace,
      "support/update-source/assets/catalog.js",
      source,
    ),
    writeFixtureSource(
      workspace,
      "support/update-source/release-catalog.json",
      JSON.stringify({ app: "sample" }),
    ),
  ]);

  expect(await checkCoreAppAgnostic(workspace)).toEqual([]);
});

test("keeps generic words and one reviewed Files type field out of identity checks", async () => {
  const workspace = await fixtureWorkspace();
  await writeFixtureSource(
    workspace,
    "apps/vfs/neutron.json",
    JSON.stringify({ id: "files" }),
  );
  await writeFixtureSource(workspace, "apps/kernel/src/tools/app.ts", [
    "const files = await fs.readdir(root);",
    "const agent = await createHttpAgent();",
    'type Prepared = PreparedPackageInstall["files"];',
  ]);
  await writeFixtureSource(
    workspace,
    "apps/kernel/src/unreviewed_type.ts",
    'type Coupled = AppDispatch["files"];',
  );

  expect(await checkCoreAppAgnostic(workspace)).toEqual([
    {
      file: "apps/kernel/src/unreviewed_type.ts",
      line: 1,
      rule: "app_identity_branch",
      value: "files",
    },
  ]);
});

test("repository Core production source is app agnostic", async () => {
  expect(await checkCoreAppAgnostic()).toEqual([]);
});

async function fixtureWorkspace(): Promise<string> {
  const workspace = await fs.mkdtemp(
    path.join(os.tmpdir(), "neutron-core-app-check-"),
  );
  workspaces.push(workspace);
  await fs.mkdir(path.join(workspace, "apps/kernel/src"), { recursive: true });
  await fs.mkdir(path.join(workspace, "apps/sample"), { recursive: true });
  await fs.writeFile(
    path.join(workspace, "apps/sample/neutron.json"),
    JSON.stringify({
      id: "sample",
      name: "Sample App",
      func: {
        add: { type: "update", async: false },
        echo: { type: "query", async: false },
        sample_private: { type: "update", async: false },
      },
    }),
  );
  await fs.writeFile(
    path.join(workspace, "apps/sample/package.json"),
    JSON.stringify({ name: "neutron-sample" }),
  );
  return workspace;
}

async function writeFixtureSource(
  workspace: string,
  relative: string,
  source: string | readonly string[],
): Promise<void> {
  const filename = path.join(workspace, relative);
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(
    filename,
    typeof source === "string" ? source : source.join("\n"),
  );
}
