import type { Identity } from "@dfinity/agent";
import {
  loadExistingIdentity,
  type ExistingIcblastIdentity,
} from "icblast";

export type BlastIdentity = Omit<ExistingIcblastIdentity, "identity"> & {
  identity: Identity;
};

export function parseBlastIdentityId(value: string | number): number {
  const id = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(id) || id < 0 || id > 65_535) {
    throw new Error("--id must be an integer from 0 through 65535");
  }
  return id;
}

/**
 * Provisioning deliberately uses icblast's fail-closed loader. It never
 * generates a secret and never accepts the SECRET environment override.
 */
export async function loadExistingBlastIdentity(
  id: number,
): Promise<BlastIdentity> {
  return (await loadExistingIdentity(parseBlastIdentityId(id))) as BlastIdentity;
}
