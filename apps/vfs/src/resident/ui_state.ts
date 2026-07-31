import type { CanonicalNat64 } from "../protocol/types.ts";

export type FilesVaultLockReason =
  | "startup"
  | "idle"
  | "explicit"
  | "worker_failure"
  | "authority_changed";

export type FilesVaultState =
  | Readonly<{ status: "initializing"; lockEpoch: CanonicalNat64 }>
  | Readonly<{
      status: "locked";
      lockEpoch: CanonicalNat64;
      reason: FilesVaultLockReason;
      promptShown: boolean;
      error: string | null;
    }>
  | Readonly<{
      status: "unlocking";
      lockEpoch: CanonicalNat64;
      promptShown: true;
    }>
  | Readonly<{
      status: "ready";
      lockEpoch: CanonicalNat64;
      generation: CanonicalNat64;
      rotationRequired: boolean;
      error: string | null;
    }>
  | Readonly<{
      status: "rotating";
      lockEpoch: CanonicalNat64;
      generation: CanonicalNat64;
    }>
  | Readonly<{
      status: "unrecoverable";
      lockEpoch: CanonicalNat64;
      reason: string;
    }>;

export type FilesVaultEvent =
  | Readonly<{
      type: "bootstrap_locked";
      lockEpoch: CanonicalNat64;
      reason?: FilesVaultLockReason;
    }>
  | Readonly<{
      type: "bootstrap_ready";
      lockEpoch: CanonicalNat64;
      generation: CanonicalNat64;
      rotationRequired: boolean;
    }>
  | Readonly<{ type: "unlock_prompted"; lockEpoch: CanonicalNat64 }>
  | Readonly<{ type: "unlock_started"; lockEpoch: CanonicalNat64 }>
  | Readonly<{
      type: "unlock_succeeded";
      lockEpoch: CanonicalNat64;
      generation: CanonicalNat64;
      rotationRequired: boolean;
    }>
  | Readonly<{
      type: "unlock_failed";
      lockEpoch: CanonicalNat64;
      message: string;
    }>
  | Readonly<{
      type: "locked";
      nextLockEpoch: CanonicalNat64;
      reason: FilesVaultLockReason;
    }>
  | Readonly<{ type: "rotation_started"; lockEpoch: CanonicalNat64 }>
  | Readonly<{
      type: "rotation_succeeded";
      lockEpoch: CanonicalNat64;
      generation: CanonicalNat64;
    }>
  | Readonly<{
      type: "rotation_failed";
      lockEpoch: CanonicalNat64;
      message: string;
    }>
  | Readonly<{
      type: "unrecoverable";
      lockEpoch: CanonicalNat64;
      reason: string;
    }>;

export const INITIAL_FILES_VAULT_STATE: FilesVaultState = Object.freeze({
  status: "initializing",
  lockEpoch: "0" as CanonicalNat64,
});

export function reduceFilesVaultState(
  state: FilesVaultState,
  event: FilesVaultEvent,
): FilesVaultState {
  switch (event.type) {
    case "bootstrap_locked":
      if (state.status !== "initializing") return state;
      return Object.freeze({
        status: "locked",
        lockEpoch: event.lockEpoch,
        reason: event.reason ?? "startup",
        promptShown: false,
        error: null,
      });
    case "bootstrap_ready":
      if (state.status !== "initializing") return state;
      return readyState(event);
    case "unlock_prompted":
      if (
        state.status !== "locked" ||
        state.lockEpoch !== event.lockEpoch ||
        state.promptShown
      ) {
        return state;
      }
      return Object.freeze({ ...state, promptShown: true });
    case "unlock_started":
      if (
        state.status !== "locked" ||
        state.lockEpoch !== event.lockEpoch ||
        !state.promptShown
      ) {
        return state;
      }
      return Object.freeze({
        status: "unlocking",
        lockEpoch: state.lockEpoch,
        promptShown: true,
      });
    case "unlock_succeeded":
      if (
        state.status !== "unlocking" ||
        state.lockEpoch !== event.lockEpoch
      ) {
        return state;
      }
      return readyState(event);
    case "unlock_failed":
      if (
        state.status !== "unlocking" ||
        state.lockEpoch !== event.lockEpoch
      ) {
        return state;
      }
      return Object.freeze({
        status: "locked",
        lockEpoch: state.lockEpoch,
        reason: "startup",
        promptShown: true,
        error: event.message,
      });
    case "locked":
      if (state.status === "unrecoverable") return state;
      return Object.freeze({
        status: "locked",
        lockEpoch: event.nextLockEpoch,
        reason: event.reason,
        promptShown: false,
        error: null,
      });
    case "rotation_started":
      if (
        state.status !== "ready" ||
        state.lockEpoch !== event.lockEpoch
      ) {
        return state;
      }
      return Object.freeze({
        status: "rotating",
        lockEpoch: state.lockEpoch,
        generation: state.generation,
      });
    case "rotation_succeeded":
      if (
        state.status !== "rotating" ||
        state.lockEpoch !== event.lockEpoch
      ) {
        return state;
      }
      return Object.freeze({
        status: "ready",
        lockEpoch: state.lockEpoch,
        generation: event.generation,
        rotationRequired: false,
        error: null,
      });
    case "rotation_failed":
      if (
        state.status !== "rotating" ||
        state.lockEpoch !== event.lockEpoch
      ) {
        return state;
      }
      return Object.freeze({
        status: "ready",
        lockEpoch: state.lockEpoch,
        generation: state.generation,
        rotationRequired: true,
        error: event.message,
      });
    case "unrecoverable":
      if (state.lockEpoch !== event.lockEpoch) return state;
      return Object.freeze({
        status: "unrecoverable",
        lockEpoch: state.lockEpoch,
        reason: event.reason,
      });
  }
}

export type FilesTransferPhase =
  | "queued"
  | "hashing"
  | "encrypting"
  | "decrypting"
  | "uploading"
  | "downloading"
  | "checking-outcome"
  | "committed"
  | "cancelled"
  | "conflicted"
  | "failed"
  | "cleanup-pending";

export type FilesTransferKind =
  | "os-upload"
  | "tool-write"
  | "private-download";

export type FilesTransferItem = Readonly<{
  id: string;
  authorityEpoch: string;
  kind: FilesTransferKind;
  label: string;
  phase: FilesTransferPhase;
  completedBytes: number;
  totalBytes: number;
  error: string | null;
}>;

export type FilesTransferState = Readonly<{
  order: readonly string[];
  items: ReadonlyMap<string, FilesTransferItem>;
}>;

export type FilesTransferEvent =
  | Readonly<{ type: "enqueue"; item: FilesTransferItem }>
  | Readonly<{
      type: "transition";
      id: string;
      phase: FilesTransferPhase;
      error?: string;
    }>
  | Readonly<{
      type: "progress";
      id: string;
      completedBytes: number;
    }>
  | Readonly<{ type: "remove"; id: string }>
  | Readonly<{ type: "purge_authority"; authorityEpoch: string }>;

export const INITIAL_FILES_TRANSFER_STATE: FilesTransferState = Object.freeze({
  order: Object.freeze([]),
  items: new Map(),
});

const TRANSFER_TRANSITIONS: Readonly<
  Record<FilesTransferPhase, ReadonlySet<FilesTransferPhase>>
> = Object.freeze({
  queued: phaseSet("hashing", "decrypting", "cancelled", "failed"),
  hashing: phaseSet("encrypting", "uploading", "cancelled", "failed"),
  encrypting: phaseSet("uploading", "cancelled", "failed"),
  decrypting: phaseSet("downloading", "cancelled", "failed"),
  uploading: phaseSet(
    "checking-outcome",
    "committed",
    "cancelled",
    "conflicted",
    "failed",
    "cleanup-pending",
  ),
  downloading: phaseSet("committed", "cancelled", "conflicted", "failed"),
  "checking-outcome": phaseSet(
    "uploading",
    "committed",
    "cancelled",
    "conflicted",
    "failed",
    "cleanup-pending",
  ),
  committed: phaseSet(),
  cancelled: phaseSet("cleanup-pending"),
  conflicted: phaseSet(),
  failed: phaseSet("queued", "cleanup-pending"),
  "cleanup-pending": phaseSet("cancelled", "failed"),
});

export function reduceFilesTransferState(
  state: FilesTransferState,
  event: FilesTransferEvent,
): FilesTransferState {
  const items = new Map(state.items);
  switch (event.type) {
    case "enqueue": {
      if (items.has(event.item.id)) return state;
      assertTransfer(event.item);
      items.set(event.item.id, Object.freeze({ ...event.item }));
      return freezeTransferState([...state.order, event.item.id], items);
    }
    case "transition": {
      const item = items.get(event.id);
      if (!item) return state;
      if (!TRANSFER_TRANSITIONS[item.phase].has(event.phase)) return state;
      items.set(
        event.id,
        Object.freeze({
          ...item,
          phase: event.phase,
          error: event.error ?? null,
        }),
      );
      return freezeTransferState(state.order, items);
    }
    case "progress": {
      const item = items.get(event.id);
      if (
        !item ||
        !Number.isSafeInteger(event.completedBytes) ||
        event.completedBytes < item.completedBytes ||
        event.completedBytes > item.totalBytes
      ) {
        return state;
      }
      items.set(
        event.id,
        Object.freeze({ ...item, completedBytes: event.completedBytes }),
      );
      return freezeTransferState(state.order, items);
    }
    case "remove":
      if (!items.delete(event.id)) return state;
      return freezeTransferState(
        state.order.filter((id) => id !== event.id),
        items,
      );
    case "purge_authority": {
      for (const [id, item] of items) {
        if (item.authorityEpoch !== event.authorityEpoch) items.delete(id);
      }
      return freezeTransferState(
        state.order.filter((id) => items.has(id)),
        items,
      );
    }
  }
}

function readyState(input: {
  lockEpoch: CanonicalNat64;
  generation: CanonicalNat64;
  rotationRequired: boolean;
}): FilesVaultState {
  return Object.freeze({
    status: "ready",
    lockEpoch: input.lockEpoch,
    generation: input.generation,
    rotationRequired: input.rotationRequired,
    error: null,
  });
}

function assertTransfer(item: FilesTransferItem): void {
  if (
    !item.id ||
    !item.authorityEpoch ||
    !item.label ||
    !validCount(item.completedBytes) ||
    !validCount(item.totalBytes) ||
    item.completedBytes > item.totalBytes
  ) {
    throw new Error("Invalid Files transfer item");
  }
}

function freezeTransferState(
  order: readonly string[],
  items: Map<string, FilesTransferItem>,
): FilesTransferState {
  return Object.freeze({
    order: Object.freeze([...order]),
    items,
  });
}

function validCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function phaseSet(
  ...phases: FilesTransferPhase[]
): ReadonlySet<FilesTransferPhase> {
  return new Set<FilesTransferPhase>(phases);
}
