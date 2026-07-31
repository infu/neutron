import { assertIsolatedSameNamedSlots, compactHex } from "./evidence";

export type LocalPublicRoot = {
  appId: string;
  slot: string;
  slotUid: string;
  canisterPrincipal: string;
  generation: string;
  publicKey: number[];
  publicFingerprint: number[];
  derivationInput: number[];
};

export type IsolationReport = {
  canisterPrincipal: string;
  slot: string;
  first: {
    appId: string;
    slotUid: string;
    generation: string;
    publicFingerprint: string;
    publicRoot: string;
  };
  second: {
    appId: string;
    slotUid: string;
    generation: string;
    publicFingerprint: string;
    publicRoot: string;
  };
  isolated: true;
};

export function createIsolationReport(
  first: LocalPublicRoot,
  second: LocalPublicRoot,
): IsolationReport {
  if (
    first.canisterPrincipal !== second.canisterPrincipal ||
    first.canisterPrincipal.length < 3
  ) {
    throw new Error("Isolation roots must come from the same Neutron canister");
  }
  assertIsolatedSameNamedSlots(first, second);
  return {
    canisterPrincipal: first.canisterPrincipal,
    slot: first.slot,
    first: summarize(first),
    second: summarize(second),
    isolated: true,
  };
}

function summarize(value: LocalPublicRoot): IsolationReport["first"] {
  return {
    appId: value.appId,
    slotUid: value.slotUid,
    generation: value.generation,
    publicFingerprint: compactHex(value.publicFingerprint),
    publicRoot: compactHex(value.publicKey),
  };
}
