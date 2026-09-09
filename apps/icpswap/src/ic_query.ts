/** Shared anonymous IC transport for browser protocol reads. No identity keys,
 * update calls, or cached application replies. */
import { HttpAgent, makeNonce, type HttpAgentOptions } from "@icp-sdk/core/agent";
import { IDL } from "@dfinity/candid";

export const ICPSWAP_QUERY_HOST = "https://icp-api.io";
export type IcpswapQueryTransportOptions = {
  createAgent?: (options: HttpAgentOptions) => Promise<HttpAgent>;
};

function subnetKeyStore(): NonNullable<HttpAgentOptions["subnetNodeKeyExpirableStore"]> {
  // Sandboxed tiles have opaque origins: IndexedDB may exist but accessing it
  // throws SecurityError. Keep the SDK's five-minute verified-key lifetime in
  // memory, as the legacy agent did, without requiring persistent browser data.
  const expirationTime = 5 * 60_000;
  type Keys = Awaited<ReturnType<HttpAgent["fetchSubnetKeys"]>>;
  const entries = new Map<string, { value: Keys; expires: number }>();
  return {
    expirationTime,
    async get(key) {
      const entry = entries.get(key);
      if (!entry || Date.now() >= entry.expires) { entries.delete(key); return undefined; }
      return entry.value;
    },
    async set(key, value) {
      const now = Date.now();
      for (const [id, entry] of entries) if (now >= entry.expires) entries.delete(id);
      entries.set(key, { value, expires: now + expirationTime });
    },
    async delete(key) { entries.delete(key); },
  };
}

/** Core 5.4 hashes the post-transform query before verifying its response.
 * The legacy agent hashes before transforms; adding a nonce there would
 * invalidate verification. Both SDKs' useQueryNonces option currently invokes
 * a transform that only handles update calls, so add the query nonce explicitly.
 *
 * Cancellation belongs to the consumer, not a shared fetch function. A query
 * already on the wire may finish verification after cancellation; its reply
 * cannot reach the cancelled caller or disrupt another consumer's request. */
export function createIcpswapQueryTransport({ createAgent = (options: HttpAgentOptions) => HttpAgent.create(options) }: IcpswapQueryTransportOptions = {}) {
  let agentPromise: Promise<HttpAgent> | null = null;
  function getAgent(): Promise<HttpAgent> {
    if (!agentPromise) {
      agentPromise = Promise.resolve().then(async () => {
        const agent = await createAgent({ host: ICPSWAP_QUERY_HOST, verifyQuerySignatures: true, subnetNodeKeyExpirableStore: subnetKeyStore() });
        agent.addTransform("query", async (request) => {
          if (request.endpoint === "read") request.body.nonce = makeNonce();
        });
        return agent;
      });
      void agentPromise.catch(() => { agentPromise = null; });
    }
    return agentPromise;
  }
  return async ({ canister, method, args, signature, signal }: {
    canister: string; method: string; args: unknown[]; signature: { args: IDL.Type[]; output: IDL.Type }; signal: AbortSignal;
  }): Promise<unknown> => {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const aborted = () => { signal.removeEventListener("abort", aborted); reject(signal.reason); };
      signal.addEventListener("abort", aborted, { once: true });
      const read = async () => {
        const agent = await getAgent();
        signal.throwIfAborted();
        const response = await agent.query(canister, { methodName: method, arg: IDL.encode(signature.args, args) });
        signal.throwIfAborted();
        if (response.status !== "replied") {
          throw new Error(`${method} on ${canister} rejected (${response.reject_code}${response.error_code ? `, ${response.error_code}` : ""}): ${response.reject_message}`);
        }
        const [value] = IDL.decode([signature.output], response.reply.arg);
        return value;
      };
      read().then((value) => { signal.removeEventListener("abort", aborted); resolve(value); },
        (error: unknown) => { signal.removeEventListener("abort", aborted); reject(error); });
    });
  };
}

/** One verified subnet-key cache shared by swaps, liquidity and their tools. */
export const icpswapQuery = createIcpswapQueryTransport();
