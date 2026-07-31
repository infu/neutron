import chalk from "chalk";
import { disposeMotokoCompiler } from "neutron-motoko-wasm";
import { checkCoreAppAgnostic } from "./src/core_app_agnostic.ts";
import { checkSecurityFixtures } from "./src/fixtures.ts";

const [results, coreIssues] = await Promise.all([
  checkSecurityFixtures().finally(disposeMotokoCompiler),
  checkCoreAppAgnostic(),
]);
const failures = results.filter((result) => !result.passed);

for (const result of results) {
  const color = result.passed ? chalk.blue : chalk.red;
  console.log(
    color(result.passed ? "\u2713" : "\u2717"),
    result.passed ? "passed" : "failed",
    chalk.blue(result.pattern),
    chalk.green(result.directory),
    chalk.yellow(result.file),
    result.parseError ? chalk.cyan(result.parseError) : ""
  );
}

if (failures.length > 0) {
  console.error(`${failures.length} security fixture check(s) failed`);
  process.exitCode = 1;
}

for (const issue of coreIssues) {
  console.error(
    chalk.red("\u2717"),
    chalk.red("app-coupled Core source"),
    chalk.yellow(`${issue.file}:${issue.line}`),
    chalk.blue(issue.rule),
    chalk.green(issue.value),
  );
}
if (coreIssues.length > 0) {
  console.error(`${coreIssues.length} Core app-agnostic check(s) failed`);
  process.exitCode = 1;
}
