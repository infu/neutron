import { expect, test } from "bun:test";
import { encodeFunctionData, getAddress, parseAbi, type Address, type Hex } from "viem";
import type { Operation } from "../src/data.ts";
import { presentOperation } from "../src/presentation.ts";
import { agentProviderReview } from "../src/provider.ts";

const owner = "0x1111111111111111111111111111111111111111";
const beneficiary = "0x2222222222222222222222222222222222222222";
const key = "0x3333333333333333333333333333333333333333";
const zero = "0x0000000000000000000000000000000000000000";
const messenger = "0x28b5a0e9c621a5badaa536219b3a228c8168cf5d";
const forwarder = "0xb21d281dedb17ae5b501f6aa8256fe38c4e45757";
const usdc = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const arbUsdc = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const domain = [
  { name: "name", type: "string" }, { name: "version", type: "string" },
  { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" },
];
function authorization(withdraw = false) {
  const primaryType = `HyperliquidTransaction:${withdraw ? "SendToEvmWithData" : "ApproveAgent"}`;
  return {
    domain: { name: "HyperliquidSignTransaction", version: "1", chainId: 42161, verifyingContract: zero }, primaryType,
    types: { EIP712Domain: structuredClone(domain), [primaryType]: withdraw ? [
      { name: "hyperliquidChain", type: "string" }, { name: "token", type: "string" }, { name: "amount", type: "string" },
      { name: "sourceDex", type: "string" }, { name: "destinationRecipient", type: "string" }, { name: "addressEncoding", type: "string" },
      { name: "destinationChainId", type: "uint32" }, { name: "gasLimit", type: "uint64" }, { name: "data", type: "bytes" }, { name: "nonce", type: "uint64" },
    ] : [
      { name: "hyperliquidChain", type: "string" }, { name: "agentAddress", type: "address" }, { name: "agentName", type: "string" }, { name: "nonce", type: "uint64" },
    ] },
    message: (withdraw ? {
      hyperliquidChain: "Mainnet", token: "USDC", amount: "125.012345", sourceDex: "", destinationRecipient: beneficiary,
      addressEncoding: "hex", destinationChainId: 0, gasLimit: "200000", data: "0x", nonce: "1800000000000",
    } : { hyperliquidChain: "Mainnet", agentAddress: key, agentName: "Neutron", nonce: "1800000000000" }) as Record<string, unknown>,
  };
}
function signing(data = authorization()): Operation {
  return { kind: "typed_data", chainId: "42161", address: owner, caller: { appId: "unrelated", installationUid: "requester", endpoint: "background" }, intent: { typedDataJson: JSON.stringify(data) } } as Operation;
}
const value = (shown: ReturnType<typeof presentOperation>, label: string) => [...shown.parties, ...(shown.advancedDetails ?? [])].find(entry => entry.label === label)?.value;

test("Hyperliquid authorization shows the exact delegated key, name, account, environment and nonce", () => {
  const op = signing(), before = JSON.stringify(op), shown = presentOperation(op);
  expect(shown.title).toBe("Authorize Hyperliquid trading key");
  expect(shown.decoder?.id).toBe("hyperliquid-authorization");
  expect(value(shown, "Account")).toBe(owner);
  expect(value(shown, "Trading key")).toBe(key);
  expect(value(shown, "Key name")).toBe("Neutron");
  expect(value(shown, "Network")).toBe("Hyperliquid Mainnet");
  expect(value(shown, "Nonce (milliseconds)")).toBe("1800000000000");
  expect(shown.description).toContain("cannot withdraw to an external address");
  expect(shown.description).toContain("lose your collateral");
  expect(shown.amount).toBeNull();
  expect(JSON.stringify(op)).toBe(before);
  const testnet = authorization(); testnet.message.hyperliquidChain = "Testnet"; testnet.message.agentName = "";
  expect(value(presentOperation(signing(testnet)), "Network")).toBe("Hyperliquid Testnet");
  expect(value(presentOperation(signing(testnet)), "Key name")).toBe("Unnamed");
  const revoke = authorization(); revoke.message.agentAddress = zero;
  expect(presentOperation(signing(revoke)).title).toBe("Revoke Hyperliquid trading key");
  expect(presentOperation(signing(revoke)).description).toContain("Existing orders and positions remain open");
});

test("withdrawal distinguishes CCTP domain IDs from EVM chain IDs and identifies exact native USDC destination", () => {
  const data = authorization(true), shown = presentOperation(signing(data));
  expect(shown).toMatchObject({ title: "Withdraw Hyperliquid USDC to Ethereum", amount: "125.012345 USDC", amountAtoms: "125012345", amountDecimals: 6 });
  expect(value(shown, "Recipient")).toBe(beneficiary);
  expect(value(shown, "Source balance")).toBe("Perpetuals");
  expect(value(shown, "Destination network")).toBe("Ethereum mainnet");
  expect(value(shown, "CCTP destination domain")).toBe("0 (Ethereum)");
  expect(value(shown, "Destination gas limit")).toBe("200000");
  expect(shown.description).toContain("reduced by protocol and forwarding fees");
  data.message.destinationChainId = 3; data.message.sourceDex = "spot";
  expect(presentOperation(signing(data)).title).toBe("Withdraw Hyperliquid USDC to Arbitrum");
  expect(value(presentOperation(signing(data)), "Source balance")).toBe("Spot / unified collateral");
  data.message.hyperliquidChain = "Testnet";
  expect(value(presentOperation(signing(data)), "Destination network")).toBe("Arbitrum testnet (Sepolia)");
});

test("a changed signing domain, schema, selected chain or unsigned message field retains generic review", () => {
  const changes: ((data: ReturnType<typeof authorization>) => void)[] = [
    data => { data.domain.name = "Other"; }, data => { data.domain.version = "2"; },
    data => { data.domain.chainId = 1; }, data => { data.domain.verifyingContract = key; },
    data => { data.types.EIP712Domain.reverse(); }, data => { data.types[data.primaryType]![0]!.type = "bytes"; },
    data => { data.types[data.primaryType]!.reverse(); }, data => { data.types[data.primaryType]!.push({ name: "amount", type: "uint256" }); data.message.amount = "1"; },
    data => { data.message.type = "approveAgent"; }, data => { data.message.signatureChainId = "0xa4b1"; },
    data => { data.message.nonce = 9007199254740992; }, data => { data.message.nonce = "18446744073709551616"; },
    data => { data.message.nonce = -1; }, data => { data.message.agentAddress = "0x1234"; }, data => { data.message.agentName = 123; },
    data => { data.message.hyperliquidChain = "mainnet"; },
  ];
  for (const change of changes) {
    const data = authorization(); change(data);
    expect(presentOperation(signing(data)).title).toBe("Sign typed data");
    expect(presentOperation(signing(data)).decoder).toBeUndefined();
  }
  const op = signing(); op.chainId = "1";
  expect(presentOperation(op).title).toBe("Sign typed data");
});

test("withdrawal never mislabels changed asset, recipient encoding, fractional amount or custom hook", () => {
  const changes: Record<string, unknown>[] = [
    { token: "USDT" }, { destinationChainId: 1 }, { destinationChainId: 42161 }, { destinationRecipient: "0x1234" },
    { addressEncoding: "base58" }, { data: "0x1234" }, { amount: "1e6" }, { amount: "0.0000001" },
    { amount: "-1" }, { amount: 10 }, { gasLimit: "18446744073709551616" }, { sourceDex: "other" }, { sourceDex: [] },
  ];
  for (const change of changes) {
    const data = authorization(true); Object.assign(data.message, change);
    expect(presentOperation(signing(data)).title).toBe("Sign typed data");
  }
});

const depositAbi = parseAbi(["function depositForBurnWithHook(uint256,uint32,bytes32,address,bytes32,uint256,uint32,bytes)"]);
const paddedForwarder = `0x${forwarder.slice(2).padStart(64, "0")}` as Hex;
// Independent explicit fixture: bytes24 prefix, version0, length24, beneficiary20, perp DEX0.
const hook = `0x636374702d666f72776172640000000000000000000000000000000000000018${beneficiary.slice(2)}00000000` as Hex;
type DepositArgs = readonly [bigint, number, Hex, Address, Hex, bigint, number, Hex];
function deposit(args: DepositArgs = [125012345n, 19, paddedForwarder, usdc, paddedForwarder, 250001n, 1000, hook], chainId = "1", to = messenger): Operation {
  return { kind: "transaction", chainId, address: owner, caller: { appId: "unrelated", installationUid: "requester", endpoint: "background" }, intent: { transaction: { to, value: "0", data: encodeFunctionData({ abi: depositAbi, functionName: "depositForBurnWithHook", args }) } } } as Operation;
}
const depositArgs = (): [...DepositArgs] => [125012345n, 19, paddedForwarder, usdc, paddedForwarder, 250001n, 1000, hook];

test("CCTP deposit names the HyperCore beneficiary, exact fee ceiling and destination balance from calldata", () => {
  const shown = presentOperation(deposit());
  expect(shown).toMatchObject({ title: "Deposit USDC to Hyperliquid", amount: "125.012345 USDC", amountAtoms: "125012345", amountDecimals: 6, tokenAddress: usdc, contract: messenger });
  expect(value(shown, "HyperCore beneficiary")).toBe(beneficiary);
  expect(value(shown, "Mint recipient")).toBe(getAddress(forwarder));
  expect(value(shown, "Destination caller")).toBe(getAddress(forwarder));
  expect(value(shown, "Maximum CCTP fee")).toBe("0.250001 USDC");
  expect(value(shown, "Destination balance")).toBe("Hyperliquid mainnet perpetuals");
  expect(value(shown, "Minimum finality")).toBe("Fast (1000)");
  const args = depositArgs(); args[3] = arbUsdc; args[6] = 2000;
  expect(value(presentOperation(deposit(args, "42161")), "Source network")).toBe("Arbitrum mainnet");
  expect(value(presentOperation(deposit(args, "42161")), "Minimum finality")).toBe("Standard (2000)");
});

test("CCTP identity requires the chain, contract, burn token, both forwarder fields, full canonical calldata and exact perp hook", () => {
  const changes: ((args: [...DepositArgs]) => void)[] = [
    args => { args[1] = 0; }, args => { args[2] = `0x${key.slice(2).padStart(64, "0")}`; },
    args => { args[4] = `0x${zero.slice(2).padStart(64, "0")}`; }, args => { args[3] = arbUsdc; },
    args => { args[6] = 999; }, args => { args[7] = `${hook}00`; }, args => { args[7] = `${hook.slice(0, -8)}ffffffff` as Hex; },
    args => { args[7] = `0x00${hook.slice(4)}`; }, args => { args[7] = `${hook.slice(0, 50)}00000001${hook.slice(58)}` as Hex; },
    args => { args[7] = `${hook.slice(0, 58)}00000000${hook.slice(66)}` as Hex; },
  ];
  for (const change of changes) {
    const args = depositArgs(); change(args);
    expect(presentOperation(deposit(args)).title).toBe("Contract interaction");
  }
  const trailing = deposit(); trailing.intent.transaction!.data += "00";
  const nativePayment = deposit(); nativePayment.intent.transaction!.value = "1";
  for (const op of [trailing, nativePayment, deposit(depositArgs(), "11155111"), deposit(depositArgs(), "1", key)]) {
    expect(presentOperation(op).decoder).toBeUndefined();
  }
});

test("Agent receives the same signed-action interpretation and the complete typed data as the owner", () => {
  for (const op of [signing(), signing(authorization(true))]) {
    Object.assign(op, { requestId: "ab".repeat(16), accountId: "main", operationId: "hl-review", status: "prepared", reviewRevision: "1", tokenEvidence: null, message: null });
    const review = agentProviderReview({
      kind: "typed_data", operation: op,
      request: { requestId: op.requestId, accountId: "main", chainId: op.chainId, typedDataJson: op.intent.typedDataJson! },
      identity: { caller: { app_id: op.caller.appId, installation_uid: op.caller.installationUid, endpoint: op.caller.endpoint } },
    });
    const shown = presentOperation(op);
    expect(review.summary).toMatchObject({ title: shown.title, amount: shown.amount, description: shown.description, parties: shown.parties, advancedDetails: shown.advancedDetails });
    expect((review.summary as Record<string, unknown>).recognition).toContain("exact signing domain");
    expect(review.typedDataJson).toBe(op.intent.typedDataJson);
  }
});
