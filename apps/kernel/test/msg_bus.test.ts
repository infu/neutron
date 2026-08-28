import { expect, test } from "bun:test";
import { spawn } from "bun";

test("Kernel message-bus routing stays isolated from process-global module mocks", async () => {
  const fixture = new URL("./msg_bus.isolated.ts", import.meta.url).pathname;
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
  expect(`${stdout}\n${stderr}`).toContain(
    "NEUTRON_MSG_BUS_ISOLATED_SUCCESS",
  );
});
