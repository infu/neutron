import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";

test("resident tools register through the actual Neutron descriptor validator", async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ["--eval", `await import(${JSON.stringify(new URL("../src/service.ts", import.meta.url).href)}); const {listExposedTools}=await import("neutron-tools/app"); console.log(JSON.stringify(listExposedTools().map(t=>t.name))); process.exit(0);`], { cwd: new URL("..", import.meta.url).pathname });
  expect(JSON.parse(stdout).sort()).toEqual(["aave_markets_v1", "aave_quote_v1", "aave_fees_v1", "aave_execute_v1", "aave_continue_v1", "aave_reconcile_v1", "aave_status_v1", "aave_history_v1"].sort());
});

test("Aave declares only its exact public Wallet protocol and durable v1 journal", async () => {
  const manifest = JSON.parse(await readFile(new URL("../neutron.json", import.meta.url), "utf8"));
  expect(manifest.update_source).toBe("sj2r4-haaaa-aaaay-aadgq-cai");
  expect(manifest.capabilities.frontend_tools.targets).toEqual([{ app: "evm_wallet", tools: ["evm_accounts_v1", "evm_balances_v1", "evm_wallet_prices_v1", "evm_call_contract_v1", "evm_estimate_transaction_v1", "evm_transaction_v1", "evm_replacement_transaction_v1", "evm_operation_status_v1", "evm_send_transaction_v1"] }]);
  expect(Object.keys(manifest.memory)).toEqual(["aave"]);
  expect(manifest.memory.aave).toMatchObject({ version: 1, schemas: { "1": { src: "memory/aave/v1.mo" } }, migrations: [] });
});
