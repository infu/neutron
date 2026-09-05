import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import {
  QUALIFICATION_COMMAND_LIMIT_MS,
  QUALIFICATION_WORK_LIMIT_MS,
  superviseQualificationProcess,
} from "./supervisor.ts";

test("qualification timeout kills its process tree and removes private state", async () => {
  expect(QUALIFICATION_COMMAND_LIMIT_MS).toBe(300_000);
  expect(QUALIFICATION_COMMAND_LIMIT_MS - QUALIFICATION_WORK_LIMIT_MS).toBe(10_000);
  const parent = await mkdtemp(path.join(tmpdir(), "ca-supervisor-test-"));
  const pidFile = path.join(parent, "pids.json");
  let privateRoot = "";
  try {
    const worker = `
      const { spawn } = require("node:child_process");
      const { writeFileSync } = require("node:fs");
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
      writeFileSync(process.env.PID_FILE, JSON.stringify([process.pid, child.pid]));
      setInterval(() => {}, 1000);
    `;
    await expect(superviseQualificationProcess(
      process.execPath,
      ["-e", worker],
      {
        workLimitMs: 500,
        commandLimitMs: 7_000,
        temporaryParent: parent,
        environment: { ...process.env, PID_FILE: pidFile },
        onTemporaryRoot: (root) => {
          privateRoot = root;
        },
        stdio: "ignore",
      },
    )).rejects.toThrow("exceeded its 0.5 second work limit");
    const pids = JSON.parse(await readFile(pidFile, "utf8")) as number[];
    expect(pids.every((pid) => !processExists(pid))).toBe(true);
    await expect(access(privateRoot)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (
      typeof error === "object" && error !== null &&
      "code" in error && error.code === "ESRCH"
    ) {
      return false;
    }
    throw error;
  }
}
