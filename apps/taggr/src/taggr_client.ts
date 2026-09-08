// Direct transport to the Taggr canister.
//
// Taggr's API is not Candid. Almost every endpoint is exported as
// `canister_query <name>` / `canister_update <name>` and reads raw UTF-8 JSON
// argument bytes, replying with raw UTF-8 JSON (`serde_json` on both sides).
// Only a handful of methods — `add_post` among them — use Candid. This module
// speaks both, the same way Taggr's own frontend does in
// `src/frontend/src/api.ts`.
//
// It runs only in the resident background, which owns the identity. Reads are
// ordinary non-replicated queries: fast, free, and — because a query method's
// state mutations are always discarded — safe against the Taggr read endpoints
// that call `mutate(...)` internally to avoid cloning.

import { HttpAgent, isV2ResponseBody, polling, type Identity } from "@dfinity/agent";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { isLocalHost } from "./network.ts";

export type PostId = number;

export type AddPostInput = {
  body: string;
  parent?: PostId | null;
  realm?: string | null;
};

export class TaggrCallError extends Error {}

/**
 * Taggr's `add_post`, from `src/backend/taggr.did`:
 *   (text, vec record { text; nat64; nat64 }, opt nat64, opt text, opt blob)
 *     -> (variant { Ok : nat64; Err : text })
 */
const ADD_POST_ARGS = [
  IDL.Text,
  IDL.Vec(IDL.Tuple(IDL.Text, IDL.Nat64, IDL.Nat64)),
  IDL.Opt(IDL.Nat64),
  IDL.Opt(IDL.Text),
  IDL.Opt(IDL.Vec(IDL.Nat8)),
];
const ADD_POST_RESULT = [IDL.Variant({ Ok: IDL.Nat64, Err: IDL.Text })];

/** Taggr's `CONFIG.max_post_length` is 100,000 characters; stay well inside it. */
export const MAX_POST_BYTES = 60_000;

/**
 * Mirrors `jsonArg` + `getEffParams` in Taggr's own frontend: no arguments
 * encode as `null`, exactly one argument encodes bare, several encode as a JSON
 * array. Getting this wrong makes `serde_json` reject the call on the canister.
 */
export const encodeArgs = (args: unknown[]): string => {
  const values = args.filter((value) => value !== undefined);
  if (values.length === 0) return "null";
  if (values.length === 1) return JSON.stringify(values[0]);
  return JSON.stringify(values);
};

/**
 * agent-js v3 takes and returns `Uint8Array`. Passing an `ArrayBuffer` here
 * signs one representation and transmits another, which the replica rejects as
 * an invalid signature — a failure that looks nothing like its cause.
 */
const jsonArg = (payload: string): Uint8Array => new TextEncoder().encode(payload);

const decodeReply = (reply: Uint8Array): string => new TextDecoder().decode(reply);

export { isLocalHost } from "./network.ts";

export const replicaHost = (location = globalThis.location): string => {
  if (!location) return "https://icp-api.io";
  if (!isLocalHost(location.hostname)) return "https://icp-api.io";
  // A local gateway serves every canister from one port, whatever subdomain the
  // app surface happens to use.
  return `${location.protocol}//localhost:${location.port || "8000"}`;
};

/**
 * Encodes Taggr's Candid `add_post` argument sequence. `refs` is always empty
 * and `extension` always absent: attachments live in per-user Taggr bucket
 * canisters and polls need an extension payload, neither of which this client
 * writes. Kept pure so the wire contract can be tested without a replica.
 */
export const encodeAddPostArgs = (input: AddPostInput): Uint8Array => {
  const body = input.body.trim();
  if (body.length === 0) throw new TaggrCallError("A post needs a body");
  if (new TextEncoder().encode(body).length > MAX_POST_BYTES) {
    throw new TaggrCallError(`A post must be under ${MAX_POST_BYTES} bytes`);
  }
  const realm = input.realm?.trim() ?? "";
  if (realm.length > 64) throw new TaggrCallError("That realm name is too long");
  return IDL.encode(ADD_POST_ARGS, [
    body,
    [],
    input.parent === null || input.parent === undefined ? [] : [BigInt(input.parent)],
    realm.length > 0 ? [realm] : [],
    [],
  ]);
};

/** Decodes Taggr's `variant { Ok : nat64; Err : text }` reply. */
export const decodeAddPostReply = (reply: Uint8Array): PostId => {
  let decoded: { Ok: bigint } | { Err: string };
  try {
    decoded = IDL.decode(ADD_POST_RESULT, reply)[0] as { Ok: bigint } | { Err: string };
  } catch {
    throw new TaggrCallError("Taggr's reply to add_post did not decode");
  }
  if ("Err" in decoded) throw new TaggrCallError(decoded.Err);
  return Number(decoded.Ok);
};

export type TaggrClient = {
  readonly canisterId: string;
  readonly principal: string;
  /** Non-replicated read. */
  query: (method: string, payload?: string) => Promise<string>;
  /** Replicated update. */
  update: (method: string, payload?: string) => Promise<string>;
  addPost: (input: AddPostInput) => Promise<PostId>;
};

export async function createTaggrClient(options: {
  canisterId: string;
  identity: Identity;
  host?: string;
  local?: boolean;
}): Promise<TaggrClient> {
  const host = options.host ?? replicaHost();
  const local = options.local ?? isLocalHost(new URL(host).hostname);
  const canister = Principal.fromText(options.canisterId);
  const agent = await HttpAgent.create({
    host,
    identity: options.identity,
    // The IC's root key is pinned in the agent; a local replica's is not.
    shouldFetchRootKey: local,
  });

  const query = async (method: string, payload = "null"): Promise<string> => {
    const response = await agent.query(canister, {
      methodName: method,
      arg: jsonArg(payload),
    });
    if (response.status !== "replied") {
      const reject =
        "reject_message" in response && typeof response.reject_message === "string"
          ? response.reject_message
          : `Taggr rejected ${method}`;
      throw new TaggrCallError(reject);
    }
    return decodeReply(response.reply.arg);
  };

  const callRaw = async (method: string, arg: Uint8Array): Promise<Uint8Array> => {
    const { requestId, response } = await agent.call(canister, {
      methodName: method,
      arg,
      callSync: false,
    });
    // Async submissions can return HTTP 200 with an explicit rejection. Such
    // requests were not accepted, so there is no certified result to poll for.
    if (isV2ResponseBody(response.body)) {
      throw new TaggrCallError(response.body.reject_message);
    }
    const { reply } = await polling.pollForResponse(agent, canister, requestId);
    return reply;
  };

  const update = async (method: string, payload = "null"): Promise<string> =>
    decodeReply(await callRaw(method, jsonArg(payload)));

  const addPost = async (input: AddPostInput): Promise<PostId> =>
    decodeAddPostReply(await callRaw("add_post", encodeAddPostArgs(input)));

  return {
    canisterId: options.canisterId,
    principal: options.identity.getPrincipal().toText(),
    query,
    update,
    addPost,
  };
}
