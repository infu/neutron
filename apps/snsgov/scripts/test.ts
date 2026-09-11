import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { spawn } from "bun";

// Give each browser suite a fresh Bun/Playwright IPC lifetime. A timed-out
// Chromium launch must not leave an in-flight child process in later suites.
const cwd = fileURLToPath(new URL("../", import.meta.url));
const files = (await readdir(new URL("../test/", import.meta.url)))
  .filter(name => name.endsWith(".test.ts")).sort().map(name => `test/${name}`);
const browsers = files.filter(name => name.endsWith("_browser.test.ts"));
const units = files.filter(name => !name.endsWith("_browser.test.ts"));
for (const group of [units, ...browsers.map(name => [name])]) {
  if (!group.length) continue;
  const child = spawn([process.execPath, "test", ...group], {
    cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit",
  });
  const code = await child.exited;
  if (code !== 0) process.exit(code);
}
