import { expect, test } from "bun:test";
import { concatHex, encodeAbiParameters, encodeEventTopics, numberToHex, parseAbi, stringToHex, type Hex } from "viem";
import {
  decodeCctpMessage, destinationMintFilter, destinationMintHashes, evidenceAddressWord, findWithdrawalBurn, observedCoreCredits,
  selectCctpMessage, verifyCoreForwardReceipt, verifyDestinationReceipt, withdrawalBurnFilter, withdrawalHook,
  type CctpEvidenceIntent, type MatchedCctpMessage,
} from "../src/funding_evidence.ts";

const addr = (digit: string) => `0x${digit.repeat(40)}` as Hex;
const owner = addr("1"), other = addr("2"), transmitter = addr("3"), messenger = addr("4"), token = addr("5"), core = addr("6"), forwarder = addr("7"), zero = addr("0");
const sourceHash = `0x${"ab".repeat(32)}` as Hex, destinationHash = `0x${"cd".repeat(32)}` as Hex, cctpNonce = `0x${"ef".repeat(32)}` as Hex;
const nonce = 1788819000000;
const number = (value: number | bigint, size: number) => numberToHex(value, { size });
const w = evidenceAddressWord;
const expectation = (changes: Partial<CctpEvidenceIntent> = {}): CctpEvidenceIntent => ({
  sourceTxHash: sourceHash, sourceDomain: 19, destinationDomain: 0, sender: messenger, recipient: messenger,
  destinationCaller: zero, burnToken: token, mintRecipient: owner, messageSender: core,
  amountAtoms: "100000000", maxFeeAtoms: "200000", minFinalityThreshold: 1000, hookData: withdrawalHook(owner, nonce), ...changes,
});
function wire(expected = expectation(), overrides: { fee?: bigint; nonce?: Hex } = {}): Hex {
  return concatHex([
    number(1, 4), number(expected.sourceDomain, 4), number(expected.destinationDomain, 4), overrides.nonce ?? cctpNonce,
    w(expected.sender), w(expected.recipient), w(expected.destinationCaller), number(expected.minFinalityThreshold ?? 1000, 4), number(1000, 4),
    number(1, 4), w(expected.burnToken), w(expected.mintRecipient), number(BigInt(expected.amountAtoms), 32), w(expected.messageSender),
    number(BigInt(expected.maxFeeAtoms ?? "200000"), 32), number(overrides.fee ?? 200000n, 32), number(12345678, 32), expected.hookData as Hex,
  ]);
}
function circle(message = wire()) {
  return { sourceTxHash: sourceHash, messages: [{ message, cctpVersion: 2, status: "complete", attestation: `0x${"11".repeat(65)}`, forwardState: "COMPLETED", forwardTxHash: destinationHash }] };
}
function matched(expected = expectation()): MatchedCctpMessage {
  return selectCctpMessage(circle(wire(expected)), expected)!;
}
function log(signature: string, indexed: Record<string, unknown>, types: string[], values: unknown[], address: string) {
  const abi = parseAbi([signature]);
  return { address, topics: encodeEventTopics({ abi, args: indexed } as never), data: encodeAbiParameters(types.map((type) => ({ type })), values as never), transactionHash: destinationHash, logIndex: "0x1", removed: false };
}
function received(message: MatchedCctpMessage) {
  return log("event MessageReceived(address indexed caller, uint32 sourceDomain, bytes32 indexed nonce, bytes32 sender, uint32 indexed finalityThresholdExecuted, bytes messageBody)",
    { caller: forwarder, nonce: message.nonce, finalityThresholdExecuted: message.finalityThresholdExecuted }, ["uint32", "bytes32", "bytes"], [message.sourceDomain, message.sender, message.messageBody], transmitter);
}
function transfer(from: string, to: string, amount: bigint, address = token) {
  return log("event Transfer(address indexed from, address indexed to, uint256 value)", { from, to }, ["uint256"], [amount], address);
}
function receipt(logs: unknown[]) { return { status: "0x1", transactionHash: destinationHash, blockNumber: "0x123", logs }; }
function sent(amount = 9980000000n) {
  return log("event SendAsset(address indexed coreRecipient, uint64 coreAmount, uint32 destinationDex)", { coreRecipient: owner }, ["uint64", "uint32"], [amount, 0], core);
}

test("withdrawal default hook matches independently ABI-packed owner and signed Core nonce", () => {
  const expected = concatHex([stringToHex("cctp-forward", { size: 24 }), number(0, 4), number(28, 4), owner, number(nonce, 8)]);
  expect(withdrawalHook(owner, nonce)).toBe(expected);
  expect((expected.length - 2) / 2).toBe(60);
  expect(() => withdrawalHook(owner, (1n << 64n).toString())).toThrow("uint64");
});

test("withdrawal burn discovery binds every indexed identity and exact amount/domain", () => {
  const input = { coreDepositWallet: core, owner, recipient: other, nonce, destinationDomain: 0, amountAtoms: "100000000" };
  const burn = { ...log("event CrossChainWithdraw(address indexed from, bytes32 indexed to, uint256 value, uint32 destinationDomain, uint64 indexed coreNonce)", { from: owner, to: w(other), coreNonce: BigInt(nonce) }, ["uint256", "uint32"], [100000000n, 0], core), transactionHash: sourceHash, blockNumber: "0x100" };
  expect(findWithdrawalBurn([burn], input)).toEqual({ transactionHash: sourceHash, blockNumber: "256", amountAtoms: "100000000", coreNonce: String(nonce) });
  for (const changed of [{ owner: other }, { nonce: nonce + 1 }, { recipient: owner }, { amountAtoms: "99999999" }, { destinationDomain: 3 }, { coreDepositWallet: other }]) expect(findWithdrawalBurn([burn], { ...input, ...changed })).toBeNull();
  expect(findWithdrawalBurn([{ ...burn, removed: true }], input)).toBeNull();
  expect(findWithdrawalBurn([burn, burn], input)).not.toBeNull();
  expect(() => findWithdrawalBurn([burn, { ...burn, transactionHash: destinationHash }], input)).toThrow("Ambiguous");
  const filter = withdrawalBurnFilter({ ...input, fromBlock: "256", toBlock: "512" });
  expect(filter.fromBlock).toBe("0x100"); expect(filter.toBlock).toBe("0x200"); expect(filter.topics).toHaveLength(4);
});

test("CCTP binary parser preserves amounts beyond JS safe integers and treats nonce as bytes32", () => {
  const expected = expectation({ amountAtoms: "123456789012345678901234567890" });
  const decoded = decodeCctpMessage(wire(expected));
  expect(decoded.amountAtoms).toBe(expected.amountAtoms); expect(decoded.nonce).toBe(cctpNonce);
  expect(decoded.messageSender).toBe(w(core)); expect(decoded.hookData).toBe(withdrawalHook(owner, nonce));
  expect(() => decodeCctpMessage("0x1234")).toThrow("Truncated");
  expect(() => decodeCctpMessage(wire(expected, { fee: 200001n }))).toThrow("fee");
});

test("Circle status is not delivery and decoded display metadata cannot override signed message", () => {
  const input = expectation(), response = circle();
  const message = selectCctpMessage(response, input)!;
  expect(message.attestationStatus).toBe("complete");
  expect(verifyDestinationReceipt(null, message, { messageTransmitter: transmitter, usdc: token, recipient: owner })).toBeNull();
  const forgedMetadata = { ...response, messages: response.messages.map((row) => ({ ...row, decodedMessage: { decodedMessageBody: { mintRecipient: other } } })) };
  expect(selectCctpMessage(forgedMetadata, input)?.mintRecipient).toBe(w(owner));
  for (const changed of [{ mintRecipient: other }, { messageSender: owner }, { amountAtoms: "99000000" }, { hookData: withdrawalHook(owner, nonce + 1) }, { destinationCaller: other }, { sourceDomain: 3 }, { maxFeeAtoms: "300000" }]) expect(selectCctpMessage(response, { ...input, ...changed })).toBeNull();
  expect(() => selectCctpMessage({ ...response, sourceTxHash: destinationHash }, input)).toThrow("different source");
  expect(() => selectCctpMessage({ ...response, messages: [...response.messages, { ...response.messages[0], message: wire(input, { nonce: sourceHash }) }] }, input)).toThrow("Ambiguous");
});

test("withdrawal destination proof requires native token mint and exact received CCTP message", () => {
  const message = matched(), proofInput = { messageTransmitter: transmitter, usdc: token, recipient: owner };
  const logs = [received(message), transfer(zero, owner, 99800000n)];
  expect(verifyDestinationReceipt(receipt(logs), message, proofInput)).toEqual({ transactionHash: destinationHash, blockNumber: "291", deliveredAtoms: "99800000", nonce: cctpNonce, finality: "included" });
  expect(verifyDestinationReceipt(receipt([transfer(zero, owner, 99800000n)]), message, proofInput)).toBeNull();
  expect(verifyDestinationReceipt(receipt([received({ ...message, nonce: sourceHash }), logs[1]]), message, proofInput)).toBeNull();
  expect(verifyDestinationReceipt(receipt([logs[0], transfer(zero, other, 99800000n)]), message, proofInput)).toBeNull();
  expect(verifyDestinationReceipt(receipt([logs[0], transfer(zero, owner, 99800000n, other)]), message, proofInput)).toBeNull();
  expect(verifyDestinationReceipt({ ...receipt(logs), status: "0x0" }, message, proofInput)).toBeNull();
  expect(verifyDestinationReceipt({ ...receipt(logs), transactionHash: sourceHash }, message, proofInput)).toBeNull();
  expect(verifyDestinationReceipt(receipt([logs[0], { ...logs[1], transactionHash: sourceHash }]), message, proofInput)).toBeNull();
});

test("destination discovery checks message body, sender and source domain beyond indexed nonce", () => {
  const message = matched(), input = { messageTransmitter: transmitter }, event = received(message);
  const filter = destinationMintFilter(message, { ...input, fromBlock: "256", toBlock: "0x200" });
  expect(filter.address).toBe(transmitter); expect(filter.fromBlock).toBe("0x100"); expect(filter.toBlock).toBe("0x200");
  expect(filter.topics).toEqual([event.topics[0], null, cctpNonce, number(1000, 32)]);
  expect(destinationMintHashes([event, event], message, input)).toEqual([destinationHash]);
  for (const changed of [{ nonce: sourceHash }, { messageBody: "0x1234" as Hex }, { sender: w(other) }, { sourceDomain: 3 }, { finalityThresholdExecuted: 2000 }]) expect(destinationMintHashes([received({ ...message, ...changed })], message, input)).toEqual([]);
  expect(destinationMintHashes([{ ...event, removed: true }], message, input)).toEqual([]);
  expect(destinationMintHashes([{ ...event, address: other }], message, input)).toEqual([]);
  expect(destinationMintHashes([{ ...event, transactionHash: "0x12" }], message, input)).toEqual([]);
});

test("an explicitly discovered manual mint can supersede Circle's stale forwarding hint", () => {
  const message = matched(), input = { messageTransmitter: transmitter, usdc: token, recipient: owner };
  const manual = { ...receipt([received(message), transfer(zero, owner, 99800000n)].map((entry) => ({ ...entry, transactionHash: sourceHash }))), transactionHash: sourceHash };
  expect(verifyDestinationReceipt(manual, message, input)).toBeNull();
  expect(verifyDestinationReceipt(manual, message, { ...input, allowDiscoveredReceipt: true })?.transactionHash).toBe(sourceHash);
  const incorrect = { ...manual, logs: [received({ ...message, nonce: sourceHash }), transfer(zero, owner, 99800000n)].map((entry) => ({ ...entry, transactionHash: sourceHash })) };
  expect(verifyDestinationReceipt(incorrect, message, { ...input, allowDiscoveredReceipt: true })).toBeNull();
  expect(verifyDestinationReceipt({ ...manual, status: "0x0" }, message, { ...input, allowDiscoveredReceipt: true })).toBeNull();
  const deposit = matched(expectation({ sourceDomain: 0, destinationDomain: 19, mintRecipient: forwarder, destinationCaller: forwarder }));
  const forwarded = { ...receipt([received(deposit), transfer(zero, forwarder, 99800000n), transfer(forwarder, core, 99800000n), sent()].map((entry) => ({ ...entry, transactionHash: sourceHash }))), transactionHash: sourceHash };
  const coreInput = { messageTransmitter: transmitter, usdc: token, forwarder, coreDepositWallet: core, owner };
  expect(verifyCoreForwardReceipt(forwarded, deposit, coreInput)).toBeNull();
  expect(verifyCoreForwardReceipt(forwarded, deposit, { ...coreInput, allowDiscoveredReceipt: true })?.transactionHash).toBe(sourceHash);
});

test("deposit proof reports Core forwarding without claiming subsequent CoreWriter success", () => {
  const message = matched(expectation({ sourceDomain: 0, destinationDomain: 19, mintRecipient: forwarder, destinationCaller: forwarder }));
  const input = { messageTransmitter: transmitter, usdc: token, forwarder, coreDepositWallet: core, owner };
  const beforeSend = [received(message), transfer(zero, forwarder, 99800000n), transfer(forwarder, core, 99800000n)];
  expect(verifyCoreForwardReceipt(receipt(beforeSend), message, input)).toBeNull();
  const proof = verifyCoreForwardReceipt(receipt([...beforeSend, sent()]), message, input)!;
  expect(proof.phase).toBe("forwarded_to_core"); expect(proof.coreAmountAtoms).toBe("9980000000"); expect(proof.coreExecutionProven).toBe(false);
  expect(verifyCoreForwardReceipt(receipt([...beforeSend, sent(), sent()]), message, input)).toBeNull();
  expect(verifyCoreForwardReceipt(receipt([...beforeSend, sent(9880000000n)]), message, input)).toBeNull();
  const fee = log("event NewCoreAccountFeeApplied(address indexed coreRecipient, uint64 newCoreAccountFee, uint256 evmDepositAmount, uint64 coreSentAmount)", { coreRecipient: owner }, ["uint64", "uint256", "uint64"], [100000000n, 99800000n, 9880000000n], core);
  expect(verifyCoreForwardReceipt(receipt([...beforeSend, fee, sent(9880000000n)]), message, input)?.coreAmountAtoms).toBe("9880000000");
});

test("matching Core ledger entries stay explicitly contextual and exclude already observed credits", () => {
  const row = { hash: sourceHash, time: nonce + 1000, delta: { type: "send", user: core, destination: owner, sourceDex: "spot", destinationDex: "", token: "USDC", amount: "99.8", nonce: 3195855 } };
  const input = { owner, coreDepositWallet: core, coreAmountAtoms: "9980000000", notBeforeMs: nonce };
  expect(observedCoreCredits([row], input)).toEqual([{ hash: sourceHash, time: nonce + 1000, amount: "99.8", nonce: "3195855", inferredLinkage: true }]);
  expect(observedCoreCredits([row], { ...input, seenHashes: [sourceHash] })).toEqual([]);
  expect(observedCoreCredits([row], { ...input, notBeforeMs: nonce + 1001 })).toEqual([]);
  for (const changes of [{ user: other }, { destination: other }, { destinationDex: "spot" }, { sourceDex: "" }, { amount: "99.80000001" }, { token: "USDC.e" }]) expect(observedCoreCredits([{ ...row, delta: { ...row.delta, ...changes } }], input)).toEqual([]);
});
