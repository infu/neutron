import { IDL } from "@dfinity/candid";
import { decodeSelfCallValue } from "neutron-tools/app";
import { encodeSelfCallResult, normalizeSelfCallResult, preflightSelfCallReply } from "../../kernel/src/self_calls.ts";

export const blobType = IDL.Vec(IDL.Nat8);
export const stateType = IDL.Record({ owner: IDL.Principal, seed: IDL.Opt(blobType) });
export const stateResultType = IDL.Variant({ ok: stateType, err: IDL.Text });
export const textResultType = IDL.Variant({ ok: IDL.Text, err: IDL.Text });
export const blobResultType = IDL.Variant({ ok: blobType, err: IDL.Text });
export const draftType = IDL.Opt(blobType);
export const draftPageType = IDL.Record({ items: IDL.Vec(IDL.Record({ id: IDL.Text, value: blobType })), nextCursor: IDL.Opt(IDL.Text) });

/** The real self-call reply path: raw Candid is metered and decoded, Kernel
 * normalizes API-1 values, binary leaves travel as sidecars, and the app SDK
 * restores them. In particular, absent optional record fields disappear. */
export function kernelBoundary(type: IDL.Type, value: unknown) {
  const raw = new Uint8Array(IDL.encode([type], [value]));
  preflightSelfCallReply(raw, type);
  const decoded = IDL.decode([type], raw)[0];
  const normalized = normalizeSelfCallResult(decoded, type);
  const framed = encodeSelfCallResult(normalized);
  return decodeSelfCallValue(framed.value, framed.blobs);
}
