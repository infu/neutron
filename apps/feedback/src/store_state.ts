import { Ed25519KeyIdentity } from "@dfinity/identity";
import { Principal } from "@dfinity/principal";
import type { MsgBusToolContext } from "neutron-tools/app";
export type Kernel = MsgBusToolContext["kernel"];
export type StoredState = { seed: Uint8Array | null; owner: string };
export function unwrap(value: unknown): unknown {
  if (value && typeof value === "object" && "err" in value) throw new Error(String(value.err));
  return value && typeof value === "object" && "ok" in value ? value.ok : value;
}
export function bytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (Array.isArray(value) && value.every(v => Number.isInteger(v) && v >= 0 && v <= 255)) return Uint8Array.from(value);
  throw new Error("Feedback returned an invalid binary value.");
}
export function parseState(value: unknown): StoredState {
  const record = unwrap(value);
  if (!record || typeof record !== "object" || !("owner" in record) || typeof record.owner !== "string") throw new Error("Feedback could not read its saved settings. Please retry.");
  Principal.fromText(record.owner);
  // API-1 omits absent Candid optional record fields. A present optional
  // blob is the direct Uint8Array restored from its binary sidecar.
  const raw = (record as { seed?: unknown }).seed;
  let seed: Uint8Array | null;
  try { seed = raw == null ? null : bytes(raw); }
  catch { throw new Error("Your saved Feedback read key is invalid. Its stored value has been preserved."); }
  if (seed && seed.length !== 32) throw new Error("Your saved Feedback read key is invalid. Its stored value has been preserved.");
  return { owner: record.owner, seed };
}
export async function readIdentity(kernel: Kernel): Promise<{ state: StoredState; identity: Ed25519KeyIdentity }> {
  let state = parseState(await kernel.querySelf("feedback_state", [null]));
  if (!state.seed) {
    const generated = Ed25519KeyIdentity.generate();
    state = parseState(await kernel.updateSelf("feedback_initialize", [new Uint8Array(generated.getKeyPair().secretKey).slice(0, 32)], 0));
  }
  if (!state.seed) throw new Error("Your Neutron did not confirm its saved Feedback read key.");
  return { state, identity: Ed25519KeyIdentity.generate(state.seed) };
}
/** The backend saves these bytes once, before any send. Reusing a request ID
 * with different content is rejected there, including after resident reload. */
function intent(requestId: string, method: string, args: unknown) {
  return { id: `request:${requestId}`, value: new TextEncoder().encode(JSON.stringify({ method, args })) };
}
export async function saveIntent(kernel: Kernel, requestId: string, method: string, args: unknown): Promise<void> {
  if (!requestId) throw new Error("Keep a request ID with this message so a retry cannot send it twice.");
  unwrap(await kernel.updateSelf("feedback_save_draft", [intent(requestId, method, args)], 0));
}

/** Protocol idempotency retains the final message and exact request inputs.
 * Only a confirmed send permits journal cleanup; an unknown outcome stays. */
export async function completeIntent(kernel: Kernel, requestId: string, method: string, args: unknown): Promise<void> {
  unwrap(await kernel.updateSelf("feedback_complete_draft", [intent(requestId, method, args)], 0));
}

export type StoredIntent = { id: string; value: unknown };
function jsonBytes(value: unknown): unknown { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes(value))); }
export async function loadIntent(kernel: Kernel, requestId: string): Promise<unknown | null> {
  const value = await kernel.querySelf("feedback_draft", [`request:${requestId}`]);
  return value == null ? null : jsonBytes(value);
}
export async function listIntents(kernel: Kernel, cursor?: string): Promise<{ items: StoredIntent[]; nextCursor: string | null }> {
  let limit = 30;
  let raw: Awaited<ReturnType<Kernel["querySelf"]>>;
  for (;;) {
    try {
      raw = await kernel.querySelf("feedback_drafts", [{ cursor: cursor ?? null, limit: String(limit) }]);
      break;
    } catch (error) {
      // Long saved messages can exceed the existing private self-call binary
      // envelope before their page reaches this app. Retry the same cursor
      // with fewer whole entries only for that transport's size-limit errors.
      const message = error instanceof Error ? error.message : String(error);
      const oversized = /(?:Candid reply|Self-call (?:reply|result|response)).*(?:exceeds|too large|limit)/iu.test(message);
      if (!oversized || limit === 1) throw error;
      limit = Math.max(1, Math.floor(limit / 2));
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !("items" in raw) || !Array.isArray(raw.items)) throw new Error("Your saved Feedback requests could not be read.");
  const next = (raw as { nextCursor?: unknown }).nextCursor ?? null;
  if (next !== null && (typeof next !== "string" || next === cursor)) throw new Error("Your saved Feedback request page has an invalid continuation.");
  const items = raw.items.map(row => {
    if (!row || typeof row !== "object" || Array.isArray(row) || !("id" in row) || typeof row.id !== "string" || !("value" in row)) throw new Error("A saved Feedback request is invalid. Its content has been preserved.");
    return { id: row.id, value: jsonBytes(row.value) };
  });
  return { items, nextCursor: next as string | null };
}
