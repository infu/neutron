import { decodeSelfCallValue, type SelfCallObject } from "neutron-tools/app";
import { browserEvmRpc, createBrowserEvmRpc } from "../../src/browser_rpc.ts";
import { prepareBrowserOperation, executeBrowserOperation, readBrowserOperation, reconcileBrowserOperation, refreshBrowserEvidence, type OperationKernel } from "../../src/browser_operations.ts";
import { browserBalances } from "../../src/browser_reads.ts";
import { identityArgs, type Operation } from "../../src/data.ts";

declare const __CHAIN_RPC_URL__: string;
declare const __CHAIN_BRIDGE_URL__: string;
const fixture = { dropBroadcastReply: false, interruptAfterBroadcast: false, interrupted: false, rpcCalls: [] as string[] };
const directFetch = globalThis.fetch.bind(globalThis);
const rpc = createBrowserEvmRpc({ endpoints: { "1": __CHAIN_RPC_URL__ }, fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
  const { method } = JSON.parse(String(init?.body)) as { method: string };
  if (fixture.interrupted) throw new Error("Fixture: browser disconnected before receipt lookup");
  fixture.rpcCalls.push(method);
  const response = await directFetch(input, init);
  if (method === "eth_sendRawTransaction" && fixture.dropBroadcastReply) {
    fixture.dropBroadcastReply = false;
    fixture.interrupted = fixture.interruptAfterBroadcast;
    throw new Error("Fixture: broadcast accepted but reply lost");
  }
  return response;
}) as typeof globalThis.fetch });
browserEvmRpc.request = rpc.request;

async function bridge(kind: "query" | "update", method: string, args: unknown[]) {
  const response = await directFetch(__CHAIN_BRIDGE_URL__, {
    method: "POST", mode: "cors", credentials: "omit", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, method, args }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return decodeSelfCallValue(result.value, result.blobs.map((blob: { data: number[] }) => ({ ...blob, data: Uint8Array.from(blob.data).buffer })));
}
const kernel = {
  querySelf: (method: string, args: unknown[]) => bridge("query", method, args),
  updateSelf: (method: string, args: unknown[]) => bridge("update", method, args),
} as OperationKernel;
const caller = { appId: "evm_wallet", installationUid: "1", endpoint: "tile" };
const identity = (id: string) => identityArgs(caller, id);
Object.assign(globalThis, { __chain: {
  fixture,
  origin: globalThis.origin,
  prepare: (id: string, intent: SelfCallObject) => prepareBrowserOperation(kernel, identity(id), intent),
  execute: (operation: Operation) => executeBrowserOperation(kernel, operation),
  read: (id: string) => readBrowserOperation(kernel, identity(id)),
  reconcile: (operation: Operation) => reconcileBrowserOperation(kernel, operation),
  evidence: (operation: Operation) => refreshBrowserEvidence(kernel, operation, true),
  balances: (address: string, tokens: string[]) => browserBalances({ accountId: "main", chainId: "1", tokens }, address),
  ready: true,
} });
