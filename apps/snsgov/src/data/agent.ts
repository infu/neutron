/**
 * The anonymous IC agent used for every read in this app.
 *
 * All SNS reads are anonymous queries. They cost the Neutron owner nothing,
 * need no manifest capability, no backend-call reservation, and no owner
 * dialog. `apps/mysubnet` establishes this pattern in production with an empty
 * `capabilities` block.
 *
 * In the browser the agent talks to the page's own origin, which is already an
 * IC boundary node (`i<nonce>--<canister>.icp0.io`) or the local PocketIC
 * gateway — so there is no cross-origin request and no CORS involved at all.
 */

import { Actor, HttpAgent, type ActorSubclass } from "@dfinity/agent";
import type { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { classifyError } from "./errors";

/** Fallback host for non-browser contexts (tests, tooling). */
const DEFAULT_HOST = "https://icp-api.io";

export interface AgentOptions {
  /** Override the boundary node. Defaults to the page origin in a browser. */
  host?: string;
  /** Force local-network behaviour (root key fetch). Auto-detected otherwise. */
  local?: boolean;
}

let cached: Promise<HttpAgent> | undefined;
let cachedKey = "";

/**
 * A process-wide anonymous agent. Shared deliberately: agent construction does
 * a root-key fetch on local networks, and every caller wants the same one.
 */
export async function getAgent(options: AgentOptions = {}): Promise<HttpAgent> {
  const host = options.host ?? defaultHost();
  const local = options.local ?? isLocalHost(host);
  const key = `${host}|${local}`;
  if (cached && cachedKey === key) return cached;

  cachedKey = key;
  cached = (async () => {
    const agent = await HttpAgent.create({ host });
    if (local) {
      // A local replica signs with a per-instance key the agent cannot know.
      await agent.fetchRootKey();
    }
    return agent;
  })();

  try {
    return await cached;
  } catch (error) {
    cached = undefined;
    cachedKey = "";
    throw classifyError(error);
  }
}

/** Drop the shared agent, e.g. after an authority change. */
export function resetAgent(): void {
  cached = undefined;
  cachedKey = "";
}

function defaultHost(): string {
  if (typeof window !== "undefined" && window.location?.origin) {
    // The app's own origin is a boundary node, so this is same-origin.
    return window.location.origin;
  }
  return DEFAULT_HOST;
}

function isLocalHost(host: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(host).hostname.toLowerCase();
  } catch {
    return false;
  }
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "127.0.0.1" ||
    hostname === "0.0.0.0" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

export type IdlFactory = IDL.InterfaceFactory;

/** Build a read-only actor for a canister. */
export async function actorFor<T>(
  idlFactory: IdlFactory,
  canisterId: string | Principal,
  options: AgentOptions = {},
): Promise<ActorSubclass<T>> {
  const agent = await getAgent(options);
  return Actor.createActor<T>(idlFactory, {
    agent,
    canisterId: typeof canisterId === "string" ? Principal.fromText(canisterId) : canisterId,
  });
}

/**
 * Send raw Candid bytes to a canister method and return the raw reply.
 *
 * Used for the generic-proposal validator pre-flight, where governance itself
 * passes the payload through verbatim and we want to reproduce that exactly.
 * This operation is query-only. A missing query method does not authorize an
 * update: validator updates can change state and run with a different caller
 * from Governance. Writes use the explicit Neutron backend operation path.
 */
export async function callRaw(
  canisterId: string | Principal,
  methodName: string,
  arg: Uint8Array,
  options: AgentOptions = {},
): Promise<Uint8Array> {
  const agent = await getAgent(options);
  const target = typeof canisterId === "string" ? Principal.fromText(canisterId) : canisterId;

  let response: Awaited<ReturnType<HttpAgent["query"]>>;
  try {
    response = await agent.query(target, { methodName, arg });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isMissingQuery(message)) throw new QueryMethodUnavailableError(message);
    throw classifyError(error);
  }
  if (response.status === "replied") return new Uint8Array(response.reply.arg);
  const message = response.reject_message ?? "query rejected";
  if (isMissingQuery(message)) throw new QueryMethodUnavailableError(message);
  throw classifyError(new Error(`query rejected (${response.reject_code}): ${message}`));
}

/** Query absence may require an explicitly routed update; no write was made. */
export class QueryMethodUnavailableError extends Error {
  readonly updateRequired = true;
  constructor(message: string) {
    super(message);
    this.name = "QueryMethodUnavailableError";
  }
}

function isMissingQuery(message: string): boolean {
  return /has no query method|query method .*not found|no query method|does not have.*query/i.test(message);
}

export const callRawQuery = callRaw;
