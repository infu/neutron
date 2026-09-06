import { expect, test, type FrameLocator, type Page } from "@playwright/test";
import { getAddress, Interface, keccak256 } from "ethers";
import type { EvmReadContractResult } from "neutron-tools/evm_wallet";
import { localCanisterOrigin } from "neutron-tools/src/runtime.js";
import { resolveLocalNeutronRuntime } from "../../packages/neutron-provision/src/local_session.ts";
import { allowEvmInspectionGrantsUntil } from "./fixtures/evm-wallet-browser.ts";
import { createEvmNetworkFixture } from "./fixtures/evm-wallet-network.ts";

const CHAIN = "42161";
const FACTORY = "0x1f98431c8ad98523631ae4a59f267346ea31f984";
const WRAPPED = "0x82af49447d8a07e3bd95bd0d56f35241523fbab1";
const TOKEN = "0x1000000000000000000000000000000000000011";
// Exact calldata captured in the EVM103 IC0502/text_compare_range failure.
const FAILED_GET_POOL = "0x1698ee8200000000000000000000000082af49447d8a07e3bd95bd0d56f35241523fbab100000000000000000000000010000000000000000000000000000000000000110000000000000000000000000000000000000000000000000000000000000bb8";
const FACTORY_CODE_BYTES = 24_535;
const POOL_CODE_BYTES = 22_142;
const factoryAbi = new Interface(["function getPool(address,address,uint24) view returns (address)"]);
const poolAbi = new Interface([
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)",
  "function liquidity() view returns (uint128)",
]);
const KITCHEN = 'iframe[data-app-id="kitchensink"][data-tile-id="main"]';

// Installed Kitchen, Kernel and EVM Wallet stay untouched. This reads existing
// official contracts on unforked local chain 42161; it deploys, funds and signs
// nothing. It qualifies complete provider-consensus code bytes, not Nitro fees.
test.describe.configure({ retries: 0 });
test.skip(!process.env.NEUTRON_NDEPLOY_CONFIG?.endsWith("evm-wallet-local.ndeploy.json") ||
  process.env.NEUTRON_EVM_LARGE_READ_READY !== "1",
"Requires checked EVM105 installation and the existing canonical Arbitrum contract fixture");

test("factory and pool reads retain complete large code without trapping", async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  expect(factoryAbi.encodeFunctionData("getPool", [WRAPPED, TOKEN, 3000]).toLowerCase()).toBe(FAILED_GET_POOL);
  const network = await createEvmNetworkFixture(CHAIN);
  const { chain } = network;
  const kitchen = await openKitchen(page);
  await kitchen.locator('[data-tid="evm-wallet-discover"]').click();
  await allowEvmInspectionGrantsUntil(page, () => kitchen.locator('[data-tid="evm-wallet-prepare"]').isEnabled());
  await kitchen.locator('[data-tid="evm-wallet-chain"]').selectOption(CHAIN);
  const option = await kitchen.getByLabel(/^Account/u).locator("option:checked").textContent();
  const address = option?.match(/0x[0-9a-f]{40}/iu)?.[0];
  if (!address) throw new Error("Installed EVM Wallet returned no account address");
  const nonceBefore = await chain.nonce(address);
  const expectedFactoryCode = await chain.rpc<string>("eth_getCode", [FACTORY, "latest"]);
  expect((expectedFactoryCode.length - 2) / 2).toBe(FACTORY_CODE_BYTES);
  const reads: Array<{ label: string; bytes: number; codeHash: string; result: EvmReadContractResult }> = [];

  async function verifiedRead(label: string, to: string, data: string, expectedBytes: number): Promise<EvmReadContractResult> {
    const result = await readContract(page, kitchen, to, data);
    expect(result).toMatchObject({ chainId: CHAIN, accountId: "main", to: to.toLowerCase(), data });
    expect(result.address.toLowerCase()).toBe(address!.toLowerCase());
    expect(BigInt(result.observedAtNs)).toBeGreaterThan(0n);
    const block = `0x${BigInt(result.blockNumber).toString(16)}`;
    const [code, output] = await Promise.all([
      chain.rpc<string>("eth_getCode", [to, block]),
      chain.rpc<string>("eth_call", [{ from: address, to, data }, block]),
    ]);
    expect((code.length - 2) / 2).toBe(expectedBytes);
    expect(result.code).toBe(code.toLowerCase());
    expect(result.result).toBe(output.toLowerCase());
    // Both byte equality and length are deliberate: truncating the large code
    // or replacing it with a digest would hide the original consensus failure.
    expect((result.code.length - 2) / 2).toBe(expectedBytes);
    reads.push({ label, bytes: expectedBytes, codeHash: keccak256(code), result });
    return result;
  }

  const factory = await verifiedRead("previously trapped getPool", FACTORY, FAILED_GET_POOL, FACTORY_CODE_BYTES);
  expect(factory.code).toBe(expectedFactoryCode.toLowerCase());
  const pool = getAddress(factoryAbi.decodeFunctionResult("getPool", factory.result)[0]);
  expect(pool).not.toBe("0x0000000000000000000000000000000000000000");
  const slot0 = await verifiedRead("pool slot0", pool, poolAbi.encodeFunctionData("slot0"), POOL_CODE_BYTES);
  const decodedSlot0 = poolAbi.decodeFunctionResult("slot0", slot0.result);
  expect(decodedSlot0.sqrtPriceX96).toBeGreaterThan(0n);
  expect(decodedSlot0.unlocked).toBe(true);
  const liquidity = await verifiedRead("pool liquidity", pool, poolAbi.encodeFunctionData("liquidity"), POOL_CODE_BYTES);
  expect(poolAbi.decodeFunctionResult("liquidity", liquidity.result)[0]).toBeGreaterThan(0n);
  const repeated = await verifiedRead("repeated complete factory read", FACTORY, FAILED_GET_POOL, FACTORY_CODE_BYTES);
  expect(repeated.code).toBe(factory.code);
  expect(repeated.result).toBe(factory.result);
  expect(await chain.nonce(address)).toBe(nonceBefore);
  await expect(page.locator('iframe[data-app-id="evm_wallet"][data-tile-id="evm_wallet"]')).toHaveCount(0);
  await expect(kitchen.locator('[data-tid="evm-wallet-evidence"]')).toHaveAttribute("role", "status");
  await testInfo.attach("complete-large-contract-read-evidence", {
    contentType: "application/json", body: JSON.stringify({ chainId: CHAIN, clientVersion: network.clientVersion,
      proof: "Actual installed ordinary Kitchen readContract calls, full EVM Wallet provider-consensus code, independent guarded local RPC at the returned block; no contract or financial mutation", factory: FACTORY, pool, address,
      failedCalldata: FAILED_GET_POOL, nonceBefore: String(nonceBefore), nonceAfter: String(await chain.nonce(address)), reads }, null, 2),
  });
});

async function readContract(page: Page, kitchen: FrameLocator, to: string, data: string): Promise<EvmReadContractResult> {
  await kitchen.getByLabel("Read-only contract address", { exact: true }).fill(to);
  await kitchen.getByLabel("Read calldata (hex)", { exact: true }).fill(data);
  await kitchen.getByRole("button", { name: "Read contract without signing", exact: true }).click();
  const evidence = kitchen.locator('[data-tid="evm-wallet-evidence"]');
  await allowEvmInspectionGrantsUntil(page, async () => await evidence.getAttribute("aria-busy") === "false" &&
    (await evidence.locator("pre").count() === 1 || await evidence.getAttribute("role") === "alert"));
  await expect(evidence, await evidence.textContent() ?? "Contract read failed").toHaveAttribute("role", "status");
  return JSON.parse((await evidence.locator("pre").textContent())!) as EvmReadContractResult;
}
async function openKitchen(page: Page): Promise<FrameLocator> {
  const runtime = resolveLocalNeutronRuntime();
  await page.goto(localCanisterOrigin(runtime.canisterId, runtime.gatewayUrl));
  await page.waitForFunction(() => typeof (window as typeof window & { __NEUTRON_PLAYWRIGHT_LOGIN_AS__?: unknown }).__NEUTRON_PLAYWRIGHT_LOGIN_AS__ === "function");
  expect(await page.evaluate(async (seed) => {
    const login = (window as typeof window & { __NEUTRON_PLAYWRIGHT_LOGIN_AS__?: (seed: number) => Promise<string> }).__NEUTRON_PLAYWRIGHT_LOGIN_AS__;
    if (!login) throw new Error("Local Kernel login hook unavailable");
    return login(seed);
  }, runtime.developerIdentitySeed)).toBe(runtime.developerIdentityPrincipal);
  for (const app of ["evm_wallet", "kitchensink"]) {
    await expect(page.locator(`[data-tid="app-background-frame"][data-app-id="${app}"]`)).toHaveAttribute("data-resident-launch", "ready", { timeout: 120_000 });
  }
  await page.locator('[data-tid="launcher-open"]').click();
  await page.locator('[data-tid="launcher-tile-kitchensink-main"]').click();
  const kitchen = page.frameLocator(KITCHEN);
  await expect(kitchen.locator('[data-tid="kitchen-tile-main"]')).toBeVisible();
  await kitchen.locator('[data-tid="kitchen-nav-evm_wallet"]').click();
  await expect(kitchen.locator('[data-tid="evm-wallet-intents"]')).toBeVisible();
  return kitchen;
}
