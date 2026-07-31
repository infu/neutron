import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const packageUrl = new URL("../package.json", import.meta.url);

test("package exposes compiled helpers and supported SCSS entrypoints", async () => {
  const pkg = JSON.parse(await readFile(packageUrl, "utf8")) as {
    dependencies?: Record<string, string>;
    exports: Record<string, unknown>;
    sideEffects: string[];
  };

  expect(pkg.dependencies).toBeUndefined();
  expect(Object.keys(pkg.exports).sort()).toEqual([
    ".",
    "./base.scss",
    "./components.scss",
    "./layout.scss",
    "./package.json",
    "./styles.scss",
    "./tokens.scss",
  ]);
  expect(pkg.sideEffects).toContain("**/*.scss");
  expect(pkg.sideEffects).toContain("**/*.css");
});
