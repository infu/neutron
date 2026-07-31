import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import {
  type HashFiles,
  getDependencies,
  hashContent,
  parseImports,
  parsePackageString,
  removeCommentsAndEmptyLines,
  replaceImportPaths,
  walkReplace,
} from "../src/walk.ts";

test("parses mops package source output", () => {
  expect(
    parsePackageString(
      "--package core .mops/core/src --package vector .mops/vector/src"
    )
  ).toEqual({
    core: ".mops/core/src",
    vector: ".mops/vector/src",
  });
});

test("hashContent is deterministic sha256 hex", () => {
  expect(hashContent("actor {}")).toBe(
    "83f1b9f937941c168593ff34c7c3492d234fc6e3e52222b0d71313d542d2e994"
  );
});

test("parses and rewrites Motoko imports", () => {
  const source = `
    import Array "mo:core/Array";
    import Helper "./Helper";
  `;

  expect(parseImports(source)).toEqual({
    Array: "mo:core/Array",
    Helper: "./Helper",
  });
  expect(
    replaceImportPaths(source, "./Helper", "mo/hash"),
  ).toBe(`
    import Array "mo:core/Array";
    import Helper "mo/hash";
  `);
});

test("removes comments before dependency parsing", () => {
  expect(
    removeCommentsAndEmptyLines(`
// hidden import Debug "mo:core/Debug";
import Array "mo:core/Array";

/* hidden block */
`),
  ).toBe(`import Array "mo:core/Array";\n`);
});

test("dependency walking rejects legacy mo:base imports", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "neutron-walk-base-"));
  try {
    const filePath = path.join(dir, "main.mo");
    await writeFile(filePath, 'import Array "mo:base/Array"; module {}');

    await expect(
      getDependencies(
        null,
        filePath,
        { base: path.join(dir, "base") },
        {},
      ),
    ).rejects.toThrow(/unsupported mo:base package directly; use mo:core/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Core Random is not an ambient packaging exception", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "neutron-walk-random-"));
  try {
    const core = path.join(dir, "core");
    await mkdir(core, { recursive: true });
    const filePath = path.join(dir, "main.mo");
    await writeFile(
      filePath,
      'import Random "mo:core/Random"; module { public let random = Random }',
    );
    await writeFile(
      path.join(core, "Random.mo"),
      'module { public let blob = (actor "aaaaa-aa" : actor { raw_rand : shared () -> async Blob }).raw_rand }',
    );

    const hashfiles: HashFiles = {};
    const dependencies = await getDependencies(
      null,
      filePath,
      { core },
      hashfiles,
    );
    expect(() => walkReplace(dependencies, hashfiles, [])).toThrow(
      /Disallowed Motoko code.*actor/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("comment removal preserves Motoko strings and character literals", () => {
  expect(
    removeCommentsAndEmptyLines(`
let authorizationUrl = "https://openrouter.ai/auth"; // provider endpoint
let escaped = "quote: \\\" // still text";
let slash = '/';
let joined = left/* outer /* nested */ block */right;
`),
  ).toBe(`let authorizationUrl = "https://openrouter.ai/auth";  \nlet escaped = "quote: \\\" // still text";\nlet slash = '/';\nlet joined = left right;\n`);
});

test("dependency cache is scoped to one walk", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "neutron-walk-"));
  try {
    const filePath = path.join(dir, "main.mo");
    await writeFile(filePath, "module { public func hello() : () {} }");

    const first: HashFiles = {};
    await getDependencies(null, filePath, {}, first);
    expect(Object.keys(first)).toHaveLength(1);

    const second: HashFiles = {};
    await getDependencies(null, filePath, {}, second);
    expect(Object.keys(second)).toHaveLength(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("certified package imports use the normal directory fallback", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "neutron-walk-certified-"));
  try {
    const certified = path.join(dir, "certified");
    await mkdir(path.join(certified, "Tree"), { recursive: true });
    const filePath = path.join(dir, "main.mo");
    await writeFile(
      filePath,
      'import Tree "mo:certified/Tree"; module { public let tree = Tree }',
    );
    await writeFile(
      path.join(certified, "Tree", "lib.mo"),
      "module { public let empty = 0 }",
    );

    const hashfiles: HashFiles = {};
    const dependencies = await getDependencies(
      null,
      filePath,
      { certified },
      hashfiles,
    );

    expect(Object.keys(dependencies.mods)).toEqual(["Tree"]);
    expect(Object.values(hashfiles).some(
      ({ path: sourcePath }) =>
        sourcePath === path.join(certified, "Tree", "lib.mo"),
    )).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
