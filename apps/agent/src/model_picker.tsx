import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  IoArrowBack,
  IoCheckmark,
  IoChevronDown,
  IoClose,
  IoOptionsOutline,
  IoRefresh,
  IoSearchOutline,
} from "react-icons/io5";
import type { OpenRouterModel } from "./chat_types.ts";
import {
  filterModels,
  formatModelContext,
  formatModelPrice,
  modelAuthorLabel,
  modelDisplayName,
  modelFamilyScope,
  modelMatchesFamily,
  type ModelFamilyScope,
} from "./model_catalog.ts";

const MODEL_ROW_HEIGHT = 56;
const MODEL_ROW_OVERSCAN = 4;
const DEFAULT_LIST_HEIGHT = 320;

export function ModelPicker({
  models,
  selectedModelId,
  loading,
  selectionLocked,
  selectionLockedReason,
  onRefresh,
  onSelect,
}: {
  models: OpenRouterModel[];
  selectedModelId: string | null;
  loading: boolean;
  selectionLocked: boolean;
  selectionLockedReason: string;
  onRefresh: () => Promise<boolean>;
  onSelect: (modelId: string) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [reasoningOnly, setReasoningOnly] = useState(false);
  const [freeOnly, setFreeOnly] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [family, setFamily] = useState<ModelFamilyScope | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [viewport, setViewport] = useState({
    firstRow: 0,
    height: DEFAULT_LIST_HEIGHT,
  });
  const selectingRef = useRef(false);
  const refreshingRef = useRef(false);
  const initialScrollRef = useRef(false);
  const scrollFrameRef = useRef<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = `${useId().replaceAll(":", "")}-model-list`;
  const popoverId = `${listId}-dialog`;
  const statusId = `${listId}-status`;
  const selectedModel = models.find((model) => model.id === selectedModelId) ?? null;
  const selectedFamily = useMemo(
    () => selectedModel ? modelFamilyScope(selectedModel) : null,
    [selectedModel],
  );
  const scopedModels = useMemo(
    () =>
      family === null
        ? models
        : models.filter((model) => modelMatchesFamily(model, family)),
    [family, models],
  );
  const result = useMemo(
    () => filterModels(scopedModels, { query, reasoningOnly, freeOnly }),
    [freeOnly, query, reasoningOnly, scopedModels],
  );
  const activeIndex = result.items.findIndex((model) => model.id === activeId);
  const activeOptionId =
    activeIndex >= 0 ? `${listId}-option-${activeIndex}` : undefined;
  const visibleIndexes = useMemo(() => {
    const visibleRows = Math.max(1, Math.ceil(viewport.height / MODEL_ROW_HEIGHT));
    const start = Math.max(0, viewport.firstRow - MODEL_ROW_OVERSCAN);
    const end = Math.min(
      result.items.length,
      viewport.firstRow + visibleRows + MODEL_ROW_OVERSCAN,
    );
    const indexes = Array.from({ length: Math.max(0, end - start) }, (_, offset) =>
      start + offset
    );
    if (activeIndex >= 0 && (activeIndex < start || activeIndex >= end)) {
      indexes.push(activeIndex);
      indexes.sort((left, right) => left - right);
    }
    return indexes;
  }, [activeIndex, result.items.length, viewport]);

  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    setPendingId(null);
    if (restoreFocus) {
      window.setTimeout(() => triggerRef.current?.focus(), 0);
    }
  }, []);

  const resetListScroll = useCallback(() => {
    if (listRef.current) listRef.current.scrollTop = 0;
    setViewport((current) =>
      current.firstRow === 0 ? current : { ...current, firstRow: 0 },
    );
  }, []);

  const scrollToIndex = useCallback(
    (index: number, align: "nearest" | "center" = "nearest") => {
      const list = listRef.current;
      if (!list || index < 0) return;
      const rowTop = index * MODEL_ROW_HEIGHT;
      const rowBottom = rowTop + MODEL_ROW_HEIGHT;
      const viewTop = list.scrollTop;
      const viewBottom = viewTop + list.clientHeight;
      let next = viewTop;
      if (align === "center") {
        next = rowTop - (list.clientHeight - MODEL_ROW_HEIGHT) / 2;
      } else if (rowTop < viewTop) {
        next = rowTop;
      } else if (rowBottom > viewBottom) {
        next = rowBottom - list.clientHeight;
      }
      const maximum = Math.max(0, result.items.length * MODEL_ROW_HEIGHT - list.clientHeight);
      next = Math.max(0, Math.min(maximum, next));
      if (Math.abs(list.scrollTop - next) > 0.5) list.scrollTop = next;
      setViewport({
        firstRow: Math.floor(next / MODEL_ROW_HEIGHT),
        height: list.clientHeight || DEFAULT_LIST_HEIGHT,
      });
    },
    [result.items.length],
  );

  const updateViewport = useCallback(() => {
    if (scrollFrameRef.current !== null) return;
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      const list = listRef.current;
      if (!list) return;
      const next = {
        firstRow: Math.floor(list.scrollTop / MODEL_ROW_HEIGHT),
        height: list.clientHeight || DEFAULT_LIST_HEIGHT,
      };
      setViewport((current) =>
        current.firstRow === next.firstRow && current.height === next.height
          ? current
          : next,
      );
    });
  }, []);

  const openPicker = () => {
    initialScrollRef.current = true;
    setOpen(true);
    setFamily(selectedFamily);
    setQuery("");
    setFiltersOpen(false);
    setActionError(null);
    setActiveId(selectedModelId ?? models[0]?.id ?? null);
    setViewport((current) => ({ ...current, firstRow: 0 }));
  };

  const showAllModels = () => {
    setFamily(null);
    setQuery("");
    setActiveId(null);
    resetListScroll();
    window.setTimeout(() => searchRef.current?.focus(), 0);
  };

  useEffect(() => {
    if (
      family !== null &&
      !models.some((model) => modelMatchesFamily(model, family))
    ) {
      setFamily(null);
    }
  }, [family, models]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => searchRef.current?.focus(), 0);
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close(false);
    };
    const onFocusIn = (event: FocusEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close(true);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [close, open]);

  useLayoutEffect(() => {
    if (!open) return;
    const list = listRef.current;
    if (!list) return;
    const measure = () => {
      const nextHeight = list.clientHeight || DEFAULT_LIST_HEIGHT;
      setViewport((current) =>
        current.height === nextHeight ? current : { ...current, height: nextHeight },
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  }, [open]);

  useEffect(
    () => () => {
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (!open) return;
    if (result.items.some((model) => model.id === activeId)) return;
    const next =
      activeId === null
        ? result.items[0] ?? null
        : result.items.find((model) => model.id === selectedModelId) ??
          result.items[0] ??
          null;
    setActiveId(next?.id ?? null);
  }, [activeId, open, result.items, selectedModelId]);

  useLayoutEffect(() => {
    if (!open || !initialScrollRef.current || activeIndex < 0) return;
    initialScrollRef.current = false;
    scrollToIndex(activeIndex, "center");
  }, [activeIndex, open, scrollToIndex]);

  const activateIndex = (index: number) => {
    const model = result.items[index];
    if (!model) return;
    setActiveId(model.id);
    scrollToIndex(index);
  };

  const moveActive = (direction: -1 | 1) => {
    if (result.items.length === 0) return;
    if (activeIndex < 0) {
      activateIndex(direction === 1 ? 0 : result.items.length - 1);
      return;
    }
    const current = activeIndex;
    const next = (current + direction + result.items.length) % result.items.length;
    activateIndex(next);
  };

  const choose = async (model: OpenRouterModel) => {
    if (selectingRef.current) return;
    if (model.id === selectedModelId) {
      close(true);
      return;
    }
    if (selectionLocked) return;
    selectingRef.current = true;
    setActionError(null);
    setPendingId(model.id);
    try {
      const succeeded = await onSelect(model.id);
      if (succeeded) close(true);
      else setActionError("Could not switch models. Try again.");
    } catch {
      setActionError("Could not switch models. Try again.");
    } finally {
      selectingRef.current = false;
      setPendingId(null);
    }
  };

  const onSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveActive(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(-1);
    } else if (event.key === "Home" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      activateIndex(0);
    } else if (event.key === "End" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      activateIndex(result.items.length - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const model = result.items.find((candidate) => candidate.id === activeId);
      if (model) void choose(model);
    }
  };

  const refresh = async () => {
    if (refreshingRef.current || loading || selectionLocked) return;
    refreshingRef.current = true;
    setActionError(null);
    setRefreshing(true);
    try {
      const succeeded = await onRefresh();
      if (!succeeded) setActionError("Could not refresh models. Try again.");
    } catch {
      setActionError("Could not refresh models. Try again.");
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  };

  const clearFilters = () => {
    setQuery("");
    setReasoningOnly(false);
    setFreeOnly(false);
    setActiveId(null);
    resetListScroll();
  };

  return (
    <div className="ora-model-picker" ref={rootRef}>
      <button
        aria-label={
          selectedModel
            ? `OpenRouter connected. Current model: ${modelDisplayName(selectedModel)}. Choose model`
            : "OpenRouter connected. Choose a model"
        }
        aria-controls={open ? popoverId : undefined}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={`ora-model-trigger${open ? " is-open" : ""}`}
        onClick={() => (open ? close(false) : openPicker())}
        onKeyDown={(event) => {
          if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            openPicker();
          }
        }}
        ref={triggerRef}
        title={selectedModel?.id ?? "Choose an OpenRouter model"}
        type="button"
      >
        <span className="ora-model-trigger-copy">
          <strong>{selectedFamily?.label ?? "model"}</strong>
        </span>
        <IoChevronDown aria-hidden="true" className="ora-model-chevron" />
      </button>

      {open ? (
        <div
          aria-label="Choose model"
          className="ora-model-popover"
          id={popoverId}
          role="dialog"
        >
          <div className="ora-model-top">
            <div
              className={`ora-model-search-row${
                family === null ? "" : " has-back"
              }`}
            >
              {family !== null ? (
                <button
                  aria-label="Back to all models"
                  className="ora-model-control-button ora-model-back"
                  onClick={showAllModels}
                  title="Back to all models"
                  type="button"
                >
                  <IoArrowBack aria-hidden="true" />
                </button>
              ) : null}
              <div className="ora-model-search">
                <IoSearchOutline aria-hidden="true" />
                <input
                  aria-activedescendant={activeOptionId}
                  aria-autocomplete="list"
                  aria-controls={listId}
                  aria-describedby={selectionLocked || actionError ? statusId : undefined}
                  aria-expanded="true"
                  aria-label={
                    family === null
                      ? "Search models or publishers"
                      : `Search ${family.label} models`
                  }
                  autoComplete="off"
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setActiveId(null);
                    resetListScroll();
                  }}
                  onKeyDown={onSearchKeyDown}
                  placeholder={
                    family === null
                      ? "Search models"
                      : `Search ${family.label}`
                  }
                  ref={searchRef}
                  role="combobox"
                  spellCheck={false}
                  type="search"
                  value={query}
                />
                {query ? (
                  <button
                    aria-label="Clear model search"
                    onClick={() => {
                      setQuery("");
                      setActiveId(null);
                      resetListScroll();
                      searchRef.current?.focus();
                    }}
                    title="Clear model search"
                    type="button"
                  >
                    <IoClose aria-hidden="true" />
                  </button>
                ) : null}
              </div>
              <button
                aria-expanded={filtersOpen}
                aria-label={`Model filters${reasoningOnly || freeOnly ? " active" : ""}`}
                className={`ora-model-control-button${
                  reasoningOnly || freeOnly ? " is-active" : ""
                }`}
                onClick={() => setFiltersOpen((current) => !current)}
                title="Model filters"
                type="button"
              >
                <IoOptionsOutline aria-hidden="true" />
                {reasoningOnly || freeOnly ? (
                  <span>{Number(reasoningOnly) + Number(freeOnly)}</span>
                ) : null}
              </button>
              <button
                aria-label={refreshing || loading ? "Refreshing models" : "Refresh models"}
                className="ora-model-control-button"
                disabled={refreshing || loading || selectionLocked}
                onClick={() => void refresh()}
                title={refreshing || loading ? "Refreshing models" : "Refresh models"}
                type="button"
              >
                {refreshing || loading ? <span className="ora-spinner" /> : <IoRefresh />}
              </button>
              <span className="ora-model-count" aria-live="polite">
                {result.total} result{result.total === 1 ? "" : "s"}
              </span>
            </div>

            {filtersOpen || selectionLocked || actionError ? (
              <div className="ora-model-filters" aria-label="Model filters">
                {filtersOpen ? (
                  <>
                    <button
                      aria-pressed={reasoningOnly}
                      className={reasoningOnly ? "is-active" : undefined}
                      onClick={() => {
                        setReasoningOnly((current) => !current);
                        setActiveId(null);
                        resetListScroll();
                      }}
                      type="button"
                    >
                      Reasoning
                    </button>
                    <button
                      aria-pressed={freeOnly}
                      className={freeOnly ? "is-active" : undefined}
                      onClick={() => {
                        setFreeOnly((current) => !current);
                        setActiveId(null);
                        resetListScroll();
                      }}
                      type="button"
                    >
                      Free
                    </button>
                  </>
                ) : null}
                {selectionLocked || actionError ? (
                  <span
                    aria-live="polite"
                    className={`ora-model-lock${actionError ? " is-error" : ""}`}
                    id={statusId}
                  >
                    {actionError ?? selectionLockedReason}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>

          <div
            aria-label={
              family === null
                ? "All OpenRouter models"
                : `${family.label} models`
            }
            aria-busy={refreshing || loading}
            aria-describedby={selectionLocked || actionError ? statusId : undefined}
            className="ora-model-list"
            id={listId}
            onScroll={updateViewport}
            ref={listRef}
            role={result.items.length > 0 ? "listbox" : undefined}
          >
            {result.items.length === 0 ? (
              <div className="ora-model-empty">
                <strong>No matching models</strong>
                <span>Try another name or publisher.</span>
                <button onClick={clearFilters} type="button">Clear search and filters</button>
              </div>
            ) : (
              <div
                className="ora-model-list-spacer"
                role="presentation"
                style={{ height: result.items.length * MODEL_ROW_HEIGHT }}
              >
                {visibleIndexes.map((index) => {
                  const model = result.items[index];
                  if (!model) return null;
                  const selected = model.id === selectedModelId;
                  const active = model.id === activeId;
                  const pending = model.id === pendingId;
                  return (
                  <button
                    aria-disabled={selectionLocked || pendingId !== null}
                    aria-label={`${modelDisplayName(model)}. ${modelAuthorLabel(model)}. ${
                      formatModelContext(model.contextLength)
                    }. Input ${formatModelPrice(model.promptPrice)}. Output ${formatModelPrice(
                      model.completionPrice,
                    )}${model.supportsReasoning ? ". Reasoning supported" : ""}`}
                    aria-posinset={index + 1}
                    aria-selected={selected}
                    aria-setsize={result.items.length}
                    className={`ora-model-option${selected ? " is-selected" : ""}${
                      active ? " is-active" : ""
                    }`}
                    data-model-id={model.id}
                    id={`${listId}-option-${index}`}
                    key={model.id}
                    onClick={() => void choose(model)}
                    onMouseDown={(event) => event.preventDefault()}
                    role="option"
                    style={{ height: MODEL_ROW_HEIGHT, top: index * MODEL_ROW_HEIGHT }}
                    tabIndex={-1}
                    title={model.id}
                    type="button"
                  >
                    <span className="ora-model-option-copy">
                      <span className="ora-model-option-heading">
                        <strong>{modelDisplayName(model)}</strong>
                      </span>
                      <span className="ora-model-option-stats">
                        <span>{modelAuthorLabel(model)}</span>
                        <i aria-hidden="true">·</i>
                        <span>{formatModelContext(model.contextLength)}</span>
                        <i aria-hidden="true">·</i>
                        <span><b>In</b> {formatModelPrice(model.promptPrice)}</span>
                        <i aria-hidden="true">·</i>
                        <span><b>Out</b> {formatModelPrice(model.completionPrice)}</span>
                      </span>
                    </span>
                    <span className="ora-model-option-state">
                      {pending ? <span className="ora-spinner" /> : selected ? <IoCheckmark /> : null}
                    </span>
                  </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
