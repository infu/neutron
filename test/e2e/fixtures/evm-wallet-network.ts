import { randomBytes } from "node:crypto";
import { getAddress } from "ethers";
import { createLocalEvmChain, type LocalEvmChain } from "./evm-wallet-chain.ts";

// Empty calldata reads slot 0; non-empty calldata stores its first 32 bytes.
// These fixture contracts execute real EVM bytecode. The application, chain-key
// signer, RPC responses, transaction pool and receipts are not mocked.
const STORAGE_RUNTIME = "0x3615600b576000356000555b60005460005260206000f3";
export type EvmNetworkFixture = {
  chain: LocalEvmChain;
  chainId: "1" | "42161";
  clientVersion: string;
  nodeKind: "anvil";
  rpcUrl: string;
  fund(address: string): Promise<void>;
  deployStorage(): Promise<{ address: string; runtime: string; transactionHash: null }>;
};

/** Two independent, unforked execution fixtures. Chain 42161 establishes the
 * Wallet's network selection and signing behavior, not Nitro's parent posting
 * charges, sequencer operation, reorg rules or parent-finality progression.
 */
export async function createEvmNetworkFixture(chainId: "1" | "42161"): Promise<EvmNetworkFixture> {
  const rpcUrl = chainId === "1" ? "http://127.0.0.1:8545" : process.env.NEUTRON_EVM_ARBITRUM_RPC_URL ?? "http://127.0.0.1:8546";
  const chain = await createLocalEvmChain({ chainId, rpcUrl });
  const clientVersion = await chain.rpc<string>("web3_clientVersion");
  if (!/^anvil\b/iu.test(clientVersion)) throw new Error("Network matrix requires its isolated Anvil fixtures");
  const info = await chain.rpc<{ forkConfig?: { forkUrl?: unknown; forkBlockNumber?: unknown } }>("anvil_nodeInfo");
  if (info.forkConfig?.forkUrl != null || info.forkConfig?.forkBlockNumber != null) throw new Error("Network matrix requires unforked fixture chains");
  return {
    chain, chainId, clientVersion, nodeKind: "anvil", rpcUrl,
    fund: chain.fund,
    async deployStorage() {
      const address = getAddress(`0x${randomBytes(20).toString("hex")}`);
      await chain.rpc("anvil_setCode", [address, STORAGE_RUNTIME]);
      const code = await chain.rpc<string>("eth_getCode", [address, "latest"]);
      if (code.toLowerCase() !== STORAGE_RUNTIME) throw new Error("Storage fixture runtime differs from reviewed bytecode");
      const initial = await chain.rpc<string>("eth_call", [{ to: address, data: "0x" }, "latest"]);
      if (BigInt(initial) !== 0n) throw new Error("Storage fixture did not initialize to zero");
      return { address, runtime: STORAGE_RUNTIME, transactionHash: null };
    },
  };
}
