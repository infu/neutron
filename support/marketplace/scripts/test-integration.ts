import { readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { projectRoot } from "./test-ash-runtime.ts";
import type { IntegrationCase } from "../test/host/helpers.ts";

const directory = path.join(projectRoot, "test/host");
const entries = (await readdir(directory)).filter((entry) => entry.endsWith(".integration.ts")).sort();
if (entries.length === 0) throw new Error("No marketplace host integration suites were found.");
let passed = 0;
let failed = 0;
const scopes = new Map<string, number>();
for (const file of entries) {
  const module = await import(pathToFileURL(path.join(directory, file)).href);
  const cases: IntegrationCase[] = module.cases;
  if (!Array.isArray(cases) || cases.length === 0) throw new Error(`No cases exported by ${file}`);
  for (const test of cases) {
    if (process.argv[2] && !test.name.includes(process.argv[2])) continue;
    try {
      await test.run();
      passed += 1;
      scopes.set(test.scope, (scopes.get(test.scope) ?? 0) + 1);
      console.log(`PASS [${test.scope}] ${test.name}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL [${test.scope}] ${test.name}`);
      console.error(error);
    }
  }
}
if (passed + failed === 0) throw new Error("No integration tests matched the filter.");
console.log(`Marketplace PocketIC: ${passed} passed, ${failed} failed; ${JSON.stringify(Object.fromEntries(scopes))}`);
if (failed) process.exitCode = 1;
