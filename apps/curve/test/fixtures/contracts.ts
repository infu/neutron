/** Execute app-generated calls on pinned forks of official deployed contracts.
 * Only a local Anvil receives effects; remote providers receive read RPCs.
 * npm ci --prefix apps/curve/test/fixtures; npm -w neutron-curve run test:contracts
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { getAddress, encodeAbiParameters, keccak256, toHex, type Address, type Hex } from "viem";
import { call, encode, CHAINS, TOKEN_BALANCE, type ChainId, type Family, type Reader, type Transaction } from "../../src/contracts.ts";
import { verifyPool } from "../../src/pools.ts";
import { parseInput, quoteLiquidity, quoteSwap, type LiquidityInput, type SwapInput, type Plan } from "../../src/plans.ts";

const require = createRequire(process.env.CURVE_FIXTURE_DEPS ? `${process.env.CURVE_FIXTURE_DEPS}/package.json` : import.meta.url);
const anvil = require.resolve("@foundry-rs/anvil-linux-amd64/bin/anvil");
const account = { accountId: "main" as const, address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", publicKey: "0x02" + "22".repeat(32), keyFingerprint: "0x" + "33".repeat(32), namespaceVersion: "1" };
const receiver = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const configs: { chainId: ChainId; block: number; pools: [string, Family][] }[] = [
  { chainId: "1", block: 25922607, pools: [
    ["0xD001aE433f254283FeCE51d4ACcE8c53263aa186", "stable-ng"],
    ["0x2482DFb5A65D901d137742AB1095f26374509352", "stable-meta-ng"],
    ["0xEe351f12EAE8C2B8B9d1B9BFd3c5dd565234578d", "twocrypto-ng"],
    ["0xf5f5B97624542D72A9E06f04804Bf81baA15e2B4", "tricrypto-ng"],
    ["0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7", "legacy-3"],
    ["0xDC24316b9AE028F1497c275EB9192a3Ea0f67022", "legacy-2"],
  ] },
  { chainId: "42161", block: 502541973, pools: [
    ["0x186cF879186986A20aADFb7eAD50e3C20cb26CeC", "stable-ng"],
    ["0x98961b846D1a046701Af1a56023e29FF55522aD5", "twocrypto-ng"],
    ["0x82670f35306253222F8a165869B28c64739ac62e", "tricrypto-ng"],
    ["0x7f90122BF0700F9E7e1F688fe926940E8839F353", "legacy-2"],
    ["0x6eB2dc694eB516B16Dc9FBc678C60052BbdD7d80", "legacy-2"],
  ] },
];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
for (const config of configs.filter((item) => !process.env.CURVE_FIXTURE_CHAIN || item.chainId === process.env.CURVE_FIXTURE_CHAIN)) {
  const server = createServer(); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port; await new Promise<void>((resolve) => server.close(() => resolve()));
  const rpcUrl = `http://127.0.0.1:${port}`;
  assert.equal(new URL(rpcUrl).hostname, "127.0.0.1");
  const child = spawn(anvil, ["--host", "127.0.0.1", "--port", String(port), "--chain-id", config.chainId, "--fork-url", config.chainId === "1" ? "https://ethereum-rpc.publicnode.com" : "https://arb1.arbitrum.io/rpc", "--fork-header", "User-Agent: Mozilla/5.0", "--fork-block-number", String(config.block), "--silent"], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = ""; child.stderr.on("data", (chunk) => { stderr += chunk; });
  async function rpc<T = string>(method: string, params: unknown[]): Promise<T> {
    const response = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const body = await response.json() as { result: T; error?: { message: string } };
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result;
  }
  const read: Reader = async (chainId, to, data, blockNumber) => {
    assert.equal(chainId, config.chainId);
    const block = blockNumber === undefined ? await rpc("eth_blockNumber", []) : toHex(BigInt(blockNumber));
    const output = await rpc<Hex>("eth_call", [{ from: account.address, to, data }, block]);
    return { data: output, blockNumber: BigInt(block).toString() };
  };
  const balance = async (token: Address, owner = account.address) => BigInt(String((await call(read, config.chainId, token, TOKEN_BALANCE, [owner])).value));
  const send = async (transaction: Transaction) => {
    assert.equal(transaction.chainId, config.chainId);
    // Keep fork test funds independent of remote fixture-account balances and
    // Anvil's chain-specific fee defaults. Calldata/value are unchanged.
    await rpc("anvil_setBalance", [account.address, toHex(10n ** 30n)]);
    const hash = await rpc("eth_sendTransaction", [{ from: account.address, to: transaction.to, data: transaction.data, value: toHex(BigInt(transaction.valueWei)), gas: "0x989680" }]);
    let receipt: { status: string } | null = null;
    for (let i = 0; i < 240 && !receipt; i++) { receipt = await rpc("eth_getTransactionReceipt", [hash]); if (!receipt) await sleep(250); }
    assert(receipt, `Fixture receipt unavailable: ${hash}`);
    if (receipt.status !== "0x1") {
      const trace = await rpc<{ returnValue: string; structLogs: { op: string; pc: number; depth: number; error?: string; stack: string[] }[] }>("debug_traceTransaction", [hash, {}]);
      console.error(JSON.stringify({ transaction, receipt, returnValue: trace.returnValue, trace: trace.structLogs.slice(-6) }));
    }
    assert.equal(receipt.status, "0x1", `Reverted ${transaction.to} ${transaction.data.slice(0, 10)} on ${config.chainId}`);
  };
  const execute = async (plan: Plan) => { for (const step of plan.steps) await send(step.transaction); };
  // Test-only ERC20 balance injection into the isolated fork. Discover the
  // balance mapping from storage reads, then verify the exact observed balance.
  async function fund(token: Address, value: bigint) {
    const data = encode(TOKEN_BALANCE, [account.address]);
    const before = await balance(token);
    if (before >= value) return;
    const trace = await rpc<{ structLogs: { op: string; stack: string[] }[] }>("debug_traceCall", [{ from: account.address, to: token, data }, "latest", {}]);
    const slots = [...new Set(trace.structLogs.filter((row) => row.op === "SLOAD").map((row) => "0x" + row.stack.at(-1)!.replace(/^0x/, "").padStart(64, "0")))];
    for (const slot of slots) {
      const old = await rpc("eth_getStorageAt", [token, slot, "latest"]);
      await rpc("anvil_setStorageAt", [token, slot, toHex(value, { size: 32 })]);
      let actual: bigint | null = null;
      try { actual = await balance(token); } catch { /* restore non-balance slot */ }
      if (actual !== null && actual !== before && actual >= value && actual < value * 2n) return;
      await rpc("anvil_setStorageAt", [token, slot, old]);
    }
    // Vyper and Solidity layouts without trace stack support.
    for (let slot = 0n; slot < 30n; slot++) for (const reverse of [false, true]) {
      const key = keccak256(encodeAbiParameters(reverse ? [{ type: "uint256" }, { type: "address" }] : [{ type: "address" }, { type: "uint256" }], reverse ? [slot, account.address as Address] : [account.address as Address, slot]));
      const old = await rpc("eth_getStorageAt", [token, key, "latest"]);
      await rpc("anvil_setStorageAt", [token, key, toHex(value, { size: 32 })]);
      const actual = await balance(token);
      if (actual >= value && actual < value * 2n) return;
      await rpc("anvil_setStorageAt", [token, key, old]);
    }
    throw new Error(`Could not inject fixture balance for ${token}; prior ${before}`);
  }
  try {
    let started = false;
    for (let i = 0; i < 120; i++) { try { await rpc("eth_chainId", []); started = true; break; } catch { if (child.exitCode !== null) throw new Error(stderr); await sleep(250); } }
    assert(started, stderr || "Anvil did not start");
    assert.equal(await rpc("eth_chainId", []), toHex(BigInt(config.chainId)));
    console.log(`Pinned official contract fork: ${config.chainId} block ${config.block}`);
    for (const [address, family] of config.pools) {
      if (process.env.CURVE_FIXTURE_POOL && !address.toLowerCase().includes(process.env.CURVE_FIXTURE_POOL.toLowerCase())) continue;
      const ref = { chainId: config.chainId, address: getAddress(address), family };
      console.log(`Verifying ${family} ${address}`);
      const pool = await verifyPool(read, ref);
      const catalog = { pools: [pool], errors: [], complete: true, fetchedAtMs: Date.now() };
      const budgets = pool.balances.map((value) => (BigInt(value) / 100000n || 1n).toString());
      await rpc("anvil_setBalance", [account.address, toHex(10n ** 30n)]);
      for (let i = 0; i < pool.coins.length; i++) if (pool.coins[i]!.address) await fund(pool.coins[i]!.address!, BigInt(budgets[i]!) * 100n);
      const input = (kind: string, extra: object = {}) => parseInput({ kind, chainId: config.chainId, pool: ref, slippageBps: 50, amounts: budgets, lpAmount: "0", ...extra }) as LiquidityInput;
      const deposit = await quoteLiquidity(read, account, input("deposit"), { catalog });
      const before = await balance(pool.lpToken);
      await execute(deposit);
      const minted = await balance(pool.lpToken) - before;
      assert(minted >= BigInt(deposit.preview.outputs[0]!.minimum));
      console.log(`  Deposit: minted ${minted} LP atomic units`);
      const burn = minted / 4n;
      const proportional = await quoteLiquidity(read, account, input("withdraw", { lpAmount: burn.toString(), ...(family.startsWith("legacy") ? {} : { recipient: receiver }) }), { catalog });
      const holdings = await Promise.all(pool.coins.map((token) => token.address ? balance(token.address, proportional.preview.recipient) : rpc("eth_getBalance", [proportional.preview.recipient, "latest"]).then(BigInt)));
      await execute(proportional);
      assert.equal(await balance(pool.lpToken), before + minted - burn);
      for (let i = 0; i < pool.coins.length; i++) if (pool.coins[i]!.address) assert(await balance(pool.coins[i]!.address!, proportional.preview.recipient) - holdings[i]! >= BigInt(proportional.preview.outputs[i]!.minimum));
      const one = await quoteLiquidity(read, account, input("withdraw_one", { lpAmount: burn.toString(), coinIndex: 0 }), { catalog });
      await execute(one);
      assert.equal(await balance(pool.lpToken), before + minted - burn * 2n);
      console.log("  Proportional and single-coin withdrawals: confirmed");
      const swapInput = parseInput({ kind: "swap", chainId: config.chainId, tokenIn: pool.coins[0]!.address, tokenOut: pool.coins[1]!.address, amountIn: budgets[0], recipient: receiver, pool: ref }) as SwapInput;
      const swap = await quoteSwap(read, account, swapInput, { catalog });
      const outBefore = pool.coins[1]!.address ? await balance(pool.coins[1]!.address!, receiver) : BigInt(await rpc("eth_getBalance", [receiver, "latest"]));
      await execute(swap);
      const outAfter = pool.coins[1]!.address ? await balance(pool.coins[1]!.address!, receiver) : BigInt(await rpc("eth_getBalance", [receiver, "latest"]));
      assert(outAfter - outBefore >= BigInt(swap.preview.outputs[0]!.minimum));
      // Alter only the min output word of exact app calldata; the contract must
      // revert even though the input budget, route and recipient are valid.
      const final = swap.steps.at(-1)!.transaction, offset = 4 + (11 + 25 + 1) * 32;
      const impossible = (1n << 255n).toString(16).padStart(64, "0");
      const bad = final.data.slice(0, 2 + offset * 2) + impossible + final.data.slice(2 + (offset + 32) * 2);
      await assert.rejects(rpc("eth_call", [{ from: account.address, to: final.to, data: bad, value: toHex(BigInt(final.valueWei)) }, "latest"]));
      console.log("  Router swap: recipient credited; impossible minimum reverted");
      if (family === "tricrypto-ng") {
        const index = pool.coins.findIndex((token) => token.address === CHAINS[config.chainId].weth);
        if (index >= 0) {
          await execute(await quoteLiquidity(read, account, input("deposit", { useNative: true }), { catalog }));
          await execute(await quoteLiquidity(read, account, input("withdraw_one", { lpAmount: burn.toString(), coinIndex: index, useNative: true }), { catalog }));
          const nativeSwap = parseInput({ ...swapInput, tokenIn: null, tokenOut: pool.coins[index === 0 ? 1 : 0]!.address, amountIn: budgets[index] }) as SwapInput;
          await execute(await quoteSwap(read, account, nativeSwap, { catalog }));
          console.log("  Native ETH liquidity and Router wrap hop: confirmed");
        }
      }
    }
    const wrap = parseInput({ kind: "swap", chainId: config.chainId, tokenIn: null, tokenOut: CHAINS[config.chainId].weth, amountIn: "1000000000000000", recipient: receiver }) as SwapInput;
    await execute(await quoteSwap(read, account, wrap));
    console.log(`PASS ${config.chainId}: official contracts, fixture funds only`);
  } finally { child.kill("SIGTERM"); await new Promise<void>((resolve) => { if (child.exitCode !== null) resolve(); else child.once("exit", () => resolve()); }); }
}
