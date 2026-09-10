import { Ed25519KeyIdentity } from "@dfinity/identity";
import { Principal } from "@dfinity/principal";
import type { MsgBusToolContext, SelfCallValue } from "neutron-tools/app";

export type Kernel = MsgBusToolContext["kernel"];
export type StoredState = { seed: Uint8Array | null; canisterId: string | null; host: string; owner: string; revision: number };
export function unwrap(value: unknown): unknown {
  if (value && typeof value === "object" && "err" in value) throw new Error(String((value as { err: unknown }).err));
  return value && typeof value === "object" && "ok" in value ? (value as { ok: unknown }).ok : value;
}
export function optional(value: unknown): unknown { return Array.isArray(value) ? value.length ? value[0] : null : value ?? null; }
export function bytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (Array.isArray(value) && value.every(v => Number.isInteger(v) && v >= 0 && v <= 255)) return Uint8Array.from(value);
  throw new Error("The marketplace returned an invalid binary value.");
}
export function parseState(value: unknown): StoredState {
  const record = unwrap(value) as Record<string, unknown>;
  if (!record || typeof record !== "object" || typeof record.host !== "string" || typeof record.owner !== "string") throw new Error("The saved marketplace configuration is unavailable.");
  const seedValue = record.seed instanceof Uint8Array || record.seed instanceof ArrayBuffer ||
    (Array.isArray(record.seed) && record.seed.length === 32 && record.seed.every(v => Number.isInteger(v)))
    ? record.seed : optional(record.seed);
  const seed = seedValue === null ? null : bytes(seedValue);
  if (seed !== null && seed.length !== 32) throw new Error("The saved marketplace read key is invalid. Its stored value has not been replaced.");
  const canister = optional(record.canister);
  if (canister !== null && typeof canister !== "string") throw new Error("The saved marketplace canister is invalid.");
  const revision = Number(record.revision);
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("The saved marketplace revision is invalid.");
  Principal.fromText(record.owner);
  return { seed, canisterId: canister, owner: record.owner, host: record.host, revision };
}
export function validateHost(host: string): string {
  const url = new URL(host);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) throw new Error("Use HTTPS, or HTTP on localhost for a local protocol.");
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) throw new Error("Enter the replica origin without credentials, a path or query.");
  return url.origin;
}
export async function readState(kernel: Kernel): Promise<StoredState> {
  return parseState(await kernel.querySelf("marketplace_state", [null]));
}
export async function readIdentity(kernel: Kernel): Promise<{ state: StoredState; identity: Ed25519KeyIdentity }> {
  let state = await readState(kernel);
  if (!state.seed) {
    const generated = Ed25519KeyIdentity.generate();
    const seed = new Uint8Array(generated.getKeyPair().secretKey).slice(0, 32);
    state = parseState(await kernel.updateSelf("marketplace_initialize", [seed]));
  }
  if (!state.seed) throw new Error("The Neutron did not confirm the saved browser read identity.");
  return { state, identity: Ed25519KeyIdentity.generate(state.seed) };
}
export async function configureState(kernel: Kernel, input: { canisterId: string; host: string }): Promise<StoredState> {
  const canister = Principal.fromText(input.canisterId);
  if (canister.isAnonymous()) throw new Error("Enter the marketplace protocol canister ID.");
  return parseState(await kernel.updateSelf("marketplace_configure", [{ canister: canister.toText(), host: validateHost(input.host) }]));
}
export async function saveIntent(kernel: Kernel, id: string, value: unknown): Promise<void> {
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  unwrap(await kernel.updateSelf("marketplace_save_draft", [{ id, value: encoded }]));
}
export async function reviseIntent(kernel: Kernel, id: string, expected: unknown, value: unknown): Promise<void> {
  const previous = new TextEncoder().encode(JSON.stringify(expected));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", previous));
  const revision = [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("");
  unwrap(await kernel.updateSelf("marketplace_revise_draft", [{ id, expected: previous, value: new TextEncoder().encode(JSON.stringify(value)), revision }]));
}
export async function loadIntent<T>(kernel: Kernel, id: string): Promise<T | null> {
  const reply = optional(await kernel.querySelf<SelfCallValue>("marketplace_draft", [id]));
  if (reply === null) return null;
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes(reply))) as T;
}
export async function listIntents<T>(kernel: Kernel): Promise<Array<{ id: string; value: T }>> {
  const result: Array<{ id: string; value: T }> = [];
  let cursor: string | null = null;
  do {
    const reply = await kernel.querySelf<SelfCallValue>("marketplace_drafts", [{ cursor, limit: "16" }]);
    if (!reply || typeof reply !== "object" || Array.isArray(reply)) throw new Error("The saved marketplace intents are invalid.");
    const page = reply as { items: Array<{ id: string; value: unknown }>; nextCursor?: SelfCallValue };
    if (!Array.isArray(page.items)) throw new Error("The saved marketplace intent page is invalid.");
    for (const row of page.items) result.push({ id: row.id, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes(row.value))) as T });
    const next = optional(page.nextCursor);
    if (next !== null && (typeof next !== "string" || next === cursor)) throw new Error("The marketplace intent cursor did not advance.");
    cursor = next;
  } while (cursor !== null);
  return result;
}
