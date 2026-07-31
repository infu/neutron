import { expect, test } from "bun:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkSecurityFixtures } from "../src/fixtures.ts";

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("allowed and disallowed Motoko security fixtures match expectations", async () => {
  const results = await checkSecurityFixtures(packageRoot);
  expect(results.filter((result) => !result.passed)).toEqual([]);
});
