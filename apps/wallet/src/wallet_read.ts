import { type JsonValue, type SelfCallValue } from "neutron-tools/app";

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
