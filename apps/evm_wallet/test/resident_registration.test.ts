import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { EVM_WALLET_TOOLS } from "neutron-tools/evm_wallet";

test("EVM Wallet resident registers its complete consumer protocol through the real SDK validator", async () => {
  // Import the actual resident in a fresh process so another test's mocked
  // exposeTool cannot hide a schema error that aborts later registrations.
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ["--eval",
    `await import(${JSON.stringify(new URL("../src/service.ts", import.meta.url).href)});
     const { listExposedTools } = await import("neutron-tools/app");
     console.log(JSON.stringify(listExposedTools().map(tool => tool.name)));
     process.exit(0);`,
  ], { cwd: new URL("..", import.meta.url).pathname });
  expect(stderr).toBe("");
  expect(JSON.parse(stdout).sort()).toEqual(Object.values(EVM_WALLET_TOOLS).sort());
});
