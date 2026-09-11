import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  IoAlertCircleOutline,
  IoArrowForward,
  IoCheckmarkCircleOutline,
  IoChevronDown,
  IoClose,
  IoFlashOutline,
  IoOpenOutline,
  IoRefresh,
  IoTimeOutline,
} from "react-icons/io5";
import { Principal } from "@dfinity/principal";
import { formatTokenAmount, parseTokenAmount } from "./format.ts";
import {
  continueRefill,
  createRefillRequestId,
  executeRefill,
  listRefillPage,
  loadRefillSnapshot,
  prepareRefill,
  quoteRefill,
  readRefillStatus,
  type RefillCursor,
  type RefillInput,
  type RefillOperation,
  type RefillQuote,
  type RefillSnapshot,
} from "./refill.ts";

import {
  executeOperatingCyclesConversion,
  isOperatingCyclesCancellation,
  isOperatingCyclesNotDispatched,
  loadOperatingCyclesSnapshot,
  quoteOperatingCyclesConversion,
  readOperatingCyclesConversionStatus,
  type OperatingCyclesOperation,
  type OperatingCyclesQuote,
  type OperatingCyclesSnapshot,
} from "./cycles_conversion.ts";
import { OperatingCyclesHistory } from "./operating_cycles_history.tsx";

type Mode = "refill" | "convert";
type Source = "ICP" | "TCYCLES";
const text = (reason: unknown) =>
  reason instanceof Error ? reason.message : String(reason);
const amountText = (atoms: string, decimals: number) =>
  formatTokenAmount(atoms, decimals);
const cyclesText = (atoms: string) => `${amountText(atoms, 12)} T cycles`;
const tokenText = (atoms: string, source: Source) =>
  `${amountText(atoms, source === "ICP" ? 8 : 12)} ${source}`;
const done = (operation: RefillOperation) =>
  ["complete", "refunded", "stopped"].includes(operation.phase);
const label = (kind: RefillInput["kind"]) =>
  kind === "icp_to_tcycles" ? "Get TCYCLES" : "Refill canister";

function mergeOperations(...pages: RefillOperation[][]): RefillOperation[] {
  const entries = new Map<string, RefillOperation>();
  for (const page of pages)
    for (const operation of page) {
      const previous = entries.get(operation.requestId);
      if (
        !previous ||
        BigInt(operation.updatedAtNs) >= BigInt(previous.updatedAtNs)
      )
        entries.set(operation.requestId, operation);
    }
  return [...entries.values()].sort((a, b) =>
    BigInt(a.createdAtNs) === BigInt(b.createdAtNs)
      ? b.requestId.localeCompare(a.requestId)
      : BigInt(a.createdAtNs) > BigInt(b.createdAtNs)
        ? -1
        : 1,
  );
}

function destination(value: string, mode: Mode): string {
  let principal: Principal;
  try {
    principal = Principal.fromText(value.trim());
  } catch {
    throw new Error(
      mode === "refill"
        ? "Enter a valid canister ID."
        : "Enter a valid recipient principal.",
    );
  }
  if (principal.isAnonymous() || principal.toText() === "aaaaa-aa")
    throw new Error(
      "Choose a receiving account other than the anonymous or management principal.",
    );
  return principal.toText();
}

/** A review alone never creates a saved operation or moves money. */
export function WalletRefillPage({
  owner,
  refreshRevision = 0,
  tray = false,
  openInTile,
}: {
  owner: string;
  refreshRevision?: number;
  tray?: boolean;
  openInTile: () => Promise<void>;
}) {
  const [mode, setMode] = useState<Mode>("refill");
  const [source, setSource] = useState<Source>("ICP");
  const [conversionSource, setConversionSource] = useState<"ICP" | "cycles">(
    "ICP",
  );
  const operatingCycles = mode === "convert" && conversionSource === "cycles";
  const [operatingSnapshot, setOperatingSnapshot] =
    useState<OperatingCyclesSnapshot | null>(null);
  const [operatingError, setOperatingError] = useState<string | null>(null);
  const [operatingLoading, setOperatingLoading] = useState(false);
  const [allowPartialCycles, setAllowPartialCycles] = useState(false);
  const [cyclesRequestId, setCyclesRequestId] = useState(createRefillRequestId);
  const [latestCyclesOperation, setLatestCyclesOperation] =
    useState<OperatingCyclesOperation | null>(null);
  const [cyclesRevision, setCyclesRevision] = useState(0);
  const [cyclesAttempted, setCyclesAttempted] = useState(false);
  const [amount, setAmount] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [otherTarget, setOtherTarget] = useState(false);
  const [target, setTarget] = useState("");
  const [snapshot, setSnapshot] = useState<RefillSnapshot | null>(null);
  const [operations, setOperations] = useState<RefillOperation[]>([]);
  const [pendingCursor, setPendingCursor] = useState<RefillCursor | null>(null);
  const [historyCursor, setHistoryCursor] = useState<RefillCursor | null>(null);
  const [loadingMore, setLoadingMore] = useState<"pending" | "history" | null>(
    null,
  );
  const moreInFlight = useRef(false);
  const currentOperation = useRef<RefillOperation | null>(null);
  const [reviewRequestId, setReviewRequestId] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<RefillQuote | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const loadGeneration = useRef(0);
  const operatingGeneration = useRef(0);
  const operatingTarget = useMemo(() => {
    try {
      return otherTarget ? destination(target, "convert") : owner;
    } catch {
      return null;
    }
  }, [otherTarget, target, owner]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setLoading(true);
    const [balanceResult, pendingResult, historyResult] =
      await Promise.allSettled([
        loadRefillSnapshot(owner),
        listRefillPage({ pendingOnly: true }),
        listRefillPage({ pendingOnly: false }),
      ]);
    if (!mounted.current || generation !== loadGeneration.current) return;
    if (balanceResult.status === "fulfilled") {
      setSnapshot(balanceResult.value);
      setError(null);
    } else setError(text(balanceResult.reason));
    const historyErrors = [pendingResult, historyResult].flatMap((result) =>
      result.status === "rejected" ? [text(result.reason)] : [],
    );
    setHistoryError(
      historyErrors.length
        ? `Saved refills could not be loaded: ${historyErrors.join("; ")}`
        : null,
    );
    if (pendingResult.status === "fulfilled")
      setPendingCursor(pendingResult.value.nextCursor);
    if (historyResult.status === "fulfilled")
      setHistoryCursor(historyResult.value.nextCursor);
    setOperations((current) =>
      mergeOperations(
        historyErrors.length ? current : [],
        pendingResult.status === "fulfilled"
          ? pendingResult.value.operations
          : [],
        historyResult.status === "fulfilled"
          ? historyResult.value.operations
          : [],
        currentOperation.current ? [currentOperation.current] : [],
      ),
    );
    setLoading(false);
  }, [owner]);
  useEffect(() => {
    void load();
  }, [load, refreshRevision]);

  const loadOperating = useCallback(async () => {
    const generation = ++operatingGeneration.current;
    if (!operatingTarget) {
      setOperatingLoading(false);
      return;
    }
    setOperatingLoading(true);
    try {
      const next = await loadOperatingCyclesSnapshot(owner, operatingTarget);
      if (mounted.current && generation === operatingGeneration.current) {
        setOperatingSnapshot(next);
        setOperatingError(null);
      }
    } catch (reason) {
      if (mounted.current && generation === operatingGeneration.current)
        setOperatingError(text(reason));
    } finally {
      if (mounted.current && generation === operatingGeneration.current)
        setOperatingLoading(false);
    }
  }, [owner, operatingTarget]);
  useEffect(() => {
    if (operatingCycles) void loadOperating();
  }, [operatingCycles, loadOperating, refreshRevision, cyclesRevision]);

  const loadMore = async (section: "pending" | "history") => {
    const cursor = section === "pending" ? pendingCursor : historyCursor;
    if (!cursor || moreInFlight.current || loading) return;
    moreInFlight.current = true;
    const generation = loadGeneration.current;
    setLoadingMore(section);
    try {
      const page = await listRefillPage({
        pendingOnly: section === "pending",
        before: cursor,
      });
      if (!mounted.current || generation !== loadGeneration.current) return;
      setOperations((current) => mergeOperations(current, page.operations));
      if (section === "pending") setPendingCursor(page.nextCursor);
      else setHistoryCursor(page.nextCursor);
      setHistoryError(null);
    } catch (reason) {
      if (mounted.current) setHistoryError(text(reason));
    } finally {
      moreInFlight.current = false;
      if (mounted.current) setLoadingMore(null);
    }
  };

  const effectiveSource = mode === "convert" ? "ICP" : source;
  const token = effectiveSource === "ICP" ? snapshot?.icp : snapshot?.tcycles;
  const sourceDecimals = operatingCycles
    ? 12
    : effectiveSource === "ICP"
      ? 8
      : 12;
  const sourceLabel = operatingCycles ? "T cycles" : effectiveSource;
  const amountLabel = operatingCycles
    ? "Amount of Neutron cycles"
    : `Amount of ${effectiveSource}`;
  const balanceAtoms = operatingCycles
    ? operatingSnapshot?.balanceAtoms
    : token?.balanceAtoms;
  const maximum = operatingCycles
    ? operatingSnapshot
      ? BigInt(operatingSnapshot.maxCyclesAtoms)
      : null
    : token?.balanceAtoms != null && token.feeAtoms != null
      ? BigInt(token.balanceAtoms) > BigInt(token.feeAtoms)
        ? BigInt(token.balanceAtoms) - BigInt(token.feeAtoms)
        : 0n
      : null;
  const request = useMemo((): {
    input: RefillInput | null;
    error: string | null;
  } => {
    if (operatingCycles || !amount.trim()) return { input: null, error: null };
    try {
      const amountAtoms = parseTokenAmount(
        amount,
        effectiveSource === "ICP" ? 8 : 12,
      );
      const recipient = otherTarget ? destination(target, mode) : owner;
      return {
        input: {
          kind:
            mode === "convert"
              ? "icp_to_tcycles"
              : effectiveSource === "ICP"
                ? "icp_topup"
                : "tcycles_topup",
          amountAtoms,
          target: recipient,
        },
        error: null,
      };
    } catch (reason) {
      return { input: null, error: text(reason) };
    }
  }, [
    amount,
    effectiveSource,
    mode,
    operatingCycles,
    otherTarget,
    owner,
    target,
  ]);
  const estimate = useMemo((): {
    quote: RefillQuote | null;
    error: string | null;
  } => {
    if (!request.input || !snapshot)
      return { quote: null, error: request.error };
    try {
      return { quote: quoteRefill(request.input, snapshot), error: null };
    } catch (reason) {
      return { quote: null, error: text(reason) };
    }
  }, [request, snapshot]);
  const operatingEstimate = useMemo((): {
    quote: OperatingCyclesQuote | null;
    error: string | null;
  } => {
    if (!operatingCycles || !operatingSnapshot || !amount.trim())
      return { quote: null, error: null };
    try {
      return {
        quote: quoteOperatingCyclesConversion(
          {
            requestId: cyclesRequestId,
            owner,
            target: otherTarget ? destination(target, "convert") : owner,
            amountAtoms: parseTokenAmount(amount, 12),
            allowPartial: allowPartialCycles,
          },
          operatingSnapshot,
        ),
        error: null,
      };
    } catch (reason) {
      return { quote: null, error: text(reason) };
    }
  }, [
    operatingCycles,
    operatingSnapshot,
    amount,
    cyclesRequestId,
    owner,
    otherTarget,
    target,
    allowPartialCycles,
  ]);
  const formError = operatingCycles ? operatingEstimate.error : estimate.error;
  const canReview = operatingCycles
    ? cyclesAttempted || operatingEstimate.quote !== null
    : estimate.quote !== null;

  const percent = useMemo(() => {
    if (!maximum || !amount.trim()) return 0;
    try {
      const atoms = BigInt(parseTokenAmount(amount, sourceDecimals));
      return Math.min(100, Number((atoms * 100n) / maximum));
    } catch {
      return 0;
    }
  }, [maximum, amount, sourceDecimals]);
  const selectPercent = (value: number) => {
    if (maximum === null) return;
    const atoms = (maximum * BigInt(value)) / 100n;
    setAmount(
      atoms === 0n
        ? ""
        : amountText(atoms.toString(), sourceDecimals).replaceAll(",", ""),
    );
    setAllowPartialCycles(operatingCycles && value === 100);
    setError(null);
  };
  const changeMode = (next: Mode) => {
    setMode(next);
    setAmount("");
    setAllowPartialCycles(false);
    setOtherTarget(false);
    setTarget("");
    setReview(null);
    setReviewRequestId(null);
    setError(null);
  };
  const remember = (operation: RefillOperation) => {
    if (!mounted.current) return;
    currentOperation.current = operation;
    setOperations((current) => mergeOperations(current, [operation]));
  };

  const convertOperating = async () => {
    if (inFlight.current) return;
    if (tray) {
      await openInTile();
      return;
    }
    if (!operatingEstimate.quote && !cyclesAttempted) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const id = cyclesRequestId;
    const recovering = cyclesAttempted;
    try {
      if (recovering) {
        const saved = await readOperatingCyclesConversionStatus(id);
        if (!mounted.current) return;
        if (saved) {
          setLatestCyclesOperation(saved);
          if (saved.status === "complete" || saved.status === "failed") {
            setCyclesAttempted(false);
            setAmount("");
            setCyclesRequestId(createRefillRequestId());
          }
        } else
          setError(
            "No receipt is available yet. Keep this saved request and check again; another conversion could spend cycles twice.",
          );
        setCyclesRevision((value) => value + 1);
        return;
      }
      if (!operatingEstimate.quote) return;
      const fresh = await loadOperatingCyclesSnapshot(
        owner,
        operatingEstimate.quote.target,
      );
      const approved = quoteOperatingCyclesConversion(
        operatingEstimate.quote,
        fresh,
      );
      if (!mounted.current) return;
      setOperatingSnapshot(fresh);
      setCyclesAttempted(true);
      const result = await executeOperatingCyclesConversion(approved);
      if (mounted.current) {
        setLatestCyclesOperation(result);
        if (result.status === "complete" || result.status === "failed") {
          setAmount("");
          setCyclesAttempted(false);
          setCyclesRequestId(createRefillRequestId());
        }
        setCyclesRevision((value) => value + 1);
      }
    } catch (reason) {
      if (!recovering && isOperatingCyclesNotDispatched(reason)) {
        if (mounted.current) {
          setError(isOperatingCyclesCancellation(reason) ? null : text(reason));
          setCyclesAttempted(false);
        }
        return;
      }
      try {
        const saved = await readOperatingCyclesConversionStatus(id);
        if (saved && mounted.current) setLatestCyclesOperation(saved);
      } catch {
        /* The original request ID remains selected; the history can check it. */
      }
      if (mounted.current) {
        setError(text(reason));
        setCyclesRevision((value) => value + 1);
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const prepareReview = async () => {
    if (operatingCycles) {
      await convertOperating();
      return;
    }
    if (inFlight.current || !request.input) return;
    if (tray) {
      await openInTile();
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const fresh = await loadRefillSnapshot(owner);
      if (!mounted.current) return;
      setSnapshot(fresh);
      setReviewRequestId(null);
      setReview(quoteRefill(request.input, fresh));
    } catch (reason) {
      if (mounted.current) setError(text(reason));
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const confirm = async () => {
    if (inFlight.current || !review) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const approved = review;
    const id = reviewRequestId ?? createRefillRequestId();
    const alreadyPrepared = reviewRequestId !== null;
    setReview(null);
    setReviewRequestId(null);
    setActiveId(id);
    try {
      if (!alreadyPrepared) remember(await prepareRefill(approved, id));
      remember(await executeRefill(id));
      if (mounted.current) {
        setAmount("");
        await load();
      }
    } catch (reason) {
      // The original saved identity is retained after an interrupted reply.
      // Reading it cannot dispatch another payment.
      try {
        const saved = await readRefillStatus(id);
        if (saved) remember(saved);
      } catch {
        /* the page retains its original error and recovery history */
      }
      if (mounted.current) setError(text(reason));
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const resume = async (operation: RefillOperation) => {
    if (inFlight.current) return;
    if (tray) {
      await openInTile();
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setActiveId(operation.requestId);
    try {
      if (operation.phase === "prepared") {
        const fresh = await loadRefillSnapshot(owner);
        const quote = quoteRefill(operation, fresh);
        const icpFeeChanged =
          operation.kind !== "tcycles_topup" &&
          quote.icpFeeAtoms !== operation.icpFeeAtoms;
        const cyclesFeeChanged =
          operation.kind !== "icp_topup" &&
          quote.cyclesFeeAtoms !== operation.cyclesFeeAtoms;
        if (icpFeeChanged || cyclesFeeChanged)
          throw new Error(
            "The fees for this saved request have changed. No payment was dispatched; this request cannot be executed with different fees.",
          );
        if (!mounted.current) return;
        setSnapshot(fresh);
        setReviewRequestId(operation.requestId);
        setReview(quote);
        return;
      }
      const result = operation.canContinue
        ? await continueRefill(operation.requestId)
        : await readRefillStatus(operation.requestId);
      if (result) remember(result);
      if (mounted.current) await load();
    } catch (reason) {
      if (mounted.current) setError(text(reason));
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const pending = operations.filter((operation) => !done(operation));
  const completed = operations.filter(done);
  const displayed =
    operations.find((operation) => operation.requestId === activeId) ?? null;

  return (
    <section className="wallet-refill" aria-label="Refill your Neutron">
      <div className="wallet-refill-content">
        <header className="wallet-refill-heading">
          <span className="wallet-refill-mark">
            <IoFlashOutline aria-hidden="true" />
          </span>
          <div>
            <h1>
              {mode === "convert" ? "Get TCYCLES" : "Keep your Neutron running"}
            </h1>
            <p>
              {mode === "convert"
                ? operatingCycles
                  ? "Convert available Neutron cycles into TCYCLES."
                  : "Convert ICP into tokens you can use for refills."
                : "Top up with ICP or TCYCLES."}
            </p>
          </div>
        </header>
        <div
          className="wallet-refill-modes"
          role="group"
          aria-label="Cycles action"
        >
          <button
            type="button"
            aria-pressed={mode === "refill"}
            disabled={busy}
            onClick={() => changeMode("refill")}
          >
            Refill Neutron
          </button>
          <button
            type="button"
            aria-pressed={mode === "convert"}
            disabled={busy}
            onClick={() => changeMode("convert")}
          >
            Get TCYCLES
          </button>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void prepareReview();
          }}
        >
          <div className="wallet-refill-source-row">
            <label htmlFor="wallet-refill-amount">
              {mode === "convert" ? "Convert" : "Pay with"}
            </label>
            {mode === "refill" ? (
              <div
                className="wallet-refill-source"
                role="group"
                aria-label="Refill payment token"
              >
                {(["ICP", "TCYCLES"] as const).map((item) => (
                  <button
                    key={item}
                    type="button"
                    aria-pressed={source === item}
                    disabled={busy}
                    onClick={() => {
                      setSource(item);
                      setAmount("");
                      setError(null);
                    }}
                  >
                    {item}
                  </button>
                ))}
              </div>
            ) : (
              <div
                className="wallet-refill-source"
                role="group"
                aria-label="TCYCLES conversion source"
              >
                {(["ICP", "cycles"] as const).map((item) => (
                  <button
                    key={item}
                    type="button"
                    aria-pressed={conversionSource === item}
                    disabled={busy}
                    onClick={() => {
                      setConversionSource(item);
                      setAmount("");
                      setAllowPartialCycles(false);
                      setError(null);
                    }}
                  >
                    {item === "cycles" ? "Neutron cycles" : "ICP"}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="wallet-refill-amount-field">
            <input
              id="wallet-refill-amount"
              aria-label={amountLabel}
              autoComplete="off"
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              disabled={busy}
              onChange={(event) => {
                setAmount(event.target.value);
                setAllowPartialCycles(false);
                setError(null);
              }}
            />
            <span>{sourceLabel}</span>
          </div>
          <div className="wallet-refill-balance">
            <span>
              {(
                operatingCycles
                  ? operatingLoading && !operatingSnapshot
                  : loading && !snapshot
              ) ? (
                "Checking balance…"
              ) : balanceAtoms != null ? (
                <>
                  {operatingCycles ? "Neutron balance" : "Available"}{" "}
                  <strong>
                    {amountText(balanceAtoms, sourceDecimals)} {sourceLabel}
                  </strong>
                </>
              ) : (
                "Balance unavailable"
              )}
            </span>
            <button
              type="button"
              disabled={busy || maximum === null || maximum === 0n}
              onClick={() => selectPercent(100)}
            >
              Max
            </button>
          </div>
          <div className="wallet-refill-percent">
            <input
              type="range"
              aria-label="Percentage of available balance"
              min="0"
              max="100"
              step="1"
              value={percent}
              disabled={busy || maximum === null || maximum === 0n}
              onChange={(event) => selectPercent(Number(event.target.value))}
            />
            <span>{percent}%</span>
          </div>
          <div className="wallet-refill-shortcuts">
            {[25, 50, 75, 100].map((value) => (
              <button
                key={value}
                type="button"
                disabled={busy || !maximum}
                onClick={() => selectPercent(value)}
              >
                {value === 100 ? "Max" : `${value}%`}
              </button>
            ))}
          </div>
          {operatingCycles ? (
            <p className="wallet-refill-reserve">
              At least <strong>5 T cycles</strong> stay in your Neutron to keep
              it running.
            </p>
          ) : null}
          <div className="wallet-refill-destination">
            <span>{mode === "convert" ? "Receive in" : "Refill"}</span>
            <strong>
              {otherTarget
                ? mode === "refill"
                  ? "Another canister"
                  : "Another account"
                : "My Neutron"}
            </strong>
          </div>
          <details
            className="wallet-refill-advanced"
            open={advanced}
            onToggle={(event) => setAdvanced(event.currentTarget.open)}
          >
            <summary>
              Advanced options
              <IoChevronDown aria-hidden="true" />
            </summary>
            <div>
              <label className="wallet-refill-check">
                <input
                  type="checkbox"
                  checked={otherTarget}
                  disabled={busy}
                  onChange={(event) => {
                    setOtherTarget(event.target.checked);
                    setError(null);
                  }}
                />
                {mode === "convert"
                  ? "Send TCYCLES to another account"
                  : "Refill another canister"}
              </label>
              {otherTarget ? (
                <label className="wallet-refill-target">
                  {mode === "convert" ? "Recipient principal" : "Canister ID"}
                  <input
                    className="nt-input"
                    aria-label={
                      mode === "convert" ? "Recipient principal" : "Canister ID"
                    }
                    value={target}
                    disabled={busy}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder="xxxxx-xxxxx-…"
                    onChange={(event) => {
                      setTarget(event.target.value);
                      setError(null);
                    }}
                  />
                </label>
              ) : (
                <small className="wallet-refill-principal">
                  My Neutron · {owner}
                </small>
              )}
            </div>
          </details>
          {operatingCycles ? (
            <div className="wallet-refill-estimate" aria-live="polite">
              <span>You receive approximately</span>
              <strong>
                {operatingEstimate.quote
                  ? tokenText(
                      operatingEstimate.quote.expectedNetAtoms,
                      "TCYCLES",
                    )
                  : "—"}
              </strong>
              <span>Neutron keeps approximately</span>
              <span>
                {operatingEstimate.quote
                  ? cyclesText(operatingEstimate.quote.remainingCyclesAtoms)
                  : "—"}
              </span>
              {operatingEstimate.quote ? (
                <small>
                  Includes{" "}
                  {tokenText(operatingEstimate.quote.feeAtoms, "TCYCLES")}{" "}
                  minting fee. Network costs are reserved separately.
                </small>
              ) : null}
            </div>
          ) : (
            <div className="wallet-refill-estimate" aria-live="polite">
              <span>
                {mode === "convert"
                  ? "You receive approximately"
                  : "Estimated refill"}
              </span>
              <strong>
                {estimate.quote
                  ? mode === "convert"
                    ? tokenText(
                        estimate.quote.estimatedReceivedCycles,
                        "TCYCLES",
                      )
                    : cyclesText(estimate.quote.estimatedReceivedCycles)
                  : "—"}
              </strong>
              <span>Total from Wallet</span>
              <span>
                {estimate.quote
                  ? tokenText(estimate.quote.totalDebitAtoms, effectiveSource)
                  : "—"}
              </span>
              {estimate.quote ? (
                <small>
                  Includes{" "}
                  {tokenText(estimate.quote.sourceFeeAtoms, effectiveSource)}{" "}
                  transfer fee.
                  {mode === "convert" &&
                  BigInt(estimate.quote.cyclesFeeAtoms) > 0n
                    ? ` Conversion costs ${tokenText((BigInt(estimate.quote.estimatedCycles) - BigInt(estimate.quote.estimatedReceivedCycles)).toString(), "TCYCLES")}, deducted from the result.`
                    : ""}
                </small>
              ) : null}
            </div>
          )}
          {mode === "convert" ? (
            <p className="wallet-refill-help">
              TCYCLES are tokens you can hold, send, or use for a later refill.
            </p>
          ) : (
            <p className="wallet-refill-help">
              Cycles pay for your Neutron's storage and activity.
            </p>
          )}
          {formError && amount ? (
            <p className="wallet-refill-inline-error" role="status">
              {formError}
            </p>
          ) : null}
          {error ? (
            <div className="wallet-refill-error" role="alert">
              <IoAlertCircleOutline aria-hidden="true" />
              <span>{error}</span>
              <button
                type="button"
                aria-label="Dismiss refill error"
                onClick={() => setError(null)}
              >
                <IoClose />
              </button>
            </div>
          ) : null}
          {operatingCycles && operatingError ? (
            <div className="wallet-refill-error" role="alert">
              <span>{operatingError}</span>
              <button
                type="button"
                aria-label="Retry Neutron cycles balance"
                disabled={busy || operatingLoading}
                onClick={() => void loadOperating()}
              >
                <IoRefresh />
              </button>
            </div>
          ) : null}
          {!snapshot && !loading ? (
            <button
              className="nt-button"
              type="button"
              onClick={() => void load()}
            >
              <IoRefresh aria-hidden="true" />
              Retry balance check
            </button>
          ) : null}
          <button
            className="nt-button nt-button--accent wallet-refill-submit"
            type="submit"
            disabled={busy || (!canReview && !(tray && operatingCycles))}
          >
            {busy ? (
              <>
                <span className="wallet-spinner" />
                Working…
              </>
            ) : tray ? (
              <>
                <IoOpenOutline aria-hidden="true" />
                Open Wallet to continue
              </>
            ) : (
              <>
                {operatingCycles
                  ? cyclesAttempted
                    ? "Check conversion"
                    : "Convert Neutron cycles"
                  : `Review ${mode === "convert" ? "conversion" : "refill"}`}
                <IoArrowForward aria-hidden="true" />
              </>
            )}
          </button>
        </form>
        {snapshot?.errors.length ? (
          <details className="wallet-refill-diagnostics">
            <summary>Balance or rate details</summary>
            {snapshot.errors.map((warning, index) => (
              <p key={index}>{warning}</p>
            ))}
          </details>
        ) : null}
        <OperatingCyclesHistory
          owner={owner}
          refreshRevision={refreshRevision + cyclesRevision}
          latestOperation={latestCyclesOperation}
        />
        {historyError ? (
          <div className="wallet-refill-error" role="alert">
            <span>{historyError}</span>
            <button
              type="button"
              aria-label="Retry saved refills"
              disabled={loading || busy}
              onClick={() => void load()}
            >
              <IoRefresh />
            </button>
          </div>
        ) : null}
        {pending.length || pendingCursor ? (
          <section
            className="wallet-refill-pending"
            aria-label="Refills in progress"
          >
            <h2>In progress</h2>
            {pending.map((operation) => (
              <RefillProgress
                key={operation.requestId}
                operation={operation}
                owner={owner}
                busy={busy}
                onResume={() => void resume(operation)}
              />
            ))}
            {pendingCursor ? (
              <button
                className="nt-button wallet-refill-load-more"
                type="button"
                disabled={busy || loading || loadingMore !== null}
                onClick={() => void loadMore("pending")}
              >
                {loadingMore === "pending"
                  ? "Loading…"
                  : "Load more unfinished refills"}
              </button>
            ) : null}
          </section>
        ) : null}
        {displayed && done(displayed) ? (
          <div className="wallet-refill-result">
            <button
              type="button"
              className="wallet-refill-result-dismiss"
              aria-label="Dismiss refill result"
              onClick={() => setActiveId(null)}
            >
              <IoClose />
            </button>
            <RefillProgress operation={displayed} owner={owner} busy={busy} />
          </div>
        ) : null}
        {completed.length || historyCursor ? (
          <details
            className="wallet-refill-history"
            open={historyOpen}
            onToggle={(event) => setHistoryOpen(event.currentTarget.open)}
          >
            <summary>
              Recent refills & conversions <span>{completed.length}</span>
            </summary>
            {completed.map((operation) => (
              <RefillProgress
                key={operation.requestId}
                operation={operation}
                owner={owner}
                busy={busy}
              />
            ))}
            {historyCursor ? (
              <button
                className="nt-button wallet-refill-load-more"
                type="button"
                disabled={busy || loading || loadingMore !== null}
                onClick={() => void loadMore("history")}
              >
                {loadingMore === "history" ? "Loading…" : "Load more history"}
              </button>
            ) : null}
          </details>
        ) : null}
      </div>
      {review ? (
        <RefillReviewDialog
          quote={review}
          busy={busy}
          onConfirm={() => void confirm()}
          onCancel={() => {
            setReview(null);
            setReviewRequestId(null);
          }}
        />
      ) : null}
    </section>
  );
}

function RefillProgress({
  operation,
  owner,
  busy,
  onResume,
}: {
  operation: RefillOperation;
  owner: string;
  busy: boolean;
  onResume?: () => void;
}) {
  const complete = operation.phase === "complete";
  const refunded = operation.phase === "refunded";
  const source: Source = operation.kind === "tcycles_topup" ? "TCYCLES" : "ICP";
  const stateText = complete
    ? operation.kind === "icp_to_tcycles"
      ? "TCYCLES received"
      : "Refill complete"
    : refunded
      ? "Payment refunded"
      : operation.phase === "stopped"
        ? "Refill stopped"
        : operation.phase === "prepared"
          ? "Ready for review"
          : operation.phase === "transfer_pending"
            ? "Checking payment"
            : operation.phase === "forward_pending"
              ? "Sending TCYCLES"
              : "Completing refill";
  return (
    <article
      className={`wallet-refill-operation ${complete ? "is-complete" : ""}`}
    >
      <div className="wallet-refill-operation-heading">
        {complete ? (
          <IoCheckmarkCircleOutline aria-hidden="true" />
        ) : done(operation) ? (
          <IoAlertCircleOutline aria-hidden="true" />
        ) : (
          <IoTimeOutline aria-hidden="true" />
        )}
        <div>
          <strong>{stateText}</strong>
          <span>
            {tokenText(operation.amountAtoms, source)} ·{" "}
            {operation.target === owner
              ? "My Neutron"
              : operation.kind === "icp_to_tcycles"
                ? "Other account"
                : "Other canister"}
          </span>
        </div>
      </div>
      {complete && operation.creditedCycles !== null ? (
        <p>
          {operation.kind === "icp_to_tcycles"
            ? tokenText(operation.creditedCycles, "TCYCLES")
            : cyclesText(operation.creditedCycles)}{" "}
          added
        </p>
      ) : null}
      {operation.error ? (
        <p className="wallet-refill-operation-message">{operation.error}</p>
      ) : null}
      {!done(operation) ? (
        <p className="wallet-refill-operation-message">
          {operation.phase === "prepared"
            ? "This request is saved. No payment has been dispatched."
            : "Your progress is saved. Continuing uses the original payment."}
        </p>
      ) : null}
      {onResume ? (
        <button
          className="nt-button"
          type="button"
          disabled={busy}
          onClick={onResume}
        >
          {operation.phase === "prepared"
            ? "Review saved refill"
            : operation.canContinue
              ? "Continue"
              : "Check progress"}
        </button>
      ) : null}
      <details className="wallet-refill-diagnostics">
        <summary>Details</summary>
        <dl>
          <dt>Action</dt>
          <dd>{label(operation.kind)}</dd>
          <dt>Destination</dt>
          <dd>{operation.target}</dd>
          <dt>Saved request</dt>
          <dd>{operation.requestId}</dd>
          {[
            ["Payment block", operation.sourceBlockIndex],
            ["Mint block", operation.mintBlockIndex],
            ["Delivery block", operation.forwardBlockIndex],
            ["Refund block", operation.refundBlockIndex],
          ]
            .filter(([, value]) => value !== null)
            .map(([title, value]) => (
              <div key={title}>
                <dt>{title}</dt>
                <dd>{value}</dd>
              </div>
            ))}
        </dl>
      </details>
    </article>
  );
}

export function RefillReviewDialog({
  quote,
  busy = false,
  onConfirm,
  onCancel,
}: {
  quote: RefillQuote;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialog.current;
    if (node && !node.open) node.showModal();
    return () => {
      if (node?.open) node.close();
    };
  }, []);
  const conversion = quote.kind === "icp_to_tcycles";
  return (
    <div className="nt-app wallet-funding-layer">
      <dialog
        ref={dialog}
        className="nt-dialog wallet-funding-dialog wallet-refill-review"
        aria-labelledby="wallet-refill-review-title"
        onCancel={(event) => {
          event.preventDefault();
          if (!busy) onCancel();
        }}
      >
        <div className="nt-dialog-body">
          <header className="wallet-refill-heading">
            <span className="wallet-refill-mark">
              <IoFlashOutline aria-hidden="true" />
            </span>
            <div>
              <h2 id="wallet-refill-review-title">
                {conversion ? "Convert ICP to TCYCLES" : "Confirm refill"}
              </h2>
              <p>
                {quote.target === quote.owner
                  ? "My Neutron"
                  : conversion
                    ? "Another account"
                    : "Another canister"}
              </p>
            </div>
          </header>
          <dl className="wallet-refill-review-amounts">
            <div>
              <dt>Pay</dt>
              <dd>{tokenText(quote.amountAtoms, quote.source)}</dd>
            </div>
            <div>
              <dt>{conversion ? "Estimated TCYCLES" : "Estimated cycles"}</dt>
              <dd>
                {conversion
                  ? tokenText(quote.estimatedReceivedCycles, "TCYCLES")
                  : cyclesText(quote.estimatedReceivedCycles)}
              </dd>
            </div>
            <div>
              <dt>Transfer fee</dt>
              <dd>{tokenText(quote.sourceFeeAtoms, quote.source)}</dd>
            </div>
            {conversion && BigInt(quote.cyclesFeeAtoms) > 0n ? (
              <div>
                <dt>Deducted from conversion</dt>
                <dd>
                  {tokenText(
                    (
                      BigInt(quote.estimatedCycles) -
                      BigInt(quote.estimatedReceivedCycles)
                    ).toString(),
                    "TCYCLES",
                  )}
                </dd>
              </div>
            ) : null}
            <div className="wallet-refill-review-total">
              <dt>Total from Wallet</dt>
              <dd>{tokenText(quote.totalDebitAtoms, quote.source)}</dd>
            </div>
          </dl>
          {quote.target !== quote.owner ? (
            <p className="wallet-refill-review-destination">
              {conversion ? "Recipient" : "Canister"}
              <strong>{quote.target}</strong>
            </p>
          ) : null}
          <p className="wallet-refill-help">
            {conversion
              ? "Converted TCYCLES will be sent to this account."
              : "Cycles are deposited directly into the canister and cannot be sent back as ICP."}
          </p>
          {quote.warnings.length ? (
            <div className="wallet-refill-review-warnings">
              {quote.warnings.map((warning, index) => (
                <p key={index}>{warning}</p>
              ))}
            </div>
          ) : null}
          <details className="wallet-refill-diagnostics">
            <summary>Details</summary>
            <dl>
              <dt>Destination</dt>
              <dd>{quote.target}</dd>
              <dt>Rate checked</dt>
              <dd>{new Date(quote.observedAt).toLocaleString()}</dd>
            </dl>
          </details>
        </div>
        <footer className="nt-dialog-actions">
          <button
            className="nt-button"
            type="button"
            disabled={busy}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            className="nt-button nt-button--accent"
            type="button"
            disabled={busy}
            onClick={onConfirm}
          >
            {conversion ? "Convert ICP" : "Refill now"}
          </button>
        </footer>
      </dialog>
    </div>
  );
}

type RefillPrompt = {
  quote: RefillQuote;
  resolve: (approved: boolean) => void;
};
let prompt: RefillPrompt | null = null;
const listeners = new Set<() => void>();
export function requestWalletRefillReview(
  quote: RefillQuote,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  if (prompt)
    return Promise.reject(new Error("Finish the open refill review first."));
  return new Promise((resolve) => {
    const current: RefillPrompt = {
      quote,
      resolve: (approved) => {
        signal?.removeEventListener("abort", abort);
        if (prompt === current) {
          prompt = null;
          listeners.forEach((listener) => listener());
        }
        resolve(approved);
      },
    };
    const abort = () => current.resolve(false);
    prompt = current;
    signal?.addEventListener("abort", abort, { once: true });
    listeners.forEach((listener) => listener());
    if (signal?.aborted) abort();
  });
}
export function WalletRefillPromptHost() {
  const [, setRevision] = useState(0);
  useEffect(() => {
    const listener = () => setRevision((value) => value + 1);
    listeners.add(listener);
    listener();
    return () => {
      listeners.delete(listener);
      if (prompt) prompt.resolve(false);
    };
  }, []);
  return prompt ? (
    <RefillReviewDialog
      quote={prompt.quote}
      onConfirm={() => prompt?.resolve(true)}
      onCancel={() => prompt?.resolve(false)}
    />
  ) : null;
}
