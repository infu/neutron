import type { Agent, SubmitResponse } from "@dfinity/agent";

type CallTarget = Parameters<Agent["call"]>[0];
type CallFields = Parameters<Agent["call"]>[1];
type PollingCallFields = CallFields & { callSync?: boolean };
type PollingCall = (
  canisterId: CallTarget,
  fields: PollingCallFields,
) => Promise<SubmitResponse>;

export type PollingUpdateFetch = (
  this: unknown,
  ...args: Parameters<typeof fetch>
) => ReturnType<typeof fetch>;

/**
 * The legacy Actor bundled with @dfinity/agent 3.4 only polls after an HTTP
 * 202 response. Use the asynchronous call endpoint so every update completes
 * through the certified request-status path, including calls that suspend.
 */
export function submitPollingUpdate(
  agent: Agent,
  canisterId: CallTarget,
  fields: CallFields,
): Promise<SubmitResponse> {
  const call = agent.call.bind(agent) as PollingCall;
  return call(canisterId, { ...fields, callSync: false });
}

/**
 * Actor clients own their HttpAgent call policy, so adapt the shared fetch
 * boundary. Only the synchronous update endpoint changes; the signed request
 * is untouched.
 */
export function usePollingUpdateFetch(
  fetchImplementation: PollingUpdateFetch,
): PollingUpdateFetch {
  return (input, init) => {
    const source =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    let url: URL;
    try {
      url = new URL(source);
    } catch {
      return fetchImplementation(input, init);
    }
    if (/^\/api\/v3\/canister\/[^/]+\/call$/u.test(url.pathname)) {
      url.pathname = url.pathname.replace("/api/v3/", "/api/v2/");
      const nextInput =
        typeof input === "string"
          ? url.href
          : input instanceof URL
            ? url
            : new Request(url, input);
      return fetchImplementation(nextInput, init);
    }
    return fetchImplementation(input, init);
  };
}
