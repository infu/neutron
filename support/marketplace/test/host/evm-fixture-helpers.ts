import assert from "node:assert/strict";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { compileFixture } from "../../scripts/test-ash-runtime.ts";

export const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
export const CKUSDC = "xevnm-gaaaa-aaaar-qafnq-cai";
export const MINTER = "sv3dd-oaaaa-aaaar-qacoa-cai";
export const HELPER = "0x2d39863d30758f2c6c6cd3fb26b1d0e825eb16fa";
export const EVENT_TOPIC = "0x918adbebdb8f3b36fc337ab76df10b147b2def5c9dd62cb3456d9aeca40e0b07";

export async function installAt(pic: any, name: string, source: string, args: unknown[], principalText: string) {
  const compiled = await compileFixture(name, source);
  const targetCanisterId = Principal.fromText(principalText);
  const canisterId = await pic.createCanister({ targetCanisterId, cycles: 100_000_000_000_000n });
  assert.equal(canisterId.toText(), principalText, "PocketIC installs at the production client's fixed target");
  const arg = IDL.encode(compiled.init ? compiled.init({ IDL }) : [], args);
  await pic.installCode({ canisterId, wasm: compiled.wasmPath, arg });
  return { ...compiled, canisterId, actor: pic.createActor(compiled.idlFactory, canisterId) };
}

export type DepositEvidenceInput = {
  helper: string; payer: string; recipient: Principal; subaccount: Uint8Array;
  amount: bigint; hash: string; token?: string; blockNumber?: bigint; blockHash?: string;
};

// Encode the official Solidity event independently from Motoko EvmEvidence.
// Values are synthetic receipts, not observations of any real Ethereum action.
export function receiptFor(input: DepositEvidenceInput) {
  assert.equal(input.subaccount.length, 32);
  assert.ok(input.amount > 0n && input.amount < (1n << 256n));
  const hash = input.hash.toLowerCase();
  const blockHash = input.blockHash ?? `0x${"ab".repeat(32)}`;
  const blockNumber = input.blockNumber ?? 123n;
  const principal = input.recipient.toUint8Array();
  assert.ok(principal.length <= 29);
  const principalWord = new Uint8Array(32);
  principalWord[0] = principal.length;
  principalWord.set(principal, 1);
  const addressWord = (value: string) => `0x${value.slice(2).toLowerCase().padStart(64, "0")}`;
  const data = `0x${input.amount.toString(16).padStart(64, "0")}${Buffer.from(input.subaccount).toString("hex")}`;
  const root = `0x${"00".repeat(32)}`;
  const logsBloom = `0x${"00".repeat(256)}`;
  const receipt = {
    to: [input.helper], status: [1n], root: [], transactionHash: hash, blockNumber,
    from: input.payer, logs: [{
      transactionHash: [hash], blockNumber: [blockNumber], data, blockHash: [blockHash],
      transactionIndex: [0n], topics: [EVENT_TOPIC, addressWord(input.token ?? USDC), addressWord(input.payer), `0x${Buffer.from(principalWord).toString("hex")}`],
      address: input.helper, logIndex: [0n], removed: false,
    }], blockHash, type: "0x2", transactionIndex: 0n, effectiveGasPrice: 1n,
    logsBloom, contractAddress: [], gasUsed: 50_000n, cumulativeGasUsed: 50_000n,
  };
  const block = {
    miner: "0x1111111111111111111111111111111111111111", totalDifficulty: [], receiptsRoot: root, stateRoot: root,
    hash: blockHash, difficulty: [], size: 1_000n, uncles: [], baseFeePerGas: [1n], extraData: "0x",
    transactionsRoot: [root], sha3Uncles: root, nonce: 0n, number: blockNumber, timestamp: 1_789_000_000n,
    transactions: [hash], gasLimit: 30_000_000n, logsBloom, parentHash: root, gasUsed: 50_000n, mixHash: root,
  };
  return { receipt, block };
}
