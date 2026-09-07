import { onAppStateChange, publishAppStateChange, querySelf, updateSelf, type SelfCallValue } from "neutron-tools/app";
import { hashContent } from "neutron-tools/src/hash.js";
import { unwrap } from "../data.ts";
import { parseDecoderPack, type DecoderPack } from "./descriptor.ts";
import type { ActiveDecoderPack } from "./registry.ts";

export type StoredDecoderPack = {
  id: string; version: string; name: string; documentJson: string; sha256: string;
  enabled: boolean; createdAtNs: string; updatedAtNs: string;
  pack: DecoderPack | null; error: string | null;
};
export type DecoderQuery = (method: string, args: SelfCallValue[]) => Promise<unknown>;
const methods = { list: "evm_wallet_decoder_packs_v1", set: "evm_wallet_decoder_set_v1", remove: "evm_wallet_decoder_remove_v1" } as const;
const listeners = new Set<() => void>();
let cached: StoredDecoderPack[] | null = null;
let pending: Promise<StoredDecoderPack[]> | null = null;
let generation = 0;
let listening = false;
const emit = () => { for (const listener of listeners) listener(); };

function followWalletState(): void {
  if (listening) return;
  onAppStateChange("evm_wallet", invalidateDecoderPacks);
  listening = true;
}

function parseStored(value: unknown): StoredDecoderPack {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid saved decoder pack");
  const row = value as Record<string, unknown>;
  for (const key of ["id", "version", "name", "document_json", "sha256", "created_at", "updated_at"]) if (typeof row[key] !== "string") throw new Error(`Invalid decoder ${key}`);
  if (typeof row.enabled !== "boolean") throw new Error("Invalid decoder enabled state");
  let pack: DecoderPack | null = null, error: string | null = null;
  try {
    if (hashContent(row.document_json as string) !== row.sha256) throw new Error("Saved decoder content does not match its digest");
    pack = parseDecoderPack(JSON.parse(row.document_json as string));
    if (pack.id !== row.id || pack.version !== row.version || pack.name !== row.name) throw new Error("Saved decoder identity does not match its document");
  } catch (reason) { pack = null; error = reason instanceof Error ? reason.message : String(reason); }
  return { id: row.id as string, version: row.version as string, name: row.name as string, documentJson: row.document_json as string,
    sha256: row.sha256 as string, enabled: row.enabled, createdAtNs: row.created_at as string, updatedAtNs: row.updated_at as string, pack, error };
}
async function read(query: DecoderQuery): Promise<StoredDecoderPack[]> {
  const result = unwrap(await query(methods.list, [null]));
  if (!result || typeof result !== "object" || !Array.isArray((result as { packs?: unknown }).packs)) throw new Error("Invalid saved decoder inventory");
  return (result as { packs: unknown[] }).packs.map(parseStored);
}
/** Invocation-scoped callers always read through their own Kernel client. */
export function readDecoderPacks(query?: DecoderQuery): Promise<StoredDecoderPack[]> {
  if (query) return read(query);
  followWalletState();
  if (cached) return Promise.resolve(cached);
  if (pending) return pending;
  const started = generation;
  const work = read(querySelf).then(packs => { if (started === generation) cached = packs; return packs; });
  pending = work;
  void work.finally(() => { if (pending === work) pending = null; }).catch(() => {});
  return work;
}
export function enabledDecoderPacks(packs: readonly StoredDecoderPack[]): ActiveDecoderPack[] {
  return packs.flatMap(row => row.enabled && row.pack && !row.error ? [{ pack: row.pack, sha256: row.sha256 }] : []);
}
export function subscribeDecoderPacks(listener: () => void): () => void {
  followWalletState();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function invalidateDecoderPacks(): void { generation++; cached = null; pending = null; emit(); }
function changedDecoderPacks(): void {
  invalidateDecoderPacks();
  // The local cache belongs to one tile. Notify other Wallet tiles and review
  // endpoints so they stop using removed, disabled or superseded definitions.
  // A failed refresh notification must not make a saved update appear failed.
  void publishAppStateChange("evm_wallet", Date.now()).catch(() => {});
}
async function store(documentJson: string, enabled: boolean): Promise<StoredDecoderPack> {
  const pack = parseDecoderPack(JSON.parse(documentJson));
  const saved = parseStored(unwrap(await updateSelf(methods.set, [{ id: pack.id, version: pack.version, name: pack.name, document_json: documentJson, sha256: hashContent(documentJson), enabled }])));
  changedDecoderPacks();
  return saved;
}
export const installDecoderPack = (documentJson: string): Promise<StoredDecoderPack> => store(documentJson, true);
export const setDecoderPackEnabled = (pack: StoredDecoderPack, enabled: boolean): Promise<StoredDecoderPack> => store(pack.documentJson, enabled);
export async function removeDecoderPack(id: string): Promise<boolean> {
  const result = unwrap(await updateSelf(methods.remove, [id]));
  if (typeof result !== "boolean") throw new Error("Invalid decoder removal result");
  changedDecoderPacks();
  return result;
}
