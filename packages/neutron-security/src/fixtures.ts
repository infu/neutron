import fs from "node:fs/promises";
import path from "node:path";
import { loadMotoko } from "neutron-motoko-wasm";
import {
  checkForDangerousASTCode,
  DANGER_RULE_ORDER,
  type DangerRule,
} from "./lib.ts";

export type FixtureCheckResult = {
  directory: string;
  file: string;
  pattern: string;
  expected: boolean;
  passed: boolean;
  parseError?: string;
};

const EXPECTED_PARSE_FAILURES = new Set(["call_raw_2.mo"]);

const expectedRule = (file: string): DangerRule | undefined =>
  DANGER_RULE_ORDER.find(
    (rule) => file === `${rule}.mo` || file.startsWith(`${rule}_`),
  );

export async function checkFixtureDirectory(
  directory: string,
  expectExists = false,
): Promise<FixtureCheckResult[]> {
  const files = (await fs.readdir(directory)).sort();
  const results: FixtureCheckResult[] = [];
  const mo = await loadMotoko();

  for (const file of files) {
    const contents = await fs.readFile(path.join(directory, file), "utf-8");

    try {
      const ast = await mo.parseMotoko(contents);
      const findings = checkForDangerousASTCode(ast, contents);
      if (expectExists) {
        const pattern = expectedRule(file);
        results.push({
          directory,
          file,
          pattern: pattern ?? "missing-fixture-rule",
          expected: true,
          passed: pattern !== undefined && findings.includes(pattern),
        });
      } else if (findings.length === 0) {
        results.push({
          directory,
          file,
          pattern: "none",
          expected: false,
          passed: true,
        });
      } else {
        for (const pattern of findings) {
          results.push({
            directory,
            file,
            pattern,
            expected: false,
            passed: false,
          });
        }
      }
    } catch (error) {
      const parseError = error instanceof Error ? error.message : String(error);
      results.push({
        directory,
        file,
        pattern: "parse",
        expected: expectExists,
        passed: expectExists && EXPECTED_PARSE_FAILURES.has(file),
        parseError,
      });
    }
  }

  return results;
}

export async function checkSecurityFixtures(
  rootDirectory = process.cwd(),
): Promise<FixtureCheckResult[]> {
  const allowed = await checkFixtureDirectory(
    path.join(rootDirectory, "allowed"),
    false,
  );
  const disallowedResults = await checkFixtureDirectory(
    path.join(rootDirectory, "disallowed"),
    true,
  );
  return [...allowed, ...disallowedResults];
}
