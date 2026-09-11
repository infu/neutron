// All rights reserved. See ../LICENSE.
import { Actor, HttpAgent } from "@icp-sdk/core/agent";
import { IDL } from "@icp-sdk/core/candid";
import { Principal } from "@icp-sdk/core/principal";
import { verifyRequestResponsePair } from "@dfinity/response-verification";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { REPOSITORY_LIMITS } from "neutron-tools/src/repository.ts";

const blob = IDL.Vec(IDL.Nat8);
const header = IDL.Tuple(IDL.Text, IDL.Text);
const token = IDL.Record({ path: IDL.Text, sha256: blob, grant: IDL.Opt(IDL.Text), index: IDL.Nat });
const stream = IDL.Record({ body: blob, token: IDL.Opt(token) });
const request = IDL.Record({ method: IDL.Text, url: IDL.Text, headers: IDL.Vec(header), body: blob, certificate_version: IDL.Opt(IDL.Nat16) });
const response = IDL.Record({ status_code: IDL.Nat16, headers: IDL.Vec(header), body: blob, streaming_strategy: IDL.Opt(IDL.Variant({ Callback: IDL.Record({ callback: IDL.Func([token], [stream], ["query"]), token }) })), upgrade: IDL.Opt(IDL.Bool) });
const factory = () => IDL.Service({ http_request: IDL.Func([request], [response], ["query"]), http_streaming_callback: IDL.Func([token], [stream], ["query"]) });
type Header = [string, string];
type Token = { path: string; sha256: Uint8Array; grant: [] | [string]; index: bigint };
type Response = { status_code: number; headers: Header[]; body: Uint8Array; streaming_strategy: [] | [{ Callback: { callback: [{ toText(): string }, string]; token: Token } }]; upgrade: [] | [boolean] };
export type HttpReader = { http_request: (value: { method: string; url: string; headers: Header[]; body: Uint8Array; certificate_version: [number] }) => Promise<Response>; http_streaming_callback: (value: Token) => Promise<{ body: Uint8Array; token: [] | [Token] }> };
export const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export async function reader(canister: string, host: string, rootKeyFile?: string): Promise<{ actor: HttpReader; rootKey: Uint8Array }> {
  const url = new URL(host);
  const publicHost = url.origin === "https://icp-api.io" || url.origin === "https://ic0.app";
  if (!publicHost && !rootKeyFile) throw new Error("A non-mainnet replica host requires an explicit trusted root-key file.");
  const rootKey = rootKeyFile ? new Uint8Array(await readFile(rootKeyFile)) : undefined;
  const agent = await HttpAgent.create({ host: url.origin, ...(rootKey ? { rootKey } : {}) });
  if (!agent.rootKey) throw new Error("No trusted IC root key is configured.");
  return { actor: Actor.createActor(factory, { agent, canisterId: canister }) as unknown as HttpReader, rootKey: agent.rootKey };
}

// Read the HTTP interface directly and verify its assembled response ourselves.
// Query success or a gateway header alone is never treated as certification.
export async function download(options: { actor: HttpReader; canister: string; rootKey: Uint8Array; path: string; token: string; expectedDigest: string; maximumBytes?: number; nowNs?: bigint }): Promise<Uint8Array> {
  const { actor, canister, rootKey, path, token: credential, expectedDigest } = options;
  if (!/^\/repo\/v1\/(packages\/[0-9a-f]{64}\.neutron|sources\/[0-9a-f]{64}\.source\.v1\.msgpack\.gz)$/.test(path)) throw new Error("Noncanonical review artifact path.");
  if (!/^[0-9a-f]{64}$/.test(expectedDigest) || !/^[0-9a-f]{64}$/.test(credential)) throw new Error("Invalid digest or review credential.");
  const maximumBytes = options.maximumBytes ?? REPOSITORY_LIMITS.packageBytes;
  const req = { method: "GET", url: path, headers: [["Authorization", `Bearer ${credential}`]] as Header[], body: new Uint8Array(), certificate_version: [2] as [number] };
  const first = await actor.http_request(req);
  if (first.upgrade[0]) throw new Error("Review artifact requested an unexpected HTTP update.");
  const chunks = [Uint8Array.from(first.body)];
  let size = first.body.length;
  if (size > maximumBytes) throw new Error("Review artifact exceeds the supported package/source size.");
  let next = first.streaming_strategy[0]?.Callback;
  let previousIndex = -1n;
  while (next) {
    if (next.callback[0].toText() !== canister || next.callback[1] !== "http_streaming_callback") throw new Error("Review streaming callback points outside the selected protocol.");
    if (next.token.path !== path || sha256Hex(next.token.sha256) !== expectedDigest || next.token.grant[0] !== credential || next.token.index <= previousIndex) throw new Error("Review stream changed its authorized artifact or did not progress.");
    previousIndex = next.token.index;
    const part = await actor.http_streaming_callback(next.token);
    if (part.body.length === 0 && part.token.length) throw new Error("Review stream made no progress.");
    size += part.body.length;
    if (size > maximumBytes) throw new Error("Review artifact exceeds the supported package/source size.");
    chunks.push(Uint8Array.from(part.body));
    next = part.token[0] ? { callback: next.callback, token: part.token[0] } : undefined;
  }
  const body = Uint8Array.from(Buffer.concat(chunks));
  const verified = verifyRequestResponsePair(req, { status_code: first.status_code, headers: first.headers, body }, Principal.fromText(canister).toUint8Array(), options.nowNs ?? BigInt(Date.now()) * 1_000_000n, 300_000_000_000n, rootKey, 2);
  if (verified.verificationVersion !== 2 || !verified.response || first.status_code !== 200) throw new Error(`No certified successful review artifact response (HTTP ${first.status_code}).`);
  if (sha256(body) !== expectedDigest) throw new Error("The review artifact digest differs from the exact candidate.");
  return body;
}
function sha256Hex(value: Uint8Array): string { return Buffer.from(value).toString("hex"); }
