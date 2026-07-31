import { IDL } from "@dfinity/candid";

type LiveCandidTarget = {
  $idlFactory?: (args: { IDL: typeof IDL }) => IDL.ServiceClass;
};

/**
 * Derive presentation-only read/change semantics from the same live Candid
 * interface used to validate the call. If that trusted metadata is unavailable
 * or malformed, the consent UI must use its conservative unknown-action copy.
 */
export function verifiedCallMode(
  target: LiveCandidTarget,
  method: string,
): "query" | "update" | undefined {
  if (typeof target.$idlFactory !== "function") return undefined;
  try {
    const service = target.$idlFactory({ IDL });
    const candidMethod = service._fields.find(([name]) => name === method)?.[1];
    if (!(candidMethod instanceof IDL.FuncClass)) return undefined;
    return candidMethod.annotations.includes("query") ||
      candidMethod.annotations.includes("composite_query")
      ? "query"
      : "update";
  } catch {
    return undefined;
  }
}
