import { scopedPhysicalStem } from "neutron-tools/src/physical_names.js";

/**
 * Compiler-owned physical namespace for one app-local managed-memory root.
 * Logical memory ids remain unchanged in manifests, runtime inventory, and the
 * app's projected backend environment.
 */
export function managedMemoryPhysicalStem(
  owner: string,
  memoryId: string,
): string {
  return scopedPhysicalStem(owner, memoryId);
}

export function managedMemoryStoreName(
  owner: string,
  memoryId: string,
): string {
  return `NeutronMemoryStore_${managedMemoryPhysicalStem(owner, memoryId)}`;
}

export function retiredManagedMemoryStoreName(
  owner: string,
  memoryId: string,
): string {
  return `NeutronRetiredMemoryStore_${managedMemoryPhysicalStem(owner, memoryId)}`;
}

/** Motoko data-loss diagnostics quote the compiler-emitted stable field. */
export const MANAGED_MEMORY_STORE_NAME_PATTERN =
  /Neutron(?:Retired)?MemoryStore_a[0-9]+_[A-Za-z0-9_]+_r[0-9]+_[A-Za-z0-9_]+/g;
