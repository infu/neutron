// All rights reserved. See ../LICENSE.
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export const blob = IDL.Vec(IDL.Nat8);
export const result = (type: IDL.Type) => IDL.Variant({ ok: type, err: IDL.Record({ code: IDL.Text, message: IDL.Text }) });
export const Candidate = IDL.Record({ id: IDL.Nat64, appId: IDL.Text, version: IDL.Nat, publisher: IDL.Principal, requestId: IDL.Text, listingRevision: IDL.Nat64, artifactId: IDL.Nat64, sourceArtifactId: IDL.Opt(IDL.Nat64), digest: blob, sourceDigest: IDL.Opt(blob), dependencies: IDL.Vec(IDL.Record({ appId: IDL.Text, minVersion: IDL.Nat })), state: IDL.Variant({ pending: IDL.Null, approved: IDL.Null, rejected: IDL.Null, revoked: IDL.Null }), published: IDL.Bool, createdAtNs: IDL.Int, updatedAtNs: IDL.Int });
export const PageRequest = IDL.Record({ cursor: IDL.Opt(IDL.Nat64), limit: IDL.Nat });
export const CandidatePage = result(IDL.Record({ candidates: IDL.Vec(Candidate), nextCursor: IDL.Opt(IDL.Nat64) }));
export const AuditRequest = IDL.Record({ requestId: IDL.Text, candidateId: IDL.Nat64, expectedDigest: blob, expectedSourceDigest: IDL.Opt(blob), decision: IDL.Variant({ approved: IDL.Null, rejected: IDL.Null, revoked: IDL.Null }), analysis: IDL.Text, reason: IDL.Opt(IDL.Text) });
export const Audit = IDL.Record({ id: IDL.Nat64, auditor: IDL.Principal, requestId: IDL.Text, candidateId: IDL.Nat64, decision: IDL.Variant({ approved: IDL.Null, rejected: IDL.Null, revoked: IDL.Null }), analysis: IDL.Text, reason: IDL.Opt(IDL.Text), createdAtNs: IDL.Int });
export const AccessRequest = IDL.Record({ request_id: IDL.Text, token: IDL.Text, paths: IDL.Vec(IDL.Text), fee_version: IDL.Nat });
export const AccessReply = result(IDL.Record({ request_id: IDL.Text, paths: IDL.Vec(IDL.Text), accepted_cycles: IDL.Nat }));
export const RelayRequest = IDL.Record({ canister: IDL.Principal, method: IDL.Text, args: blob, cycles: IDL.Nat });
export const RelayReply = IDL.Variant({ ok: blob, err: IDL.Text });
export type CandidateValue = { id: bigint; appId: string; version: bigint; publisher: Principal; artifactId: bigint; sourceArtifactId: [] | [bigint]; digest: Uint8Array; sourceDigest: [] | [Uint8Array]; dependencies: { appId: string; minVersion: bigint }[]; state: Record<string, null> };
export type Target = { canister: string; identity: string; network: string; rootKeyFile?: string; candid?: string };
export type Run = (args: string[]) => Promise<string>;
export function encode(type: IDL.Type, value: unknown): Uint8Array { return new Uint8Array(IDL.encode([type], [value])); }
export function decode<T>(type: IDL.Type, bytes: Uint8Array): T { return IDL.decode([type], bytes)[0] as T; }
export function unwrap<T>(value: { ok: T } | { err: { code: string; message: string } }): T { if ("err" in value) throw new Error(`${value.err.code}: ${value.err.message}`); return value.ok; }
export function principal(value: string): string { const p = Principal.fromText(value); if (p.isAnonymous()) throw new Error("An authenticated canister/principal is required."); return p.toText(); }
export function natural(value: string, label: string): bigint { if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`${label} must be an unsigned decimal integer.`); return BigInt(value); }
export function json(value: unknown): string { return JSON.stringify(value, (_key, v) => typeof v === "bigint" ? v.toString() : v instanceof Uint8Array ? [...v] : v && typeof v.toText === "function" ? v.toText() : v && typeof v.__principal__ === "string" ? v.__principal__ : v, 2) + "\n"; }
export function runIcp(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("icp", args, { stdio: ["inherit", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += String(chunk); });
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve(stdout) : reject(new Error(`icp call failed (${code}): ${stderr.slice(-4000)}`)));
  });
}
// Credentials are passed in a private binary file, never process arguments or logs.
export async function call(target: Target, method: string, args: Uint8Array, query: boolean, run: Run = runIcp): Promise<Uint8Array> {
  principal(target.canister);
  if (!target.identity.trim()) throw new Error("Select an explicit icp identity.");
  if (!target.network.trim()) throw new Error("Select an explicit network.");
  const directory = await mkdtemp(path.join(tmpdir(), "marketplace-call-"));
  try {
    const file = path.join(directory, "args.bin");
    await writeFile(file, args, { mode: 0o600 });
    const command = ["canister", "call", target.canister, method, "--args-file", file, "--args-format", "bin", "--output", "hex", "--identity", target.identity, "--network", target.network];
    if (target.rootKeyFile) command.push("--root-key", target.rootKeyFile);
    if (target.candid) command.push("--candid", target.candid);
    if (query) command.push("--query");
    const output = (await run(command)).trim().replace(/^0x/, "");
    if (!/^[0-9a-fA-F]+$/.test(output) || output.length % 2 !== 0) throw new Error("icp returned a non-hexadecimal call response.");
    return Uint8Array.from(Buffer.from(output, "hex"));
  } finally { await rm(directory, { recursive: true, force: true }); }
}
export const ADMIN_METHODS = new Set(["admin_auditor_set", "admin_reserve_app", "admin_set_burn_account", "rates_refresh"]);
export async function adminCall(target: Target, method: string, args: Uint8Array, run?: Run): Promise<Uint8Array> {
  if (!ADMIN_METHODS.has(method)) throw new Error("This method is not a direct administrator marketplace update.");
  return call(target, method, args, false, run);
}
export const RELAY_METHODS = new Set(["read_delegate_set", "listing_save", "rating_set", "referral_get_or_create", "purchase", "withdraw", "upload_begin", "upload_chunk", "upload_finish", "candidate_submit", "install_prepare"]);
export async function relay(target: Target, neutron: string, method: string, args: Uint8Array, cycles: bigint, run?: Run): Promise<Uint8Array> {
  if (!RELAY_METHODS.has(method)) throw new Error("This method is not an ordinary cycle-paying marketplace update.");
  if (cycles <= 0n) throw new Error("Attach the reviewed positive cycle estimate through Neutron.");
  const bytes = encode(RelayRequest, { canister: Principal.fromText(principal(target.canister)), method, args, cycles });
  const response = decode<{ ok: Uint8Array } | { err: string }>(RelayReply, await call({ ...target, canister: principal(neutron), candid: undefined }, "marketplace_marketplace_call", bytes, false, run));
  if ("err" in response) throw new Error(response.err);
  return Uint8Array.from(response.ok);
}
