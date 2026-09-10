// All rights reserved. See ../LICENSE.
import { randomBytes } from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { json } from "./operator-wire.ts";

export async function savePublisherJournal(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(json(value)); await handle.sync(); } finally { await handle.close(); }
  try { await rename(temporary, file); const directory = await open(path.dirname(file), "r"); try { await directory.sync(); } finally { await directory.close(); } }
  finally { await rm(temporary, { force: true }); }
}

export async function lockPublisherJournal(file: string): Promise<() => Promise<void>> {
  const name = `${file}.lock`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { const handle = await open(name, "wx", 0o600); await handle.writeFile(String(process.pid)); await handle.close(); return () => rm(name, { force: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = Number(await readFile(name, "utf8"));
      if (!Number.isSafeInteger(owner) || owner <= 0) throw new Error(`Publisher journal lock is unreadable: ${name}`);
      try { process.kill(owner, 0); throw new Error("This publication journal is already being used by another process."); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; }
      await rm(name);
    }
  }
  throw new Error("Could not acquire the publication journal.");
}
