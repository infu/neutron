// All rights reserved. See ../../LICENSE.
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { projectRoot } from "../../scripts/test-ash-runtime.ts";
import type { IntegrationCase } from "./helpers.ts";

export const cases: IntegrationCase[] = [{
  name: "Paid package checked installation, owned reinstall and grouped private-source updates",
  scope: "upgrade",
  async run() {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("bun", ["test", "./test/lifecycle/lifecycle.pocketic.test.ts"], { cwd: projectRoot, stdio: "inherit", env: { ...process.env, NEUTRON_POCKETIC_BIN: process.env.NEUTRON_POCKETIC_BIN ?? path.join(homedir(), ".local/bin/pocket-ic") } });
      child.once("error", reject);
      child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`Paid package lifecycle failed (${code ?? signal})`)));
    });
  },
}];
