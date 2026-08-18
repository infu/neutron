import { spawn } from "bun";
import { expect, test } from "bun:test";

test("isolated repository pre-dispatch build review", async () => {
  const fixture = new URL(
    "./repository_build_review_service.isolated.ts",
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
