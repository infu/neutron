import { NATIVE_MIME, SPREADSHEET_LIMITS } from "./constants.ts";
import { createKitchenSinkWorkbook } from "./demo.ts";
import {
  type ApplyRequest,
  type ApplyResult,
  type HistoryResult,
  type ReadRangeResult,
  WorkbookEngine,
} from "./engine.ts";
import { type BinaryFileMetadata, type WorkbookFilesPort, UnavailableFilesPort } from "./file_ports.ts";
import type { XlsxCodecPort } from "./file_ports.ts";
import { exportCsv, importCsv, type CsvInjectionPolicy, type CsvTypingPolicy } from "./formats/csv.ts";
import { decodeNativeWorkbook, encodeNativeWorkbook, validateNativeWorkbook } from "./formats/native.ts";
import { createWorkbook, type SpreadsheetWorkbook } from "./model.ts";
import {
  type RecoveryPersistence,
  type RecoveryRecord,
  createIndexedDbRecoveryPersistence,
} from "./recovery.ts";

export type NativeSource = { path: string; etag: string; mediaType: string };
export type ImportProvenance = { path: string; etag: string; format: "csv" | "xlsx"; warnings: string[] };
export type AttachmentDelegationProvider = () => Promise<string | undefined>;

type AcceptedFileInput = {
  path: string;
  etag: string;
  mediaType: string;
  data: ArrayBuffer;
  /** Attachment-envelope metadata supplied by the Files tile handoff. */
  attachmentMediaType?: string;
  /** Attachment-envelope metadata supplied by the Files tile handoff. */
  byteLength?: number;
};

export type MutationEnvelope = {
  expectedRevision: number;
  commandId: string;
  signal?: AbortSignal;
};

export type SessionMutationResult = SessionStatus & {
  commandId: string;
  previousRevision: number;
};

export type RecoveryDisposition =
  | "source_exact"
  | "source_changed"
  | "source_deleted"
  | "no_source";

export type RecoveryResult = SessionMutationResult & {
  recoveryDisposition: RecoveryDisposition;
};

export type NativeSaveResult = {
  action: "native";
  commandId: string;
  revision: number;
  savedRevision: number;
  dirty: boolean;
  file: BinaryFileMetadata;
};

export type ExportFormat = "csv" | "xlsx";

export type ExportOptions = {
  format: ExportFormat;
  path: string;
  sheetId?: string;
  range?: string;
  csvInjectionPolicy?: CsvInjectionPolicy;
  bom?: boolean;
};

export type ExportPreflightResult = {
  action: "export_preflight";
  commandId: string;
  revision: number;
  format: ExportFormat;
  path: string;
  preflightToken: string;
  expiresAt: number;
  byteLength: number;
  warnings: string[];
  losses: Record<string, number>;
};

export type ExportCommitResult = {
  action: "export_commit";
  commandId: string;
  revision: number;
  format: ExportFormat;
  file: BinaryFileMetadata;
  warnings: string[];
  losses: Record<string, number>;
};

type NormalizedExportOptions = {
  format: ExportFormat;
  path: string;
  sheetId: string | null;
  range: string | null;
  csvInjectionPolicy: CsvInjectionPolicy | null;
  bom: boolean;
};

type ExportPreflight = {
  token: string;
  revision: number;
  sourceEtag: string | null;
  options: NormalizedExportOptions;
  optionsFingerprint: string;
  expiresAt: number;
  data: ArrayBuffer;
  mediaType: string;
  warnings: string[];
  losses: Record<string, number>;
  committingCommandId: string | null;
};

type CompletedSessionCommand = {
  fingerprint: string;
} & (
  | { outcome: "success"; result: unknown }
  | {
      outcome: "uncertain";
      error: { code: "SAVE_OUTCOME_UNKNOWN"; message: string; details?: Record<string, unknown> };
    }
);

const EXPORT_PREFLIGHT_TTL_MS = 2 * 60 * 1_000;
const MAX_EXPORT_PREFLIGHTS = 4;
const SHA_256_ETAG = /^[a-f0-9]{64}$/u;
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const GENERIC_BINARY_MIME = "application/octet-stream";
const AMBIGUOUS_WRITE_CODES = new Set([
  "ATTACHMENT_CANCELLED",
  "ATTACHMENT_DISCONNECTED",
  "ATTACHMENT_ENDPOINT_CHANGED",
  "ATTACHMENT_TIMEOUT",
  "FILES_INVALID_RESPONSE",
]);

export type SessionStatus = ReturnType<WorkbookEngine["status"]> & {
  dirty: boolean;
  lastSavedRevision: number | null;
  nativeSource: NativeSource | null;
  importProvenance: ImportProvenance | null;
  recovery: { available: boolean; pending: boolean; savedAt: number | null; revision: number | null; degraded: boolean; error: string | null };
  saving: boolean;
};

export class WorkbookSession {
  private engine: WorkbookEngine;
  private files: WorkbookFilesPort;
  private readonly recovery: RecoveryPersistence;
  private recoveryRecord: RecoveryRecord | null = null;
  private recoveryPending = false;
  private recoveryDegraded = false;
  private recoveryError: string | null = null;
  private xlsx: XlsxCodecPort | null;
  private nativeSource: NativeSource | null = null;
  private importProvenance: ImportProvenance | null = null;
  private lastSavedRevision: number | null = null;
  private cleanUnsavedRevision = 0;
  private saving = false;
  private sessionGeneration = 0;
  private forceDirty = false;
  private queue: Promise<unknown> = Promise.resolve();
  private listeners = new Set<(status: SessionStatus) => void>();
  private readonly completedCommands = new Map<string, CompletedSessionCommand>();
  private readonly inFlightCommands = new Map<string, { fingerprint: string; promise: Promise<unknown> }>();
  private readonly exportPreflights = new Map<string, ExportPreflight>();
  private readonly now: () => number;
  private readonly preflightTtlMs: number;

  private constructor(options: {
    recovery: RecoveryPersistence;
    files: WorkbookFilesPort;
    recoveryRecord: RecoveryRecord | null;
    xlsx: XlsxCodecPort | null;
    now: () => number;
    preflightTtlMs: number;
  }) {
    this.recovery = options.recovery;
    this.files = options.files;
    this.recoveryRecord = options.recoveryRecord;
    this.recoveryPending = options.recoveryRecord !== null;
    this.xlsx = options.xlsx;
    this.now = options.now;
    this.preflightTtlMs = options.preflightTtlMs;
    this.engine = new WorkbookEngine(createWorkbook());
  }

  static async open(options: {
    recovery?: RecoveryPersistence;
    files?: WorkbookFilesPort;
    xlsx?: XlsxCodecPort;
    /** Test seam for expiry behavior. Production callers should omit it. */
    now?: () => number;
    /** Test seam for expiry behavior. Production callers should omit it. */
    preflightTtlMs?: number;
  } = {}): Promise<WorkbookSession> {
    const recovery = options.recovery ?? createIndexedDbRecoveryPersistence();
    let record: RecoveryRecord | null = null;
    try {
      record = await recovery.load();
      if (record) {
        if (record.version !== 1 || !Number.isSafeInteger(record.revision) || record.revision < 0) throw new Error("Invalid recovery metadata");
        encodeNativeWorkbook(record.workbook);
      }
    } catch {
      record = null; // A corrupt recovery record must not prevent a usable new workbook.
    }
    return new WorkbookSession({
      recovery,
      files: options.files ?? new UnavailableFilesPort(),
      recoveryRecord: record,
      xlsx: options.xlsx ?? null,
      now: options.now ?? Date.now,
      preflightTtlMs: options.preflightTtlMs ?? EXPORT_PREFLIGHT_TTL_MS,
    });
  }

  setFilesPort(files: WorkbookFilesPort): void { this.files = files; }
  setXlsxCodec(xlsx: XlsxCodecPort): void { this.xlsx = xlsx; }

  subscribe(listener: (status: SessionStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  status(): SessionStatus {
    return {
      ...this.engine.status(),
      dirty: this.forceDirty || (this.nativeSource !== null
        ? this.lastSavedRevision !== this.engine.getRevision()
        : this.cleanUnsavedRevision !== this.engine.getRevision()),
      lastSavedRevision: this.lastSavedRevision,
      nativeSource: this.nativeSource ? { ...this.nativeSource } : null,
      importProvenance: this.importProvenance ? structuredClone(this.importProvenance) : null,
      recovery: {
        available: this.recoveryRecord !== null,
        pending: this.recoveryPending,
        savedAt: this.recoveryRecord?.savedAt ?? null,
        revision: this.recoveryRecord?.revision ?? null,
        degraded: this.recoveryDegraded,
        error: this.recoveryError,
      },
      saving: this.saving,
    };
  }

  readRange(...args: Parameters<WorkbookEngine["readRange"]>): ReadRangeResult {
    return this.engine.readRange(...args);
  }

  find(...args: Parameters<WorkbookEngine["find"]>): ReturnType<WorkbookEngine["find"]> {
    return this.engine.find(...args);
  }

  async apply(request: ApplyRequest, signal?: AbortSignal): Promise<ApplyResult> {
    throwIfAborted(signal);
    return this.enqueue(async () => {
      throwIfAborted(signal);
      this.assertRecoveryResolved();
      const result = this.engine.apply(request);
      if (!result.dryRun && !result.noChange) {
        await this.checkpoint();
        this.emit();
      }
      return result;
    });
  }

  async undo(expectedRevision: number, commandId: string, expectedHistoryId?: string, signal?: AbortSignal): Promise<HistoryResult> {
    throwIfAborted(signal);
    return this.enqueue(async () => {
      throwIfAborted(signal);
      this.assertRecoveryResolved();
      const result = this.engine.undo(expectedRevision, commandId, expectedHistoryId);
      await this.checkpoint();
      this.emit();
      return result;
    });
  }

  async redo(expectedRevision: number, commandId: string, expectedHistoryId?: string, signal?: AbortSignal): Promise<HistoryResult> {
    throwIfAborted(signal);
    return this.enqueue(async () => {
      throwIfAborted(signal);
      this.assertRecoveryResolved();
      const result = this.engine.redo(expectedRevision, commandId, expectedHistoryId);
      await this.checkpoint();
      this.emit();
      return result;
    });
  }

  async newWorkbook(options: MutationEnvelope & { discardDirty?: boolean }): Promise<SessionMutationResult> {
    throwIfAborted(options.signal);
    const fingerprint = commandFingerprint({
      action: "session:new",
      expectedRevision: options.expectedRevision,
      discardDirty: options.discardDirty === true,
    });
    return this.runSessionCommand(options.commandId, fingerprint, () => this.enqueue(async () => {
      throwIfAborted(options.signal);
      this.assertExpectedRevision(options.expectedRevision);
      this.assertCanReplace(options.discardDirty);
      const previousRevision = this.engine.getRevision();
      this.engine.replace(createWorkbook());
      this.sessionGeneration += 1;
      this.nativeSource = null;
      this.importProvenance = null;
      this.lastSavedRevision = null;
      this.cleanUnsavedRevision = this.engine.getRevision();
      this.forceDirty = false;
      await this.clearRecovery();
      this.emit();
      return this.sessionMutationResult(options.commandId, previousRevision);
    }));
  }

  async loadDemo(options: MutationEnvelope & { discardDirty?: boolean }): Promise<SessionMutationResult> {
    throwIfAborted(options.signal);
    const fingerprint = commandFingerprint({
      action: "session:demo",
      expectedRevision: options.expectedRevision,
      discardDirty: options.discardDirty === true,
    });
    return this.runSessionCommand(options.commandId, fingerprint, () => this.enqueue(async () => {
      throwIfAborted(options.signal);
      this.assertExpectedRevision(options.expectedRevision);
      this.assertCanReplace(options.discardDirty);
      const previousRevision = this.engine.getRevision();
      this.engine.replace(createKitchenSinkWorkbook());
      this.sessionGeneration += 1;
      this.nativeSource = null;
      this.importProvenance = null;
      this.lastSavedRevision = null;
      this.forceDirty = true;
      await this.checkpoint();
      this.emit();
      return this.sessionMutationResult(options.commandId, previousRevision);
    }));
  }

  async recoverDraft(options: MutationEnvelope & {
    discardDirty?: boolean;
    getDelegationToken?: AttachmentDelegationProvider;
  }): Promise<RecoveryResult> {
    throwIfAborted(options.signal);
    const fingerprint = commandFingerprint({
      action: "session:recover",
      expectedRevision: options.expectedRevision,
      discardDirty: options.discardDirty === true,
    });
    return this.runSessionCommand(options.commandId, fingerprint, async () => {
      const capture = await this.enqueue(async () => {
        throwIfAborted(options.signal);
        this.assertExpectedRevision(options.expectedRevision);
        this.assertCanReplace(options.discardDirty, true);
        if (!this.recoveryRecord) throw new SessionError("NO_RECOVERY", "There is no recovery draft");
        return {
          record: structuredClone(this.recoveryRecord),
          recordIdentity: this.recoveryRecord,
          previousRevision: this.engine.getRevision(),
          sessionGeneration: this.sessionGeneration,
        };
      });
      const recoveryDisposition = await this.resolveRecoverySource(
        capture.record,
        options.getDelegationToken,
        options.signal,
      );
      return this.enqueue(async () => {
        throwIfAborted(options.signal);
        this.assertExpectedRevision(options.expectedRevision);
        this.assertCanReplace(options.discardDirty, true);
        if (
          this.recoveryRecord !== capture.recordIdentity ||
          this.sessionGeneration !== capture.sessionGeneration
        ) {
          throw new SessionError(
            "RECOVERY_CHANGED",
            "The recovery draft changed while its source was being verified",
          );
        }
        this.engine.replace(capture.record.workbook, capture.record.revision);
        this.sessionGeneration += 1;
        this.nativeSource = recoveryDisposition === "source_exact" && capture.record.nativeSource
          ? { ...capture.record.nativeSource, mediaType: NATIVE_MIME }
          : null;
        this.importProvenance = null;
        this.lastSavedRevision = null;
        this.forceDirty = true;
        this.recoveryPending = false;
        this.emit();
        return {
          ...this.sessionMutationResult(options.commandId, capture.previousRevision),
          recoveryDisposition,
        };
      });
    });
  }

  async discardRecovery(options: MutationEnvelope): Promise<SessionMutationResult> {
    throwIfAborted(options.signal);
    const fingerprint = commandFingerprint({
      action: "session:discard_recovery",
      expectedRevision: options.expectedRevision,
    });
    return this.runSessionCommand(options.commandId, fingerprint, () => this.enqueue(async () => {
      throwIfAborted(options.signal);
      this.assertExpectedRevision(options.expectedRevision);
      const previousRevision = this.engine.getRevision();
      await this.clearRecovery();
      this.emit();
      return this.sessionMutationResult(options.commandId, previousRevision);
    }));
  }

  async openPath(
    path: string,
    options: MutationEnvelope & {
      discardDirty?: boolean;
      csvTyping?: CsvTypingPolicy;
      getDelegationToken?: AttachmentDelegationProvider;
    },
  ): Promise<SessionMutationResult> {
    throwIfAborted(options.signal);
    const fingerprint = commandFingerprint({
      action: "session:open",
      expectedRevision: options.expectedRevision,
      path,
      discardDirty: options.discardDirty === true,
      csvTyping: options.csvTyping ?? "text",
    });
    return this.runSessionCommand(options.commandId, fingerprint, () => this.enqueue(async () => {
      throwIfAborted(options.signal);
      // Revision and dirty checks happen before consent or Files I/O.
      this.assertExpectedRevision(options.expectedRevision);
      this.assertCanReplace(options.discardDirty);
      const previousRevision = this.engine.getRevision();
      throwIfAborted(options.signal);
      const delegationToken = await options.getDelegationToken?.();
      throwIfAborted(options.signal);
      const file = await this.files.readBinary(path, { ...(delegationToken ? { delegationToken } : {}) });
      throwIfAborted(options.signal);
      await this.acceptFileNow(file, options);
      return this.sessionMutationResult(options.commandId, previousRevision);
    }));
  }

  async acceptFile(
    file: AcceptedFileInput,
    options: { discardDirty?: boolean; csvTyping?: CsvTypingPolicy } = {},
  ): Promise<SessionStatus> {
    const verified = await validateAcceptedFileHandoff(file);
    return this.enqueue(async () => {
      this.assertCanReplace(options.discardDirty);
      return this.acceptFileNow(verified, options);
    });
  }

  async saveNative(options: MutationEnvelope & {
    path?: string;
    getDelegationToken?: AttachmentDelegationProvider;
  }): Promise<NativeSaveResult> {
    throwIfAborted(options.signal);
    const fingerprint = commandFingerprint({
      action: "save:native",
      expectedRevision: options.expectedRevision,
      path: options.path ?? null,
    });
    return this.runSessionCommand(options.commandId, fingerprint, async () => {
      const capture = await this.enqueue(async () => {
        throwIfAborted(options.signal);
        this.assertRecoveryResolved();
        this.assertExpectedRevision(options.expectedRevision);
        if (this.saving) throw new SessionError("SAVE_IN_PROGRESS", "Another file operation is already in progress");
        const snapshot = this.engine.snapshot();
        const destination = options.path ?? this.nativeSource?.path;
        if (!destination) throw new SessionError("SAVE_PATH_REQUIRED", "Save As requires a .nsheet path");
        if (!destination.toLocaleLowerCase("en-US").endsWith(".nsheet")) throw new SessionError("UNSUPPORTED_FORMAT", "Native saves require a .nsheet path");
        const bytes = encodeNativeWorkbook(snapshot.workbook);
        const data = copyArrayBuffer(bytes);
        const existing = this.nativeSource?.path === destination ? this.nativeSource : null;
        this.saving = true;
        this.emit();
        return {
          snapshot,
          destination,
          data,
          existing,
          sessionGeneration: this.sessionGeneration,
          workbookId: snapshot.workbook.workbookId,
        };
      });
      try {
        const file = await this.writeBinaryWithReconciliation(
          capture.destination,
          NATIVE_MIME,
          capture.data,
          capture.existing ? { ifMatch: capture.existing.etag } : { ifNoneMatch: "*" },
          options.getDelegationToken,
          options.signal,
        );
        return await this.enqueue(async () => {
          if (
            this.sessionGeneration !== capture.sessionGeneration ||
            this.engine.status().workbookId !== capture.workbookId
          ) {
            throw new SessionError(
              "REVISION_CONFLICT",
              "The workbook session changed while its native save was in progress",
              {
                savedRevision: capture.snapshot.revision,
                actualRevision: this.engine.getRevision(),
              },
            );
          }
          this.nativeSource = { path: file.path, etag: file.etag, mediaType: file.mediaType };
          this.importProvenance = null;
          this.lastSavedRevision = capture.snapshot.revision;
          this.forceDirty = false;
          if (this.engine.getRevision() === capture.snapshot.revision) await this.clearRecovery();
          return {
            action: "native",
            commandId: options.commandId,
            revision: this.engine.getRevision(),
            savedRevision: capture.snapshot.revision,
            dirty: this.engine.getRevision() !== capture.snapshot.revision,
            file,
          };
        });
      } finally {
        await this.enqueue(async () => {
          this.saving = false;
          this.emit();
        });
      }
    });
  }

  exportCsv(sheetId: string, options: { range?: string; injectionPolicy: CsvInjectionPolicy; bom?: boolean }): ReturnType<typeof exportCsv> & { revision: number } {
    const snapshot = this.engine.snapshot();
    return { ...exportCsv(snapshot.workbook, sheetId, options), revision: snapshot.revision };
  }

  async preflightExport(options: MutationEnvelope & ExportOptions): Promise<ExportPreflightResult> {
    throwIfAborted(options.signal);
    const normalized = normalizeExportOptions(options);
    const optionsFingerprint = commandFingerprint(normalized);
    const fingerprint = commandFingerprint({
      action: "save:export_preflight",
      expectedRevision: options.expectedRevision,
      options: normalized,
    });
    return this.runSessionCommand(options.commandId, fingerprint, async () => {
      const capture = await this.enqueue(async () => {
        throwIfAborted(options.signal);
        this.assertRecoveryResolved();
        this.assertExpectedRevision(options.expectedRevision);
        return {
          snapshot: this.engine.snapshot(),
          sourceEtag: this.nativeSource?.etag ?? null,
        };
      });
      throwIfAborted(options.signal);
      const encoded = await this.encodeExport(capture.snapshot.workbook, normalized);
      throwIfAborted(options.signal);
      return this.enqueue(async () => {
        throwIfAborted(options.signal);
        // Encoding is intentionally outside the mutation queue. Do not issue a
        // consent token for a snapshot that changed while it was encoded.
        this.assertExpectedRevision(options.expectedRevision);
        if ((this.nativeSource?.etag ?? null) !== capture.sourceEtag) {
          throw new SessionError("REVISION_CONFLICT", "The native source changed while export preflight was prepared");
        }
        this.pruneExportPreflights();
        while (this.exportPreflights.size >= MAX_EXPORT_PREFLIGHTS) {
          const oldest = [...this.exportPreflights]
            .find(([, candidate]) => candidate.committingCommandId === null)?.[0];
          if (!oldest) throw new SessionError("PREFLIGHT_LIMIT", "Too many export preflights are active");
          this.exportPreflights.delete(oldest);
        }
        const token = this.createPreflightToken();
        const expiresAt = this.now() + this.preflightTtlMs;
        this.exportPreflights.set(token, {
          token,
          revision: capture.snapshot.revision,
          sourceEtag: capture.sourceEtag,
          options: normalized,
          optionsFingerprint,
          expiresAt,
          data: encoded.data,
          mediaType: encoded.mediaType,
          warnings: [...encoded.warnings],
          losses: { ...encoded.losses },
          committingCommandId: null,
        });
        return {
          action: "export_preflight",
          commandId: options.commandId,
          revision: capture.snapshot.revision,
          format: normalized.format,
          path: normalized.path,
          preflightToken: token,
          expiresAt,
          byteLength: encoded.data.byteLength,
          warnings: [...encoded.warnings],
          losses: { ...encoded.losses },
        };
      });
    });
  }

  async commitExport(options: MutationEnvelope & ExportOptions & {
    preflightToken: string;
    getDelegationToken?: AttachmentDelegationProvider;
  }): Promise<ExportCommitResult> {
    throwIfAborted(options.signal);
    let normalized: NormalizedExportOptions;
    try {
      normalized = normalizeExportOptions(options);
    } catch {
      throw new SessionError("PREFLIGHT_STALE", "Export options do not match the preflight");
    }
    const optionsFingerprint = commandFingerprint(normalized);
    const fingerprint = commandFingerprint({
      action: "save:export_commit",
      expectedRevision: options.expectedRevision,
      preflightToken: options.preflightToken,
      options: normalized,
    });
    return this.runSessionCommand(options.commandId, fingerprint, async () => {
      const capture = await this.enqueue(async () => {
        throwIfAborted(options.signal);
        const preflight = this.requireExportPreflight(
          options.preflightToken,
          options.expectedRevision,
          optionsFingerprint,
        );
        if (preflight.committingCommandId !== null) {
          throw new SessionError("PREFLIGHT_STALE", "Export preflight is already being committed");
        }
        if (this.saving) throw new SessionError("SAVE_IN_PROGRESS", "Another file operation is already in progress");
        preflight.committingCommandId = options.commandId;
        this.saving = true;
        this.emit();
        return {
          preflight,
          // The attachment transport transfers and detaches its input. Retain
          // the preflight bytes so a conditionally safe failed call can retry.
          data: preflight.data.slice(0),
        };
      });
      let committed = false;
      try {
        const file = await this.writeBinaryWithReconciliation(
          capture.preflight.options.path,
          capture.preflight.mediaType,
          capture.data,
          { ifNoneMatch: "*" },
          options.getDelegationToken,
          options.signal,
        );
        committed = true;
        return {
          action: "export_commit",
          commandId: options.commandId,
          revision: capture.preflight.revision,
          format: capture.preflight.options.format,
          file,
          warnings: [...capture.preflight.warnings],
          losses: { ...capture.preflight.losses },
        };
      } finally {
        await this.enqueue(async () => {
          const current = this.exportPreflights.get(options.preflightToken);
          if (current?.committingCommandId === options.commandId) {
            if (committed) this.exportPreflights.delete(options.preflightToken);
            else current.committingCommandId = null;
          }
          this.saving = false;
          this.emit();
        });
      }
    });
  }

  private async encodeExport(
    workbook: SpreadsheetWorkbook,
    options: NormalizedExportOptions,
  ): Promise<{
    data: ArrayBuffer;
    mediaType: string;
    warnings: string[];
    losses: Record<string, number>;
  }> {
    if (options.format === "csv") {
      const csv = exportCsv(workbook, options.sheetId!, {
        injectionPolicy: options.csvInjectionPolicy!,
        ...(options.range ? { range: options.range } : {}),
        ...(options.bom ? { bom: true } : {}),
      });
      return {
        data: copyArrayBuffer(csv.bytes),
        mediaType: "text/csv",
        warnings: ["CSV is a values-only snapshot; formulas, formatting, filters, and other sheets are not preserved."],
        losses: {
          formulaCellsFlattened: csv.formulaCells,
          errorCells: csv.errorCells,
          textCellsHardened: csv.transformed,
          omittedSheets: Math.max(0, workbook.sheets.length - 1),
        },
      };
    }
    if (!this.xlsx) throw new SessionError("XLSX_CODEC_REQUIRED", "XLSX codec is unavailable");
    const encoded = await this.xlsx.export(workbook);
    if (encoded.data.byteLength > SPREADSHEET_LIMITS.maxNativeBytes) {
      throw new SessionError("EXPORT_LIMIT", `XLSX export exceeds ${SPREADSHEET_LIMITS.maxNativeBytes} bytes`);
    }
    return {
      data: encoded.data,
      mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      warnings: [...encoded.warnings],
      losses: { ...(encoded.losses ?? {}) },
    };
  }

  private requireExportPreflight(
    token: string,
    expectedRevision: number,
    optionsFingerprint: string,
  ): ExportPreflight {
    const preflight = this.exportPreflights.get(token);
    if (
      !preflight ||
      preflight.expiresAt <= this.now() ||
      preflight.revision !== expectedRevision ||
      preflight.revision !== this.engine.getRevision() ||
      preflight.sourceEtag !== (this.nativeSource?.etag ?? null) ||
      preflight.optionsFingerprint !== optionsFingerprint
    ) {
      if (preflight?.expiresAt !== undefined && preflight.expiresAt <= this.now()) {
        this.exportPreflights.delete(token);
      }
      throw new SessionError("PREFLIGHT_STALE", "Export preflight expired or no longer matches the workbook and options");
    }
    return preflight;
  }

  private pruneExportPreflights(): void {
    const now = this.now();
    for (const [token, preflight] of this.exportPreflights) {
      if (preflight.expiresAt <= now && preflight.committingCommandId === null) {
        this.exportPreflights.delete(token);
      }
    }
  }

  private createPreflightToken(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const bytes = new Uint8Array(18);
      crypto.getRandomValues(bytes);
      let value = "";
      for (const byte of bytes) value += String.fromCharCode(byte);
      const token = `ep1_${btoa(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "")}`;
      if (!this.exportPreflights.has(token)) return token;
    }
    throw new SessionError("PREFLIGHT_UNAVAILABLE", "Could not allocate an export preflight token");
  }

  private sessionMutationResult(commandId: string, previousRevision: number): SessionMutationResult {
    return { ...this.status(), commandId, previousRevision };
  }

  private assertExpectedRevision(expectedRevision: number): void {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new SessionError("INVALID_REVISION", "expectedRevision must be a non-negative safe integer");
    }
    const actualRevision = this.engine.getRevision();
    if (expectedRevision !== actualRevision) {
      throw new SessionError("REVISION_CONFLICT", "Workbook revision changed", {
        expectedRevision,
        actualRevision,
      });
    }
  }

  private runSessionCommand<T>(
    commandId: string,
    fingerprint: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    assertCommandId(commandId);
    const completed = this.completedCommands.get(commandId);
    if (completed) {
      if (completed.fingerprint !== fingerprint) {
        return Promise.reject(new SessionError("COMMAND_ID_REUSED", "Command id was already used for a different session command"));
      }
      if (completed.outcome === "uncertain") {
        return Promise.reject(new SessionError(
          completed.error.code,
          completed.error.message,
          completed.error.details ? structuredClone(completed.error.details) : undefined,
        ));
      }
      return Promise.resolve(structuredClone(completed.result) as T);
    }
    const inFlight = this.inFlightCommands.get(commandId);
    if (inFlight) {
      if (inFlight.fingerprint !== fingerprint) {
        return Promise.reject(new SessionError("COMMAND_ID_REUSED", "Command id is already in use for a different session command"));
      }
      return inFlight.promise.then((result) => structuredClone(result) as T);
    }
    const promise = Promise.resolve()
      .then(operation)
      .then((result) => {
        this.rememberSessionCommand(commandId, fingerprint, result);
        return result;
      })
      .catch((error) => {
        if (error instanceof SessionError && error.code === "SAVE_OUTCOME_UNKNOWN") {
          this.rememberUncertainSessionCommand(commandId, fingerprint, error);
        }
        throw error;
      })
      .finally(() => {
        this.inFlightCommands.delete(commandId);
      });
    this.inFlightCommands.set(commandId, { fingerprint, promise });
    return promise.then((result) => structuredClone(result) as T);
  }

  private rememberSessionCommand(commandId: string, fingerprint: string, result: unknown): void {
    this.completedCommands.set(commandId, {
      fingerprint,
      outcome: "success",
      result: structuredClone(result),
    });
    this.pruneCompletedCommands();
  }

  private rememberUncertainSessionCommand(
    commandId: string,
    fingerprint: string,
    error: SessionError,
  ): void {
    this.completedCommands.set(commandId, {
      fingerprint,
      outcome: "uncertain",
      error: {
        code: "SAVE_OUTCOME_UNKNOWN",
        message: error.message,
        ...(error.details ? { details: structuredClone(error.details) } : {}),
      },
    });
    this.pruneCompletedCommands();
  }

  private pruneCompletedCommands(): void {
    while (this.completedCommands.size > SPREADSHEET_LIMITS.maxIdempotencyEntries) {
      const oldest = this.completedCommands.keys().next().value as string | undefined;
      if (!oldest) break;
      this.completedCommands.delete(oldest);
    }
  }

  private async writeBinaryWithReconciliation(
    path: string,
    mediaType: string,
    data: ArrayBuffer,
    condition: { ifMatch: string } | { ifNoneMatch: "*" },
    getDelegationToken?: AttachmentDelegationProvider,
    signal?: AbortSignal,
  ): Promise<BinaryFileMetadata> {
    throwIfAborted(signal);
    const expectedByteLength = data.byteLength;
    const expectedEtag = await sha256Hex(data);
    throwIfAborted(signal);
    try {
      const delegationToken = await getDelegationToken?.();
      throwIfAborted(signal);
      // Do not consult signal after this call begins. The write may have
      // committed, so response-loss reconciliation and caller finalization are
      // mandatory even if the owning agent turn is stopped meanwhile.
      return await this.files.writeBinary(
        path,
        mediaType,
        data,
        condition,
        { ...(delegationToken ? { delegationToken } : {}) },
      );
    } catch (writeError) {
      if (!isAmbiguousWriteError(writeError)) throw writeError;
      try {
        const delegationToken = await getDelegationToken?.();
        const read = await this.files.readBinary(path, {
          ifMatch: expectedEtag,
          ...(delegationToken ? { delegationToken } : {}),
        });
        const actualEtag = await sha256Hex(read.data);
        if (
          read.etag !== expectedEtag ||
          actualEtag !== expectedEtag ||
          read.byteLength !== expectedByteLength ||
          read.data.byteLength !== expectedByteLength ||
          baseMediaType(read.mediaType) !== baseMediaType(mediaType)
        ) {
          throw reconciliationError("RECONCILIATION_MISMATCH");
        }
        const { data: _data, ...metadata } = read;
        return metadata;
      } catch (reconciliationFailure) {
        throw new SessionError(
          "SAVE_OUTCOME_UNKNOWN",
          "Files may have committed the write, but its exact outcome could not be verified",
          {
            path: boundedDetail(path, 240),
            expectedEtag,
            writeError: errorCode(writeError) ?? "UNKNOWN",
            reconciliationError: errorCode(reconciliationFailure) ?? "UNAVAILABLE",
          },
        );
      }
    }
  }

  private async resolveRecoverySource(
    record: RecoveryRecord,
    getDelegationToken?: AttachmentDelegationProvider,
    signal?: AbortSignal,
  ): Promise<RecoveryDisposition> {
    throwIfAborted(signal);
    if (!record.nativeSource) return "no_source";
    const delegationToken = await getDelegationToken?.();
    throwIfAborted(signal);
    try {
      const read = await this.files.readBinary(record.nativeSource.path, {
        ifMatch: record.nativeSource.etag,
        ...(delegationToken ? { delegationToken } : {}),
      });
      throwIfAborted(signal);
      const actualEtag = await sha256Hex(read.data);
      throwIfAborted(signal);
      if (
        read.etag !== record.nativeSource.etag ||
        actualEtag !== record.nativeSource.etag ||
        read.byteLength !== read.data.byteLength
      ) {
        throw new SessionError(
          "FILES_INVALID_RESPONSE",
          "Files returned source bytes that did not match the recovery etag",
        );
      }
      return "source_exact";
    } catch (error) {
      if (errorCode(error) === "VFS_CONFLICT") return "source_changed";
      if (errorCode(error) === "VFS_NOT_FOUND") return "source_deleted";
      throw error;
    }
  }

  private async acceptFileNow(
    file: { path: string; etag: string; mediaType: string; data: ArrayBuffer },
    options: { csvTyping?: CsvTypingPolicy; signal?: AbortSignal },
  ): Promise<SessionStatus> {
    throwIfAborted(options.signal);
    const lower = file.path.toLocaleLowerCase("en-US");
    if (lower.endsWith(".nsheet") || file.mediaType === NATIVE_MIME) {
      const candidate = decodeNativeWorkbook(file.data);
      throwIfAborted(options.signal);
      this.engine.replace(candidate);
      this.sessionGeneration += 1;
      this.nativeSource = { path: file.path, etag: file.etag, mediaType: file.mediaType || NATIVE_MIME };
      this.importProvenance = null;
      this.lastSavedRevision = this.engine.getRevision();
      this.forceDirty = false;
      await this.clearRecovery();
    } else if (lower.endsWith(".csv") || file.mediaType === "text/csv") {
      const candidate = importCsv(file.data, { typing: options.csvTyping ?? "text", sheetName: baseName(file.path) });
      validateNativeWorkbook(candidate);
      throwIfAborted(options.signal);
      this.engine.replace(candidate);
      this.sessionGeneration += 1;
      this.nativeSource = null;
      this.importProvenance = { path: file.path, etag: file.etag, format: "csv", warnings: ["CSV imports one sheet of values and cannot preserve formulas or formatting."] };
      this.lastSavedRevision = null;
      this.forceDirty = true;
      await this.checkpoint();
    } else if (lower.endsWith(".xlsx")) {
      if (!this.xlsx) throw new SessionError("XLSX_CODEC_REQUIRED", "XLSX codec is unavailable");
      const imported = await this.xlsx.import(file.data);
      validateNativeWorkbook(imported.workbook);
      throwIfAborted(options.signal);
      this.engine.replace(imported.workbook);
      this.sessionGeneration += 1;
      this.nativeSource = null;
      this.importProvenance = { path: file.path, etag: file.etag, format: "xlsx", warnings: imported.warnings };
      this.lastSavedRevision = null;
      this.forceDirty = true;
      await this.checkpoint();
    } else {
      throw new SessionError("UNSUPPORTED_FORMAT", "Open .nsheet, .xlsx, or .csv files");
    }
    this.emit();
    return this.status();
  }

  private assertCanReplace(discardDirty = false, allowRecovery = false): void {
    if (this.saving) {
      throw new SessionError(
        "SAVE_IN_PROGRESS",
        "Wait for the current save or export before replacing the workbook",
      );
    }
    if (this.status().dirty && !discardDirty) throw new SessionError("DIRTY_WORKBOOK", "Save or explicitly discard the current workbook before replacing it");
    if (this.recoveryRecord && !allowRecovery && !discardDirty) {
      throw new SessionError("RECOVERY_PENDING", "Recover or explicitly discard the recovery draft before opening another workbook");
    }
  }

  private assertRecoveryResolved(): void {
    if (this.recoveryPending) {
      throw new SessionError(
        "RECOVERY_PENDING",
        "Recover or discard the recovery draft before editing or saving this workbook",
        { recoveryRevision: this.recoveryRecord?.revision ?? null },
      );
    }
  }

  private async checkpoint(): Promise<void> {
    const snapshot = this.engine.snapshot();
    const record: RecoveryRecord = {
      version: 1,
      savedAt: Date.now(),
      revision: snapshot.revision,
      workbook: snapshot.workbook,
      nativeSource: this.nativeSource ? { path: this.nativeSource.path, etag: this.nativeSource.etag } : null,
    };
    // This record belongs to the currently visible document. Even if replacing
    // the prior checkpoint fails, it must not be treated as an unresolved
    // startup choice that could later overwrite the live workbook.
    this.recoveryPending = false;
    try {
      await this.recovery.save(record);
      this.recoveryRecord = record;
      this.recoveryDegraded = false;
      this.recoveryError = null;
    } catch (error) {
      this.recoveryDegraded = true;
      this.recoveryError = error instanceof Error ? error.message : "Recovery persistence failed";
    }
  }

  private async clearRecovery(): Promise<void> {
    try {
      await this.recovery.clear();
      this.recoveryRecord = null;
      this.recoveryPending = false;
      this.recoveryDegraded = false;
      this.recoveryError = null;
    } catch (error) {
      this.recoveryPending = this.recoveryRecord !== null;
      this.recoveryDegraded = true;
      this.recoveryError = error instanceof Error ? error.message : "Could not clear recovery";
    }
  }

  private emit(): void {
    const status = this.status();
    for (const listener of this.listeners) listener(status);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }
}

function normalizeExportOptions(options: ExportOptions): NormalizedExportOptions {
  if (options.format !== "csv" && options.format !== "xlsx") {
    throw new SessionError("UNSUPPORTED_FORMAT", "Export format must be csv or xlsx");
  }
  if (!options.path) throw new SessionError("SAVE_PATH_REQUIRED", "Export requires a destination path");
  if (options.format === "csv") {
    if (!options.path.toLocaleLowerCase("en-US").endsWith(".csv")) {
      throw new SessionError("UNSUPPORTED_FORMAT", "CSV export paths must end in .csv");
    }
    if (!options.sheetId) throw new SessionError("SHEET_REQUIRED", "CSV export requires an explicit sheet id");
    if (options.csvInjectionPolicy !== "exact" && options.csvInjectionPolicy !== "safe") {
      throw new SessionError("LOSS_ACK_REQUIRED", "CSV export requires an explicit exact or safe injection policy");
    }
    return {
      format: "csv",
      path: options.path,
      sheetId: options.sheetId,
      range: options.range ?? null,
      csvInjectionPolicy: options.csvInjectionPolicy,
      bom: options.bom === true,
    };
  }
  if (!options.path.toLocaleLowerCase("en-US").endsWith(".xlsx")) {
    throw new SessionError("UNSUPPORTED_FORMAT", "XLSX export paths must end in .xlsx");
  }
  if (
    options.sheetId !== undefined ||
    options.range !== undefined ||
    options.csvInjectionPolicy !== undefined ||
    options.bom !== undefined
  ) {
    throw new SessionError("INVALID_EXPORT_OPTIONS", "CSV-only options cannot be used for XLSX export");
  }
  return {
    format: "xlsx",
    path: options.path,
    sheetId: null,
    range: null,
    csvInjectionPolicy: null,
    bom: false,
  };
}

function commandFingerprint(value: unknown): string {
  return JSON.stringify(value);
}

function assertCommandId(commandId: string): void {
  if (!commandId || commandId.length > 128) {
    throw new SessionError("INVALID_COMMAND", "commandId is required and at most 128 characters");
  }
}

function baseName(path: string): string {
  const name = path.split("/").at(-1)?.replace(/\.csv$/i, "") || "Sheet1";
  return name.slice(0, 31).replace(/[\\/*?:[\]]/g, "_") || "Sheet1";
}

function copyArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const data = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(data).set(bytes);
  return data;
}

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function isAmbiguousWriteError(error: unknown): boolean {
  const code = errorCode(error);
  return code !== undefined && AMBIGUOUS_WRITE_CODES.has(code);
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.length <= 80 ? code : undefined;
}

function reconciliationError(code: string): Error {
  const error = new Error("Files reconciliation did not match the intended write");
  Object.defineProperty(error, "code", { enumerable: true, value: code });
  return error;
}

function boundedDetail(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function baseMediaType(value: string): string {
  return value.split(";", 1)[0]!.trim().toLocaleLowerCase("en-US");
}

async function validateAcceptedFileHandoff(
  file: AcceptedFileInput,
): Promise<{ path: string; etag: string; mediaType: string; data: ArrayBuffer }> {
  if (
    typeof file.path !== "string" ||
    file.path.length < 1 ||
    file.path.length > 240 ||
    !(file.data instanceof ArrayBuffer)
  ) {
    throw invalidFileHandoff("path or binary data is invalid");
  }
  const expectedMediaType = expectedFileMediaType(file.path);
  const mediaType = normalizeHandoffMediaType(file.mediaType);
  if (baseMediaType(mediaType) !== expectedMediaType) {
    throw invalidFileHandoff("metadata media type contradicts the file extension");
  }
  const attachmentMediaType = baseMediaType(normalizeHandoffMediaType(
    file.attachmentMediaType ?? mediaType,
  ));
  if (attachmentMediaType !== expectedMediaType && attachmentMediaType !== GENERIC_BINARY_MIME) {
    throw invalidFileHandoff("attachment media type contradicts file metadata");
  }
  const declaredLength = file.byteLength ?? file.data.byteLength;
  if (!Number.isSafeInteger(declaredLength) || declaredLength < 0 || declaredLength !== file.data.byteLength) {
    throw invalidFileHandoff("attachment byte length does not match its data");
  }
  if (!SHA_256_ETAG.test(file.etag)) {
    throw invalidFileHandoff("etag is not a lowercase SHA-256 digest");
  }
  const data = file.data.slice(0);
  if (await sha256Hex(data) !== file.etag) {
    throw invalidFileHandoff("attachment bytes do not match their SHA-256 etag");
  }
  return { path: file.path, etag: file.etag, mediaType, data };
}

function expectedFileMediaType(path: string): string {
  const lower = path.toLocaleLowerCase("en-US");
  if (lower.endsWith(".nsheet")) return NATIVE_MIME;
  if (lower.endsWith(".xlsx")) return XLSX_MIME;
  if (lower.endsWith(".csv")) return "text/csv";
  throw invalidFileHandoff("file extension is not supported");
}

function normalizeHandoffMediaType(value: string): string {
  if (typeof value !== "string") throw invalidFileHandoff("media type is invalid");
  const normalized = value.trim().toLocaleLowerCase("en-US");
  if (
    normalized.length < 3 ||
    normalized.length > 160 ||
    /[\u0000-\u001f\u007f]/u.test(normalized) ||
    !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:\s*;\s*[a-z0-9!#$&^_.+-]+=[a-z0-9!#$&^_.+"-]+)*$/u.test(normalized)
  ) {
    throw invalidFileHandoff("media type is invalid");
  }
  return normalized;
}

function invalidFileHandoff(reason: string): SessionError {
  return new SessionError(
    "FILE_HANDOFF_INVALID",
    "Files supplied a spreadsheet handoff whose metadata or bytes could not be verified",
    { reason },
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const reason: unknown = signal.reason;
  if (errorCode(reason) !== undefined) throw reason;
  throw new SessionError("REQUEST_CANCELLED", "Spreadsheet operation was cancelled");
}

export class SessionError extends Error {
  constructor(readonly code: string, message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "SessionError";
  }
}
