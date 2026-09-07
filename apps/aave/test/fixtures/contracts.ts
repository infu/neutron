/** Run app-generated Aave V3 plans on pinned forks of deployed contracts.
 * Only the local Anvil endpoint receives transactions or fixture mutations.
 * Remote Ethereum / Arbitrum endpoints receive read RPCs for fork data only.
 * npm ci --prefix apps/aave/test/fixtures; npm -w neutron-aave run test:contracts
 * AAVE_FIXTURE_DEPS can point at an existing isolated Anvil 1.7.1 install.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { encodeAbiParameters, encodeFunctionData, decodeFunctionResult, decodeFunctionData, getAddress, keccak256, parseAbi, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CHAINS, type ChainId, type Reader, type Transaction } from "../../src/contracts.ts";
import { calculatePosition, parseInput, quotePlan, type Input, type Plan } from "../../src/plans.ts";
import { readMarket } from "../../src/markets.ts";

// Independent ABI fragments, not imported from the app's encoder.
const abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function getUserAccountData(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256)",
  "function getUserConfiguration(address) view returns ((uint256 data))",
  "function getUserEMode(address) view returns (uint256)",
  "function getReserveTokensAddresses(address) view returns (address,address,address)",
  "function getReserveNormalizedIncome(address) view returns (uint256)",
  "function getEModeCategoryCollateralConfig(uint8) view returns (uint16,uint16,uint16)",
  "function supply(address,uint256,address,uint16)",
  "function withdraw(address,uint256,address) returns (uint256)",
  "function borrow(address,uint256,uint256,uint16,address)",
  "function repay(address,uint256,uint256,address) returns (uint256)",
  "function repayWithATokens(address,uint256,uint256) returns (uint256)",
  "function setUserUseReserveAsCollateral(address,bool)",
  "function setUserEMode(uint8)",
  "function approve(address,uint256) returns (bool)",
  "function approveDelegation(address,uint256)",
  "function depositETH(address,address,uint16) payable",
  "function withdrawETH(address,uint256,address)",
  "function borrowETH(address,uint256,uint16)",
  "function repayETH(address,uint256,address) payable",
  "function claimAllRewards(address[],address) returns (address[],uint256[])",
]);
const maxUint = (1n << 256n) - 1n;
const require = createRequire(process.env.AAVE_FIXTURE_DEPS ? `${process.env.AAVE_FIXTURE_DEPS}/package.json` : import.meta.url);
const anvil = require.resolve("@foundry-rs/anvil-linux-amd64/bin/anvil");
// Public deterministic test identity. Anvil's standard f39… account already has
// EIP-7702 delegation on both live networks, so it is not a clean EOA fixture.
// This account is only impersonated on the loopback fork and never signed or
// submitted to a remote endpoint. Assert empty code before using it.
const fixtureIdentity = privateKeyToAccount(keccak256(toHex("neutron:aave:contract-qualification:v1")));
const account = { accountId: "main" as const, address: fixtureIdentity.address, publicKey: fixtureIdentity.publicKey, keyFingerprint: "0x" + "33".repeat(32), namespaceVersion: "1" };
const configs: { chainId: ChainId; block: number; pool: Address; dataProvider: Address; weth: Address; usdc: Address; wsteth: Address; eMode: number }[] = [
  { chainId: "1", block: 25925506, pool: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2", dataProvider: "0x0a16f2FCC0D44FaE41cc54e079281D84A363bECD", weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", wsteth: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0", eMode: 1 },
  { chainId: "42161", block: 502679266, pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD", dataProvider: "0x243Aa95cAC2a25651eda86e80bEe66114413c43b", weth: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", wsteth: "0x5979D7b546E38E414F7E9822514be443A4800529", eMode: 7 },
];
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

for (const config of configs.filter(item => !process.env.AAVE_FIXTURE_CHAIN || item.chainId === process.env.AAVE_FIXTURE_CHAIN)) {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  const rpcUrl = `http://127.0.0.1:${port}`;
  assert.equal(new URL(rpcUrl).hostname, "127.0.0.1");
  // PublicNode serves current app reads, but its anonymous archive window is
  // too short for pinned reruns; these read-only fork URLs provide archive data.
  const child = spawn(anvil, ["--host", "127.0.0.1", "--port", String(port), "--chain-id", config.chainId, "--fork-url", config.chainId === "1" ? "https://eth.drpc.org" : "https://arb1.arbitrum.io/rpc", "--fork-header", "User-Agent: Mozilla/5.0", "--fork-block-number", String(config.block), "--silent"], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  async function rpc<T = string>(method: string, params: unknown[]): Promise<T> {
    const response = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(600_000) }).catch(error => { throw new Error(`Local fixture ${method} timed out or failed: ${String(error)}`); });
    const body = await response.json() as { result: T; error?: { message: string; data?: unknown } };
    if (body.error) throw new Error(`${method}: ${body.error.message} ${JSON.stringify(body.error.data ?? "")}`);
    return body.result;
  }
  const read: Reader = async (chainId, to, data, blockNumber) => {
    assert.equal(chainId, config.chainId);
    const block = blockNumber === undefined ? await rpc("eth_blockNumber", []) : toHex(BigInt(blockNumber));
    return { data: await rpc<Hex>("eth_call", [{ from: account.address, to, data }, block]), blockNumber: BigInt(block).toString() };
  };
  async function view(to: Address, functionName: string, args: readonly unknown[] = []): Promise<any> {
    const data = encodeFunctionData({ abi, functionName: functionName as any, args: args as any });
    const output = await rpc<Hex>("eth_call", [{ from: account.address, to, data }, "latest"]);
    return decodeFunctionResult({ abi, functionName: functionName as any, data: output });
  }
  const balance = (token: Address) => view(token, "balanceOf", [account.address]) as Promise<bigint>;
  const accountData = () => view(config.pool, "getUserAccountData", [account.address]) as Promise<readonly bigint[]>;
  async function fund(token: Address, amount: bigint) {
    const before = await balance(token);
    if (before >= amount) return;
    const data = encodeFunctionData({ abi, functionName: "balanceOf", args: [account.address as Address] });
    const trace = await rpc<{ structLogs: { op: string; stack: string[] }[] }>("debug_traceCall", [{ from: account.address, to: token, data }, "latest", {}]);
    const slots = [...new Set(trace.structLogs.filter(row => row.op === "SLOAD").map(row => "0x" + row.stack.at(-1)!.replace(/^0x/, "").padStart(64, "0")))];
    for (const slot of slots) {
      const old = await rpc("eth_getStorageAt", [token, slot, "latest"]);
      await rpc("anvil_setStorageAt", [token, slot, toHex(amount, { size: 32 })]);
      let actual: bigint | null = null;
      try { actual = await balance(token); } catch { /* The slot was not the balance mapping. */ }
      if (actual === amount) return;
      await rpc("anvil_setStorageAt", [token, slot, old]);
    }
    for (let slot = 0n; slot < 30n; slot++) {
      const key = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [account.address as Address, slot]));
      const old = await rpc("eth_getStorageAt", [token, key, "latest"]);
      await rpc("anvil_setStorageAt", [token, key, toHex(amount, { size: 32 })]);
      if (await balance(token) === amount) return;
      await rpc("anvil_setStorageAt", [token, key, old]);
    }
    throw new Error(`Could not inject isolated fixture funds for ${token}`);
  }
  async function send(transaction: Transaction) {
    assert.equal(transaction.chainId, config.chainId);
    assert.equal(transaction.accountId, "main");
    await rpc("anvil_setBalance", [account.address, toHex(10n ** 30n)]);
    const nativeBefore = BigInt(await rpc("eth_getBalance", [account.address, "latest"]));
    const hash = await rpc("eth_sendTransaction", [{ from: account.address, to: transaction.to, data: transaction.data, value: toHex(BigInt(transaction.valueWei)), gas: "0x989680" }]);
    let receipt: { status: string; gasUsed: string; effectiveGasPrice: string } | null = null;
    for (let i = 0; i < 240 && !receipt; i++) { receipt = await rpc("eth_getTransactionReceipt", [hash]); if (!receipt) await sleep(250); }
    assert(receipt, `Fixture receipt unavailable: ${hash}`);
    if (receipt.status !== "0x1") {
      const trace = await rpc<{ returnValue: string; structLogs: { op: string; pc: number; depth: number; error?: string; stack: string[] }[] }>("debug_traceTransaction", [hash, {}]);
      console.error(JSON.stringify({ transaction, receipt, returnValue: trace.returnValue, trace: trace.structLogs.slice(-6) }));
    }
    assert.equal(receipt.status, "0x1", `Reverted ${transaction.to} ${transaction.data.slice(0, 10)} on ${config.chainId}`);
    const nativeAfter = BigInt(await rpc("eth_getBalance", [account.address, "latest"]));
    const fee = BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice);
    return { hash, nativeBefore, nativeAfter, fee, nativeReceived: nativeAfter - nativeBefore + fee + BigInt(transaction.valueWei) };
  }
  const execute = async (plan: Plan) => { let final: Awaited<ReturnType<typeof send>> | null = null; for (const step of plan.steps) final = await send(step.transaction); return final!; };
  const decodedFinal = (plan: Plan) => decodeFunctionData({ abi, data: plan.steps.at(-1)!.transaction.data });
  async function expectContractRevert(functionName: string, args: readonly unknown[]) {
    await assert.rejects(view(config.pool, functionName, args), /revert/i);
  }
  const quote = async (raw: Record<string, unknown>) => quotePlan(read, account, parseInput({ chainId: config.chainId, ...raw }) as Input);
  try {
    let started = false;
    for (let i = 0; i < 120; i++) {
      try { await rpc("eth_chainId", []); started = true; break; }
      catch { if (child.exitCode !== null) throw new Error(stderr); await sleep(250); }
    }
    assert(started, stderr || "Anvil did not start");
    assert.equal(await rpc("eth_chainId", []), toHex(BigInt(config.chainId)));
    assert.equal(getAddress(CHAINS[config.chainId].pool), config.pool);
    console.log(`Pinned Aave V3 fork: chain ${config.chainId}, block ${config.block}`);
    assert.equal(await rpc("eth_getCode", [account.address, "latest"]), "0x", "Qualification needs a clean EOA fixture without delegated account behavior");
    await rpc("anvil_impersonateAccount", [account.address]);
    await rpc("anvil_setBalance", [account.address, toHex(10n ** 30n)]);
    const [wethAToken, , wethDebt] = await view(config.dataProvider, "getReserveTokensAddresses", [config.weth]) as Address[];
    const [usdcAToken, , usdcDebt] = await view(config.dataProvider, "getReserveTokensAddresses", [config.usdc]) as Address[];
    assert.equal((await accountData())[1], 0n, "Fork fixture account must start without debt");
    console.log("  Funding only the local fixture account");
    await fund(config.usdc, 10_000n * 10n ** 6n);
    await fund(config.weth, 10n * 10n ** 18n);
    console.log("  Loading the complete pinned market (cold fork storage can take several minutes)");
    const startMarket = await readMarket(read, config.chainId, account.address as Address);
    assert(startMarket.reserves.length >= (config.chainId === "1" ? 60 : 20));
    assert.equal(startMarket.reserves.find(reserve => reserve.address.toLowerCase() === config.usdc.toLowerCase())!.decimals, 6);
    console.log(`  Market: ${startMarket.reserves.length} registered reserves; ${startMarket.eModes.length} efficiency modes`);
    await expectContractRevert("borrow", [config.usdc, 100_000_000n, 2n, 0, account.address]);
    await assert.rejects(quote({ kind: "borrow", asset: config.usdc, amount: "100000000" }));

    const supplyNative = await quote({ kind: "supply", asset: config.weth, amount: "1000000000000000000", useNative: true });
    assert.equal(decodedFinal(supplyNative).functionName, "depositETH");
    assert.equal(supplyNative.steps.at(-1)!.transaction.valueWei, "1000000000000000000");
    const suppliedBefore = await balance(wethAToken!);
    await execute(supplyNative);
    const minted = await balance(wethAToken!) - suppliedBefore;
    const liquidityIndex = await view(config.pool, "getReserveNormalizedIncome", [config.weth]) as bigint;
    const rounding = (liquidityIndex + 10n ** 27n - 1n) / 10n ** 27n;
    assert(minted >= 10n ** 18n - rounding, `Minted aWETH ${minted} must match ETH supplied within the index rounding ${rounding}`);
    assert((await accountData())[0]! > 0n);
    console.log("  Native supply: aWETH credited and collateral enabled");

    const borrow = await quote({ kind: "borrow", asset: config.usdc, amount: "100000000" });
    const borrowedBefore = await balance(config.usdc);
    assert.deepEqual(decodedFinal(borrow), { functionName: "borrow", args: [config.usdc, 100_000_000n, 2n, 0, getAddress(account.address)] });
    await execute(borrow);
    assert.equal(await balance(config.usdc) - borrowedBefore, 100_000_000n);
    assert(await balance(usdcDebt!) >= 100_000_000n - 1n);
    assert((await accountData())[5]! > 10n ** 18n);
    await expectContractRevert("setUserUseReserveAsCollateral", [config.weth, false]);
    await expectContractRevert("withdraw", [config.weth, maxUint, account.address]);
    await assert.rejects(quote({ kind: "collateral", asset: config.weth, collateralEnabled: false }));
    await assert.rejects(quote({ kind: "withdraw", asset: config.weth, all: true }));
    console.log("  Variable borrow: wallet credited, debt minted, unsafe collateral disable / withdrawal rejected");

    await send({ chainId: config.chainId, accountId: "main", to: config.usdc, valueWei: "0", data: encodeFunctionData({ abi, functionName: "approve", args: [config.pool, 1n] }) });
    const repay = await quote({ kind: "repay", asset: config.usdc, amount: "20000000" });
    const replacementApprovals = repay.steps.filter(step => step.kind === "approval").map(step => decodeFunctionData({ abi, data: step.transaction.data }));
    assert.deepEqual(replacementApprovals.map(approval => approval.args![1]), [20_000_000n], "Use the exact repayment approval for USDC");
    await execute(repay);
    const partialDebt = await balance(usdcDebt!);
    assert(partialDebt < 81_000_000n && partialDebt >= 80_000_000n - 1n);
    await rpc("evm_increaseTime", [86400]);
    await rpc("evm_mine", []);
    assert(await balance(usdcDebt!) > partialDebt, "Variable debt should grow with interest");
    await send({ chainId: config.chainId, accountId: "main", to: config.usdc, valueWei: "0", data: encodeFunctionData({ abi, functionName: "approve", args: [config.pool, maxUint] }) });
    const tightBudget = await balance(usdcDebt!);
    const tightRepay = await quote({ kind: "repay", asset: config.usdc, all: true, maxPaymentAmount: tightBudget.toString() });
    assert(tightRepay.steps.some(step => step.kind === "approval"), "Repay all must reduce an existing unlimited allowance to the reviewed payment budget");
    for (const step of tightRepay.steps.filter(step => step.kind === "approval")) await send(step.transaction);
    assert.equal(await view(config.usdc, "allowance", [account.address, config.pool]), tightBudget);
    await rpc("evm_increaseTime", [60]);
    await rpc("evm_mine", []);
    assert(await balance(usdcDebt!) > tightBudget);
    await expectContractRevert("repay", [config.usdc, maxUint, 2n, account.address]);
    console.log("  Reviewed repayment budget: oversized allowance reduced; extra interest beyond the cap reverts");
    const repayAll = await quote({ kind: "repay", asset: config.usdc, all: true, maxPaymentAmount: "200000000" });
    assert.equal(decodedFinal(repayAll).functionName, "repay");
    assert.equal(decodedFinal(repayAll).args![1], maxUint);
    assert(repayAll.steps.some(step => step.kind === "approval"), "A renewed payment budget requires a new bounded approval");
    for (const step of repayAll.steps.filter(step => step.kind === "approval")) {
      const approval = decodeFunctionData({ abi, data: step.transaction.data });
      assert.equal(approval.functionName, "approve");
      assert(BigInt(approval.args![1] as bigint) <= 200_000_000n, "Full repayment must retain its reviewed spending budget");
    }
    await rpc("evm_increaseTime", [60]);
    await rpc("evm_mine", []);
    const beforeFullRepay = await balance(config.usdc);
    await execute(repayAll);
    assert.equal(await balance(usdcDebt!), 0n);
    const paid = beforeFullRepay - await balance(config.usdc);
    assert(paid > partialDebt && paid < 200_000_000n);
    console.log(`  Partial and full repayment: ${paid} atomic USDC repaid after interest growth; zero debt remains`);

    await execute(await quote({ kind: "supply", asset: config.usdc, amount: "100000000" }));
    await execute(await quote({ kind: "borrow", asset: config.usdc, amount: "50000000" }));
    const atokensBeforeRepay = await balance(usdcAToken!);
    const repayATokens = await quote({ kind: "repay_atokens", asset: config.usdc, all: true });
    assert.equal(decodedFinal(repayATokens).functionName, "repayWithATokens");
    assert.equal(repayATokens.steps.length, 1, "Repayment with aTokens needs no ERC20 spending approval");
    await execute(repayATokens);
    assert.equal(await balance(usdcDebt!), 0n);
    assert(await balance(usdcAToken!) < atokensBeforeRepay);
    assert(await balance(usdcAToken!) > 49_000_000n);
    const withdrawAll = await quote({ kind: "withdraw", asset: config.usdc, all: true });
    assert.equal(decodedFinal(withdrawAll).args![1], maxUint);
    const beforeWithdraw = await balance(config.usdc);
    await execute(withdrawAll);
    assert.equal(await balance(usdcAToken!), 0n);
    assert(await balance(config.usdc) - beforeWithdraw > 49_000_000n);
    console.log("  Repayment with aTokens and full underlying withdrawal: debt and aToken balance cleared");

    if (config.chainId === "1") {
      const usdt = getAddress("0xdac17f958d2ee523a2206206994597c13d831ec7");
      const [usdtAToken] = await view(config.dataProvider, "getReserveTokensAddresses", [usdt]) as Address[];
      await fund(usdt, 100_000_000n);
      await send({ chainId: config.chainId, accountId: "main", to: usdt, valueWei: "0", data: encodeFunctionData({ abi, functionName: "approve", args: [config.pool, 1n] }) });
      const usdtSupply = await quote({ kind: "supply", asset: usdt, amount: "5000000" });
      const approvals = usdtSupply.steps.filter(step => step.kind === "approval").map(step => decodeFunctionData({ abi, data: step.transaction.data }));
      assert.deepEqual(approvals.map(approval => approval.args![1]), [0n, 5_000_000n], "Mainnet USDT requires zeroing its nonzero allowance before replacement");
      await execute(usdtSupply);
      const usdtIndex = await view(config.pool, "getReserveNormalizedIncome", [usdt]) as bigint;
      const usdtRounding = (usdtIndex + 10n ** 27n - 1n) / 10n ** 27n;
      assert(await balance(usdtAToken!) >= 5_000_000n - usdtRounding, "USDT aToken minting must match the supplied amount within its liquidity-index rounding");
      await execute(await quote({ kind: "withdraw", asset: usdt, all: true }));
      assert.equal(await balance(usdtAToken!), 0n);
      console.log("  Mainnet USDT: reset-then-exact approval, supply and full withdrawal confirmed");
    }

    const beforeToggle = await view(config.pool, "getUserConfiguration", [account.address]);
    await execute(await quote({ kind: "collateral", asset: config.weth, collateralEnabled: false }));
    assert.notDeepEqual(await view(config.pool, "getUserConfiguration", [account.address]), beforeToggle);
    await execute(await quote({ kind: "collateral", asset: config.weth, collateralEnabled: true }));
    assert.deepEqual(await view(config.pool, "getUserConfiguration", [account.address]), beforeToggle);
    await fund(config.wsteth, 3n * 10n ** 18n);
    await execute(await quote({ kind: "supply", asset: config.wsteth, amount: "2000000000000000000" }));
    await execute(await quote({ kind: "emode", eModeId: config.eMode }));
    assert.equal(await view(config.pool, "getUserEMode", [account.address]), BigInt(config.eMode));
    const nativeBorrow = await quote({ kind: "borrow", asset: config.weth, amount: "10000000000000000", useNative: true });
    const delegation = decodeFunctionData({ abi, data: nativeBorrow.steps[0]!.transaction.data });
    assert.equal(delegation.functionName, "approveDelegation");
    assert.equal(delegation.args![1], 10n ** 16n);
    assert.equal(decodedFinal(nativeBorrow).functionName, "borrowETH");
    const nativeBorrowResult = await execute(nativeBorrow);
    assert(await balance(wethDebt!) >= 10n ** 16n - 1n);
    assert.equal(nativeBorrowResult.nativeReceived, 10n ** 16n, `Native borrowing must credit exact ETH; ${JSON.stringify(nativeBorrowResult, (_, value) => typeof value === "bigint" ? value.toString() : value)}`);
    assert((await accountData())[5]! > 10n ** 18n);
    const borrowedMarket = await readMarket(read, config.chainId, account.address as Address);
    const reconstructed = calculatePosition(borrowedMarket.reserves, borrowedMarket.eModes, borrowedMarket.account.eModeId);
    console.log(`  Position reconstruction: ${JSON.stringify({ contract: borrowedMarket.account, reconstructed })}`);
    assert.deepEqual(reconstructed, borrowedMarket.account, "Preview math must reproduce deployed Pool account data at the same block");
    const nativeRepay = await quote({ kind: "repay", asset: config.weth, all: true, useNative: true, maxPaymentAmount: "20000000000000000" });
    assert.equal(decodedFinal(nativeRepay).functionName, "repayETH");
    assert.equal(nativeRepay.steps.at(-1)!.transaction.valueWei, "20000000000000000");
    await rpc("evm_increaseTime", [60]);
    await rpc("evm_mine", []);
    await execute(nativeRepay);
    assert.equal(await balance(wethDebt!), 0n);
    await execute(await quote({ kind: "emode", eModeId: 0 }));
    assert.equal(await view(config.pool, "getUserEMode", [account.address]), 0n);
    console.log("  Efficiency mode, native borrow delegation and full ETH repayment: deployed gateway calls confirmed");

    const nativeWithdraw = await quote({ kind: "withdraw", asset: config.weth, amount: "100000000000000000", useNative: true });
    assert.equal(decodedFinal(nativeWithdraw).functionName, "withdrawETH");
    const beforeNativeWithdraw = await balance(wethAToken!);
    const nativeWithdrawResult = await execute(nativeWithdraw);
    assert(await balance(wethAToken!) < beforeNativeWithdraw - 99_000_000_000_000_000n);
    assert.equal(nativeWithdrawResult.nativeReceived, 10n ** 17n, "Native withdrawal must credit exact ETH after accounting for gas");
    await send({ chainId: config.chainId, accountId: "main", to: wethAToken!, valueWei: "0", data: encodeFunctionData({ abi, functionName: "approve", args: [CHAINS[config.chainId].gateway, maxUint] }) });
    const nativeWithdrawAll = await quote({ kind: "withdraw", asset: config.weth, all: true, useNative: true, maxPaymentAmount: "2000000000000000000" });
    assert.equal(decodedFinal(nativeWithdrawAll).args![1], maxUint);
    assert.equal(decodeFunctionData({ abi, data: nativeWithdrawAll.steps[0]!.transaction.data }).args![1], 2n * 10n ** 18n, "Full native withdrawal must reduce unlimited gateway allowance to the reviewed maximum");
    await execute(nativeWithdrawAll);
    assert.equal(await balance(wethAToken!), 0n);
    console.log("  Partial and full native withdrawal: aWETH burned through deployed gateway");

    const rewardMarket = await readMarket(read, config.chainId, account.address as Address);
    if (rewardMarket.rewards.some(reward => BigInt(reward.amount) > 0n)) {
      const rewardPlan = await quote({ kind: "rewards" });
      assert.equal(decodedFinal(rewardPlan).functionName, "claimAllRewards");
      const rewardsBefore = await Promise.all(rewardMarket.rewards.map(reward => balance(reward.address)));
      await execute(rewardPlan);
      let increased = false;
      for (let i = 0; i < rewardMarket.rewards.length; i++) if (await balance(rewardMarket.rewards[i]!.address) > rewardsBefore[i]!) increased = true;
      assert(increased, "A successful accrued-reward claim should credit the wallet");
      console.log("  Accrued incentive rewards: wallet credited");
    } else console.log("  Reward limitation: pinned market has no positive rewards accrued for this fixture account");
    await execute(await quote({ kind: "withdraw", asset: config.wsteth, all: true }));
    assert.equal((await accountData())[1], 0n);
    console.log(`PASS ${config.chainId}: app-generated plans on deployed Aave contracts, local fixture funds only`);
  } finally {
    child.kill("SIGTERM");
    await new Promise<void>(resolve => { if (child.exitCode !== null) resolve(); else child.once("exit", () => resolve()); });
  }
}
