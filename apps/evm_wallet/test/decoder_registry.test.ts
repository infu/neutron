import { expect, test } from "bun:test";
import { encodeFunctionData, getAddress, parseAbi, type Address, type Hex } from "viem";
import type { Asset, Network, Operation } from "../src/data.ts";
import { presentOperation } from "../src/presentation.ts";
import { parseDecoderPack, type DecoderPack } from "../src/decoders/descriptor.ts";
import { decodeBuiltin, decodeImported, presentationTokens, type ActiveDecoderPack } from "../src/decoders/registry.ts";

const vault: Address = "0x1111111111111111111111111111111111111111";
const token: Address = "0xabababababababababababababababababababab";
const receiver: Address = "0x3333333333333333333333333333333333333333";
const owner: Address = "0x4444444444444444444444444444444444444444";
const aavePool: Address = "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2";
const network: Network = { chainId: "1", name: "Ethereum", nativeSymbol: "ETH", explorerUrl: "https://etherscan.io", testnet: false, finalityDescription: "" };
const asset: Asset = { chainId: "1", address: token, decimals: 6, symbol: "USDV" };
const vaultAbi = parseAbi(["function stakeFor(address asset,uint256 amount,address recipient)"]);
const stakeData = encodeFunctionData({ abi: vaultAbi, functionName: "stakeFor", args: [token, 1234567n, receiver] });

function pack(id = "future-vault"): ActiveDecoderPack {
  return { sha256: "ab".repeat(32), pack: parseDecoderPack({
    format: 1, id, version: "2", name: id === "future-vault" ? "Future vault" : "Alternative vault", description: "Deposit into this vault.",
    source: "https://example.test/vault-decoder.json", deployments: [{ chainId: "1", address: vault }],
    functions: [{ signature: "stakeFor(address asset,uint256 amount,address recipient)", title: "Stake in future vault", value: "zero", fields: [
      { path: "args.1", label: "Stake", format: "tokenAmount", tokenPath: "args.0", role: "amount" },
      { path: "args.2", label: "Recipient", format: "address", role: "party" },
    ] }],
  }) };
}
function operation(data: Hex = stakeData, to: Address = vault, chainId = "1"): Operation {
  return {
    id: "historical-before-decoder-import", kind: "transaction", chainId, address: owner,
    status: "finalized", summary: "Unhelpful app-supplied summary", caller: { appId: "unrelated", installationUid: "old-installation", endpoint: "service" },
    intent: { transaction: { to, value: "0", data } }, preparedTransaction: null,
  } as unknown as Operation;
}
function rewritten(original: ActiveDecoderPack, overrides: Partial<DecoderPack>): ActiveDecoderPack {
  return { ...original, pack: parseDecoderPack({ ...original.pack, ...overrides }) };
}

test("an imported protocol retrospectively explains saved exact calldata with its provenance", () => {
  const op = operation(), before = JSON.stringify(op), imported = pack();
  expect(presentOperation(op, [asset], network).title).toBe("Contract interaction");
  const shown = presentOperation(op, [asset], network, [imported]);
  expect(shown).toMatchObject({ title: "Stake in future vault", amount: "1.234567 USDV", amountAtoms: "1234567", contract: vault });
  expect(shown.decoder).toEqual({ id: "future-vault", name: "Future vault", version: "2", kind: "imported", sha256: imported.sha256, source: "https://example.test/vault-decoder.json" });
  expect(shown.parties).toEqual([{ label: "Recipient", value: receiver }]);
  expect(presentationTokens(shown)).toEqual([token]);
  expect(JSON.stringify(op)).toBe(before);
});

test("ordinary ERC20 approval and transfer meanings take precedence over custom labels", () => {
  const erc20 = parseAbi(["function approve(address spender,uint256 amount)", "function transfer(address recipient,uint256 amount)"]);
  for (const functionName of ["approve", "transfer"] as const) {
    const original = pack();
    const override = rewritten(original, { deployments: [{ chainId: "1", address: token }], functions: [{
      signature: `${functionName}(address,uint256)`, title: "Free gift with no spending", value: "zero", fields: [],
    }] });
    const op = operation(encodeFunctionData({ abi: erc20, functionName, args: [receiver, 1234567n] }), token);
    const shown = presentOperation(op, [asset], network, [override]);
    expect(shown.title).toBe(functionName === "approve" ? "Approve USDV" : "Send USDV");
    expect(shown.amount).toBe("1.234567 USDV");
    expect(shown.decoder).toBeUndefined();
    expect(shown.amountAtoms).toBe("1234567");
    expect(shown.parties[0]).toEqual({ label: functionName === "approve" ? "Spender" : "Recipient", value: receiver });
  }
});

test("built-in protocol review wins over imported definitions for the same contract and selector", () => {
  const abi = parseAbi(["function supply(address,uint256,address,uint16)"]);
  const op = operation(encodeFunctionData({ abi, functionName: "supply", args: [token, 1234567n, receiver, 0] }), aavePool);
  const imported = rewritten(pack(), { deployments: [{ chainId: "1", address: aavePool }], functions: [{
    signature: "supply(address,uint256,address,uint16)", title: "Claim free tokens", value: "zero", fields: [],
  }] });
  const shown = presentOperation(op, [asset], network, [imported]);
  expect(shown.title).toBe("Supply to Aave");
  expect(shown.amount).toBe("1.234567 USDV");
  expect(shown.decoder).toEqual({ id: "aave-v3", name: "Aave V3", version: "1", kind: "built-in" });
  expect(decodeBuiltin(op, [asset])?.decoder?.id).toBe("aave-v3");
});

test("multiple matching imported packs produce an explicit generic fallback independent of order", () => {
  const first = pack(), second = pack("alternative-vault"), op = operation();
  for (const active of [[first, second], [second, first]]) {
    const decoded = decodeImported(op, [asset], network, active);
    expect(decoded.presentation).toBeNull();
    expect(decoded.warning).toContain("Future vault");
    expect(decoded.warning).toContain("Alternative vault");
    const shown = presentOperation(op, [asset], network, active);
    expect(shown.title).toBe("Contract interaction");
    expect(shown.contract).toBe(vault);
    expect(shown.amount).toBeNull();
    expect(shown.decoder).toBeUndefined();
    expect(shown.decoderWarning).toContain("Multiple enabled decoder packs match");
    expect(presentationTokens(shown)).toEqual([]);
  }
});

test("only a full deployment and calldata match participates in ambiguity or token discovery", () => {
  const valid = pack();
  const unrelated = rewritten(pack("alternative-vault"), { deployments: [{ chainId: "42161", address: vault }] });
  expect(presentOperation(operation(), [asset], network, [valid, unrelated]).decoder?.id).toBe("future-vault");
  for (const op of [operation(stakeData, receiver), operation(stakeData, vault, "42161"), operation(`${stakeData}00`)]) {
    expect(decodeImported(op, [asset], network, [valid]).presentation).toBeNull();
    expect(presentationTokens(presentOperation(op, [asset], network, [valid]))).toEqual([]);
  }
});

test("one malformed imported definition does not hide an independent valid definition", () => {
  const malformed = { sha256: "cd".repeat(32), pack: { format: 9 } as unknown as DecoderPack };
  const shown = presentOperation(operation(), [asset], network, [malformed, pack()]);
  expect(shown.title).toBe("Stake in future vault");
  expect(shown.decoderWarning).toBeUndefined();
});

test("token discovery excludes addresses which are only recipients and contract parties", () => {
  const shown = presentOperation(operation(), [asset], network, [pack()]);
  expect(presentationTokens(shown)).toEqual([token]);
  expect(presentationTokens(shown)).not.toContain(receiver);
  expect(presentationTokens(shown)).not.toContain(vault);
  const duplicate = { ...shown, tokenAddresses: [getAddress(token), token, "invalid"], tokenAddress: token.toUpperCase().replace("0X", "0x") };
  expect(presentationTokens(duplicate)).toEqual([token]);
});

test("native transfers and signing activity remain usable with imported packs present", () => {
  const native = operation("0x", receiver); native.intent.transaction!.value = "1234567890123456789";
  expect(presentOperation(native, [], network, [pack()])).toMatchObject({ title: "Send ETH", amount: "1.234567890123456789 ETH", contract: null, tokenAddress: null });
  const signedMessage = { ...operation(), kind: "message", intent: { messageHex: "0x6869" } } as Operation;
  expect(presentOperation(signedMessage, [], network, [pack()])).toMatchObject({ title: "Sign message", amount: null });
});
