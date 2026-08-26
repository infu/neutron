import { expect, test } from "bun:test";
import { spawn } from "bun";

test("registry authority loads reject stale async continuations", async () => {
  const fixture = new URL(
    "./runtime_authority_registry_race.isolated.ts",
    import.meta.url,
  ).pathname;
  const repositoryRoot = new URL("../../..", import.meta.url).pathname;
  const child = spawn([process.execPath, "test", fixture], {
    cwd: repositoryRoot,
    env: process.env,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
  expect(`${stdout}\n${stderr}`).toContain("2 pass");
});
