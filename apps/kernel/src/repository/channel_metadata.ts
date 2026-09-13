import { AnonymousIdentity, HttpAgent, type ApiQueryResponse } from "@dfinity/agent";
import { IDL } from "@dfinity/candid";
import { createCertifiedAssetReader } from "neutron-tools/certified_asset";
import { REPOSITORY_LIMITS, type RepositoryCertifiedRead } from "neutron-tools/repository";
import { repositoryChannelsPath } from "neutron-tools/src/release_channels.js";
import { getRuntimeDeployment } from "../runtime_deployment.ts";

const metadataMethod = "repo_channel_metadata";
const requestType = IDL.Record({ path: IDL.Text, index: IDL.Nat });
const responseType = IDL.Record({
  certificate: IDL.Vec(IDL.Nat8),
  witness: IDL.Vec(IDL.Nat8),
  asset: IDL.Opt(IDL.Record({ content: IDL.Vec(IDL.Nat8), chunks: IDL.Nat })),
});

/** A signed rejection of this exact optional method is the legacy negotiation.
 * Normal replied data still requires a certified asset witness, including
 * certified absence. No HTTP failure or exception text can select legacy. */
export function createRepositoryChannelMetadataReader({
  canisterId,
  agent,
  rootKey,
  local = false,
}: {
  canisterId: string;
  agent: Pick<HttpAgent, "query">;
  rootKey: Uint8Array;
  local?: boolean;
}): (path: string) => Promise<Uint8Array | undefined> {
  let methodConfirmed = false;
  return async (path) => {
    const response = await agent.query(canisterId, {
      methodName: metadataMethod,
      arg: IDL.encode([requestType], [{ path, index: 0n }]),
    });
    if (response.status === "rejected") {
      if (!methodConfirmed && path === repositoryChannelsPath() &&
        isVerifiedMissingChannelMethod(response, local)) return undefined;
      throw new Error("The repository rejected its release-channel metadata query.");
    }
    methodConfirmed = true;
    const first = IDL.decode([responseType], response.reply.arg)[0] as unknown as RepositoryCertifiedRead;
    const reader = createCertifiedAssetReader({
      canisterId,
      rootKey,
      limits: {
        maxChunkBytes: REPOSITORY_LIMITS.queryChunkBytes,
        maxChunks: 1,
        maxEncodedBytes: REPOSITORY_LIMITS.metadataJsonBytes,
      },
      readChunk: async ({ key, index }) => {
        if (key !== path || index !== 0n) throw new Error("Repository channel metadata path changed during read.");
        return first;
      },
    });
    const bytes = await reader.readRaw(path);
    if (bytes === undefined && path === repositoryChannelsPath()) {
      throw new Error("The repository supports channel metadata but its certified descriptor is missing.");
    }
    return bytes;
  };
}

/** HttpAgent verifies response signatures against this query's request ID,
 * source subnet, timestamp, and complete rejection fields. Version 3.4.3 also
 * accepts an empty signature list, so reject that case explicitly here. */
export function isVerifiedMissingChannelMethod(response: ApiQueryResponse, local = false): boolean {
  return response.status === "rejected" && response.reject_code === 5 &&
    response.error_code === "IC0536" && (local || (response.signatures?.length ?? 0) > 0);
}

export async function createAnonymousRepositoryChannelReader(
  canisterId: string,
  options: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<(path: string) => Promise<Uint8Array | undefined>> {
  const deployment = getRuntimeDeployment();
  const baseFetch = options.fetch ?? globalThis.fetch;
  const privacyFetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (options.signal?.aborted) throw new DOMException("Repository request was cancelled", "AbortError");
    return baseFetch(input, { ...init, credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", ...(options.signal ? { signal: options.signal } : {}) });
  }) as typeof fetch;
  const agent = await HttpAgent.create({
    fetch: privacyFetch,
    host: deployment.gateway,
    identity: new AnonymousIdentity(),
    ...(deployment.local ? { verifyQuerySignatures: false } : {}),
  });
  if (deployment.rootKeyPolicy === "fetch") await agent.fetchRootKey();
  if (!agent.rootKey) throw new Error("The ICP root key is unavailable");
  return createRepositoryChannelMetadataReader({ canisterId, agent, rootKey: agent.rootKey, local: deployment.local });
}
