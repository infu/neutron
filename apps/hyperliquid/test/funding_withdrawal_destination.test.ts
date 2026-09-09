import { expect, test } from "bun:test";
import { concatHex, encodeAbiParameters, encodeEventTopics, numberToHex, parseAbi, type Hex } from "viem";
import {
  evidenceAddressWord, verifyWithdrawalDestinationReceipt, withdrawalDestinationMintFilter,
  withdrawalDestinationMintHashes, withdrawalHook, type WithdrawalDestinationEvidenceIntent,
} from "../src/funding_evidence.ts";

const address = (digit: string) => `0x${digit.repeat(40)}` as Hex;
const owner = address("1"), other = address("2"), transmitter = address("3"), messenger = address("4");
const usdc = address("5"), core = address("6"), burnToken = address("7"), zero = address("0");
const hash = `0x${"ab".repeat(32)}` as Hex, otherHash = `0x${"cd".repeat(32)}` as Hex, cctpNonce = `0x${"ef".repeat(32)}` as Hex;
const blockHash = `0x${"12".repeat(32)}` as Hex, coreNonce = 1788967537057;
const input: WithdrawalDestinationEvidenceIntent = {
  messageTransmitter: transmitter, tokenMessenger: messenger, usdc, burnToken, coreDepositWallet: core,
  owner, recipient: owner, nonce: coreNonce, amountAtoms: "10000000", transactionHash: hash,
};
const word = (n: number | bigint, bytes = 32) => numberToHex(n, { size: bytes });
type Body = {
  version: number; burnToken: string; recipient: string; amount: bigint; sender: string;
  maxFee: bigint; fee: bigint; expiration: bigint; hook: Hex;
};
function body(changes: Partial<Body> = {}): Hex {
  const v: Body = {
    version: 1, burnToken, recipient: owner, amount: 10000000n, sender: core,
    maxFee: 1200000n, fee: 1200000n, expiration: 0n, hook: withdrawalHook(owner, coreNonce), ...changes,
  };
  return concatHex([
    word(v.version, 4), evidenceAddressWord(v.burnToken), evidenceAddressWord(v.recipient), word(v.amount),
    evidenceAddressWord(v.sender), word(v.maxFee), word(v.fee), word(v.expiration), v.hook,
  ]);
}
function log(signature: string, indexed: Record<string, unknown>, types: string[], values: unknown[], contract: string) {
  return {
    address: contract, topics: encodeEventTopics({ abi: parseAbi([signature]), args: indexed } as never),
    data: encodeAbiParameters(types.map(type => ({ type })), values as never), transactionHash: hash,
    blockNumber: "0x18bd25d", blockHash, logIndex: "0x0", removed: false,
  };
}
function received(changes: { body?: Hex; sourceDomain?: number; sender?: string; finality?: number; nonce?: Hex; contract?: string } = {}) {
  return log(
    "event MessageReceived(address indexed caller, uint32 sourceDomain, bytes32 indexed nonce, bytes32 sender, uint32 indexed finalityThresholdExecuted, bytes messageBody)",
    { caller: other, nonce: changes.nonce ?? cctpNonce, finalityThresholdExecuted: changes.finality ?? 2000 },
    ["uint32", "bytes32", "bytes"], [changes.sourceDomain ?? 19, evidenceAddressWord(changes.sender ?? messenger), changes.body ?? body()], changes.contract ?? transmitter,
  );
}
function mint(amount = 8800000n, to = owner, from = zero, contract = usdc) {
  return { ...log("event Transfer(address indexed from, address indexed to, uint256 value)", { from, to }, ["uint256"], [amount], contract), logIndex: "0x1" };
}
function receipt(logs: unknown[] = [received(), mint()]) {
  return { status: "0x1", transactionHash: hash, blockNumber: "0x18bd25d", blockHash, logs };
}

test("destination receipt proves the exact signed withdrawal without inventing a source hash", () => {
  const proof = verifyWithdrawalDestinationReceipt(receipt(), input);
  expect(proof).toEqual({
    transactionHash: hash, blockNumber: "25940573", deliveredAtoms: "8800000", nonce: cctpNonce, finality: "included",
    proofKind: "cctp_withdrawal_destination_receipt", sourceDomain: 19,
    amountAtoms: "10000000", maxFeeAtoms: "1200000", feeExecutedAtoms: "1200000", coreNonce: String(coreNonce),
  });
  expect(proof).not.toHaveProperty("sourceTransactionHash");
  expect(proof).not.toHaveProperty("destinationCaller");
  expect(proof).not.toHaveProperty("minFinalityThreshold");
});

test("destination proof binds all signed owner/nonce and configured contract identities", () => {
  for (const change of [
    { owner: other }, { recipient: other }, { nonce: coreNonce + 1 }, { amountAtoms: "9999999" },
    { messageTransmitter: other }, { tokenMessenger: other }, { usdc: other }, { burnToken: other },
    { coreDepositWallet: other }, { transactionHash: otherHash },
  ]) expect(verifyWithdrawalDestinationReceipt(receipt(), { ...input, ...change })).toBeNull();
  for (const change of [
    { version: 0 }, { burnToken: other }, { recipient: other }, { amount: 10000001n }, { sender: owner },
    { hook: withdrawalHook(other, coreNonce) }, { hook: withdrawalHook(owner, coreNonce + 1) },
    { hook: concatHex([withdrawalHook(owner, coreNonce), "0x00"]) },
  ]) expect(verifyWithdrawalDestinationReceipt(receipt([received({ body: body(change) }), mint()]), input)).toBeNull();
});

test("authenticated source domain, messenger, finality and exact body are required", () => {
  for (const change of [
    { sourceDomain: 0 }, { sourceDomain: 3 }, { sender: core }, { finality: 1999 },
    { contract: other }, { body: "0x" as Hex }, { body: "0x00000001" as Hex },
  ]) expect(verifyWithdrawalDestinationReceipt(receipt([received(change), mint()]), input)).toBeNull();
  expect(verifyWithdrawalDestinationReceipt(receipt([received({ finality: 3000 }), mint()]), input)).not.toBeNull();
  expect(verifyWithdrawalDestinationReceipt(receipt([mint()]), input)).toBeNull();
});

test("mint must be exact authenticated net USDC, with valid contract fee bounds", () => {
  for (const change of [
    { fee: 1200001n }, { fee: 10000000n, maxFee: 10000000n }, { fee: 0n, maxFee: 10000000n },
  ]) expect(verifyWithdrawalDestinationReceipt(receipt([received({ body: body(change) }), mint(10000000n - change.fee)]), input)).toBeNull();
  for (const wrongMint of [mint(10000000n), mint(8799999n), mint(8800000n, other), mint(8800000n, owner, other), mint(8800000n, owner, zero, other)]) {
    expect(verifyWithdrawalDestinationReceipt(receipt([received(), wrongMint]), input)).toBeNull();
  }
  expect(verifyWithdrawalDestinationReceipt(receipt([received()]), input)).toBeNull();
  // An executed fee can be below the source cap; the saved quote is not proof.
  expect(verifyWithdrawalDestinationReceipt(receipt([received({ body: body({ fee: 200000n }) }), mint(9800000n)]), input)?.deliveredAtoms).toBe("9800000");
  expect(verifyWithdrawalDestinationReceipt(receipt([received({ body: body({ fee: 0n, maxFee: 0n }) }), mint(10000000n)]), input)?.deliveredAtoms).toBe("10000000");
});

test("included receipt and every attached log must refer to the same transaction and block", () => {
  for (const change of [{ status: "0x0" }, { transactionHash: otherHash }, { blockNumber: null }, { blockNumber: "nonsense" }]) {
    expect(verifyWithdrawalDestinationReceipt({ ...receipt(), ...change }, input)).toBeNull();
  }
  for (const change of [{ transactionHash: otherHash }, { removed: true }, { blockNumber: "0x1" }, { blockHash: otherHash }]) {
    expect(verifyWithdrawalDestinationReceipt(receipt([{ ...received(), ...change }, mint()]), input)).toBeNull();
    expect(verifyWithdrawalDestinationReceipt(receipt([received(), { ...mint(), ...change }]), input)).toBeNull();
  }
  expect(verifyWithdrawalDestinationReceipt(null, input)).toBeNull();
  expect(verifyWithdrawalDestinationReceipt({ ...receipt(), logs: null }, input)).toBeNull();
});

test("duplicate views of one message are stable but distinct matching messages are ambiguous", () => {
  expect(verifyWithdrawalDestinationReceipt(receipt([received(), received(), mint()]), input)).not.toBeNull();
  expect(() => verifyWithdrawalDestinationReceipt(receipt([received(), received({ nonce: otherHash }), mint()]), input)).toThrow("Ambiguous");
  expect(() => verifyWithdrawalDestinationReceipt(receipt([
    received(), received({ body: body({ maxFee: 1300000n }) }), mint(),
  ]), input)).toThrow("Ambiguous");
  expect(() => verifyWithdrawalDestinationReceipt(receipt([
    received(), received({ body: body({ expiration: 99999999n }) }), mint(),
  ]), input)).toThrow("Ambiguous");
});

test("discovery finds bounded native-USDC mint candidates without treating amounts as linkage", () => {
  const filter = withdrawalDestinationMintFilter({ usdc, recipient: owner, fromBlock: "123", toBlock: "0x100" });
  expect(filter).toEqual({ address: usdc, fromBlock: "0x7b", toBlock: "0x100", topics: mint().topics });
  expect(withdrawalDestinationMintFilter({ usdc, recipient: owner, fromBlock: "123" }).toBlock).toBe("latest");
  const candidates = [mint(1n), mint(9800000n), mint(10000000n), mint(0n), mint(10000001n), mint(8800000n, other), mint(8800000n, owner, other), mint(8800000n, owner, zero, other)];
  expect(withdrawalDestinationMintHashes(candidates, input)).toEqual([hash]);
  expect(verifyWithdrawalDestinationReceipt(receipt(candidates), input)).toBeNull();
  expect(withdrawalDestinationMintHashes([{ ...mint(), removed: true }, { ...mint(), transactionHash: "0x12" }], input)).toEqual([]);
  expect(withdrawalDestinationMintHashes([mint(), { ...mint(), transactionHash: otherHash }], input)).toEqual([hash, otherHash]);
  expect(() => withdrawalDestinationMintHashes(null, input)).toThrow("log response");
});

test("proof preserves quantities beyond JavaScript safe integers", () => {
  const amount = 90071992547409930000n, fee = 123n;
  const proof = verifyWithdrawalDestinationReceipt(receipt([received({ body: body({ amount, fee, maxFee: 1000n }) }), mint(amount - fee)]), { ...input, amountAtoms: amount.toString() });
  expect(proof?.amountAtoms).toBe(amount.toString());
  expect(proof?.deliveredAtoms).toBe((amount - fee).toString());
});
