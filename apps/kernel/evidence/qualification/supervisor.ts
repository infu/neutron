import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CERTIFIED_ASSETS_RELEASE_QUALIFICATION_PROFILE } from "./profile.ts";

export const QUALIFICATION_COMMAND_LIMIT_MS = CERTIFIED_ASSETS_RELEASE_QUALIFICATION_PROFILE.maximum_wall_seconds * 1_000;
export const QUALIFICATION_WORK_LIMIT_MS = QUALIFICATION_COMMAND_LIMIT_MS - 10_000;
const STOP_GRACE_MS = 3_000;
type SupervisorOptions = {
  workLimitMs?: number; commandLimitMs?: number; temporaryParent?: string;
  environment?: NodeJS.ProcessEnv;
  onTemporaryRoot?: (root: string) => void;
  stdio?: "inherit" | "ignore";
};
export async function superviseQualificationProcess(
  command: string, args: readonly string[], options: SupervisorOptions = {},
): Promise<void> {
  if (process.platform !== "linux" && process.platform !== "darwin") {
    throw new Error("Qualification requires POSIX process-group cleanup");
  }
  const commandLimit = options.commandLimitMs ?? QUALIFICATION_COMMAND_LIMIT_MS;
  const workLimit = options.workLimitMs ?? QUALIFICATION_WORK_LIMIT_MS;
  if (workLimit < 1 || workLimit + 2 * STOP_GRACE_MS >= commandLimit) {
    throw new Error("Qualification timeout leaves no cleanup reserve");
  }
  let group: number | undefined;
  let root: string | undefined;
  const watchdog = setTimeout(() => {
    if (group !== undefined) signalGroup(group, "SIGKILL");
    console.error(`Certified Assets qualification exceeded ${commandLimit / 1_000} seconds`);
    process.exit(124);
  }, commandLimit);
  try {
    root = await mkdtemp(path.join(options.temporaryParent ?? tmpdir(), "neutron-ca-supervisor-"));
    options.onTemporaryRoot?.(root);
    const child = spawn(command, [...args], {
      cwd: path.resolve(import.meta.dir, "../../../.."),
      detached: true,
      env: { ...(options.environment ?? process.env), TMPDIR: root, TMP: root, TEMP: root },
      stdio: options.stdio ?? "inherit",
    });
    group = child.pid;
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    const outcome = await Promise.race([exited, wait(workLimit, true).then(() => null)]);
    if (outcome === null) {
      throw new Error(
        `Certified Assets qualification exceeded its ${workLimit / 1_000} second work limit`,
      );
    }
    if (outcome.code !== 0) {
      throw new Error(`Certified Assets qualification worker failed (${outcome.signal ?? `exit ${outcome.code}`})`);
    }
    if (group !== undefined && groupExists(group)) {
      throw new Error("Certified Assets qualification left a child process running");
    }
  } finally {
    try {
      if (group !== undefined) await stopGroup(group);
    } finally {
      try { if (root !== undefined) await rm(root, { recursive: true, force: true }); }
      finally { clearTimeout(watchdog); }
    }
  }
}
async function stopGroup(group: number): Promise<void> {
  if (!groupExists(group)) return;
  signalGroup(group, "SIGTERM");
  if (await groupStops(group)) return;
  signalGroup(group, "SIGKILL");
  if (!await groupStops(group)) {
    throw new Error("Qualification process group survived SIGKILL");
  }
}
async function groupStops(group: number): Promise<boolean> {
  const deadline = Date.now() + STOP_GRACE_MS;
  while (Date.now() < deadline) {
    if (!groupExists(group)) return true;
    await wait(10);
  }
  return !groupExists(group);
}
function groupExists(group: number): boolean {
  try {
    process.kill(-group, 0);
    return true;
  } catch (error) {
    if (missingProcess(error)) return false;
    throw error;
  }
}
function signalGroup(group: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-group, signal);
  } catch (error) {
    if (!missingProcess(error)) throw error;
  }
}
function missingProcess(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "code" in error && error.code === "ESRCH";
}
function wait(milliseconds: number, unref = false): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    if (unref) timer.unref();
  });
}
if (import.meta.main) {
  superviseQualificationProcess(process.execPath, [
    path.join(import.meta.dir, "run.ts"),
    "--release",
  ]).catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
