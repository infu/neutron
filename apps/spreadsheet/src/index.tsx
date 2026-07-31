import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  IoAddOutline,
  IoArrowRedoOutline,
  IoArrowUndoOutline,
  IoCheckmarkOutline,
  IoChevronBackOutline,
  IoChevronDownOutline,
  IoChevronForwardOutline,
  IoChevronUpOutline,
  IoClipboardOutline,
  IoCloseOutline,
  IoColorPaletteOutline,
  IoCopyOutline,
  IoCreateOutline,
  IoCutOutline,
  IoDocumentOutline,
  IoDownloadOutline,
  IoEllipsisHorizontal,
  IoFolderOpenOutline,
  IoGridOutline,
  IoHelpCircleOutline,
  IoOptionsOutline,
  IoSaveOutline,
  IoSearchOutline,
  IoTrashOutline,
} from "react-icons/io5";
import {
  callTool,
  copyToClipboard,
  loadTileContext,
  onAppStateChange,
  toError,
  type JsonObject,
  type JsonValue,
  type MsgBusEndpointId,
} from "neutron-tools/app";
import { columnName, formatCellAddress, formatRange, normalizeRange, parseCellAddress, parseRange, translateFormula, type CellAddress, type CellRange } from "./address.ts";
import { SPREADSHEET_LIMITS, STATE_TOPIC } from "./constants.ts";
import { parseClipboardTable, stringifyClipboardTable } from "./clipboard.ts";
import { rawInputFromText, type CellInput, type CellStyle } from "./model.ts";
import { formulaHintForDraft, getWorkbookHelp, type FormulaFunctionHelp } from "./help.ts";
import "./style.scss";

const VISIBLE_ROWS = 50;
const VISIBLE_COLUMNS = 20;
const CLIPBOARD_MIME = "application/x-neutron-spreadsheet+json";

type SheetFilter = { range: string; column: number; equals?: string; nonBlank?: boolean };
type SheetSummary = {
  id: string;
  name: string;
  usedRange: string | null;
  cellCount: number;
  filter: SheetFilter | null;
  hiddenRowCount: number;
  columnWidths: Record<string, number>;
  rowHeights: Record<string, number>;
};
type WorkbookStatus = {
  revision: number;
  workbookId: string;
  sheets: SheetSummary[];
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  undoHistoryId: string | null;
  redoHistoryId: string | null;
  nativeSource: { path: string; etag: string } | null;
  importProvenance?: { path: string; format: "csv" | "xlsx"; warnings: string[] } | null;
  saving: boolean;
  recovery: {
    available: boolean;
    pending?: boolean;
    degraded: boolean;
    error?: string | null;
    savedAt?: number | null;
    revision?: number | null;
  };
};
type GridCell = { address: string; raw: CellInput; display: string; style?: CellStyle; computed: JsonValue };
type ClipboardCell = { raw: CellInput; value: CellInput; style: CellStyle | null };
type SpreadsheetClipboard = {
  version: 1;
  source: CellAddress;
  rows: number;
  columns: number;
  cells: ClipboardCell[][];
};
type CutSource = { sheetId: string; range: CellRange; rows: number; columns: number };
type DraftOrigin = {
  sheetId: string;
  address: string;
  input: CellInput;
  editorText: string;
};
type FindMatch = { sheetId: string; sheetName: string; address: string; raw: string; display: string };
type ExportFormat = "csv" | "xlsx";
type CsvInjectionPolicy = "exact" | "safe";
type ExportOptions = {
  format: ExportFormat;
  path: string;
  sheetId?: string;
  range?: string;
  csvInjectionPolicy?: CsvInjectionPolicy;
  bom?: boolean;
};
type ExportPreflight = {
  options: ExportOptions;
  revision: number;
  preflightToken: string;
  expiresAt: number;
  byteLength: number;
  warnings: string[];
  losses: Record<string, number>;
};
type FillDrag = {
  pointerId: number;
  handle: HTMLButtonElement;
  sheetId: string;
  source: CellRange;
  axis: "horizontal" | "vertical" | null;
  target: CellRange;
};
type FormulaReferencePoint = {
  sheetId: string;
  anchor: CellAddress;
  range: CellRange;
  before: string;
  after: string;
  end: number;
  draft: string;
  absoluteMode: 0 | 1 | 2 | 3;
};
type DimensionResize = {
  axis: "column" | "row";
  index: number;
  pointerId: number;
  handle: HTMLSpanElement;
  sheetId: string;
  startCoordinate: number;
  startSize: number;
  size: number;
  sheet: SheetSummary;
  viewport: CellAddress;
  gridTemplate: string;
  rowStyles: Array<{ element: HTMLElement; height: string; minHeight: string }>;
};
type StoredTileView = {
  workbookId: string;
  sheetId: string;
  anchor: CellAddress;
  focus: CellAddress;
  viewport: CellAddress;
  draft: string;
  draftOrigin: DraftOrigin | null;
};
type UiDialog =
  | { kind: "save_as"; value: string; error: string | null }
  | { kind: "open"; value: string; csvTyping: "text" | "conservative"; discardDirty: boolean; error: string | null }
  | { kind: "replace"; action: "new" | "demo"; error: string | null }
  | { kind: "add_sheet"; value: string; error: string | null }
  | { kind: "rename_sheet"; sheetId: string; value: string; error: string | null }
  | { kind: "delete_sheet"; sheetId: string; sheetName: string; cellCount: number; error: string | null }
  | { kind: "dimension"; axis: "row" | "column"; index: number; value: string; error: string | null }
  | { kind: "draft_conflict"; latest: CellInput; error: string | null }
  | { kind: "find"; query: string; formulas: boolean; matches: FindMatch[]; truncated: boolean; nextCursor: string | null; error: string | null }
  | {
      kind: "filter";
      mode: "equals" | "nonblank";
      value: string;
      error: string | null;
      sheetId: string;
      range: string;
      column: number;
    }
  | {
      kind: "export_setup";
      format: ExportFormat;
      path: string;
      csvInjectionPolicy: CsvInjectionPolicy | null;
      bom: boolean;
      sheetId?: string;
      range?: string;
      error: string | null;
    }
  | ({ kind: "export_review"; error: string | null } & ExportPreflight);

export function App() {
  const context = useMemo(() => loadTileContext(), []);
  const viewStorageKey = `neutron:spreadsheet:view:${context.instance ?? "default"}`;
  const storedView = useMemo(() => loadStoredTileView(viewStorageKey), [viewStorageKey]);
  const target = `app:${context.app ?? "spreadsheet"}:background` as MsgBusEndpointId;
  const [status, setStatus] = useState<WorkbookStatus | null>(null);
  const [activeSheetId, setActiveSheetId] = useState<string | null>(storedView?.sheetId ?? null);
  const [anchor, setAnchor] = useState<CellAddress>(storedView?.anchor ?? { row: 0, column: 0 });
  const [focus, setFocus] = useState<CellAddress>(storedView?.focus ?? { row: 0, column: 0 });
  const [viewport, setViewport] = useState<CellAddress>(storedView?.viewport ?? { row: 0, column: 0 });
  const [cells, setCells] = useState(() => new Map<string, GridCell>());
  const [hiddenRows, setHiddenRows] = useState(() => new Set<number>());
  const [addressEntry, setAddressEntry] = useState("A1");
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [clipboardReady, setClipboardReady] = useState(false);
  const [cutRange, setCutRange] = useState<CellRange | null>(null);
  const [sortHasHeader, setSortHasHeader] = useState(false);
  const [dialog, setDialog] = useState<UiDialog | null>(null);
  const [fillPreview, setFillPreview] = useState<CellRange | null>(null);
  const [formulaReferenceRange, setFormulaReferenceRange] = useState<CellRange | null>(null);
  const [formulaHelpOpen, setFormulaHelpOpen] = useState(false);
  const [formulaHelpQuery, setFormulaHelpQuery] = useState("");
  const appRef = useRef<HTMLElement>(null);
  const commandRef = useRef<HTMLElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const formulaRef = useRef<HTMLInputElement>(null);
  const formulaRegionRef = useRef<HTMLElement>(null);
  const formulaHelpMenuRef = useRef<HTMLDetailsElement>(null);
  const formulaHelpSearchRef = useRef<HTMLInputElement>(null);
  const formulaHelpReturnFocusRef = useRef<HTMLElement | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const sheetStripRef = useRef<HTMLElement>(null);
  const dragging = useRef(false);
  const revisionRef = useRef(0);
  const workbookIdRef = useRef<string | null>(storedView?.workbookId ?? null);
  // `revisionRef` is the revision actually represented by both status and
  // cells. A failed/superseded refresh must never advance it. Keeping this
  // retry bit separate also lets revision 0 recover after a transient initial
  // read failure.
  const refreshIncompleteRef = useRef(true);
  const sheetRef = useRef<string | null>(storedView?.sheetId ?? null);
  const viewportRef = useRef<CellAddress>(storedView?.viewport ?? { row: 0, column: 0 });
  const loadGenerationRef = useRef(0);
  const pendingGridFocusRef = useRef<string | null>(null);
  const clipboardRef = useRef<SpreadsheetClipboard | null>(null);
  const clipboardTextRef = useRef<string | null>(null);
  const cutSourceRef = useRef<CutSource | null>(null);
  const cellsRef = useRef(new Map<string, GridCell>());
  const editingRef = useRef(false);
  const draftOriginRef = useRef<DraftOrigin | null>(null);
  const dialogPanelRef = useRef<HTMLFormElement>(null);
  const dialogReturnFocusRef = useRef<HTMLElement | null>(null);
  const recoveryDialogRef = useRef<HTMLElement>(null);
  const fillDragRef = useRef<FillDrag | null>(null);
  const formulaReferencePointRef = useRef<FormulaReferencePoint | null>(null);
  const formulaReferenceDraggingRef = useRef(false);
  const dimensionResizeRef = useRef<DimensionResize | null>(null);
  const dimensionResizeStatusRef = useRef<HTMLOutputElement>(null);
  const pendingStoredViewRef = useRef<StoredTileView | null>(storedView);
  const localMutationRef = useRef(false);
  const pendingViewWriteRef = useRef<{ key: string; view: StoredTileView } | null>(null);
  const viewWriteTimerRef = useRef<number | null>(null);
  const pendingDragFocusRef = useRef<CellAddress | null>(null);
  const dragFocusFrameRef = useRef<number | null>(null);

  const activeAddress = formatCellAddress(focus);
  const selection = normalizeRange({ start: anchor, end: focus });
  const selectionLabel = formatRange(selection);
  const activeCell = cells.get(activeAddress);
  const activeSheet = status?.sheets.find((sheet) => sheet.id === activeSheetId) ?? null;
  const recoveryPending = status?.recovery.pending === true;
  const interactionBlocked = busy || recoveryPending;
  const selectionMetrics = useMemo(
    () => selectionSummary(selection, cells, viewport),
    [
      cells,
      selection.start.row,
      selection.start.column,
      selection.end.row,
      selection.end.column,
      viewport.row,
      viewport.column,
    ],
  );
  const formulaHelpFunctions = useMemo<FormulaFunctionHelp[]>(() => getWorkbookHelp({
    topic: "functions",
    ...(formulaHelpQuery.trim() ? { query: formulaHelpQuery.trim() } : {}),
  }).functions, [formulaHelpQuery]);
  const formulaEditorHint = editing && draft.startsWith("=") ? formulaHintForDraft(draft) : "";
  const saveState = status?.saving
    ? "saving"
    : status?.nativeSource && !status.dirty && !editing
      ? "saved"
      : status?.dirty || editing
        ? "dirty"
        : "new";
  const saveDisabled = interactionBlocked || !status || saveState === "saved";
  const workbookPath = status?.nativeSource?.path ?? status?.importProvenance?.path ?? "Untitled.nsheet";
  const saveTitle = status?.recovery.degraded
    ? `Save workbook. Recovery warning: ${status.recovery.error ?? "local recovery is degraded"}`
    : saveState === "saved"
      ? "Save workbook"
      : saveState === "saving"
        ? "Saving…"
        : "Save workbook (Ctrl/Cmd+S)";

  const refresh = useCallback(async (preferredSheet?: string, preferredViewport?: CellAddress) => {
    const generation = ++loadGenerationRef.current;
    try {
      const nextStatus = assertStatus(await callTool({ target, name: "workbook_status", arguments: {} }, 30));
      if (generation !== loadGenerationRef.current) return;
      if (editingRef.current && !localMutationRef.current && nextStatus.revision > revisionRef.current) {
        setNotice("Workbook updated in another tile or by an agent. Your draft is preserved; a same-cell change will be reviewed before commit.");
      }
      const pendingStoredView = pendingStoredViewRef.current;
      const discardStoredView = Boolean(pendingStoredView && pendingStoredView.workbookId !== nextStatus.workbookId);
      const sheetId = preferredSheet && nextStatus.sheets.some((sheet) => sheet.id === preferredSheet)
        ? preferredSheet
        : !discardStoredView && sheetRef.current && nextStatus.sheets.some((sheet) => sheet.id === sheetRef.current)
          ? sheetRef.current
          : nextStatus.sheets[0]?.id ?? null;
      const windowStart = boundViewport(discardStoredView
        ? { row: 0, column: 0 }
        : preferredViewport ?? viewportRef.current);
      let committedStatus = nextStatus;
      let nextCells = new Map<string, GridCell>();
      let loadedHiddenRows = new Set<number>();
      if (sheetId) {
        const range = viewportRange(windowStart);
        const loaded: GridCell[] = [];
        let cursor: string | undefined;
        let readWorkbookId: string | null = null;
        let readRevision: number | null = null;
        do {
          const read = assertRead(await callTool({
            target,
            name: "workbook_read",
            arguments: {
              sheetId,
              range,
              limit: VISIBLE_ROWS * VISIBLE_COLUMNS,
              includeBlanks: false,
              ...(cursor ? { cursor } : {}),
            },
          }, 30));
          if (generation !== loadGenerationRef.current) return;
          if (
            (readWorkbookId !== null && read.workbookId !== readWorkbookId) ||
            (readRevision !== null && read.revision !== readRevision)
          ) throw new Error("Workbook changed while loading the grid; refreshing…");
          readWorkbookId = read.workbookId;
          readRevision = read.revision;
          loaded.push(...read.cells);
          for (const row of read.hiddenRows) loadedHiddenRows.add(row);
          cursor = read.nextCursor ?? undefined;
        } while (cursor);
        if (
          workbookIdRef.current === nextStatus.workbookId &&
          (readRevision ?? nextStatus.revision) < revisionRef.current &&
          !refreshIncompleteRef.current
        ) return;
        if (
          readWorkbookId !== null &&
          (readWorkbookId !== nextStatus.workbookId || readRevision !== nextStatus.revision)
        ) {
          const reconciledStatus = assertStatus(await callTool({ target, name: "workbook_status", arguments: {} }, 30));
          if (generation !== loadGenerationRef.current) return;
          if (reconciledStatus.workbookId !== readWorkbookId || reconciledStatus.revision !== readRevision) {
            // State advanced again between the paged read and reconciliation;
            // start one fresh generation instead of combining revisions.
            void refresh(preferredSheet, preferredViewport);
            return;
          }
          committedStatus = reconciledStatus;
        }
        nextCells = new Map(loaded.map((cell) => [cell.address, cell]));
      }

      // Commit the authoritative snapshot as one unit only after every page
      // and any reconciliation status read succeeded. Until here, the old
      // status/cells/revision remain a coherent usable snapshot.
      if (generation !== loadGenerationRef.current) return;
      if (discardStoredView) {
        pendingStoredViewRef.current = null;
        const origin = { row: 0, column: 0 };
        setAnchor(origin);
        setFocus(origin);
      }
      revisionRef.current = committedStatus.revision;
      workbookIdRef.current = committedStatus.workbookId;
      refreshIncompleteRef.current = false;
      setStatus(committedStatus);
      setActiveSheetId(sheetId);
      sheetRef.current = sheetId;
      viewportRef.current = windowStart;
      setViewport(windowStart);
      cellsRef.current = nextCells;
      setCells(nextCells);
      setHiddenRows(loadedHiddenRows);
      const stored = pendingStoredViewRef.current;
      if (stored) {
        pendingStoredViewRef.current = null;
        if (stored.workbookId === committedStatus.workbookId && stored.sheetId === sheetId && stored.draftOrigin) {
          draftOriginRef.current = structuredClone(stored.draftOrigin);
          editingRef.current = true;
          setDraft(stored.draft);
          setEditing(true);
        }
      }
      setError(null);
    } catch (nextError) {
      refreshIncompleteRef.current = true;
      setError(errorMessage(nextError));
    } finally {
      if (generation === loadGenerationRef.current) setBusy(false);
    }
  }, [target]);

  useEffect(() => { void refresh(); }, [refresh]);
  // Invalidation is a hint, never state transfer. Refetch on every event so a
  // remounted tile also behaves correctly across resident/session lifetimes.
  useEffect(() => onAppStateChange(STATE_TOPIC, ({ revision }) => {
    const nextRevision = Number(revision);
    if (
      Number.isSafeInteger(nextRevision) &&
      nextRevision <= revisionRef.current &&
      !refreshIncompleteRef.current
    ) return;
    // A local mutation always performs one authoritative refresh after its
    // command returns. Its matching invalidation is only a hint; starting a
    // second 1,000-position read here wastes work and can supersede the first
    // generation. External invalidations still refresh immediately.
    if (localMutationRef.current) return;
    void refresh();
  }), [refresh]);
  // State notifications are hints and can be dropped during reconnects. A
  // low-rate revision check keeps long-lived tiles convergent without using
  // notification payloads as state transfer.
  useEffect(() => {
    let stopped = false;
    let checking = false;
    const checkRevision = async () => {
      if (stopped || checking || document.visibilityState === "hidden") return;
      checking = true;
      try {
        const next = assertStatus(await callTool({ target, name: "workbook_status", arguments: {} }, 10));
        if (!stopped && (
          refreshIncompleteRef.current ||
          next.workbookId !== workbookIdRef.current ||
          next.revision !== revisionRef.current
        )) void refresh();
      } catch {
        // The normal error banner belongs to explicit user work. Polling is a
        // best-effort reconnect fallback and retries on the next interval.
      } finally {
        checking = false;
      }
    };
    const timer = window.setInterval(() => { void checkRevision(); }, 5_000);
    const wake = () => { void checkRevision(); };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("online", wake);
    };
  }, [refresh, target]);
  useEffect(() => {
    editingRef.current = editing;
    if (!editing) {
      draftOriginRef.current = null;
      setDraft(rawText(activeCell?.raw));
    }
  }, [activeAddress, activeCell?.raw, editing]);
  useEffect(() => {
    if (!editing) setAddressEntry(activeAddress);
  }, [activeAddress, editing]);
  useEffect(() => {
    const address = pendingGridFocusRef.current;
    if (!address) return;
    const element = gridRef.current?.querySelector<HTMLElement>(`[data-address="${address}"]`);
    if (!element) {
      if (hiddenRows.has(parseCellAddress(address).row + 1)) {
        pendingGridFocusRef.current = null;
        gridRef.current?.focus();
      }
      return;
    }
    pendingGridFocusRef.current = null;
    element.focus();
  }, [cells, hiddenRows, viewport]);
  useEffect(() => {
    if (!dialog) return;
    requestAnimationFrame(() => dialogPanelRef.current?.querySelector<HTMLElement>("input, button:not(:disabled)")?.focus());
  }, [dialog?.kind]);
  useEffect(() => {
    if (!recoveryPending) return;
    requestAnimationFrame(() => recoveryDialogRef.current?.querySelector<HTMLButtonElement>("button")?.focus());
  }, [recoveryPending]);
  useEffect(() => {
    cancelDimensionResize();
  }, [activeSheetId, status?.revision, status?.workbookId]);
  useEffect(() => {
    const cancelForKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.altKey || event.metaKey) cancelFillDrag();
      if (event.key === "Escape") cancelDimensionResize();
      if (event.key === "Escape" && cutSourceRef.current) cancelCut();
      if (event.key === "Escape") {
        const openMenus = [...document.querySelectorAll<HTMLDetailsElement>(".toolbar-menu[open], .sheet-menu[open], .formula-help-menu[open]")];
        if (openMenus.length > 0) {
          event.preventDefault();
          const focusedMenu = openMenus.find((menu) => menu.contains(document.activeElement)) ?? openMenus[0]!;
          openMenus.forEach((menu) => menu.removeAttribute("open"));
          const returnFocus = focusedMenu === formulaHelpMenuRef.current ? formulaHelpReturnFocusRef.current : null;
          if (returnFocus?.isConnected) returnFocus.focus();
          else focusedMenu.querySelector<HTMLElement>("summary")?.focus();
        }
      }
    };
    const closeOtherMenus = (event: PointerEvent) => {
      const owner = event.target instanceof Element ? event.target.closest(".toolbar-menu, .sheet-menu, .formula-help-menu") : null;
      document.querySelectorAll<HTMLDetailsElement>(".toolbar-menu[open], .sheet-menu[open], .formula-help-menu[open]").forEach((menu) => {
        if (menu !== owner) menu.removeAttribute("open");
      });
    };
    window.addEventListener("keydown", cancelForKey);
    window.addEventListener("blur", cancelDimensionResize);
    document.addEventListener("pointerdown", closeOtherMenus);
    return () => {
      window.removeEventListener("keydown", cancelForKey);
      window.removeEventListener("blur", cancelDimensionResize);
      document.removeEventListener("pointerdown", closeOtherMenus);
    };
  }, []);
  useEffect(() => () => {
    if (dragFocusFrameRef.current !== null) cancelAnimationFrame(dragFocusFrameRef.current);
  }, []);
  useEffect(() => {
    if (!status || !activeSheetId) return;
    pendingViewWriteRef.current = {
      key: viewStorageKey,
      view: {
        workbookId: status.workbookId,
        sheetId: activeSheetId,
        anchor,
        focus,
        viewport,
        draft,
        draftOrigin: editing ? structuredClone(draftOriginRef.current) : null,
      },
    };
    if (viewWriteTimerRef.current !== null) window.clearTimeout(viewWriteTimerRef.current);
    viewWriteTimerRef.current = window.setTimeout(flushStoredTileView, 250);
  }, [activeSheetId, anchor, draft, editing, focus, status?.workbookId, viewStorageKey, viewport]);
  useEffect(() => {
    window.addEventListener("pagehide", flushStoredTileView);
    return () => {
      window.removeEventListener("pagehide", flushStoredTileView);
      flushStoredTileView();
    };
  }, []);

  function flushStoredTileView(): void {
    if (viewWriteTimerRef.current !== null) {
      window.clearTimeout(viewWriteTimerRef.current);
      viewWriteTimerRef.current = null;
    }
    const pending = pendingViewWriteRef.current;
    if (!pending) return;
    pendingViewWriteRef.current = null;
    saveStoredTileView(pending.key, pending.view);
  }

  async function applyOperations(operations: JsonObject[]): Promise<boolean> {
    if (!activeSheetId || busy || recoveryPending) return false;
    if (operations.length > SPREADSHEET_LIMITS.maxOperations) {
      setError(`This action needs ${operations.length} operations, above the atomic limit of ${SPREADSHEET_LIMITS.maxOperations}. Reduce the selection and try again.`);
      return false;
    }
    setBusy(true);
    localMutationRef.current = true;
    try {
      assertApply(await callTool({
        target,
        name: "workbook_apply",
        arguments: {
          action: "apply",
          expectedRevision: revisionRef.current,
          commandId: createCommandId(),
          operations,
        },
      }, 30));
      await refresh(activeSheetId);
      return true;
    } catch (nextError) {
      const message = errorMessage(nextError);
      await refresh(activeSheetId);
      setError(message);
      return false;
    } finally {
      localMutationRef.current = false;
      setBusy(false);
    }
  }

  function clearFormulaReference(): void {
    formulaReferencePointRef.current = null;
    formulaReferenceDraggingRef.current = false;
    setFormulaReferenceRange(null);
  }

  function restoreFormulaCaret(position: number): void {
    requestAnimationFrame(() => {
      const editor = formulaRef.current;
      editor?.focus();
      editor?.setSelectionRange(position, position);
    });
  }

  function beginFormulaReference(address: CellAddress): void {
    if (!activeSheetId || !editingRef.current || !draft.startsWith("=")) return;
    const editor = formulaRef.current;
    const prior = formulaReferencePointRef.current;
    const replacePrior = Boolean(
      prior &&
      prior.sheetId === activeSheetId &&
      prior.draft === draft &&
      editor?.selectionStart === prior.end &&
      editor.selectionEnd === prior.end,
    );
    const selectionStart = clamp(editor?.selectionStart ?? draft.length, 1, draft.length);
    const selectionEnd = clamp(editor?.selectionEnd ?? selectionStart, selectionStart, draft.length);
    const before = replacePrior ? prior!.before : draft.slice(0, selectionStart);
    const after = replacePrior ? prior!.after : draft.slice(selectionEnd);
    const range = normalizeRange({ start: address, end: address });
    const reference = formulaReferenceText(range, 0);
    const nextDraft = `${before}${reference}${after}`;
    if (nextDraft.length > SPREADSHEET_LIMITS.maxFormulaLength) {
      setError(`Formulas can contain at most ${SPREADSHEET_LIMITS.maxFormulaLength} characters.`);
      return;
    }
    const point: FormulaReferencePoint = {
      sheetId: activeSheetId,
      anchor: address,
      range,
      before,
      after,
      end: before.length + reference.length,
      draft: nextDraft,
      absoluteMode: 0,
    };
    formulaReferencePointRef.current = point;
    formulaReferenceDraggingRef.current = true;
    setFormulaReferenceRange(range);
    setDraft(nextDraft);
    setError(null);
    restoreFormulaCaret(point.end);
  }

  function extendFormulaReference(address: CellAddress): void {
    const point = formulaReferencePointRef.current;
    if (!formulaReferenceDraggingRef.current || !point || point.sheetId !== activeSheetId) return;
    const range = normalizeRange({ start: point.anchor, end: address });
    const reference = formulaReferenceText(range, point.absoluteMode);
    const nextDraft = `${point.before}${reference}${point.after}`;
    if (nextDraft.length > SPREADSHEET_LIMITS.maxFormulaLength) return;
    const nextPoint = {
      ...point,
      range,
      end: point.before.length + reference.length,
      draft: nextDraft,
    };
    formulaReferencePointRef.current = nextPoint;
    setFormulaReferenceRange(range);
    setDraft(nextDraft);
  }

  function endFormulaReference(): void {
    if (!formulaReferenceDraggingRef.current) return;
    formulaReferenceDraggingRef.current = false;
    const point = formulaReferencePointRef.current;
    if (point) restoreFormulaCaret(point.end);
  }

  function cycleFormulaReferenceAbsolute(): boolean {
    const point = formulaReferencePointRef.current;
    if (!point || point.draft !== draft) return false;
    const absoluteMode = ((point.absoluteMode + 1) % 4) as FormulaReferencePoint["absoluteMode"];
    const reference = formulaReferenceText(point.range, absoluteMode);
    const nextDraft = `${point.before}${reference}${point.after}`;
    const nextPoint = {
      ...point,
      absoluteMode,
      end: point.before.length + reference.length,
      draft: nextDraft,
    };
    formulaReferencePointRef.current = nextPoint;
    setDraft(nextDraft);
    restoreFormulaCaret(nextPoint.end);
    return true;
  }

  function startFormula(): void {
    beginEditing("=");
    restoreFormulaCaret(1);
  }

  function beginEditing(replacement?: string): void {
    if (interactionBlocked || !activeSheetId) return;
    if (!editingRef.current) {
      clearFormulaReference();
      const input = cloneInput(activeCell?.raw);
      draftOriginRef.current = {
        sheetId: activeSheetId,
        address: activeAddress,
        input,
        editorText: rawText(input),
      };
    }
    editingRef.current = true;
    setEditing(true);
    if (replacement !== undefined) {
      clearFormulaReference();
      setDraft(replacement);
    }
  }

  function finishEditing(): void {
    clearFormulaReference();
    editingRef.current = false;
    draftOriginRef.current = null;
    setEditing(false);
  }

  function cancelDraft(moveFocus = true): void {
    const origin = draftOriginRef.current;
    setDraft(origin?.editorText ?? rawText(activeCell?.raw));
    finishEditing();
    if (moveFocus) {
      const address = origin?.address ?? activeAddress;
      requestAnimationFrame(() => gridRef.current?.querySelector<HTMLElement>(`[data-address="${address}"]`)?.focus());
    }
  }

  async function commitDraft(moveRows = 0, moveColumns = 0): Promise<boolean> {
    if (!editingRef.current) return true;
    if (busy || recoveryPending) {
      setError(recoveryPending ? "Recover or discard the pending draft before editing." : "Wait for the current spreadsheet operation to finish.");
      return false;
    }
    const origin = draftOriginRef.current;
    if (!origin || origin.sheetId !== activeSheetId || origin.address !== activeAddress) {
      setError("The cell being edited changed. Return to the cell or press Escape to cancel the draft.");
      return false;
    }
    const latestInput = cloneInput(cellsRef.current.get(origin.address)?.raw);
    if (!sameInput(origin.input, latestInput)) {
      openDialog({ kind: "draft_conflict", latest: latestInput, error: null });
      return false;
    }
    if (draft === origin.editorText) {
      finishEditing();
      if (moveRows || moveColumns) {
        const start = parseCellAddress(origin.address);
        selectCell({
          row: clamp(start.row + moveRows, 0, SPREADSHEET_LIMITS.maxRows - 1),
          column: clamp(start.column + moveColumns, 0, SPREADSHEET_LIMITS.maxColumns - 1),
        }, false, true);
      }
      return true;
    }
    if (/^=\s*$/.test(draft)) {
      setError("Choose a cell or complete the formula. Press Escape to cancel.");
      restoreFormulaCaret(draft.length);
      return false;
    }
    let input: CellInput;
    try {
      input = inputFromDraft(draft);
    } catch (nextError) {
      setError(errorMessage(nextError));
      return false;
    }
    const committed = await applyOperations([{
      type: "set_cells",
      sheetId: origin.sheetId,
      start: origin.address,
      values: [[input]],
    }]);
    if (!committed) return false;
    finishEditing();
    if (moveRows || moveColumns) {
      const start = parseCellAddress(origin.address);
      selectCell({
        row: clamp(start.row + moveRows, 0, SPREADSHEET_LIMITS.maxRows - 1),
        column: clamp(start.column + moveColumns, 0, SPREADSHEET_LIMITS.maxColumns - 1),
      }, false, true);
    }
    return true;
  }

  async function history(action: "undo" | "redo"): Promise<void> {
    if (!status || !(await commitDraft())) return;
    setBusy(true);
    try {
      const currentStatus = assertStatus(await callTool({ target, name: "workbook_status", arguments: {} }, 30));
      await callTool({ target, name: "workbook_apply", arguments: {
        action,
        expectedRevision: currentStatus.revision,
        commandId: createCommandId(),
        expectedHistoryId: action === "undo" ? currentStatus.undoHistoryId : currentStatus.redoHistoryId,
      } }, 30);
      await refresh(activeSheetId ?? undefined);
    } catch (nextError) { setError(errorMessage(nextError)); }
    finally { setBusy(false); }
  }

  function selectCell(address: CellAddress, extend = false, moveDomFocus = false): void {
    if (!extend) setAnchor(address);
    setFocus(address);
    const nextViewport = viewportForAddress(address, viewportRef.current);
    if (nextViewport.row !== viewportRef.current.row || nextViewport.column !== viewportRef.current.column) {
      viewportRef.current = nextViewport;
      setViewport(nextViewport);
      if (moveDomFocus) pendingGridFocusRef.current = formatCellAddress(address);
      setBusy(true);
      void refresh(activeSheetId ?? undefined, nextViewport);
    } else if (moveDomFocus) {
      requestAnimationFrame(() => gridRef.current?.querySelector<HTMLElement>(`[data-address="${formatCellAddress(address)}"]`)?.focus());
    }
  }

  function queueDragFocus(address: CellAddress): void {
    pendingDragFocusRef.current = address;
    if (dragFocusFrameRef.current !== null) return;
    dragFocusFrameRef.current = requestAnimationFrame(() => {
      dragFocusFrameRef.current = null;
      const pending = pendingDragFocusRef.current;
      pendingDragFocusRef.current = null;
      if (pending) setFocus(pending);
    });
  }

  function finishGridDrag(): void {
    if (dragFocusFrameRef.current !== null) {
      cancelAnimationFrame(dragFocusFrameRef.current);
      dragFocusFrameRef.current = null;
    }
    const pending = pendingDragFocusRef.current;
    pendingDragFocusRef.current = null;
    if (pending) setFocus(pending);
    dragging.current = false;
    endFormulaReference();
  }

  function onGridKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (editingRef.current) {
      if (event.key === "Escape") { event.preventDefault(); cancelDraft(); }
      return;
    }
    if (interactionBlocked) return;
    const modifier = event.ctrlKey || event.metaKey;
    if (modifier && event.key.toLowerCase() === "z") {
      event.preventDefault();
      void history(event.shiftKey ? "redo" : "undo");
      return;
    }
    if (modifier && event.key.toLowerCase() === "y") { event.preventDefault(); void history("redo"); return; }
    if (modifier && event.key.toLowerCase() === "d") { event.preventDefault(); void fillDown(); return; }
    if (modifier && event.key.toLowerCase() === "r") { event.preventDefault(); void fillRight(); return; }
    if (modifier && event.key.toLowerCase() === "g") { event.preventDefault(); addressRef.current?.focus(); addressRef.current?.select(); return; }
    if (event.key === " " && (modifier || event.shiftKey)) {
      event.preventDefault();
      if (modifier) {
        setAnchor({ row: SPREADSHEET_LIMITS.maxRows - 1, column: focus.column });
        setFocus({ row: 0, column: focus.column });
      } else {
        setAnchor({ row: focus.row, column: SPREADSHEET_LIMITS.maxColumns - 1 });
        setFocus({ row: focus.row, column: 0 });
      }
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      void applyOperations([{ type: "clear", sheetId: activeSheetId!, range: selectionLabel, contents: true }]);
      return;
    }
    const movement: Record<string, [number, number]> = {
      ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1],
      Enter: [event.shiftKey ? -1 : 1, 0], Tab: [0, event.shiftKey ? -1 : 1], PageUp: [-VISIBLE_ROWS, 0], PageDown: [VISIBLE_ROWS, 0],
    };
    const delta = movement[event.key];
    if (delta) {
      event.preventDefault();
      let destination = {
        row: clamp(focus.row + delta[0], 0, SPREADSHEET_LIMITS.maxRows - 1),
        column: clamp(focus.column + delta[1], 0, SPREADSHEET_LIMITS.maxColumns - 1),
      };
      if (delta[0] !== 0) {
        const step = Math.sign(delta[0]);
        while (hiddenRows.has(destination.row + 1) && destination.row > 0 && destination.row < SPREADSHEET_LIMITS.maxRows - 1) {
          destination = { ...destination, row: destination.row + step };
        }
      }
      selectCell(destination, event.shiftKey && event.key !== "Tab" && event.key !== "Enter", true);
      return;
    }
    if (event.key === "F2") { event.preventDefault(); beginEditing(); requestAnimationFrame(() => formulaRef.current?.focus()); return; }
    if (!modifier && event.key.length === 1) {
      beginEditing(event.key);
      requestAnimationFrame(() => formulaRef.current?.focus());
    }
  }

  function onCopy(event: React.ClipboardEvent): void {
    const payload = captureSelection();
    if (!payload) return;
    clipboardRef.current = payload;
    clipboardTextRef.current = clipboardText(payload);
    cancelCut();
    setClipboardReady(true);
    event.clipboardData.setData("text/plain", clipboardText(payload));
    event.clipboardData.setData(CLIPBOARD_MIME, JSON.stringify(payload));
    event.preventDefault();
  }

  function onCut(event: React.ClipboardEvent): void {
    const payload = captureSelection();
    if (!payload || !activeSheetId) return;
    clipboardRef.current = payload;
    clipboardTextRef.current = clipboardText(payload);
    cutSourceRef.current = {
      sheetId: activeSheetId,
      range: structuredClone(selection),
      rows: payload.rows,
      columns: payload.columns,
    };
    setCutRange(structuredClone(selection));
    setClipboardReady(true);
    event.clipboardData.setData("text/plain", clipboardText(payload));
    event.clipboardData.setData(CLIPBOARD_MIME, JSON.stringify(payload));
    event.preventDefault();
  }

  function onPaste(event: React.ClipboardEvent): void {
    const tagged = parseClipboard(event.clipboardData.getData(CLIPBOARD_MIME));
    if (tagged) {
      event.preventDefault();
      clipboardRef.current = tagged;
      clipboardTextRef.current = clipboardText(tagged);
      setClipboardReady(true);
      void pasteClipboard(tagged, false);
      return;
    }
    const text = event.clipboardData.getData("text/plain");
    if (!text) return;
    event.preventDefault();
    if (
      clipboardRef.current
      && clipboardTextRef.current === text
      && clipboardText(clipboardRef.current) === text
    ) {
      void pasteClipboard(clipboardRef.current, false);
      return;
    }
    clipboardRef.current = null;
    clipboardTextRef.current = null;
    setClipboardReady(false);
    cancelCut();
    void pasteText(text);
  }

  function captureSelection(): SpreadsheetClipboard | null {
    if (!containsRange(viewportRef.current, selection)) {
      setError("Copy a selection within the current 50 × 20 grid window.");
      return null;
    }
    const copied: ClipboardCell[][] = [];
    for (let row = selection.start.row; row <= selection.end.row; row += 1) {
      const copiedRow: ClipboardCell[] = [];
      for (let column = selection.start.column; column <= selection.end.column; column += 1) {
        const cell = cellsRef.current.get(formatCellAddress({ row, column }));
        copiedRow.push({
          raw: cloneInput(cell?.raw),
          value: valueInput(cell),
          style: cell?.style ? { ...cell.style } : null,
        });
      }
      copied.push(copiedRow);
    }
    return {
      version: 1,
      source: { ...selection.start },
      rows: copied.length,
      columns: copied[0]?.length ?? 0,
      cells: copied,
    };
  }

  async function copySelection(): Promise<void> {
    // Keep the trusted clipboard call in the click activation task whenever
    // there is no active draft to commit first.
    if (editingRef.current && !(await commitDraft())) return;
    const payload = captureSelection();
    if (!payload) return;
    clipboardRef.current = payload;
    const text = clipboardText(payload);
    clipboardTextRef.current = text;
    cancelCut();
    setClipboardReady(true);
    void copyToClipboard(text).catch(() => {
      // The rich internal clipboard remains available without browser access.
    });
  }

  async function cutSelection(): Promise<void> {
    if ((editingRef.current && !(await commitDraft())) || !activeSheetId) return;
    const payload = captureSelection();
    if (!payload) return;
    clipboardRef.current = payload;
    const text = clipboardText(payload);
    clipboardTextRef.current = text;
    cutSourceRef.current = {
      sheetId: activeSheetId,
      range: structuredClone(selection),
      rows: payload.rows,
      columns: payload.columns,
    };
    setCutRange(structuredClone(selection));
    setClipboardReady(true);
    void copyToClipboard(text).catch(() => {
      // The rich internal cut payload remains available without browser access.
    });
  }

  function cancelCut(): void {
    cutSourceRef.current = null;
    setCutRange(null);
  }

  async function pasteFromToolbar(valuesOnly: boolean): Promise<void> {
    if (!(await commitDraft())) return;
    if (clipboardRef.current) {
      await pasteClipboard(clipboardRef.current, valuesOnly);
      return;
    }
    try {
      const text = await navigator.clipboard?.readText();
      if (text) await pasteText(text);
      else setError("Copy cells before pasting.");
    } catch {
      setError("Clipboard access was blocked. Use Ctrl+V or Cmd+V in the grid.");
    }
  }

  async function pasteClipboard(payload: SpreadsheetClipboard, valuesOnly: boolean): Promise<void> {
    if (!activeSheetId) return;
    if (focus.row + payload.rows > SPREADSHEET_LIMITS.maxRows || focus.column + payload.columns > SPREADSHEET_LIMITS.maxColumns) {
      setError("The pasted cells would exceed the workbook limits.");
      return;
    }
    const cut = cutSourceRef.current;
    if (cut && !valuesOnly) {
      if (cut.sheetId !== activeSheetId) {
        setError("Move a cut range within its current sheet. Use Copy to place it on another sheet.");
        return;
      }
      const moved = await applyOperations([{
        type: "move_range",
        sheetId: activeSheetId,
        sourceRange: formatRange(cut.range),
        destination: activeAddress,
      }]);
      if (moved) cancelCut();
      return;
    }
    const rowDelta = focus.row - payload.source.row;
    const columnDelta = focus.column - payload.source.column;
    const values = payload.cells.map((row) => row.map((cell) => {
      const input = cloneInput(valuesOnly ? cell.value : cell.raw);
      if (!valuesOnly && input.kind === "formula") input.formula = translateFormula(input.formula, rowDelta, columnDelta);
      return input;
    }));
    if (valuesOnly) {
      await applyOperations([{ type: "set_cells", sheetId: activeSheetId, start: activeAddress, values }]);
      return;
    }
    const destination = {
      start: focus,
      end: { row: focus.row + payload.rows - 1, column: focus.column + payload.columns - 1 },
    };
    const operations: JsonObject[] = [
      { type: "clear", sheetId: activeSheetId, range: formatRange(destination), contents: true, styles: true },
      { type: "set_cells", sheetId: activeSheetId, start: activeAddress, values },
      ...styleOperations(payload, focus, activeSheetId),
    ];
    await applyOperations(operations);
  }

  async function pasteText(text: string): Promise<void> {
    let values: CellInput[][];
    try {
      values = parseClipboardTable(text).map((row) => row.map(inputFromDraft));
    } catch (nextError) {
      setError(errorMessage(nextError));
      return;
    }
    if (values.at(-1)?.length === 1 && values.at(-1)?.[0]?.kind === "blank") values.pop();
    const width = Math.max(0, ...values.map((row) => row.length));
    if (!values.length || !width) return;
    for (const row of values) while (row.length < width) row.push({ kind: "blank" });
    if (focus.row + values.length > SPREADSHEET_LIMITS.maxRows || focus.column + width > SPREADSHEET_LIMITS.maxColumns) {
      setError("The pasted cells would exceed the workbook limits.");
      return;
    }
    await applyOperations([{ type: "set_cells", sheetId: activeSheetId!, start: activeAddress, values }]);
  }

  function beginFillDrag(event: React.PointerEvent<HTMLButtonElement>): void {
    if (event.button !== 0 || event.altKey || event.metaKey || interactionBlocked || !activeSheetId) return;
    event.preventDefault();
    event.stopPropagation();
    if (editingRef.current) {
      void commitDraft();
      return;
    }
    const rows = selection.end.row - selection.start.row + 1;
    const columns = selection.end.column - selection.start.column + 1;
    if (rows > 1 && columns > 1) {
      setError("Drag fill supports a single row or single column selection. Use Fill Down or Fill Right for rectangular ranges.");
      return;
    }
    dragging.current = false;
    fillDragRef.current = {
      pointerId: event.pointerId,
      handle: event.currentTarget,
      sheetId: activeSheetId,
      source: structuredClone(selection),
      axis: null,
      target: structuredClone(selection),
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveFillDrag(event: React.PointerEvent<HTMLButtonElement>): void {
    const drag = fillDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.altKey || event.metaKey) { cancelFillDrag(); return; }
    const address = visibleCellAtPoint(event.clientX, event.clientY, viewportRef.current);
    if (!address || hiddenRows.has(address.row + 1)) return;
    if (!drag.axis) {
      const rowDistance = Math.abs(address.row - drag.source.end.row);
      const columnDistance = Math.abs(address.column - drag.source.end.column);
      if (!rowDistance && !columnDistance) return;
      drag.axis = rowDistance >= columnDistance ? "vertical" : "horizontal";
    }
    const target = drag.axis === "vertical"
      ? normalizeRange({
          start: { row: Math.min(drag.source.start.row, address.row), column: drag.source.start.column },
          end: { row: Math.max(drag.source.end.row, address.row), column: drag.source.end.column },
        })
      : normalizeRange({
          start: { row: drag.source.start.row, column: Math.min(drag.source.start.column, address.column) },
          end: { row: drag.source.end.row, column: Math.max(drag.source.end.column, address.column) },
        });
    drag.target = target;
    setFillPreview(target);
  }

  function endFillDrag(event: React.PointerEvent<HTMLButtonElement>): void {
    moveFillDrag(event);
    const drag = fillDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const releaseAddress = visibleCellAtPoint(event.clientX, event.clientY, viewportRef.current);
    const cancelled = event.altKey || event.metaKey || !releaseAddress;
    fillDragRef.current = null;
    setFillPreview(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (cancelled || sameRange(drag.source, drag.target)) return;
    void applyOperations([{
      type: "fill",
      sheetId: drag.sheetId,
      sourceRange: formatRange(drag.source),
      targetRange: formatRange(drag.target),
      mode: "auto",
    }]);
  }

  function cancelFillDrag(): void {
    const drag = fillDragRef.current;
    if (!drag) return;
    fillDragRef.current = null;
    setFillPreview(null);
    if (drag.handle.hasPointerCapture(drag.pointerId)) drag.handle.releasePointerCapture(drag.pointerId);
  }

  async function fillDown(): Promise<void> {
    if (!(await commitDraft())) return;
    if (selection.end.row === selection.start.row) return;
    await applyOperations([{
      type: "fill",
      sheetId: activeSheetId!,
      sourceRange: `${columnName(selection.start.column)}${selection.start.row + 1}:${columnName(selection.end.column)}${selection.start.row + 1}`,
      targetRange: selectionLabel,
      mode: "auto",
    }]);
  }

  async function fillRight(): Promise<void> {
    if (!(await commitDraft())) return;
    if (selection.end.column === selection.start.column) return;
    await applyOperations([{
      type: "fill",
      sheetId: activeSheetId!,
      sourceRange: `${columnName(selection.start.column)}${selection.start.row + 1}:${columnName(selection.start.column)}${selection.end.row + 1}`,
      targetRange: selectionLabel,
      mode: "auto",
    }]);
  }

  async function openAddSheetDialog(): Promise<void> {
    if (!(await commitDraft()) || !status) return;
    let index = status.sheets.length + 1;
    while (status.sheets.some((sheet) => sheet.name.toLocaleLowerCase("en-US") === `sheet${index}`.toLocaleLowerCase("en-US"))) index += 1;
    openDialog({ kind: "add_sheet", value: `Sheet${index}`, error: null });
  }

  async function requestNewWorkbook(): Promise<void> {
    if (!(await commitDraft()) || !status) return;
    if (status.dirty) {
      openDialog({ kind: "replace", action: "new", error: null });
      return;
    }
    await replaceSession("new", false);
  }

  async function requestDemoWorkbook(): Promise<void> {
    if (!(await commitDraft()) || !status) return;
    openDialog({ kind: "replace", action: "demo", error: null });
  }

  async function openWorkbookDialog(): Promise<void> {
    if (!(await commitDraft()) || !status) return;
    openDialog({
      kind: "open",
      value: status.nativeSource?.path ?? "/workbook.nsheet",
      csvTyping: "text",
      discardDirty: status.dirty,
      error: null,
    });
  }

  async function replaceSession(action: "new" | "demo", discardDirty: boolean): Promise<boolean> {
    if (busy || recoveryPending) return false;
    setBusy(true);
    try {
      await callTool({ target, name: "workbook_session", arguments: {
        action,
        expectedRevision: revisionRef.current,
        commandId: createCommandId(),
        ...(discardDirty ? { discardDirty: true } : {}),
      } }, 30);
      resetView();
      await refresh(undefined, { row: 0, column: 0 });
      setNotice(action === "demo"
        ? "Loaded the editable Kitchen Sink workbook. It is unsaved until you choose Save as."
        : "Created a new blank workbook.");
      return true;
    } catch (nextError) {
      setError(errorMessage(nextError));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function openWorkbook(dialogState: Extract<UiDialog, { kind: "open" }>): Promise<boolean> {
    const path = dialogState.value.trim();
    const message = validateOpenPath(path);
    if (message) { setDialog({ ...dialogState, error: message }); return false; }
    setBusy(true);
    try {
      const opened = assertStatus(await callTool({ target, name: "workbook_session", arguments: {
        action: "open",
        expectedRevision: revisionRef.current,
        commandId: createCommandId(),
        path,
        csvTyping: dialogState.csvTyping,
        ...(dialogState.discardDirty ? { discardDirty: true } : {}),
      } }, 90));
      resetView();
      await refresh(undefined, { row: 0, column: 0 });
      if (opened.importProvenance) {
        const warningSummary = opened.importProvenance.warnings.length > 0
          ? ` Review import warnings: ${opened.importProvenance.warnings.slice(0, 2).join("; ")}${opened.importProvenance.warnings.length > 2 ? `; +${opened.importProvenance.warnings.length - 2} more` : ""}.`
          : "";
        setNotice(`Opened ${path} as an imported snapshot. Save as .nsheet for lossless future edits.${warningSummary}`);
      } else {
        setNotice(`Opened lossless workbook ${path}.`);
      }
      return true;
    } catch (nextError) {
      setDialog({ ...dialogState, value: path, error: errorMessage(nextError) });
      return false;
    } finally {
      setBusy(false);
    }
  }

  function resetView(): void {
    const origin = { row: 0, column: 0 };
    sheetRef.current = null;
    viewportRef.current = origin;
    setViewport(origin);
    setAnchor(origin);
    setFocus(origin);
    finishEditing();
    cancelCut();
    pendingStoredViewRef.current = null;
    try { sessionStorage.removeItem(viewStorageKey); } catch { /* Storage can be unavailable in hardened frames. */ }
  }

  async function openRenameSheetDialog(): Promise<void> {
    if (!(await commitDraft()) || !activeSheet) return;
    openDialog({ kind: "rename_sheet", sheetId: activeSheet.id, value: activeSheet.name, error: null });
  }

  async function openDeleteSheetDialog(): Promise<void> {
    if (!(await commitDraft()) || !activeSheet || !status || status.sheets.length <= 1) return;
    openDialog({
      kind: "delete_sheet",
      sheetId: activeSheet.id,
      sheetName: activeSheet.name,
      cellCount: activeSheet.cellCount,
      error: null,
    });
  }

  async function openFindDialog(): Promise<void> {
    if (!(await commitDraft())) return;
    openDialog({ kind: "find", query: "", formulas: false, matches: [], truncated: false, nextCursor: null, error: null });
  }

  async function runFind(find: Extract<UiDialog, { kind: "find" }>, append = false): Promise<void> {
    const query = find.query.trim();
    if (!query) { setDialog({ ...find, error: "Enter text or a formula fragment to find." }); return; }
    setBusy(true);
    try {
      const result = assertFind(await callTool({
        target,
        name: "workbook_find",
        arguments: { query, formulas: find.formulas, limit: 100, ...(append && find.nextCursor ? { cursor: find.nextCursor } : {}) },
      }, 30));
      if (result.workbookId !== workbookIdRef.current || result.revision !== revisionRef.current) {
        void refresh();
        throw new Error("Workbook changed while finding cells; refresh and search again.");
      }
      setDialog({
        ...find,
        query,
        matches: append ? [...find.matches, ...result.matches] : result.matches,
        truncated: result.truncated,
        nextCursor: result.nextCursor,
        error: null,
      });
    } catch (nextError) {
      setDialog({ ...find, error: errorMessage(nextError) });
    } finally {
      setBusy(false);
    }
  }

  async function goToMatch(match: FindMatch): Promise<void> {
    const address = parseCellAddress(match.address);
    const nextViewport = viewportForAddress(address, { row: 0, column: 0 });
    closeDialog();
    sheetRef.current = match.sheetId;
    viewportRef.current = nextViewport;
    setActiveSheetId(match.sheetId);
    setViewport(nextViewport);
    setAnchor(address);
    setFocus(address);
    pendingGridFocusRef.current = match.address;
    setBusy(true);
    await refresh(match.sheetId, nextViewport);
  }

  async function structure(axis: "row" | "column", action: "insert" | "delete"): Promise<void> {
    if (!(await commitDraft()) || !activeSheetId) return;
    const isRow = axis === "row";
    const start = isRow ? selection.start.row : selection.start.column;
    const count = isRow
      ? selection.end.row - selection.start.row + 1
      : selection.end.column - selection.start.column + 1;
    const type = `${action}_${isRow ? "rows" : "columns"}`;
    if (await applyOperations([{ type, sheetId: activeSheetId, [isRow ? "startRow" : "startColumn"]: start, count }])) {
      setAnchor(focus);
    }
  }

  async function openDimensionDialog(axis: "row" | "column", requestedIndex?: number): Promise<void> {
    if (!(await commitDraft()) || !activeSheet) return;
    const index = requestedIndex ?? (axis === "row" ? focus.row : focus.column);
    const current = axis === "row" ? activeSheet.rowHeights[String(index)] : activeSheet.columnWidths[String(index)];
    openDialog({
      kind: "dimension",
      axis,
      index,
      value: String(current ?? (axis === "row" ? 28 : 96)),
      error: null,
    });
  }

  function beginDimensionResize(
    event: React.PointerEvent<HTMLSpanElement>,
    axis: "column" | "row",
    index: number,
  ): void {
    event.preventDefault();
    event.stopPropagation();
    if (event.button !== 0 || !event.isPrimary || interactionBlocked || editing || !activeSheet || !activeSheetId) return;
    const grid = gridRef.current;
    const header = event.currentTarget.parentElement;
    if (!grid || !header) return;
    cancelDimensionResize();
    const bounds = header.getBoundingClientRect();
    const startSize = Math.round(axis === "column" ? bounds.width : bounds.height);
    const rowStyles = axis === "row"
      ? [...grid.querySelectorAll<HTMLElement>(`[data-grid-row="${index}"]`)].map((element) => ({
          element,
          height: element.style.height,
          minHeight: element.style.minHeight,
        }))
      : [];
    const resize: DimensionResize = {
      axis,
      index,
      pointerId: event.pointerId,
      handle: event.currentTarget,
      sheetId: activeSheetId,
      startCoordinate: axis === "column" ? event.clientX : event.clientY,
      startSize,
      size: startSize,
      sheet: activeSheet,
      viewport: { ...viewportRef.current },
      gridTemplate: grid.style.gridTemplateColumns,
      rowStyles,
    };
    dimensionResizeRef.current = resize;
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Pointer capture can be unavailable after an interrupted press. */ }
    applyDimensionResizePreview(resize, event.clientX, event.clientY);
  }

  function moveDimensionResize(event: React.PointerEvent<HTMLSpanElement>): void {
    const resize = dimensionResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const coordinate = resize.axis === "column" ? event.clientX : event.clientY;
    const minimum = resize.axis === "column" ? 24 : 18;
    const maximum = resize.axis === "column" ? 600 : 300;
    resize.size = clamp(Math.round(resize.startSize + coordinate - resize.startCoordinate), minimum, maximum);
    applyDimensionResizePreview(resize, event.clientX, event.clientY);
  }

  function applyDimensionResizePreview(resize: DimensionResize, clientX: number, clientY: number): void {
    const grid = gridRef.current;
    if (!grid) return;
    grid.dataset.resizing = resize.axis;
    if (resize.axis === "column") {
      grid.style.gridTemplateColumns = gridTemplateColumns(resize.sheet, resize.viewport, resize);
    } else {
      for (const { element } of resize.rowStyles) {
        element.style.height = `${resize.size}px`;
        element.style.minHeight = `${resize.size}px`;
      }
    }
    resize.handle.setAttribute("aria-valuenow", String(resize.size));
    const readout = dimensionResizeStatusRef.current;
    const appBounds = appRef.current?.getBoundingClientRect();
    if (!readout || !appBounds) return;
    readout.hidden = false;
    readout.textContent = resize.axis === "column"
      ? `${columnName(resize.index)} · ${resize.size} px`
      : `Row ${resize.index + 1} · ${resize.size} px`;
    readout.style.left = `${clamp(clientX - appBounds.left + 10, 8, Math.max(8, appBounds.width - 118))}px`;
    readout.style.top = `${clamp(clientY - appBounds.top + 10, 84, Math.max(84, appBounds.height - 42))}px`;
  }

  function endDimensionResize(event: React.PointerEvent<HTMLSpanElement>): void {
    const resize = dimensionResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    finishDimensionResize(true);
  }

  function cancelDimensionResize(): void {
    finishDimensionResize(false);
  }

  function finishDimensionResize(commit: boolean): void {
    const resize = dimensionResizeRef.current;
    if (!resize) return;
    dimensionResizeRef.current = null;
    try {
      if (resize.handle.hasPointerCapture(resize.pointerId)) resize.handle.releasePointerCapture(resize.pointerId);
    } catch { /* The browser may already have released capture. */ }
    gridRef.current?.removeAttribute("data-resizing");
    if (dimensionResizeStatusRef.current) dimensionResizeStatusRef.current.hidden = true;
    if (!commit || resize.size === resize.startSize) {
      restoreDimensionResizePreview(resize);
      return;
    }
    void commitDimensionResize(resize);
  }

  function restoreDimensionResizePreview(resize: DimensionResize): void {
    const grid = gridRef.current;
    if (grid && resize.axis === "column") grid.style.gridTemplateColumns = resize.gridTemplate;
    for (const { element, height, minHeight } of resize.rowStyles) {
      element.style.height = height;
      element.style.minHeight = minHeight;
    }
    resize.handle.setAttribute("aria-valuenow", String(resize.startSize));
  }

  async function commitDimensionResize(resize: DimensionResize): Promise<void> {
    if (editingRef.current || sheetRef.current !== resize.sheetId || !(await commitDraft())) {
      restoreDimensionResizePreview(resize);
      return;
    }
    setStatus((current) => current && current.workbookId === workbookIdRef.current
      ? {
          ...current,
          sheets: current.sheets.map((sheet) => sheet.id !== resize.sheetId
            ? sheet
            : resize.axis === "column"
              ? { ...sheet, columnWidths: { ...sheet.columnWidths, [String(resize.index)]: resize.size } }
              : { ...sheet, rowHeights: { ...sheet.rowHeights, [String(resize.index)]: resize.size } }),
        }
      : current);
    const operation = resize.axis === "column"
      ? { type: "resize_column", sheetId: resize.sheetId, column: resize.index, width: resize.size }
      : { type: "resize_row", sheetId: resize.sheetId, row: resize.index, height: resize.size };
    if (!(await applyOperations([operation]))) restoreDimensionResizePreview(resize);
  }

  async function resetDimension(): Promise<void> {
    if (!dialog || dialog.kind !== "dimension" || !activeSheetId) return;
    const operation = dialog.axis === "row"
      ? { type: "resize_row", sheetId: activeSheetId, row: dialog.index, height: null }
      : { type: "resize_column", sheetId: activeSheetId, column: dialog.index, width: null };
    if (await applyOperations([operation])) closeDialog();
  }

  async function save(saveAs = false): Promise<void> {
    if (!status || busy || recoveryPending || dialog || !(await commitDraft())) return;
    if (saveAs || !status.nativeSource) {
      openDialog({ kind: "save_as", value: status.nativeSource?.path ?? "/workbook.nsheet", error: null });
      return;
    }
    await saveNative();
  }

  async function saveNative(path?: string): Promise<boolean> {
    setBusy(true);
    try {
      await callTool({
        target,
        name: "workbook_save",
        arguments: {
          action: "native",
          expectedRevision: revisionRef.current,
          commandId: createCommandId(),
          ...(path ? { path } : {}),
        },
      }, 60);
      await refresh(activeSheetId ?? undefined);
      return true;
    } catch (nextError) { setError(errorMessage(nextError)); return false; }
    finally { setBusy(false); }
  }

  async function goToAddress(): Promise<void> {
    try {
      const address = parseCellAddress(addressEntry);
      if (!(await commitDraft())) return;
      selectCell(address, false, true);
      setAddressEntry(formatCellAddress(address));
      setError(null);
    } catch (nextError) {
      setError(errorMessage(nextError));
      addressRef.current?.select();
    }
  }

  async function movePage(rowDelta: number, columnDelta: number): Promise<void> {
    if (!(await commitDraft())) return;
    selectCell({
      row: clamp(focus.row + rowDelta, 0, SPREADSHEET_LIMITS.maxRows - 1),
      column: clamp(focus.column + columnDelta, 0, SPREADSHEET_LIMITS.maxColumns - 1),
    }, false, true);
  }

  function onAppKeyDown(event: React.KeyboardEvent<HTMLElement>): void {
    if (event.key === "F1" && !dialog && !recoveryPending) {
      event.preventDefault();
      openFormulaHelp();
      return;
    }
    const modifier = event.ctrlKey || event.metaKey;
    if (modifier && event.key.toLocaleLowerCase("en-US") === "s") {
      event.preventDefault();
      if (!dialog && !recoveryPending) void save(event.shiftKey);
      return;
    }
    if (modifier && event.key.toLocaleLowerCase("en-US") === "n") {
      event.preventDefault();
      if (!dialog && !recoveryPending) void requestNewWorkbook();
      return;
    }
    if (modifier && event.key.toLocaleLowerCase("en-US") === "o") {
      event.preventDefault();
      if (!dialog && !recoveryPending) void openWorkbookDialog();
      return;
    }
    if (modifier && event.key.toLocaleLowerCase("en-US") === "f") {
      event.preventDefault();
      if (!dialog && !recoveryPending) void openFindDialog();
      return;
    }
    if (event.key !== "F6") return;
    event.preventDefault();
    if (recoveryPending) {
      recoveryDialogRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
      return;
    }
    const regions = [commandRef.current, formulaRegionRef.current, gridRef.current, sheetStripRef.current].filter((region): region is HTMLElement => Boolean(region));
    const current = regions.findIndex((region) => region.contains(document.activeElement));
    const next = regions[(current + (event.shiftKey ? -1 : 1) + regions.length) % regions.length];
    if (next === gridRef.current) (gridRef.current?.querySelector<HTMLElement>(`[data-address="${activeAddress}"]`) ?? gridRef.current)?.focus();
    else if (next === formulaRegionRef.current) formulaRef.current?.focus();
    else if (next === commandRef.current) next.querySelector<HTMLElement>("summary, button:not(:disabled), select:not(:disabled)")?.focus();
    else (next?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ?? next?.querySelector<HTMLElement>("button"))?.focus();
  }

  function onToolbarMenuToggle(event: React.SyntheticEvent<HTMLDetailsElement>): void {
    const opened = event.currentTarget;
    if (!opened.open) return;
    document.querySelectorAll<HTMLDetailsElement>(".toolbar-menu[open], .sheet-menu[open], .formula-help-menu[open]").forEach((menu) => {
      if (menu !== opened) menu.removeAttribute("open");
    });
  }

  function openFormulaHelp(): void {
    const menu = formulaHelpMenuRef.current;
    if (!menu) return;
    formulaHelpReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : formulaRef.current;
    menu.open = true;
    requestAnimationFrame(() => formulaHelpSearchRef.current?.focus());
  }

  function closeFormulaHelp(restoreFocus = true): void {
    formulaHelpMenuRef.current?.removeAttribute("open");
    if (!restoreFocus) return;
    const returnFocus = formulaHelpReturnFocusRef.current;
    requestAnimationFrame(() => {
      if (returnFocus?.isConnected) returnFocus.focus();
      else formulaRef.current?.focus();
    });
  }

  function onFormulaHelpToggle(event: React.SyntheticEvent<HTMLDetailsElement>): void {
    onToolbarMenuToggle(event);
    const opened = event.currentTarget.open;
    setFormulaHelpOpen(opened);
    if (opened) requestAnimationFrame(() => formulaHelpSearchRef.current?.focus());
  }

  function closeToolbarMenuFromPanel(event: React.MouseEvent<HTMLDivElement>): void {
    if (event.target instanceof Element && event.target.closest("button")) {
      event.currentTarget.closest("details")?.removeAttribute("open");
    }
  }

  async function runOperationsAfterDraft(operations: JsonObject[]): Promise<void> {
    if (await commitDraft()) await applyOperations(operations);
  }

  async function sortSelection(direction: "ascending" | "descending"): Promise<void> {
    if (!activeSheetId) return;
    const filtered = activeSheet?.filter ? normalizeRange(parseRange(activeSheet.filter.range)) : null;
    const hasHeader = sortHasHeader || Boolean(filtered && sameRange(filtered, selection));
    await runOperationsAfterDraft([{
      type: "sort_range",
      sheetId: activeSheetId,
      range: selectionLabel,
      keyColumn: focus.column,
      direction,
      hasHeader,
    }]);
  }

  async function changeDecimals(delta: -1 | 1): Promise<void> {
    const decimals = clamp((activeCell?.style?.decimals ?? 0) + delta, 0, 12);
    const numberFormat = activeCell?.style?.numberFormat ?? "general";
    await runOperationsAfterDraft([{
      type: "apply_style",
      sheetId: activeSheetId!,
      range: selectionLabel,
      style: { decimals, ...(numberFormat === "general" ? { numberFormat: "number" } : {}) },
    }]);
  }

  async function openFilterDialog(): Promise<void> {
    if (!(await commitDraft()) || !activeSheetId) return;
    if (selection.end.row <= selection.start.row) {
      setError("Select a range containing one header row and at least one data row before filtering.");
      return;
    }
    const current = activeSheet?.filter;
    openDialog({
      kind: "filter",
      mode: current && "nonBlank" in current ? "nonblank" : "equals",
      value: current && "equals" in current ? current.equals ?? "" : "",
      error: null,
      sheetId: activeSheetId,
      range: selectionLabel,
      column: focus.column,
    });
  }

  async function clearFilter(): Promise<void> {
    if (!activeSheetId || !activeSheet?.filter) return;
    await runOperationsAfterDraft([{ type: "clear_filter", sheetId: activeSheetId }]);
  }

  async function openExportDialog(format: ExportFormat): Promise<void> {
    if (!status || !activeSheetId || busy || recoveryPending || dialog || !(await commitDraft())) return;
    const common = {
      kind: "export_setup" as const,
      format,
      path: suggestedExportPath(status.nativeSource?.path ?? null, format),
      csvInjectionPolicy: null,
      bom: false,
      error: null,
    };
    openDialog(format === "csv"
      ? { ...common, sheetId: activeSheetId, range: selectionLabel }
      : common);
  }

  async function preflightExport(setup: Extract<UiDialog, { kind: "export_setup" }>): Promise<void> {
    const path = setup.path.trim();
    const pathError = validateExportPath(path, setup.format);
    if (pathError) { setDialog({ ...setup, error: pathError }); return; }
    if (setup.format === "csv" && !setup.csvInjectionPolicy) {
      setDialog({ ...setup, error: "Choose Exact or Safe text handling before continuing." });
      return;
    }
    const options: ExportOptions = setup.format === "csv"
      ? {
          format: "csv",
          path,
          sheetId: setup.sheetId!,
          range: setup.range!,
          csvInjectionPolicy: setup.csvInjectionPolicy!,
          bom: setup.bom,
        }
      : { format: "xlsx", path };
    setBusy(true);
    try {
      const result = assertExportPreflight(await callTool({
        target,
        name: "workbook_save",
        arguments: {
          action: "export_preflight",
          expectedRevision: revisionRef.current,
          commandId: createCommandId(),
          ...exportToolOptions(options),
        },
      }, 90));
      setDialog({
        kind: "export_review",
        options,
        revision: result.revision,
        preflightToken: result.preflightToken,
        expiresAt: result.expiresAt,
        byteLength: result.byteLength,
        warnings: result.warnings,
        losses: result.losses,
        error: null,
      });
    } catch (nextError) {
      setDialog({ ...setup, path, error: errorMessage(nextError) });
    } finally {
      setBusy(false);
    }
  }

  async function commitExport(review: Extract<UiDialog, { kind: "export_review" }>): Promise<void> {
    if (busy || recoveryPending) return;
    setBusy(true);
    try {
      const result = assertExportCommit(await callTool({
        target,
        name: "workbook_save",
        arguments: {
          action: "export_commit",
          expectedRevision: review.revision,
          commandId: createCommandId(),
          preflightToken: review.preflightToken,
          ...exportToolOptions(review.options),
        },
      }, 90));
      await refresh(activeSheetId ?? undefined);
      setError(null);
      setNotice(`Exported ${result.format.toUpperCase()} snapshot to ${result.path}. The native workbook save state was unchanged.`);
      closeDialog();
    } catch (nextError) {
      setDialog({ ...review, error: errorMessage(nextError) });
    } finally {
      setBusy(false);
    }
  }

  async function switchSheet(sheetId: string): Promise<void> {
    if (!(await commitDraft())) return;
    const origin = { row: 0, column: 0 };
    sheetRef.current = sheetId;
    viewportRef.current = origin;
    setActiveSheetId(sheetId);
    setViewport(origin);
    setAnchor(origin);
    setFocus(origin);
    setBusy(true);
    await refresh(sheetId, origin);
  }

  function onSheetTabKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, sheetId: string): void {
    if (!status || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const current = Math.max(0, status.sheets.findIndex((sheet) => sheet.id === sheetId));
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? status.sheets.length - 1
        : clamp(current + (event.key === "ArrowLeft" ? -1 : 1), 0, status.sheets.length - 1);
    const nextSheet = status.sheets[nextIndex];
    if (!nextSheet || nextSheet.id === sheetId) return;
    void switchSheet(nextSheet.id).then(() => requestAnimationFrame(() => {
      const tab = sheetStripRef.current?.querySelector<HTMLElement>(`[data-sheet-id="${nextSheet.id}"]`);
      tab?.focus();
      tab?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }));
  }

  async function resolveRecovery(action: "recover" | "discard_recovery"): Promise<void> {
    if (!status || busy) return;
    setRecoveryError(null);
    setBusy(true);
    try {
      await callTool({ target, name: "workbook_session", arguments: {
        action,
        expectedRevision: revisionRef.current,
        commandId: createCommandId(),
      } }, 30);
      await refresh();
      requestAnimationFrame(() => gridRef.current?.querySelector<HTMLElement>(`[data-address="${activeAddress}"]`)?.focus());
    } catch (nextError) { setRecoveryError(errorMessage(nextError)); }
    finally { setBusy(false); }
  }

  function openDialog(next: UiDialog): void {
    dialogReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setDialog(next);
  }

  function closeDialog(): void {
    const returnFocus = dialogReturnFocusRef.current;
    setDialog(null);
    dialogReturnFocusRef.current = null;
    requestAnimationFrame(() => {
      if (returnFocus?.isConnected) returnFocus.focus();
      else gridRef.current?.querySelector<HTMLElement>(`[data-address="${activeAddress}"]`)?.focus();
    });
  }

  async function submitDialog(): Promise<void> {
    if (!dialog || busy) return;
    if (dialog.kind === "export_setup") { await preflightExport(dialog); return; }
    if (dialog.kind === "export_review") { await commitExport(dialog); return; }
    if (dialog.kind === "find") { await runFind(dialog); return; }
    if (dialog.kind === "open") {
      if (await openWorkbook(dialog)) closeDialog();
      return;
    }
    if (dialog.kind === "replace") {
      if (await replaceSession(dialog.action, status?.dirty === true)) closeDialog();
      else setDialog({ ...dialog, error: "The workbook could not be replaced. Review the error and try again." });
      return;
    }
    if (dialog.kind === "draft_conflict") {
      const origin = draftOriginRef.current;
      if (!origin) { closeDialog(); return; }
      draftOriginRef.current = { ...origin, input: cloneInput(dialog.latest) };
      setDialog(null);
      await commitDraft();
      return;
    }
    if (dialog.kind === "delete_sheet") {
      if (await applyOperations([{ type: "delete_sheet", sheetId: dialog.sheetId }])) closeDialog();
      else setDialog({ ...dialog, error: "The sheet could not be deleted. Review the error and try again." });
      return;
    }
    if (dialog.kind === "dimension") {
      const size = Number(dialog.value);
      const minimum = dialog.axis === "row" ? 18 : 24;
      const maximum = dialog.axis === "row" ? 300 : 600;
      if (!Number.isFinite(size) || size < minimum || size > maximum) {
        setDialog({ ...dialog, error: `Enter a size from ${minimum} to ${maximum} pixels.` });
        return;
      }
      const operation = dialog.axis === "row"
        ? { type: "resize_row", sheetId: activeSheetId!, row: dialog.index, height: size }
        : { type: "resize_column", sheetId: activeSheetId!, column: dialog.index, width: size };
      if (await applyOperations([operation])) closeDialog();
      else setDialog({ ...dialog, error: `The ${dialog.axis} could not be resized.` });
      return;
    }
    if (dialog.kind === "filter") {
      const filter: JsonObject = dialog.mode === "equals"
        ? { range: dialog.range, column: dialog.column, equals: dialog.value }
        : { range: dialog.range, column: dialog.column, nonBlank: true };
      if (await applyOperations([{ type: "set_filter", sheetId: dialog.sheetId, filter }])) {
        const header = parseRange(dialog.range).start;
        selectCell({ row: header.row, column: dialog.column }, false, true);
        closeDialog();
      }
      else setDialog({ ...dialog, error: "The filter could not be applied. Review the error and try again." });
      return;
    }
    const value = dialog.value.trim();
    if (dialog.kind === "save_as") {
      const message = validateNativePath(value);
      if (message) { setDialog({ ...dialog, error: message }); return; }
      if (await saveNative(value)) closeDialog();
      return;
    }
    const message = validateSheetName(value, status?.sheets ?? [], dialog.kind === "rename_sheet" ? dialog.sheetId : undefined);
    if (message) { setDialog({ ...dialog, error: message }); return; }
    if (await applyOperations([dialog.kind === "rename_sheet"
      ? { type: "rename_sheet", sheetId: dialog.sheetId, name: value }
      : { type: "add_sheet", name: value }])) closeDialog();
    else setDialog({ ...dialog, error: "The sheet could not be added. Review the error and try again." });
  }

  function acceptLatestDraftValue(): void {
    if (!dialog || dialog.kind !== "draft_conflict") return;
    setDraft(rawText(dialog.latest));
    finishEditing();
    closeDialog();
  }

  function trapDialogFocus(event: React.KeyboardEvent<HTMLElement>, dismissible: boolean): void {
    if (event.key === "Escape" && dismissible) { event.preventDefault(); closeDialog(); return; }
    if (event.key !== "Tab") return;
    const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('input, button:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])')];
    if (!controls.length) return;
    const first = controls[0]!;
    const last = controls.at(-1)!;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  function onDialogKeyDown(event: React.KeyboardEvent<HTMLElement>): void {
    trapDialogFocus(event, true);
    if (event.defaultPrevented || event.key !== "Enter" || event.metaKey || event.ctrlKey || event.altKey) return;
    const targetElement = event.target;
    if (!(targetElement instanceof HTMLInputElement) || targetElement.type === "checkbox" || targetElement.type === "radio") return;
    event.preventDefault();
    void submitDialog();
  }

  return (
    <main ref={appRef} className="spreadsheet-app" data-tid="spreadsheet-app" onKeyDown={onAppKeyDown}>
      <header ref={commandRef} className="command-bar" aria-label="Workbook commands">
        <details className="toolbar-menu" onToggle={onToolbarMenuToggle}>
          <summary role="button" aria-label="File and demo commands" title="File and workbook commands">
            <IoDocumentOutline aria-hidden="true" /><span className="menu-label">File</span><IoChevronDownOutline className="menu-chevron" aria-hidden="true" />
          </summary>
          <div className="toolbar-menu-panel" onClick={closeToolbarMenuFromPanel}>
            <button type="button" onClick={() => void requestNewWorkbook()} disabled={interactionBlocked || !status}><IoDocumentOutline aria-hidden="true" /><span>New workbook</span><kbd aria-hidden="true">⌘N</kbd></button>
            <button type="button" onClick={() => void openWorkbookDialog()} disabled={interactionBlocked || !status}><IoFolderOpenOutline aria-hidden="true" /><span>Open from Files…</span><kbd aria-hidden="true">⌘O</kbd></button>
            <span className="menu-separator" role="separator" />
            <button type="button" onClick={() => void save()} disabled={saveDisabled}><IoSaveOutline aria-hidden="true" /><span>Save</span><kbd aria-hidden="true">⌘S</kbd></button>
            <button type="button" onClick={() => void save(true)} disabled={interactionBlocked || !status}><IoCreateOutline aria-hidden="true" /><span>Save as…</span><kbd aria-hidden="true">⇧⌘S</kbd></button>
            <span className="menu-separator" role="separator" />
            <button type="button" onClick={() => void openExportDialog("xlsx")} disabled={interactionBlocked || !status || !activeSheetId} aria-haspopup="dialog"><IoDownloadOutline aria-hidden="true" /><span>Export workbook as XLSX…</span></button>
            <button type="button" onClick={() => void openExportDialog("csv")} disabled={interactionBlocked || !status || !activeSheetId} aria-haspopup="dialog"><IoDownloadOutline aria-hidden="true" /><span>Export current sheet as CSV…</span></button>
            <span className="menu-separator" role="separator" />
            <button type="button" onClick={() => void requestDemoWorkbook()} disabled={interactionBlocked || !status} title="Load the editable static feature gallery"><IoGridOutline aria-hidden="true" /><span>Kitchen Sink demo</span></button>
          </div>
        </details>
        <button
          className={`toolbar-icon save-command ${saveState}`}
          type="button"
          onClick={() => void save()}
          disabled={saveDisabled}
          aria-label="Save"
          title={saveTitle}
          data-tid="spreadsheet-save-command"
          data-state={saveState}
        ><IoSaveOutline aria-hidden="true" /></button>
        <span className="separator wide-command" />
        <button className="toolbar-icon wide-command" type="button" onClick={() => void history("undo")} disabled={interactionBlocked || !status?.canUndo} aria-label="Undo" title="Undo (Ctrl/Cmd+Z)"><IoArrowUndoOutline aria-hidden="true" /></button>
        <button className="toolbar-icon wide-command" type="button" onClick={() => void history("redo")} disabled={interactionBlocked || !status?.canRedo} aria-label="Redo" title="Redo (Ctrl/Cmd+Y)"><IoArrowRedoOutline aria-hidden="true" /></button>
        <button className="toolbar-icon wide-command" type="button" onClick={() => void copySelection()} disabled={interactionBlocked} aria-label="Copy" title="Copy selected cells (Ctrl/Cmd+C)"><IoCopyOutline aria-hidden="true" /></button>
        <button className="toolbar-icon wide-command" type="button" onClick={() => void pasteFromToolbar(false)} disabled={interactionBlocked} aria-label="Paste" title={clipboardReady ? "Paste formulas, values, and styles" : "Paste text from the system clipboard"}><IoClipboardOutline aria-hidden="true" /></button>
        <details className="toolbar-menu" onToggle={onToolbarMenuToggle}>
          <summary role="button" aria-label="More edit commands" title="Edit commands">
            <IoCreateOutline aria-hidden="true" /><span className="menu-label">Edit</span><IoChevronDownOutline className="menu-chevron" aria-hidden="true" />
          </summary>
          <div className="toolbar-menu-panel" onClick={closeToolbarMenuFromPanel}>
            <button type="button" onClick={() => void history("undo")} disabled={interactionBlocked || !status?.canUndo} aria-label="Undo"><IoArrowUndoOutline aria-hidden="true" /><span>Undo</span><kbd aria-hidden="true">⌘Z</kbd></button>
            <button type="button" onClick={() => void history("redo")} disabled={interactionBlocked || !status?.canRedo} aria-label="Redo"><IoArrowRedoOutline aria-hidden="true" /><span>Redo</span><kbd aria-hidden="true">⌘Y</kbd></button>
            <span className="menu-separator" role="separator" />
            <button type="button" onClick={() => void cutSelection()} disabled={interactionBlocked} title="Cut selected cells; Escape cancels"><IoCutOutline aria-hidden="true" /><span>Cut</span><kbd aria-hidden="true">⌘X</kbd></button>
            <button type="button" onClick={() => void copySelection()} disabled={interactionBlocked}><IoCopyOutline aria-hidden="true" /><span>Copy</span><kbd aria-hidden="true">⌘C</kbd></button>
            <button type="button" onClick={() => void pasteFromToolbar(false)} disabled={interactionBlocked}><IoClipboardOutline aria-hidden="true" /><span>Paste</span><kbd aria-hidden="true">⌘V</kbd></button>
            <button type="button" onClick={() => void pasteFromToolbar(true)} disabled={interactionBlocked} title={clipboardReady ? "Paste computed values without changing destination formatting" : "Paste text from the system clipboard"}><IoClipboardOutline aria-hidden="true" /><span>Paste values</span></button>
            <span className="menu-separator" role="separator" />
            <button type="button" onClick={() => void openFindDialog()} disabled={interactionBlocked} title="Find values or formulas"><IoSearchOutline aria-hidden="true" /><span>Find…</span><kbd aria-hidden="true">⌘F</kbd></button>
          </div>
        </details>
        <span className="separator wide-command" />
        <button className="toolbar-icon format-glyph wide-command" type="button" onClick={() => void runOperationsAfterDraft([{ type: "apply_style", sheetId: activeSheetId!, range: selectionLabel, style: { bold: !(activeCell?.style?.bold) } }])} disabled={interactionBlocked} aria-label="Bold" aria-pressed={activeCell?.style?.bold === true} title="Bold"><strong aria-hidden="true">B</strong></button>
        <button className="toolbar-icon format-glyph wide-command" type="button" onClick={() => void runOperationsAfterDraft([{ type: "apply_style", sheetId: activeSheetId!, range: selectionLabel, style: { italic: !(activeCell?.style?.italic) } }])} disabled={interactionBlocked} aria-label="Italic" aria-pressed={activeCell?.style?.italic === true} title="Italic"><em aria-hidden="true">I</em></button>
        <details className="toolbar-menu" onToggle={onToolbarMenuToggle}>
          <summary role="button" aria-label="More formatting commands" title="Format cells">
            <IoColorPaletteOutline aria-hidden="true" /><span className="menu-label">Format</span><IoChevronDownOutline className="menu-chevron" aria-hidden="true" />
          </summary>
          <div className="toolbar-menu-panel toolbar-format-panel" onClick={closeToolbarMenuFromPanel}>
            <button type="button" onClick={() => void runOperationsAfterDraft([{ type: "apply_style", sheetId: activeSheetId!, range: selectionLabel, style: { bold: !(activeCell?.style?.bold) } }])} disabled={interactionBlocked} aria-label="Bold" aria-pressed={activeCell?.style?.bold === true}><strong aria-hidden="true">B</strong><span>Bold</span></button>
            <button type="button" onClick={() => void runOperationsAfterDraft([{ type: "apply_style", sheetId: activeSheetId!, range: selectionLabel, style: { italic: !(activeCell?.style?.italic) } }])} disabled={interactionBlocked} aria-label="Italic" aria-pressed={activeCell?.style?.italic === true}><em>I</em> Italic</button>
            <button type="button" onClick={() => void runOperationsAfterDraft([{ type: "apply_style", sheetId: activeSheetId!, range: selectionLabel, style: { wrap: !(activeCell?.style?.wrap) } }])} disabled={interactionBlocked} aria-label="Wrap text" aria-pressed={activeCell?.style?.wrap === true}>Wrap text</button>
            <select
              aria-label="Number format"
              title="Number format"
              value={activeCell?.style?.numberFormat ?? "general"}
              disabled={interactionBlocked}
              onChange={(event) => { const value = event.currentTarget.value; event.currentTarget.closest("details")?.removeAttribute("open"); void runOperationsAfterDraft([{ type: "apply_style", sheetId: activeSheetId!, range: selectionLabel, style: { numberFormat: value } }]); }}
            >
              <option value="general">General</option>
              <option value="number">Number</option>
              <option value="currency">Currency</option>
              <option value="percent">Percent</option>
              <option value="date">Date</option>
              <option value="time">Time</option>
            </select>
            <select
              aria-label="Horizontal alignment"
              title="Horizontal alignment"
              value={activeCell?.style?.alignment ?? "left"}
              disabled={interactionBlocked}
              onChange={(event) => { const value = event.currentTarget.value; event.currentTarget.closest("details")?.removeAttribute("open"); void runOperationsAfterDraft([{ type: "apply_style", sheetId: activeSheetId!, range: selectionLabel, style: { alignment: value } }]); }}
            >
              <option value="left">Align left</option>
              <option value="center">Align center</option>
              <option value="right">Align right</option>
            </select>
        <button
          type="button"
          onClick={() => void changeDecimals(-1)}
          disabled={interactionBlocked || (activeCell?.style?.decimals ?? 0) === 0}
          aria-label="Decrease decimals"
          title="Show fewer decimal places"
        >.0←</button>
        <button
          type="button"
          onClick={() => void changeDecimals(1)}
          disabled={interactionBlocked || (activeCell?.style?.decimals ?? 0) >= 12}
          aria-label="Increase decimals"
          title="Show more decimal places"
        >→.0</button>
        <label className="color-control" title="Text color">
          <span aria-hidden="true">A</span>
          <input
            type="color"
            aria-label="Text color"
            value={activeCell?.style?.textColor ?? "#e8edf5"}
            disabled={interactionBlocked}
            onChange={(event) => void runOperationsAfterDraft([{ type: "apply_style", sheetId: activeSheetId!, range: selectionLabel, style: { textColor: event.currentTarget.value.toUpperCase() } }])}
          />
        </label>
        <label className="color-control fill-color-control" title="Fill color">
          <span aria-hidden="true">▣</span>
          <input
            type="color"
            aria-label="Fill color"
            value={activeCell?.style?.fillColor ?? "#0d1016"}
            disabled={interactionBlocked}
            onChange={(event) => void runOperationsAfterDraft([{ type: "apply_style", sheetId: activeSheetId!, range: selectionLabel, style: { fillColor: event.currentTarget.value.toUpperCase() } }])}
          />
        </label>
            <button
              type="button"
              onClick={() => void runOperationsAfterDraft([{ type: "clear", sheetId: activeSheetId!, range: selectionLabel, contents: false, styles: true }])}
              disabled={interactionBlocked}
              aria-label="Clear formatting"
              title="Clear formatting while preserving values and formulas"
            >Clear format</button>
          </div>
        </details>
        <details className="toolbar-menu toolbar-menu-data" onToggle={onToolbarMenuToggle}>
          <summary role="button" aria-label="Data and structure commands" title="Data and structure commands">
            <IoOptionsOutline aria-hidden="true" /><span className="menu-label">Data</span><IoChevronDownOutline className="menu-chevron" aria-hidden="true" />
          </summary>
          <div className="toolbar-menu-panel toolbar-data-panel" onClick={closeToolbarMenuFromPanel}>
            <button type="button" onClick={() => void fillDown()} disabled={interactionBlocked || selection.start.row === selection.end.row}>Fill down</button>
            <button type="button" onClick={() => void fillRight()} disabled={interactionBlocked || selection.start.column === selection.end.column}>Fill right</button>
            <button type="button" onClick={() => void structure("row", "insert")} disabled={interactionBlocked} title={`Insert ${selection.end.row - selection.start.row + 1} row(s) above the selection`}>Insert row</button>
            <button type="button" onClick={() => void structure("row", "delete")} disabled={interactionBlocked} title={`Delete ${selection.end.row - selection.start.row + 1} selected row(s)`}>Delete row</button>
            <button type="button" onClick={() => void structure("column", "insert")} disabled={interactionBlocked} title={`Insert ${selection.end.column - selection.start.column + 1} column(s) before the selection`}>Insert column</button>
            <button type="button" onClick={() => void structure("column", "delete")} disabled={interactionBlocked} title={`Delete ${selection.end.column - selection.start.column + 1} selected column(s)`}>Delete column</button>
            <button type="button" onClick={() => void openDimensionDialog("row")} disabled={interactionBlocked}>Row height…</button>
            <button type="button" onClick={() => void openDimensionDialog("column")} disabled={interactionBlocked}>Column width…</button>
            <button
              type="button"
              onClick={() => void sortSelection("ascending")}
              disabled={interactionBlocked || selection.start.row === selection.end.row}
              title={`Sort selected range ascending by column ${columnName(focus.column)}`}
            >Sort A–Z</button>
            <button
              type="button"
              onClick={() => void sortSelection("descending")}
              disabled={interactionBlocked || selection.start.row === selection.end.row}
              title={`Sort selected range descending by column ${columnName(focus.column)}`}
            >Sort Z–A</button>
            <label className="sort-header-control">
              <input
                type="checkbox"
                checked={sortHasHeader}
                onChange={(event) => setSortHasHeader(event.currentTarget.checked)}
                disabled={interactionBlocked || selection.start.row === selection.end.row}
              />
              Selection has header row
            </label>
            <button
              type="button"
              onClick={() => void openFilterDialog()}
              disabled={interactionBlocked || !activeSheetId}
              aria-haspopup="dialog"
              title="Filter the selected range using the focused column"
            >Filter…</button>
            <button
              type="button"
              onClick={() => void clearFilter()}
              disabled={interactionBlocked || !activeSheet?.filter}
            >Clear filter</button>
          </div>
        </details>
        {activeSheet?.filter && (
          <span className="filter-state" data-tid="spreadsheet-filter-state" role="status" aria-label={filterDescription(activeSheet.filter, activeSheet.hiddenRowCount)} title={filterDescription(activeSheet.filter, activeSheet.hiddenRowCount)}>
            <IoOptionsOutline aria-hidden="true" /> {columnName(activeSheet.filter.column)} · {activeSheet.hiddenRowCount}
          </span>
        )}
      </header>

      <section ref={formulaRegionRef} className={`formula-bar${editing ? " editing" : ""}${editing && draft.startsWith("=") ? " formula-point-mode" : ""}`} aria-label="Cell editor and grid navigation">
        <input
          ref={addressRef}
          className="name-box"
          aria-label="Go to cell address"
          title="Enter a cell address, for example A1 or BC250"
          value={addressEntry}
          disabled={interactionBlocked}
          onChange={(event) => setAddressEntry(event.currentTarget.value.toUpperCase())}
          onKeyDown={(event) => {
            if (event.key === "Enter") { event.preventDefault(); void goToAddress(); }
            if (event.key === "Escape") { event.preventDefault(); setAddressEntry(activeAddress); (editingRef.current ? formulaRef.current : gridRef.current?.querySelector<HTMLElement>(`[data-address="${activeAddress}"]`))?.focus(); }
          }}
        />
        {editing && (
          <div className="formula-draft-actions" aria-label="Cell edit actions">
            <button type="button" className="toolbar-icon" onClick={() => cancelDraft()} aria-label="Cancel cell edit" title="Cancel (Escape)"><IoCloseOutline aria-hidden="true" /></button>
            <button type="button" className="toolbar-icon accept" onClick={() => void commitDraft()} aria-label="Accept cell edit" title="Accept (Enter)"><IoCheckmarkOutline aria-hidden="true" /></button>
          </div>
        )}
        <button type="button" className="formula-mark" onClick={startFormula} disabled={interactionBlocked} aria-label="Start formula" title="Start a formula, then click or drag cells">=</button>
        <input
          ref={formulaRef}
          aria-label={`Raw input for ${activeAddress}`}
          aria-describedby={formulaEditorHint ? "spreadsheet-formula-hint" : undefined}
          placeholder="Value or formula"
          value={draft}
          disabled={interactionBlocked}
          onFocus={() => beginEditing()}
          onChange={(event) => { clearFormulaReference(); setDraft(event.currentTarget.value); }}
          onKeyDown={(event) => {
            if (event.key === "F4" && cycleFormulaReferenceAbsolute()) { event.preventDefault(); return; }
            if (event.key === "Enter") { event.preventDefault(); void commitDraft(event.shiftKey ? -1 : 1); }
            if (event.key === "Tab") { event.preventDefault(); void commitDraft(0, event.shiftKey ? -1 : 1); }
            if (event.key === "Escape") { event.preventDefault(); cancelDraft(); }
          }}
        />
        {formulaEditorHint && (
          <span id="spreadsheet-formula-hint" className="formula-hint" data-tid="spreadsheet-formula-hint" title={formulaEditorHint}>
            {formulaEditorHint}
          </span>
        )}
        <details ref={formulaHelpMenuRef} className="formula-help-menu" onToggle={onFormulaHelpToggle}>
          <summary
            role="button"
            aria-label="Formula help"
            aria-controls="spreadsheet-formula-help-panel"
            aria-expanded={formulaHelpOpen}
            title="Formula help (F1)"
            onPointerDown={(event) => { formulaHelpReturnFocusRef.current = event.currentTarget; }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") formulaHelpReturnFocusRef.current = event.currentTarget;
            }}
          ><IoHelpCircleOutline aria-hidden="true" /></summary>
          <div
            id="spreadsheet-formula-help-panel"
            className="formula-help-panel"
            role="dialog"
            aria-labelledby="spreadsheet-formula-help-title"
          >
            <header>
              <div>
                <strong id="spreadsheet-formula-help-title">Formula help</strong>
                <span>Formulas begin with <code>=</code> and recalculate when referenced cells change.</span>
              </div>
              <button type="button" className="toolbar-icon" onClick={() => closeFormulaHelp()} aria-label="Close formula help" title="Close"><IoCloseOutline aria-hidden="true" /></button>
            </header>
            <label htmlFor="spreadsheet-formula-help-search">Find a function</label>
            <input
              ref={formulaHelpSearchRef}
              id="spreadsheet-formula-help-search"
              type="search"
              value={formulaHelpQuery}
              placeholder="SUM, lookup, date…"
              autoComplete="off"
              onChange={(event) => setFormulaHelpQuery(event.currentTarget.value)}
            />
            <span className="formula-help-count" role="status">{formulaHelpFunctions.length} supported function{formulaHelpFunctions.length === 1 ? "" : "s"}</span>
            <ul className="formula-quick-tips">
              <li><code>A1</code> references a cell; <code>A1:B10</code> references a range; <code>Sales!A1</code> references another sheet.</li>
              <li>Click cells or drag ranges while editing. Type an operator before pointing to the next reference.</li>
              <li>F4 cycles <code>A1 → $A$1 → A$1 → $A1</code>. Enter or Tab accepts; Escape cancels.</li>
              <li>Use commas between arguments. JavaScript custom functions, named ranges, and array formulas are not supported in v1.</li>
            </ul>
            <div className="formula-help-results" role="list" aria-label="Supported formula functions">
              {formulaHelpFunctions.map((guide) => (
                <article key={guide.name} role="listitem" data-formula-function={guide.name}>
                  <div><strong>{guide.name}</strong><span>{guide.category.replace("-", " ")}</span></div>
                  <code>{guide.syntax}</code>
                  <p>{guide.summary}</p>
                  <code className="formula-example">{guide.example}</code>
                  {guide.notes.length > 0 && <ul>{guide.notes.map((note) => <li key={note}>{note}</li>)}</ul>}
                </article>
              ))}
              {formulaHelpFunctions.length === 0 && <p className="formula-help-empty">No supported function matches “{formulaHelpQuery}”.</p>}
            </div>
            <details className="formula-error-help">
              <summary>Formula error meanings</summary>
              <dl>
                <div><dt>#DIV/0!</dt><dd>Division by zero or no numeric inputs.</dd></div>
                <div><dt>#VALUE!</dt><dd>Incompatible value, arguments, or lookup mode.</dd></div>
                <div><dt>#REF!</dt><dd>Invalid cell, range, or sheet reference.</dd></div>
                <div><dt>#NAME?</dt><dd>Unknown function or name.</dd></div>
                <div><dt>#NUM!</dt><dd>Invalid numeric result or calculation limit.</dd></div>
                <div><dt>#N/A</dt><dd>No exact lookup match.</dd></div>
                <div><dt>#CYCLE!</dt><dd>Circular reference.</dd></div>
              </dl>
            </details>
          </div>
        </details>
        <nav className="viewport-nav" aria-label="Grid pages">
          <button className="toolbar-icon" type="button" onClick={() => void movePage(0, -VISIBLE_COLUMNS)} disabled={interactionBlocked || focus.column === 0} aria-label="Previous 20 columns" title="Previous 20 columns"><IoChevronBackOutline aria-hidden="true" /></button>
          <button className="toolbar-icon" type="button" onClick={() => void movePage(0, VISIBLE_COLUMNS)} disabled={interactionBlocked || focus.column === SPREADSHEET_LIMITS.maxColumns - 1} aria-label="Next 20 columns" title="Next 20 columns"><IoChevronForwardOutline aria-hidden="true" /></button>
          <button className="toolbar-icon" type="button" onClick={() => void movePage(-VISIBLE_ROWS, 0)} disabled={interactionBlocked || focus.row === 0} aria-label="Previous 50 rows" title="Previous 50 rows"><IoChevronUpOutline aria-hidden="true" /></button>
          <button className="toolbar-icon" type="button" onClick={() => void movePage(VISIBLE_ROWS, 0)} disabled={interactionBlocked || focus.row === SPREADSHEET_LIMITS.maxRows - 1} aria-label="Next 50 rows" title="Next 50 rows"><IoChevronDownOutline aria-hidden="true" /></button>
          <output title="Visible grid window">{viewportRange(viewport)}</output>
        </nav>
      </section>

      <div className="banner-slot">
        {error
          ? <div className="error-banner" role="alert"><span>{error}</span><button onClick={() => setError(null)} aria-label="Dismiss error">×</button></div>
          : notice
            ? <div className="notice-banner" data-tid="spreadsheet-notice" role="status"><span>{notice}</span><button onClick={() => setNotice(null)} aria-label="Dismiss notice">×</button></div>
            : null}
      </div>

      <div
        ref={gridRef}
        className="grid-scroll"
        style={activeSheet && Object.keys(activeSheet.columnWidths).length
          ? { gridTemplateColumns: gridTemplateColumns(activeSheet, viewport) }
          : undefined}
        role="grid"
        tabIndex={hiddenRows.has(focus.row + 1) ? 0 : -1}
        aria-rowcount={100000}
        aria-colcount={1000}
        aria-label="Spreadsheet grid"
        aria-disabled={recoveryPending || undefined}
        onKeyDown={onGridKeyDown}
        onCopy={onCopy}
        onCut={onCut}
        onPaste={onPaste}
        onMouseUp={finishGridDrag}
        onMouseLeave={finishGridDrag}
      >
        <div className="grid-corner" aria-hidden="true" />
        {Array.from({ length: VISIBLE_COLUMNS }, (_, localColumn) => {
          const column = viewport.column + localColumn;
          const selected = selection.start.row === 0 && selection.end.row === SPREADSHEET_LIMITS.maxRows - 1
            && column >= selection.start.column && column <= selection.end.column;
          return <div
            key={`h-${column}`}
            className={`column-header${selected ? " selected" : ""}`}
            role="columnheader"
            aria-colindex={column + 1}
            aria-selected={selected}
            onMouseDown={(event) => {
              event.preventDefault();
              if (interactionBlocked) return;
              const choose = () => {
                setAnchor({ row: SPREADSHEET_LIMITS.maxRows - 1, column });
                setFocus({ row: 0, column });
                requestAnimationFrame(() => gridRef.current?.querySelector<HTMLElement>(`[data-address="${columnName(column)}1"]`)?.focus());
              };
              if (editingRef.current) void commitDraft().then((committed) => { if (committed) choose(); });
              else choose();
            }}
          >
            <span className="header-label">{columnName(column)}</span>
            <span
              className="dimension-resize-handle column-resize-handle"
              role="separator"
              aria-label={`Resize column ${columnName(column)}`}
              aria-orientation="vertical"
              aria-valuemin={24}
              aria-valuemax={600}
              aria-valuenow={activeSheet?.columnWidths[String(column)] ?? 96}
              aria-disabled={interactionBlocked || editing}
              title={editing ? "Finish editing the cell before resizing" : `Drag to resize column ${columnName(column)}`}
              tabIndex={-1}
              data-resize-column={columnName(column)}
              onPointerDown={(event) => beginDimensionResize(event, "column", column)}
              onPointerMove={moveDimensionResize}
              onPointerUp={endDimensionResize}
              onPointerCancel={(event) => { event.stopPropagation(); cancelDimensionResize(); }}
              onLostPointerCapture={(event) => { if (dimensionResizeRef.current?.handle === event.currentTarget) cancelDimensionResize(); }}
              onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
              onClick={(event) => { event.preventDefault(); event.stopPropagation(); }}
            />
          </div>;
        })}
        {Array.from({ length: VISIBLE_ROWS }, (_, localRow) => {
          const row = viewport.row + localRow;
          if (hiddenRows.has(row + 1)) return null;
          return (
          <div className="grid-row" role="row" aria-rowindex={row + 1} key={`r-${row}`}>
            <div
              className={`row-header${selection.start.column === 0 && selection.end.column === SPREADSHEET_LIMITS.maxColumns - 1 && row >= selection.start.row && row <= selection.end.row ? " selected" : ""}`}
              data-grid-row={row}
              role="rowheader"
              aria-selected={selection.start.column === 0 && selection.end.column === SPREADSHEET_LIMITS.maxColumns - 1 && row >= selection.start.row && row <= selection.end.row}
              style={rowSizeStyle(activeSheet, row)}
              onMouseDown={(event) => {
                event.preventDefault();
                if (interactionBlocked) return;
                const choose = () => {
                  setAnchor({ row, column: SPREADSHEET_LIMITS.maxColumns - 1 });
                  setFocus({ row, column: 0 });
                  requestAnimationFrame(() => gridRef.current?.querySelector<HTMLElement>(`[data-address="A${row + 1}"]`)?.focus());
                };
                if (editingRef.current) void commitDraft().then((committed) => { if (committed) choose(); });
                else choose();
              }}
            >
              <span className="header-label">{row + 1}</span>
              <span
                className="dimension-resize-handle row-resize-handle"
                role="separator"
                aria-label={`Resize row ${row + 1}`}
                aria-orientation="horizontal"
                aria-valuemin={18}
                aria-valuemax={300}
                aria-valuenow={activeSheet?.rowHeights[String(row)] ?? 28}
                aria-disabled={interactionBlocked || editing}
                title={editing ? "Finish editing the cell before resizing" : `Drag to resize row ${row + 1}`}
                tabIndex={-1}
                data-resize-row={row + 1}
                onPointerDown={(event) => beginDimensionResize(event, "row", row)}
                onPointerMove={moveDimensionResize}
                onPointerUp={endDimensionResize}
                onPointerCancel={(event) => { event.stopPropagation(); cancelDimensionResize(); }}
                onLostPointerCapture={(event) => { if (dimensionResizeRef.current?.handle === event.currentTarget) cancelDimensionResize(); }}
                onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
                onClick={(event) => { event.preventDefault(); event.stopPropagation(); }}
              />
            </div>
            {Array.from({ length: VISIBLE_COLUMNS }, (_, localColumn) => {
              const column = viewport.column + localColumn;
              const address = formatCellAddress({ row, column });
              const cell = cells.get(address);
              const active = row === focus.row && column === focus.column;
              const selected = row >= selection.start.row && row <= selection.end.row && column >= selection.start.column && column <= selection.end.column;
              const selectionEnd = row === selection.end.row && column === selection.end.column;
              const fillPreviewed = Boolean(fillPreview && addressInRange({ row, column }, fillPreview) && !addressInRange({ row, column }, selection));
              const cut = Boolean(cutRange && activeSheetId === cutSourceRef.current?.sheetId && addressInRange({ row, column }, cutRange));
              const formulaReferenced = Boolean(formulaReferenceRange && addressInRange({ row, column }, formulaReferenceRange));
              return (
                <div
                  key={address}
                  data-address={address}
                  data-grid-row={row}
                  className={`grid-cell${active ? " active" : ""}${selected ? " selected" : ""}${selectionEnd ? " selection-end" : ""}${fillPreviewed ? " fill-preview" : ""}${cut ? " cut-source" : ""}${formulaReferenced ? " formula-reference" : ""}${cell?.display?.startsWith("#") ? " formula-error" : ""}`}
                  role="gridcell"
                  aria-colindex={column + 1}
                  aria-selected={selected}
                  aria-label={`${address}, ${cell?.display || "blank"}${cell?.raw.kind === "formula" ? `, formula ${cell.raw.formula}` : ""}${computedErrorMessage(cell?.computed)}`}
                  tabIndex={active && !recoveryPending ? 0 : -1}
                  style={{ ...cellStyle(cell?.style), ...rowSizeStyle(activeSheet, row) }}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    if (interactionBlocked) return;
                    const element = event.currentTarget;
                    const extend = event.shiftKey;
                    const choose = () => { selectCell({ row, column }, extend); element.focus(); };
                    if (editingRef.current && draft.startsWith("=")) beginFormulaReference({ row, column });
                    else if (editingRef.current) void commitDraft().then((committed) => { if (committed) choose(); });
                    else { dragging.current = true; choose(); }
                  }}
                  onMouseEnter={() => {
                    if (formulaReferenceDraggingRef.current) extendFormulaReference({ row, column });
                    else if (dragging.current) queueDragFocus({ row, column });
                  }}
                  onDoubleClick={() => { beginEditing(); requestAnimationFrame(() => formulaRef.current?.focus()); }}
                >
                  {cell?.display ?? ""}
                  {selectionEnd && (
                    <button
                      type="button"
                      className="fill-handle"
                      tabIndex={-1}
                      aria-label={`Drag to fill from ${selectionLabel}`}
                      title="Drag vertically or horizontally to fill. Escape, Alt, or Meta cancels."
                      disabled={interactionBlocked}
                      onMouseDown={(event) => { if (!event.altKey && !event.metaKey) { event.preventDefault(); event.stopPropagation(); } }}
                      onClick={(event) => { if (!event.altKey && !event.metaKey) { event.preventDefault(); event.stopPropagation(); } }}
                      onPointerDown={beginFillDrag}
                      onPointerMove={moveFillDrag}
                      onPointerUp={endFillDrag}
                      onPointerCancel={() => cancelFillDrag()}
                      onLostPointerCapture={() => cancelFillDrag()}
                    />
                  )}
                </div>
              );
            })}
          </div>
          );
        })}
      </div>

      <output ref={dimensionResizeStatusRef} className="dimension-resize-status" data-tid="spreadsheet-dimension-resize-status" hidden />

      <footer ref={sheetStripRef} className="sheet-strip" aria-label="Workbook sheets and selection status">
        <button className="toolbar-icon sheet-add" type="button" onClick={() => void openAddSheetDialog()} disabled={interactionBlocked} aria-label="Add sheet" title="Add sheet"><IoAddOutline aria-hidden="true" /></button>
        <div className="sheet-tabs-viewport">
          <div className="sheet-tabs" role="tablist" aria-label="Workbook sheets">
            {status?.sheets.map((sheet) => (
              <button
                type="button"
                role="tab"
                aria-selected={sheet.id === activeSheetId}
                tabIndex={sheet.id === activeSheetId ? 0 : -1}
                data-sheet-id={sheet.id}
                className={sheet.id === activeSheetId ? "active" : ""}
                key={sheet.id}
                disabled={interactionBlocked}
                onClick={() => void switchSheet(sheet.id)}
                onKeyDown={(event) => onSheetTabKeyDown(event, sheet.id)}
              >{sheet.name}</button>
            ))}
          </div>
        </div>
        <details className="sheet-menu" onToggle={onToolbarMenuToggle}>
          <summary role="button" aria-label="Sheet actions" title="Rename or delete the current sheet"><IoEllipsisHorizontal aria-hidden="true" /></summary>
          <div className="sheet-menu-panel" onClick={closeToolbarMenuFromPanel}>
            <button type="button" onClick={() => void openRenameSheetDialog()} disabled={interactionBlocked || !activeSheet} aria-label="Rename current sheet"><IoCreateOutline aria-hidden="true" /><span>Rename sheet…</span></button>
            <button type="button" onClick={() => void openDeleteSheetDialog()} disabled={interactionBlocked || !status || status.sheets.length <= 1} aria-label="Delete current sheet"><IoTrashOutline aria-hidden="true" /><span>Delete sheet…</span></button>
          </div>
        </details>
        <span
          className={fillPreview ? "fill-preview-status" : "selection-summary"}
          data-tid="spreadsheet-selection-summary"
          role={fillPreview ? "status" : undefined}
          title="Selection metrics are shown only when the complete selection is loaded"
        >{fillPreview ? `Fill preview ${formatRange(fillPreview)}` : selectionMetrics}</span>
        <span className="workbook-name" data-tid="spreadsheet-workbook-path" aria-label={`Workbook ${workbookPath}`} title={workbookPath}><IoDocumentOutline aria-hidden="true" /><span>{fileName(workbookPath)}</span></span>
      </footer>
      {busy && <div className="busy-indicator" aria-label="Working" />}

      {dialog && (
        <div className="dialog-backdrop">
          <section
            ref={dialogPanelRef}
            className="ui-dialog"
            data-tid="spreadsheet-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="spreadsheet-dialog-title"
            aria-describedby="spreadsheet-dialog-description"
            onKeyDown={onDialogKeyDown}
          >
            <h2 id="spreadsheet-dialog-title">{dialogTitle(dialog)}</h2>
            <p id="spreadsheet-dialog-description">{dialogDescription(dialog)}</p>
            {dialog.kind === "export_setup" ? (
              <>
                <label htmlFor="spreadsheet-dialog-value">New Files destination</label>
                <input
                  id="spreadsheet-dialog-value"
                  value={dialog.path}
                  maxLength={240}
                  aria-invalid={Boolean(dialog.error)}
                  aria-describedby={dialog.error ? "spreadsheet-dialog-error" : "spreadsheet-dialog-description"}
                  onChange={(event) => setDialog({ ...dialog, path: event.currentTarget.value, error: null })}
                />
                {dialog.format === "csv" && (
                  <fieldset className="filter-options export-options">
                    <legend>Text beginning with =, +, -, @, tab, or carriage return</legend>
                    <label className="radio-option">
                      <input
                        type="radio"
                        name="csv-injection-policy"
                        checked={dialog.csvInjectionPolicy === "exact"}
                        onChange={() => setDialog({ ...dialog, csvInjectionPolicy: "exact", error: null })}
                      />
                      Export exact text
                    </label>
                    <label className="radio-option">
                      <input
                        type="radio"
                        name="csv-injection-policy"
                        checked={dialog.csvInjectionPolicy === "safe"}
                        onChange={() => setDialog({ ...dialog, csvInjectionPolicy: "safe", error: null })}
                      />
                      Add an apostrophe for safer spreadsheet opening
                    </label>
                    <label className="radio-option">
                      <input
                        type="checkbox"
                        checked={dialog.bom}
                        onChange={(event) => setDialog({ ...dialog, bom: event.currentTarget.checked, error: null })}
                      />
                      Include UTF-8 BOM
                    </label>
                    <p className="dialog-detail">Sheet: {status?.sheets.find((sheet) => sheet.id === dialog.sheetId)?.name ?? dialog.sheetId}; range: {dialog.range}</p>
                  </fieldset>
                )}
                <p className="new-file-note">Exports create a new snapshot file and fail safely if that path already exists. They never replace or mark the native workbook saved.</p>
              </>
            ) : dialog.kind === "export_review" ? (
              <section className="export-review" aria-label="Export preflight results">
                <dl>
                  <div><dt>Destination</dt><dd>{dialog.options.path}</dd></div>
                  <div><dt>Exact size</dt><dd>{dialog.byteLength.toLocaleString("en-US")} bytes</dd></div>
                  <div><dt>Snapshot revision</dt><dd>{dialog.revision}</dd></div>
                </dl>
                <div>
                  <h3>Warnings</h3>
                  {dialog.warnings.length
                    ? <ul>{dialog.warnings.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}</ul>
                    : <p>None.</p>}
                </div>
                <div>
                  <h3>Nonzero loss counts</h3>
                  {nonzeroLosses(dialog.losses).length
                    ? <ul>{nonzeroLosses(dialog.losses).map(([name, count]) => <li key={name}><code>{name}</code>: {count}</li>)}</ul>
                    : <p>None reported.</p>}
                </div>
                <p className="dialog-detail">This preflight expires at {new Date(dialog.expiresAt).toLocaleTimeString()}.</p>
              </section>
            ) : dialog.kind === "filter" ? (
              <fieldset className="filter-options">
                <legend>Show rows where {columnName(dialog.column)} is</legend>
                <label className="radio-option">
                  <input
                    type="radio"
                    name="filter-mode"
                    value="equals"
                    checked={dialog.mode === "equals"}
                    onChange={() => setDialog({ ...dialog, mode: "equals", error: null })}
                  />
                  Equal to entered text
                </label>
                <label className="radio-option">
                  <input
                    type="radio"
                    name="filter-mode"
                    value="nonblank"
                    checked={dialog.mode === "nonblank"}
                    onChange={() => setDialog({ ...dialog, mode: "nonblank", error: null })}
                  />
                  Not blank
                </label>
                {dialog.mode === "equals" && (
                  <label className="filter-value" htmlFor="spreadsheet-dialog-value">
                    Text to match exactly
                    <input
                      id="spreadsheet-dialog-value"
                      value={dialog.value}
                      maxLength={SPREADSHEET_LIMITS.maxTextLength}
                      aria-invalid={Boolean(dialog.error)}
                      aria-describedby={dialog.error ? "spreadsheet-dialog-error" : "spreadsheet-dialog-description"}
                      onChange={(event) => setDialog({ ...dialog, value: event.currentTarget.value, error: null })}
                    />
                  </label>
                )}
              </fieldset>
            ) : dialog.kind === "open" ? (
              <>
                <label htmlFor="spreadsheet-dialog-value">Files path</label>
                <input
                  id="spreadsheet-dialog-value"
                  value={dialog.value}
                  maxLength={240}
                  aria-invalid={Boolean(dialog.error)}
                  aria-describedby={dialog.error ? "spreadsheet-dialog-error" : "spreadsheet-dialog-description"}
                  onChange={(event) => setDialog({ ...dialog, value: event.currentTarget.value, error: null })}
                />
                <fieldset className="filter-options">
                  <legend>CSV type detection</legend>
                  <label className="radio-option">
                    <input type="radio" name="csv-typing" checked={dialog.csvTyping === "text"} onChange={() => setDialog({ ...dialog, csvTyping: "text", error: null })} />
                    Preserve every CSV field as text
                  </label>
                  <label className="radio-option">
                    <input type="radio" name="csv-typing" checked={dialog.csvTyping === "conservative"} onChange={() => setDialog({ ...dialog, csvTyping: "conservative", error: null })} />
                    Detect unambiguous numbers and booleans
                  </label>
                </fieldset>
                {dialog.discardDirty && <p className="destructive-note">Opening this file will discard the current unsaved workbook. Cancel keeps it unchanged.</p>}
              </>
            ) : dialog.kind === "find" ? (
              <>
                <label htmlFor="spreadsheet-dialog-value">Find</label>
                <input
                  id="spreadsheet-dialog-value"
                  value={dialog.query}
                  maxLength={1024}
                  aria-invalid={Boolean(dialog.error)}
                  onChange={(event) => setDialog({ ...dialog, query: event.currentTarget.value, matches: [], truncated: false, nextCursor: null, error: null })}
                />
                <label className="find-option">
                  <input type="checkbox" checked={dialog.formulas} onChange={(event) => setDialog({ ...dialog, formulas: event.currentTarget.checked, matches: [], truncated: false, nextCursor: null, error: null })} />
                  Search raw formulas instead of displayed values
                </label>
                {dialog.matches.length > 0 && (
                  <section className="find-results" aria-label="Find results">
                    {dialog.matches.map((match) => (
                      <button type="button" key={`${match.sheetId}:${match.address}`} onClick={() => void goToMatch(match)}>
                        <strong>{match.sheetName}!{match.address}</strong>
                        <span>{dialog.formulas ? match.raw : match.display}</span>
                      </button>
                    ))}
                    {dialog.nextCursor && <button type="button" onClick={() => void runFind(dialog, true)} disabled={busy}>Load more results</button>}
                  </section>
                )}
                {dialog.query && !dialog.error && dialog.matches.length === 0 && <p className="dialog-detail">Run Find to search the workbook.</p>}
              </>
            ) : dialog.kind === "replace" ? (
              <p className="destructive-note">{status?.dirty
                ? "This replaces the unsaved workbook. The operation is explicit and cannot be undone; Cancel keeps your current work."
                : "This replaces the current workbook session. Cancel keeps it unchanged."}</p>
            ) : dialog.kind === "delete_sheet" ? (
              <p className="destructive-note">Delete “{dialog.sheetName}” and its {dialog.cellCount.toLocaleString("en-US")} populated cell{dialog.cellCount === 1 ? "" : "s"}? This is one undoable workbook command.</p>
            ) : dialog.kind === "draft_conflict" ? (
              <section className="draft-conflict">
                <div><strong>Your draft</strong><code>{draft}</code></div>
                <div><strong>Latest workbook value</strong><code>{rawText(dialog.latest) || "(blank)"}</code></div>
                <p>Reapply writes your draft over the latest value as a new revision. Use latest discards only your uncommitted draft.</p>
              </section>
            ) : dialog.kind === "dimension" ? (
              <>
                <label htmlFor="spreadsheet-dialog-value">Size in pixels</label>
                <input
                  id="spreadsheet-dialog-value"
                  type="number"
                  min={dialog.axis === "row" ? 18 : 24}
                  max={dialog.axis === "row" ? 300 : 600}
                  value={dialog.value}
                  aria-invalid={Boolean(dialog.error)}
                  onChange={(event) => setDialog({ ...dialog, value: event.currentTarget.value, error: null })}
                />
              </>
            ) : (
              <>
                <label htmlFor="spreadsheet-dialog-value">{dialog.kind === "save_as" ? "Files path" : "Sheet name"}</label>
                <input
                  id="spreadsheet-dialog-value"
                  value={dialog.value}
                  maxLength={dialog.kind === "save_as" ? 240 : 31}
                  aria-invalid={Boolean(dialog.error)}
                  aria-describedby={dialog.error ? "spreadsheet-dialog-error" : "spreadsheet-dialog-description"}
                  onChange={(event) => setDialog({ ...dialog, value: event.currentTarget.value, error: null })}
                />
              </>
            )}
            {dialog.error && <p id="spreadsheet-dialog-error" className="dialog-error" role="alert">{dialog.error}</p>}
            <div className="dialog-actions">
              <button type="button" onClick={closeDialog} disabled={busy}>{dialog.kind.startsWith("export_") ? "Cancel export" : dialog.kind === "find" ? "Close" : dialog.kind === "draft_conflict" ? "Review draft" : "Cancel"}</button>
              {dialog.kind === "draft_conflict" && <button type="button" onClick={acceptLatestDraftValue} disabled={busy}>Use latest</button>}
              {dialog.kind === "dimension" && <button type="button" onClick={() => void resetDimension()} disabled={busy}>Use default</button>}
              <button type="button" onClick={() => void submitDialog()} className={dialog.kind === "delete_sheet" ? "danger" : "primary"} disabled={busy}>
                {dialogSubmitLabel(dialog)}
              </button>
            </div>
          </section>
        </div>
      )}

      {recoveryPending && (
        <div className="dialog-backdrop recovery-backdrop">
          <section
            ref={recoveryDialogRef}
            className="ui-dialog recovery-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="recovery-dialog-title"
            aria-describedby={`recovery-dialog-description${recoveryError ? " recovery-dialog-error" : ""}`}
            onKeyDown={(event) => trapDialogFocus(event, false)}
          >
            <h2 id="recovery-dialog-title">Recovery draft found</h2>
            <p id="recovery-dialog-description">A newer local draft is waiting. Recover it before editing, or explicitly discard it and keep the currently opened workbook.</p>
            {status?.recovery.savedAt && <p className="dialog-detail">Saved {new Date(status.recovery.savedAt).toLocaleString()}</p>}
            {recoveryError && <p id="recovery-dialog-error" className="dialog-error" role="alert">{recoveryError}</p>}
            <div className="dialog-actions">
              <button type="button" className="danger" onClick={() => void resolveRecovery("discard_recovery")} disabled={busy}>Discard recovery draft</button>
              <button type="button" className="primary" onClick={() => void resolveRecovery("recover")} disabled={busy}>Recover draft</button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

function dialogTitle(dialog: UiDialog): string {
  switch (dialog.kind) {
    case "save_as": return "Save as native workbook";
    case "open": return "Open workbook from Files";
    case "replace": return dialog.action === "demo" ? "Load Kitchen Sink workbook" : "Create new workbook";
    case "add_sheet": return "Add sheet";
    case "rename_sheet": return "Rename sheet";
    case "delete_sheet": return "Delete sheet";
    case "dimension": return dialog.axis === "row" ? `Resize row ${dialog.index + 1}` : `Resize column ${columnName(dialog.index)}`;
    case "draft_conflict": return "This cell changed while you were editing";
    case "find": return "Find in workbook";
    case "filter": return "Filter selected range";
    case "export_setup": return `Export ${dialog.format.toUpperCase()} snapshot`;
    case "export_review": return `Review ${dialog.options.format.toUpperCase()} export`;
  }
}

function visibleCellAtPoint(clientX: number, clientY: number, viewport: CellAddress): CellAddress | null {
  const element = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>("[data-address]");
  const addressText = element?.dataset.address;
  if (!addressText) return null;
  try {
    const address = parseCellAddress(addressText);
    if (
      address.row < viewport.row || address.row >= viewport.row + VISIBLE_ROWS ||
      address.column < viewport.column || address.column >= viewport.column + VISIBLE_COLUMNS
    ) return null;
    return address;
  } catch {
    return null;
  }
}

function addressInRange(address: CellAddress, range: CellRange): boolean {
  return address.row >= range.start.row && address.row <= range.end.row && address.column >= range.start.column && address.column <= range.end.column;
}

function sameRange(left: CellRange, right: CellRange): boolean {
  return left.start.row === right.start.row && left.start.column === right.start.column && left.end.row === right.end.row && left.end.column === right.end.column;
}

function dialogDescription(dialog: UiDialog): string {
  switch (dialog.kind) {
    case "save_as": return "Choose a Files path ending in .nsheet.";
    case "open": return "Open a lossless .nsheet workbook or import a .xlsx/.csv file from the Files app.";
    case "replace": return dialog.action === "demo"
      ? "Load a six-sheet, editable tour of every verified Spreadsheet v1 feature. It is not saved automatically."
      : "Start with one blank sheet and no Files destination.";
    case "add_sheet": return "Choose a unique sheet name.";
    case "rename_sheet": return "Choose a unique name. Cross-sheet formulas are rewritten atomically.";
    case "delete_sheet": return "Formulas that explicitly reference this sheet become #REF!.";
    case "dimension": return `Set a custom ${dialog.axis === "row" ? "height" : "width"}, or return it to the responsive default.`;
    case "draft_conflict": return "An agent or another tile committed a different value after your draft began. Nothing has been overwritten.";
    case "find": return "Search displayed values across every sheet, or search the raw formula text.";
    case "filter": return `Use column ${columnName(dialog.column)} to filter ${dialog.range}. The first row remains visible as the header.`;
    case "export_setup": return dialog.format === "csv"
      ? "Export computed values from the current sheet and selection to a new CSV file. Formulas and workbook features are not preserved."
      : "Export the whole workbook to a new XLSX snapshot file. This does not change the native save destination.";
    case "export_review": return "Review the exact encoded result before creating the new file. Commit will fail rather than overwrite an existing destination.";
  }
}

function dialogSubmitLabel(dialog: UiDialog): string {
  switch (dialog.kind) {
    case "save_as": return "Save";
    case "open": return "Open file";
    case "replace": return dialog.action === "demo" ? "Load Kitchen Sink" : "Create new workbook";
    case "add_sheet": return "Add sheet";
    case "rename_sheet": return "Rename sheet";
    case "delete_sheet": return "Delete sheet";
    case "dimension": return "Apply size";
    case "draft_conflict": return "Reapply my draft";
    case "find": return "Find";
    case "filter": return "Apply filter";
    case "export_setup": return "Run export preflight";
    case "export_review": return `Create ${dialog.options.format.toUpperCase()} snapshot`;
  }
}

function suggestedExportPath(nativePath: string | null, format: ExportFormat): string {
  if (!nativePath) return `/workbook.${format}`;
  const slash = nativePath.lastIndexOf("/");
  const dot = nativePath.lastIndexOf(".");
  const stem = dot > slash ? nativePath.slice(0, dot) : nativePath;
  return `${stem}.${format}`;
}

function validateExportPath(path: string, format: ExportFormat): string | null {
  if (!path) return "Enter a new Files destination.";
  if (path.length > 240) return "The Files path is too long.";
  if (!path.toLocaleLowerCase("en-US").endsWith(`.${format}`)) return `${format.toUpperCase()} export paths must end in .${format}.`;
  return null;
}

function exportToolOptions(options: ExportOptions): JsonObject {
  if (options.format === "xlsx") return { format: "xlsx", path: options.path };
  return {
    format: "csv",
    path: options.path,
    sheetId: options.sheetId!,
    range: options.range!,
    csvInjectionPolicy: options.csvInjectionPolicy!,
    bom: options.bom === true,
  };
}

function nonzeroLosses(losses: Record<string, number>): Array<[string, number]> {
  return Object.entries(losses).filter((entry): entry is [string, number] => Number.isFinite(entry[1]) && entry[1] > 0);
}

function assertExportPreflight(value: JsonValue): Omit<ExportPreflight, "options"> {
  if (
    !isJsonObject(value) || value.action !== "export_preflight" ||
    !Number.isSafeInteger(value.revision) || typeof value.preflightToken !== "string" ||
    typeof value.expiresAt !== "number" || !Number.isFinite(value.expiresAt) ||
    !Number.isSafeInteger(value.byteLength) || (value.byteLength as number) < 0 ||
    !Array.isArray(value.warnings) || value.warnings.some((warning) => typeof warning !== "string") ||
    !isJsonObject(value.losses) || Object.values(value.losses).some((count) => typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
  ) throw new Error("Spreadsheet service returned an invalid export preflight");
  return {
    revision: value.revision as number,
    preflightToken: value.preflightToken,
    expiresAt: value.expiresAt,
    byteLength: value.byteLength as number,
    warnings: value.warnings as string[],
    losses: value.losses as Record<string, number>,
  };
}

function assertExportCommit(value: JsonValue): { format: ExportFormat; path: string } {
  if (
    !isJsonObject(value) || value.action !== "export_commit" ||
    (value.format !== "csv" && value.format !== "xlsx") ||
    !isJsonObject(value.file) || typeof value.file.path !== "string"
  ) throw new Error("Spreadsheet service returned an invalid export result");
  return { format: value.format, path: value.file.path };
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function validateNativePath(path: string): string | null {
  if (!path) return "Enter a Files path.";
  if (path.length > 240) return "The Files path is too long.";
  if (!path.toLocaleLowerCase("en-US").endsWith(".nsheet")) return "Native workbook paths must end in .nsheet.";
  return null;
}

function validateOpenPath(path: string): string | null {
  if (!path) return "Enter a Files path.";
  if (path.length > 240) return "The Files path is too long.";
  if (!/\.(?:nsheet|xlsx|csv)$/i.test(path)) return "Open a path ending in .nsheet, .xlsx, or .csv.";
  return null;
}

function validateSheetName(name: string, sheets: SheetSummary[], exceptId?: string): string | null {
  if (!name) return "Enter a sheet name.";
  if (name.length > 31) return "Sheet names can contain at most 31 characters.";
  if (/[\\/*?:[\]]/.test(name)) return "Sheet names cannot contain \\ / * ? : [ or ].";
  if (sheets.some((sheet) => sheet.id !== exceptId && sheet.name.toLocaleLowerCase("en-US") === name.toLocaleLowerCase("en-US"))) return "Choose a unique sheet name.";
  return null;
}

function filterDescription(filter: SheetFilter, hiddenRowCount: number): string {
  const predicate = "equals" in filter ? `equals ${JSON.stringify(filter.equals ?? "")}` : "is not blank";
  return `Filter ${filter.range} on column ${columnName(filter.column)}: ${predicate}; ${hiddenRowCount} ${hiddenRowCount === 1 ? "row" : "rows"} hidden.`;
}

function assertStatus(value: JsonValue): WorkbookStatus {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.revision !== "number" || !Array.isArray(value.sheets)) throw new Error("Spreadsheet service returned an invalid status");
  return value as unknown as WorkbookStatus;
}

function assertRead(value: JsonValue): { workbookId: string; revision: number; cells: GridCell[]; hiddenRows: number[]; nextCursor: string | null } {
  if (
    !value || typeof value !== "object" || Array.isArray(value) || typeof value.workbookId !== "string" || typeof value.revision !== "number" ||
    !Array.isArray(value.cells) || !Array.isArray(value.hiddenRows) ||
    value.hiddenRows.some((row) => !Number.isSafeInteger(row) || (row as number) < 1 || (row as number) > SPREADSHEET_LIMITS.maxRows) ||
    !(typeof value.nextCursor === "string" || value.nextCursor === null)
  ) throw new Error("Spreadsheet service returned invalid cells");
  return value as unknown as { workbookId: string; revision: number; cells: GridCell[]; hiddenRows: number[]; nextCursor: string | null };
}

function assertApply(value: JsonValue): { revision: number } {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.revision !== "number") throw new Error("Spreadsheet service returned an invalid command result");
  return value as unknown as { revision: number };
}

function assertFind(value: JsonValue): { workbookId: string; revision: number; matches: FindMatch[]; truncated: boolean; nextCursor: string | null } {
  if (
    !isJsonObject(value) || typeof value.workbookId !== "string" || !Number.isSafeInteger(value.revision) || !Array.isArray(value.matches) || typeof value.truncated !== "boolean" ||
    !(typeof value.nextCursor === "string" || value.nextCursor === null) || value.truncated !== (value.nextCursor !== null) ||
    value.matches.some((match) => !isJsonObject(match) || typeof match.sheetId !== "string" || typeof match.sheetName !== "string" || typeof match.address !== "string" || typeof match.raw !== "string" || typeof match.display !== "string")
  ) throw new Error("Spreadsheet service returned invalid find results");
  return value as unknown as { workbookId: string; revision: number; matches: FindMatch[]; truncated: boolean; nextCursor: string | null };
}

function rawText(input?: CellInput): string {
  if (!input || input.kind === "blank") return "";
  if (input.kind === "formula") return input.formula;
  if (input.kind === "boolean") return input.value ? "TRUE" : "FALSE";
  return String(input.value);
}

function formulaReferenceText(range: CellRange, absoluteMode: FormulaReferencePoint["absoluteMode"]): string {
  const normalized = normalizeRange(range);
  const address = (value: CellAddress) => {
    const columnAbsolute = absoluteMode === 1 || absoluteMode === 3;
    const rowAbsolute = absoluteMode === 1 || absoluteMode === 2;
    return `${columnAbsolute ? "$" : ""}${columnName(value.column)}${rowAbsolute ? "$" : ""}${value.row + 1}`;
  };
  const start = address(normalized.start);
  const end = address(normalized.end);
  return start === end ? start : `${start}:${end}`;
}

function inputFromDraft(value: string): CellInput {
  if (/^=\s*$/.test(value)) {
    throw new Error("Choose a cell or complete the formula. Press Escape to cancel.");
  }
  return rawInputFromText(value);
}

function cloneInput(input?: CellInput): CellInput {
  return input ? { ...input } as CellInput : { kind: "blank" };
}

function sameInput(left: CellInput, right: CellInput): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function selectionSummary(range: CellRange, cells: Map<string, GridCell>, viewport: CellAddress): string {
  const label = formatRange(range);
  if (!containsRange(viewport, range)) return `${label} · Metrics unavailable outside loaded grid`;
  if (sameRange(range, { start: range.start, end: range.start })) {
    const cell = cells.get(label);
    if (!cell || cell.raw.kind === "blank") return label;
    const computed = cell.computed;
    if (isJsonObject(computed) && computed.kind === "value" && typeof computed.value === "number" && Number.isFinite(computed.value)) {
      const metric = formatMetric(computed.value);
      return `${label} · Count 1 · Sum ${metric} · Avg ${metric}`;
    }
    return `${label} · Count 1`;
  }
  let count = 0;
  const numeric: number[] = [];
  for (const cell of cells.values()) {
    if (!addressInRange(parseCellAddress(cell.address), range) || cell.raw.kind === "blank") continue;
    count += 1;
    const computed = cell.computed;
    if (isJsonObject(computed) && computed.kind === "value" && typeof computed.value === "number" && Number.isFinite(computed.value)) numeric.push(computed.value);
  }
  if (!count) return label;
  if (!numeric.length) return `${label} · Count ${count}`;
  const sum = numeric.reduce((total, value) => total + value, 0);
  const average = sum / numeric.length;
  return `${label} · Count ${count} · Sum ${formatMetric(sum)} · Avg ${formatMetric(average)}`;
}

function formatMetric(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 }).format(value);
}

function computedErrorMessage(computed: JsonValue | undefined): string {
  return isJsonObject(computed) && computed.kind === "error" && typeof computed.message === "string"
    ? `, error: ${computed.message}`
    : "";
}

function loadStoredTileView(key: string): StoredTileView | null {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(key) ?? "null") as Partial<StoredTileView> | null;
    if (!parsed || typeof parsed.workbookId !== "string" || typeof parsed.sheetId !== "string") return null;
    if (!isCellAddress(parsed.anchor) || !isCellAddress(parsed.focus) || !isCellAddress(parsed.viewport)) return null;
    if (typeof parsed.draft !== "string") return null;
    if (parsed.draftOrigin !== null && !isDraftOrigin(parsed.draftOrigin)) return null;
    return parsed as StoredTileView;
  } catch {
    return null;
  }
}

function saveStoredTileView(key: string, view: StoredTileView): void {
  try { sessionStorage.setItem(key, JSON.stringify(view)); }
  catch { /* View persistence is best effort in hardened/credentialless frames. */ }
}

function isCellAddress(value: unknown): value is CellAddress {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return Number.isSafeInteger(candidate.row) && Number.isSafeInteger(candidate.column)
    && (candidate.row as number) >= 0 && (candidate.row as number) < SPREADSHEET_LIMITS.maxRows
    && (candidate.column as number) >= 0 && (candidate.column as number) < SPREADSHEET_LIMITS.maxColumns;
}

function isDraftOrigin(value: unknown): value is DraftOrigin {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.sheetId === "string" && typeof candidate.address === "string"
    && typeof candidate.editorText === "string" && isCellInput(candidate.input);
}

function valueInput(cell?: GridCell): CellInput {
  if (!cell) return { kind: "blank" };
  const computed = cell.computed;
  if (computed && typeof computed === "object" && !Array.isArray(computed)) {
    if (computed.kind === "blank") return { kind: "blank" };
    if (computed.kind === "error" && typeof computed.code === "string") {
      return { kind: "formula", formula: `=${computed.code}` };
    }
    if (computed.kind === "value") {
      if (typeof computed.value === "number") return { kind: "number", value: computed.value };
      if (typeof computed.value === "boolean") return { kind: "boolean", value: computed.value };
      if (typeof computed.value === "string") return { kind: "text", value: computed.value };
    }
  }
  return cloneInput(cell.raw);
}

function clipboardText(payload: SpreadsheetClipboard): string {
  return stringifyClipboardTable(payload.cells.map((row) => row.map((cell) => rawText(cell.value))));
}

function parseClipboard(serialized: string): SpreadsheetClipboard | null {
  if (!serialized) return null;
  try {
    const value = JSON.parse(serialized) as Partial<SpreadsheetClipboard>;
    if (value.version !== 1 || !value.source || !Number.isInteger(value.source.row) || !Number.isInteger(value.source.column)) return null;
    if (!Number.isInteger(value.rows) || !Number.isInteger(value.columns) || value.rows! < 1 || value.columns! < 1 || value.rows! > VISIBLE_ROWS || value.columns! > VISIBLE_COLUMNS) return null;
    if (!Array.isArray(value.cells) || value.cells.length !== value.rows) return null;
    for (const row of value.cells) {
      if (!Array.isArray(row) || row.length !== value.columns) return null;
      for (const cell of row) {
        if (!cell || !isCellInput(cell.raw) || !isCellInput(cell.value) || !(cell.style === null || isCellStyle(cell.style))) return null;
      }
    }
    parseCellAddress(formatCellAddress(value.source));
    return value as SpreadsheetClipboard;
  } catch {
    return null;
  }
}

function isCellInput(value: unknown): value is CellInput {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("kind" in value)) return false;
  const input = value as Record<string, unknown>;
  if (input.kind === "blank") return true;
  if (input.kind === "text") return typeof input.value === "string";
  if (input.kind === "number") return typeof input.value === "number" && Number.isFinite(input.value);
  if (input.kind === "boolean") return typeof input.value === "boolean";
  return input.kind === "formula" && typeof input.formula === "string" && input.formula.startsWith("=");
}

function isCellStyle(value: unknown): value is CellStyle {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const style = value as Record<string, unknown>;
  const known = new Set(["numberFormat", "decimals", "bold", "italic", "textColor", "fillColor", "alignment", "wrap"]);
  return Object.keys(style).every((key) => known.has(key));
}

function styleOperations(payload: SpreadsheetClipboard, destination: CellAddress, sheetId: string): JsonObject[] {
  const visited = payload.cells.map((row) => row.map(() => false));
  const signature = (row: number, column: number) => JSON.stringify(payload.cells[row]?.[column]?.style ?? null);
  const operations: JsonObject[] = [];
  for (let row = 0; row < payload.rows; row += 1) {
    for (let column = 0; column < payload.columns; column += 1) {
      const style = payload.cells[row]![column]!.style;
      if (!style || visited[row]![column]) continue;
      const expected = signature(row, column);
      let width = 1;
      while (column + width < payload.columns && !visited[row]![column + width] && signature(row, column + width) === expected) width += 1;
      let height = 1;
      while (row + height < payload.rows) {
        let matches = true;
        for (let offset = 0; offset < width; offset += 1) {
          if (visited[row + height]![column + offset] || signature(row + height, column + offset) !== expected) { matches = false; break; }
        }
        if (!matches) break;
        height += 1;
      }
      for (let rowOffset = 0; rowOffset < height; rowOffset += 1) {
        for (let columnOffset = 0; columnOffset < width; columnOffset += 1) visited[row + rowOffset]![column + columnOffset] = true;
      }
      operations.push({
        type: "apply_style",
        sheetId,
        range: formatRange({
          start: { row: destination.row + row, column: destination.column + column },
          end: { row: destination.row + row + height - 1, column: destination.column + column + width - 1 },
        }),
        style,
      });
    }
  }
  return operations;
}

function boundViewport(address: CellAddress): CellAddress {
  return {
    row: clamp(address.row, 0, SPREADSHEET_LIMITS.maxRows - VISIBLE_ROWS),
    column: clamp(address.column, 0, SPREADSHEET_LIMITS.maxColumns - VISIBLE_COLUMNS),
  };
}

function viewportForAddress(address: CellAddress, current: CellAddress): CellAddress {
  const row = address.row < current.row || address.row >= current.row + VISIBLE_ROWS
    ? address.row - Math.floor(VISIBLE_ROWS / 2)
    : current.row;
  const column = address.column < current.column || address.column >= current.column + VISIBLE_COLUMNS
    ? address.column - Math.floor(VISIBLE_COLUMNS / 2)
    : current.column;
  return boundViewport({ row, column });
}

function viewportRange(start: CellAddress): string {
  return formatRange({
    start,
    end: { row: start.row + VISIBLE_ROWS - 1, column: start.column + VISIBLE_COLUMNS - 1 },
  });
}

function containsRange(start: CellAddress, range: { start: CellAddress; end: CellAddress }): boolean {
  return range.start.row >= start.row
    && range.start.column >= start.column
    && range.end.row < start.row + VISIBLE_ROWS
    && range.end.column < start.column + VISIBLE_COLUMNS;
}

function cellStyle(style?: CellStyle): React.CSSProperties {
  return {
    ...(style?.bold ? { fontWeight: 700 } : {}),
    ...(style?.italic ? { fontStyle: "italic" } : {}),
    ...(style?.textColor ? { color: style.textColor } : {}),
    ...(style?.fillColor ? { backgroundColor: style.fillColor } : {}),
    ...(style?.alignment ? { textAlign: style.alignment } : {}),
    ...(style?.wrap ? { whiteSpace: "normal", lineHeight: 1.35, paddingBlock: 5 } : {}),
  };
}

function gridTemplateColumns(sheet: SheetSummary | null, viewport: CellAddress, preview?: Pick<DimensionResize, "axis" | "index" | "size">): string {
  const columns = Array.from({ length: VISIBLE_COLUMNS }, (_, offset) => {
    const index = viewport.column + offset;
    const width = preview?.axis === "column" && preview.index === index
      ? preview.size
      : sheet?.columnWidths[String(index)];
    return width === undefined ? "minmax(96px, 1fr)" : `${width}px`;
  });
  return `48px ${columns.join(" ")}`;
}

function rowSizeStyle(sheet: SheetSummary | null, row: number): React.CSSProperties {
  const height = sheet?.rowHeights[String(row)];
  return height === undefined ? {} : { height, minHeight: height };
}

function fileName(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function createCommandId(): string {
  return `ui-${Date.now()}-${crypto.getRandomValues(new Uint32Array(1))[0]}`;
}

function clamp(value: number, minimum: number, maximum: number): number { return Math.max(minimum, Math.min(maximum, value)); }
function errorMessage(error: unknown): string { return toError(error).message || "Spreadsheet operation failed"; }

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
