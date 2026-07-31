import {
  getMailCryptoStatus,
  getMailEncryptedList,
  getMailEncryptedSettings,
  rewrapMailCrypto,
  MailBackendCryptoError,
  type MailBackendCryptoProgress,
  type MailBackendEncryptedHeader,
  type MailBackendEncryptedListItem,
  type MailCryptoRewrapTarget,
} from "./backend.ts";
import type { MailCryptoWorkerClient } from "./crypto_worker_client.ts";
import { MailCryptoWorkerClientError } from "./crypto_worker_client.ts";
import type { MailCryptoWorkerResult, MailWorkerLocalWrap } from "./crypto_worker.ts";
import type { MailCryptoResidentSession } from "./mail_crypto_session.ts";
import type { MailFolder } from "./model.ts";

export const MAIL_CRYPTO_MIGRATE_TOOL = "mail_crypto_migrate";
export const MAIL_CRYPTO_REWRAP_BATCH_MAX = 50;
export const MAIL_CRYPTO_SCAN_PAGES_PER_STEP = 4;

export type MailRotationErrorCode =
  | "not_rotating"
  | "current_locked"
  | "previous_locked"
  | "capability_changed"
  | "conflict"
  | "unavailable";

export class MailRotationError extends Error {
  constructor(public readonly code: MailRotationErrorCode, message: string) {
    super(message);
    this.name = "MailRotationError";
  }
}

export type MailRotationStep = {
  version: 1;
  changed: string;
  scanned: string;
  scanComplete: boolean;
  progress: MailBackendCryptoProgress;
};

type RotationWorkerPort = Pick<MailCryptoWorkerClient, "rewrap">;

export type MailRotationDependencies = {
  status: typeof getMailCryptoStatus;
  session: Pick<MailCryptoResidentSession, "status">;
  settings: typeof getMailEncryptedSettings;
  list: typeof getMailEncryptedList;
  rewrap: typeof rewrapMailCrypto;
  worker: RotationWorkerPort;
};

type ScanCursor = {
  currentEpoch: string;
  previousEpoch: string;
  folderIndex: number;
  offset: string;
};

type Candidate = {
  target:
    | {
        kind: "settings";
        expectedRevision: string;
        expectedLocalWrappedCek: Uint8Array;
      }
    | {
        kind: "inbox" | "outbox";
        localId: string;
        expectedLocalWrappedCek: Uint8Array;
      };
  localWrap: MailWorkerLocalWrap;
};

const SCAN_FOLDERS: readonly MailFolder[] = ["inbox", "sent", "outbox"];

/**
 * Resident-only local-wrap migration. Each invocation scans at most four
 * ciphertext-header pages and commits at most fifty replacement wraps. Its
 * volatile cursor is an optimization only: a resident restart safely resumes
 * from the beginning while backend reference counts remain authoritative.
 */
export class MailRotationResidentWorkflow {
  readonly #dependencies: MailRotationDependencies;
  #cursor: ScanCursor | null = null;
  #running: Promise<MailRotationStep> | null = null;

  constructor(dependencies: MailRotationDependencies) {
    this.#dependencies = dependencies;
  }

  migrateStep(): Promise<MailRotationStep> {
    if (this.#running) return this.#running;
    const operation = this.#migrateStepNow().finally(() => {
      if (this.#running === operation) this.#running = null;
    });
    this.#running = operation;
    return operation;
  }

  reset(): void {
    this.#cursor = null;
  }

  async #migrateStepNow(): Promise<MailRotationStep> {
    const progress = await this.#requireProgress();
    const previousEpoch = progress.previousEpoch;
    if (previousEpoch === null) {
      this.#cursor = null;
      throw new MailRotationError("not_rotating", "Mail has no previous key to migrate");
    }
    if (progress.readyToRetire) {
      this.#cursor = null;
      return step("0", "0", true, progress);
    }
    await this.#requireBothGenerationsWithRetry(progress);

    if (
      this.#cursor === null ||
      this.#cursor.currentEpoch !== progress.currentEpoch ||
      this.#cursor.previousEpoch !== previousEpoch
    ) {
      this.#cursor = initialCursor(progress.currentEpoch, previousEpoch);
    }

    const candidates: Candidate[] = [];
    let scanned = 0;
    let scanPages = 0;

    if (progress.previousReferences.settings !== "0") {
      const settings = await this.#dependencies.settings();
      if (settings === null) throw conflict("Mail settings changed during key migration");
      if (settings.localWrapEpoch === previousEpoch) {
        candidates.push({
          target: {
            kind: "settings",
            expectedRevision: settings.revision,
            expectedLocalWrappedCek: settings.localWrappedCek.slice(),
          },
          localWrap: {
            epoch: settings.localWrapEpoch,
            fingerprint: settings.localWrapFingerprint.slice(),
            wrappedCek: settings.localWrappedCek.slice(),
          },
        });
      }
    }

    while (
      candidates.length < MAIL_CRYPTO_REWRAP_BATCH_MAX &&
      scanPages < MAIL_CRYPTO_SCAN_PAGES_PER_STEP &&
      this.#cursor.folderIndex < SCAN_FOLDERS.length
    ) {
      const folder = SCAN_FOLDERS[this.#cursor.folderIndex]!;
      if (skipFolder(folder, progress)) {
        advanceFolder(this.#cursor);
        continue;
      }
      const page = await this.#dependencies.list({
        folder,
        unreadOnly: false,
        offset: this.#cursor.offset,
        limit: 50,
        expectedRevision: null,
        expectedContactsRevision: null,
      });
      scanPages += 1;
      scanned += page.items.length;
      for (const item of page.items) {
        if (
          candidates.length >= MAIL_CRYPTO_REWRAP_BATCH_MAX ||
          item.encryptedHeader.localWrapEpoch !== previousEpoch
        ) continue;
        candidates.push(candidateFromItem(item));
      }
      if (page.nextOffset === null) {
        advanceFolder(this.#cursor);
      } else {
        this.#cursor.offset = page.nextOffset;
      }
    }

    const scanComplete = this.#cursor.folderIndex >= SCAN_FOLDERS.length;
    if (candidates.length === 0) {
      if (scanComplete) this.#cursor = null;
      return step("0", String(scanned), scanComplete, progress);
    }

    let targets: MailCryptoRewrapTarget[];
    try {
      targets = await mapBounded(candidates, 4, async (candidate) => {
        const result = expectWorkerResult(
          await this.#dependencies.worker.rewrap(candidate.localWrap),
          "rewrapped",
        );
        if (
          result.localWrap.epoch !== progress.currentEpoch ||
          sameBytes(result.localWrap.wrappedCek, candidate.localWrap.wrappedCek)
        ) throw new MailCryptoWorkerClientError("authentication_failed");
        return {
          ...candidate.target,
          replacementLocalWrappedCek: result.localWrap.wrappedCek.slice(),
        } as MailCryptoRewrapTarget;
      });
    } catch (error) {
      if (error instanceof MailCryptoWorkerClientError && error.code === "locked") {
        throw new MailRotationError(
          "previous_locked",
          "The previous Mail key is still preparing. Try again.",
        );
      }
      throw unavailable("Mail could not rewrap its local keys", error);
    }

    await this.#requireBothGenerationsWithRetry(progress);
    try {
      const committed = await this.#dependencies.rewrap({
        expectedCurrentEpoch: progress.currentEpoch,
        expectedPreviousEpoch: previousEpoch,
        targets,
      });
      if (
        committed.changed !== String(targets.length) ||
        committed.progress.currentEpoch !== progress.currentEpoch ||
        committed.progress.previousEpoch !== previousEpoch
      ) throw unavailable("Mail returned an invalid key migration result");
      if (committed.progress.readyToRetire) this.#cursor = null;
      return step(
        committed.changed,
        String(scanned),
        committed.progress.readyToRetire || scanComplete,
        committed.progress,
      );
    } catch (error) {
      this.#cursor = null;
      if (error instanceof MailBackendCryptoError && error.code === "revision_conflict") {
        throw conflict("Mail changed during key migration; retry the batch");
      }
      if (error instanceof MailRotationError) throw error;
      throw unavailable("Mail could not commit its key migration", error);
    }
  }

  async #requireProgress(): Promise<MailBackendCryptoProgress> {
    try {
      const progress = await this.#dependencies.status();
      if (progress === null) {
        throw new MailRotationError("not_rotating", "Private Mail is not configured");
      }
      return progress;
    } catch (error) {
      if (error instanceof MailRotationError) throw error;
      throw unavailable("Mail key status is temporarily unavailable", error);
    }
  }

  async #requireBothGenerations(progress: MailBackendCryptoProgress): Promise<void> {
    let session;
    try {
      session = await this.#dependencies.session.status();
    } catch (error) {
      throw unavailable("Mail key access changed during migration", error, "capability_changed");
    }
    if (
      session.currentEpoch !== progress.currentEpoch ||
      session.previousEpoch !== progress.previousEpoch
    ) {
      throw new MailRotationError(
        "capability_changed",
        "Mail key generations changed; refresh before continuing",
      );
    }
    if (!session.currentUnlocked) {
      throw new MailRotationError("current_locked", "Private Mail is still preparing. Try again.");
    }
    if (!session.previousUnlocked) {
      throw new MailRotationError("previous_locked", "The previous Mail key is still preparing. Try again.");
    }
  }

  /**
   * Rotation changes the resident binding before both derived generations are
   * necessarily observable by the next task. Recover once inside the same
   * user action so that transient readiness never consumes a migration click.
   * A final failure drops the scan cursor: no later retry may skip candidates
   * that were scanned but not committed at the second readiness gate.
   */
  async #requireBothGenerationsWithRetry(
    progress: MailBackendCryptoProgress,
  ): Promise<void> {
    try {
      await this.#requireBothGenerations(progress);
      return;
    } catch (error) {
      if (!isReadinessRace(error)) {
        this.#cursor = null;
        throw error;
      }
    }

    try {
      await this.#requireBothGenerations(progress);
    } catch (error) {
      this.#cursor = null;
      throw error;
    }
  }
}

export function defaultMailRotationDependencies(input: {
  session: Pick<MailCryptoResidentSession, "status">;
  worker: RotationWorkerPort;
}): MailRotationDependencies {
  return {
    ...input,
    status: getMailCryptoStatus,
    settings: getMailEncryptedSettings,
    list: getMailEncryptedList,
    rewrap: rewrapMailCrypto,
  };
}

function initialCursor(currentEpoch: string, previousEpoch: string): ScanCursor {
  return { currentEpoch, previousEpoch, folderIndex: 0, offset: "0" };
}

function advanceFolder(cursor: ScanCursor): void {
  cursor.folderIndex += 1;
  cursor.offset = "0";
}

function skipFolder(folder: MailFolder, progress: MailBackendCryptoProgress): boolean {
  return folder === "inbox"
    ? progress.previousReferences.inbox === "0"
    : progress.previousReferences.outbox === "0";
}

function candidateFromItem(item: MailBackendEncryptedListItem): Candidate {
  const header = item.encryptedHeader;
  return {
    target: {
      kind: item.kind === "inbox" ? "inbox" : "outbox",
      localId: item.localId,
      expectedLocalWrappedCek: header.localWrappedCek.slice(),
    },
    localWrap: localWrap(header),
  };
}

function localWrap(header: MailBackendEncryptedHeader): MailWorkerLocalWrap {
  return {
    epoch: header.localWrapEpoch,
    fingerprint: header.localWrapFingerprint.slice(),
    wrappedCek: header.localWrappedCek.slice(),
  };
}

function step(
  changed: string,
  scanned: string,
  scanComplete: boolean,
  progress: MailBackendCryptoProgress,
): MailRotationStep {
  return { version: 1, changed, scanned, scanComplete, progress };
}

function conflict(message: string): MailRotationError {
  return new MailRotationError("conflict", message);
}

function unavailable(
  message: string,
  _cause?: unknown,
  code: MailRotationErrorCode = "unavailable",
): MailRotationError {
  return new MailRotationError(code, message);
}

function isReadinessRace(error: unknown): error is MailRotationError {
  return error instanceof MailRotationError && (
    error.code === "capability_changed" ||
    error.code === "current_locked" ||
    error.code === "previous_locked"
  );
}

function expectWorkerResult<T extends MailCryptoWorkerResult["type"]>(
  result: MailCryptoWorkerResult,
  type: T,
): Extract<MailCryptoWorkerResult, { type: T }> {
  if (result.type !== type) throw new MailCryptoWorkerClientError("crypto_unavailable");
  return result as Extract<MailCryptoWorkerResult, { type: T }>;
}

async function mapBounded<Input, Output>(
  values: readonly Input[],
  concurrency: number,
  operation: (value: Input) => Promise<Output>,
): Promise<Output[]> {
  const output = new Array<Output>(values.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      output[index] = await operation(values[index]!);
    }
  });
  await Promise.all(runners);
  return output;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength &&
    left.every((value, index) => value === right[index]);
}
