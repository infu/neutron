import { type JsonValue, type SelfCallValue, type SelfCallObject } from "neutron-tools/app";

type Query = (method: string, args: SelfCallValue[]) => Promise<unknown>;

/** Shared read entry point; the released individual owner APIs remain available. */
export async function queryWalletRead(
  query: Query,
  kind: "snapshot" | "catalog",
): Promise<JsonValue> {
  const result = await query("wallet_read_v1", [{ [kind]: null }]);
  if (!result || typeof result !== "object" || Array.isArray(result) || !(kind in result)) {
    throw new Error(`Invalid Wallet ${kind} response`);
  }
  return (result as Record<string, JsonValue>)[kind]!;
}

/** Additive query variants share Wallet's existing installed read permission. */
export async function queryWalletReview(
  query: Query,
  kind: "funding_preview" | "token_info_preview",
  request: SelfCallObject,
): Promise<JsonValue> {
  const result = await query("wallet_read_v1", [{ [kind]: request }]);
  if (!result || typeof result !== "object" || Array.isArray(result) || !(kind in result)) throw new Error(`Invalid Wallet ${kind} response`);
  const outcome = (result as Record<string, unknown>)[kind];
  if (!outcome || typeof outcome !== "object" || Array.isArray(outcome) || Object.keys(outcome).length !== 1) throw new Error(`Invalid Wallet ${kind} result`);
  if ("err" in outcome && typeof outcome.err === "string") throw new Error(outcome.err);
  if (!("ok" in outcome)) throw new Error(`Invalid Wallet ${kind} result`);
  return outcome.ok as JsonValue;
}
