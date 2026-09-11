import { useCallback, useEffect, useRef, useState } from "react";
import {
  IoAlertCircleOutline,
  IoCheckmarkCircleOutline,
  IoClose,
  IoTimeOutline,
} from "react-icons/io5";
import { formatTokenAmount } from "./format.ts";
import {
  listOperatingCyclesConversions,
  readOperatingCyclesConversionStatus,
  type OperatingCyclesOperation,
} from "./cycles_conversion.ts";

type HistoryPage = Awaited<ReturnType<typeof listOperatingCyclesConversions>>;
type Props = {
  owner: string;
  refreshRevision: number;
  latestOperation: OperatingCyclesOperation | null;
};
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const amount = (atoms: string) => formatTokenAmount(atoms, 12);
const hasUnreadReceipt = (operation: OperatingCyclesOperation) =>
  operation.status === "unknown" &&
  !operation.detailsAvailable &&
  operation.error === null;
const unresolved = (operation: OperatingCyclesOperation) =>
  operation.status === "pending" ||
  (operation.status === "unknown" && !hasUnreadReceipt(operation));

function mergeOperations(
  current: OperatingCyclesOperation[],
  incoming: OperatingCyclesOperation[],
): OperatingCyclesOperation[] {
  const entries = new Map(
    current.map((operation) => [operation.requestId, operation]),
  );
  for (const operation of incoming) {
    const previous = entries.get(operation.requestId);
    if (
      !previous ||
      BigInt(operation.updatedAtNs) > BigInt(previous.updatedAtNs) ||
      (operation.updatedAtNs === previous.updatedAtNs &&
        !(previous.detailsAvailable && !operation.detailsAvailable))
    ) {
      // A full receipt outranks an equally recent compact summary, including
      // when decoding changes its apparent completion into an unknown outcome.
      entries.set(operation.requestId, operation);
    }
  }
  return [...entries.values()].sort((a, b) =>
    BigInt(a.createdAtNs) === BigInt(b.createdAtNs)
      ? b.requestId.localeCompare(a.requestId)
      : BigInt(a.createdAtNs) > BigInt(b.createdAtNs)
        ? -1
        : 1,
  );
}

/** Reads the original Kernel journal; no action here creates or repeats a conversion. */
export function OperatingCyclesHistory(props: Props) {
  return <OperatingCyclesHistoryContent key={props.owner} {...props} />;
}

function OperatingCyclesHistoryContent({
  owner,
  refreshRevision,
  latestOperation,
}: Props) {
  const [operations, setOperations] = useState<OperatingCyclesOperation[]>([]);
  const [nextCursor, setNextCursor] = useState<HistoryPage["nextCursor"]>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkErrors, setCheckErrors] = useState<Record<string, string>>({});
  const [checking, setChecking] = useState<string[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [resultId, setResultId] = useState<string | null>(null);
  const dismissed = useRef(new Set<string>());
  const checkingIds = useRef(new Set<string>());
  const mounted = useRef(true);
  const generation = useRef(0);
  const moreInFlight = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    setLoadingMore(false);
    moreInFlight.current = false;
    try {
      const page = await listOperatingCyclesConversions({ limit: 20 });
      if (!mounted.current || current !== generation.current) return;
      setOperations((previous) => mergeOperations(previous, page.operations));
      setNextCursor(page.nextCursor);
      setError(null);
    } catch (reason) {
      if (mounted.current && current === generation.current)
        setError(`Saved conversions could not be loaded: ${message(reason)}`);
    } finally {
      if (mounted.current && current === generation.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshRevision]);
  useEffect(() => {
    if (!latestOperation) return;
    setOperations((previous) => mergeOperations(previous, [latestOperation]));
    setCheckErrors((previous) => {
      if (!(latestOperation.requestId in previous)) return previous;
      const next = { ...previous };
      delete next[latestOperation.requestId];
      return next;
    });
    if (
      latestOperation.status === "complete" &&
      !dismissed.current.has(latestOperation.requestId)
    )
      setResultId(latestOperation.requestId);
  }, [latestOperation]);

  const loadMore = async () => {
    if (!nextCursor || moreInFlight.current || loading) return;
    moreInFlight.current = true;
    setLoadingMore(true);
    const current = generation.current;
    try {
      const page = await listOperatingCyclesConversions({
        before: nextCursor,
        limit: 20,
      });
      if (!mounted.current || current !== generation.current) return;
      setOperations((previous) => mergeOperations(previous, page.operations));
      setNextCursor(page.nextCursor);
      setError(null);
    } catch (reason) {
      if (mounted.current && current === generation.current)
        setError(
          `More saved conversions could not be loaded: ${message(reason)}`,
        );
    } finally {
      if (mounted.current && current === generation.current) {
        moreInFlight.current = false;
        setLoadingMore(false);
      }
    }
  };

  const check = async (requestId: string, showResult = true) => {
    if (checkingIds.current.has(requestId)) return;
    checkingIds.current.add(requestId);
    setChecking([...checkingIds.current]);
    try {
      const operation = await readOperatingCyclesConversionStatus(requestId);
      if (!mounted.current) return;
      if (!operation)
        throw new Error(
          "The saved receipt is not available yet. Check this original conversion again later.",
        );
      setOperations((previous) => mergeOperations(previous, [operation]));
      setCheckErrors((previous) => {
        const next = { ...previous };
        delete next[requestId];
        return next;
      });
      if (
        showResult &&
        operation.status === "complete" &&
        !dismissed.current.has(requestId)
      )
        setResultId(requestId);
      if (showResult && operation.status === "failed") setHistoryOpen(true);
    } catch (reason) {
      if (mounted.current)
        setCheckErrors((previous) => ({
          ...previous,
          [requestId]: message(reason),
        }));
    } finally {
      checkingIds.current.delete(requestId);
      if (mounted.current) setChecking([...checkingIds.current]);
    }
  };

  const pending = operations.filter(unresolved);
  const historyEntries = operations.filter(
    (operation) => !unresolved(operation),
  );
  const result = operations.find(
    (operation) =>
      operation.requestId === resultId && operation.status === "complete",
  );
  return (
    <div>
      {result ? (
        <div className="wallet-refill-result" role="status">
          <ConversionProgress
            operation={result}
            owner={owner}
            checking={checking.includes(result.requestId)}
            error={checkErrors[result.requestId]}
            onDetails={() => void check(result.requestId, false)}
          />
          <button
            type="button"
            className="wallet-refill-result-dismiss"
            aria-label="Dismiss conversion receipt"
            onClick={() => {
              dismissed.current.add(result.requestId);
              setResultId(null);
            }}
          >
            <IoClose aria-hidden="true" />
          </button>
        </div>
      ) : null}
      {pending.length ? (
        <section
          className="wallet-refill-pending"
          aria-label="Pending Neutron cycles conversions"
        >
          <h2>Conversions in progress</h2>
          {pending.map((operation) => (
            <ConversionProgress
              key={operation.requestId}
              operation={operation}
              owner={owner}
              checking={checking.includes(operation.requestId)}
              error={checkErrors[operation.requestId]}
              onCheck={() => void check(operation.requestId)}
              onDetails={() => void check(operation.requestId, false)}
            />
          ))}
        </section>
      ) : null}
      {error ? (
        <div className="wallet-refill-error" role="alert">
          <IoAlertCircleOutline aria-hidden="true" />
          <span>{error}</span>
          <button
            type="button"
            disabled={loading || loadingMore}
            onClick={() => void load()}
          >
            Retry
          </button>
        </div>
      ) : null}
      {historyEntries.length || nextCursor ? (
        <details
          className="wallet-refill-history"
          open={historyOpen}
          onToggle={(event) => setHistoryOpen(event.currentTarget.open)}
        >
          <summary>
            Neutron cycles conversions{" "}
            <span>{historyEntries.length || ""}</span>
          </summary>
          {historyEntries.map((operation) => (
            <ConversionProgress
              key={operation.requestId}
              operation={operation}
              owner={owner}
              checking={checking.includes(operation.requestId)}
              error={checkErrors[operation.requestId]}
              onDetails={() => void check(operation.requestId, false)}
            />
          ))}
          {nextCursor ? (
            <button
              type="button"
              className="nt-button wallet-refill-load-more"
              disabled={loading || loadingMore}
              onClick={() => void loadMore()}
            >
              {loadingMore ? "Loading…" : "Load more conversions"}
            </button>
          ) : null}
        </details>
      ) : null}
    </div>
  );
}

function ConversionProgress({
  operation,
  owner,
  checking = false,
  error,
  onCheck,
  onDetails,
}: {
  operation: OperatingCyclesOperation;
  owner: string;
  checking?: boolean;
  error?: string | undefined;
  onCheck?: () => void;
  onDetails?: () => void;
}) {
  const complete = operation.status === "complete";
  const receiptAvailable = hasUnreadReceipt(operation);
  const actual = operation.attachedCyclesAtoms;
  const fee = operation.feeAtoms;
  const estimatedNet =
    actual === null
      ? operation.expectedNetAtoms
      : fee === null
        ? null
        : (BigInt(actual) > BigInt(fee)
            ? BigInt(actual) - BigInt(fee)
            : 0n
          ).toString();
  const title = complete
    ? "TCYCLES conversion complete"
    : operation.status === "failed"
      ? "Conversion stopped"
      : receiptAvailable
        ? "Receipt available"
        : operation.status === "unknown"
          ? "Conversion needs checking"
          : "Converting Neutron cycles";
  return (
    <article
      className={`wallet-refill-operation ${complete ? "is-complete" : ""}`}
    >
      <div className="wallet-refill-operation-heading">
        {complete ? (
          <IoCheckmarkCircleOutline aria-hidden="true" />
        ) : operation.status === "failed" ? (
          <IoAlertCircleOutline aria-hidden="true" />
        ) : (
          <IoTimeOutline aria-hidden="true" />
        )}
        <div>
          <strong>{title}</strong>
          <span>
            {amount(actual ?? operation.requestedCyclesAtoms)} T cycles
            {operation.target
              ? ` · ${operation.target === owner ? "My Neutron" : "Other account"}`
              : ""}
          </span>
        </div>
      </div>
      {complete && estimatedNet !== null ? (
        <p>{amount(estimatedNet)} TCYCLES estimated</p>
      ) : null}
      {unresolved(operation) || receiptAvailable ? (
        <p className="wallet-refill-operation-message">
          {receiptAvailable
            ? "The original response is saved. Open its receipt to check the conversion outcome."
            : operation.status === "unknown"
              ? "The outcome is not confirmed yet. Check this saved conversion before starting another one."
              : "Your progress is saved. Checking this conversion will not send another payment."}
        </p>
      ) : null}
      {operation.error ? (
        <p className="wallet-refill-operation-message">{operation.error}</p>
      ) : null}
      {error ? (
        <p className="wallet-refill-inline-error" role="alert">
          {error}
        </p>
      ) : null}
      {onCheck ? (
        <button
          type="button"
          className="nt-button"
          disabled={checking}
          onClick={onCheck}
        >
          {checking ? "Checking…" : "Check progress"}
        </button>
      ) : null}
      <details
        className="wallet-refill-diagnostics"
        onToggle={(event) => {
          if (
            event.currentTarget.open &&
            !operation.detailsAvailable &&
            !checking
          )
            onDetails?.();
        }}
      >
        <summary>Details</summary>
        {!operation.detailsAvailable ? (
          <p>
            {checking
              ? "Loading saved receipt…"
              : "Open this conversion's saved receipt for recipient and payment details."}
          </p>
        ) : null}
        {!operation.detailsAvailable && error && onDetails ? (
          <button
            type="button"
            className="nt-button"
            disabled={checking}
            onClick={onDetails}
          >
            Retry details
          </button>
        ) : null}
        <dl>
          {operation.target ? (
            <>
              <dt>Recipient</dt>
              <dd>{operation.target}</dd>
            </>
          ) : null}
          <dt>Saved request</dt>
          <dd>{operation.requestId}</dd>
          {estimatedNet !== null ? (
            <>
              <dt>Estimated TCYCLES</dt>
              <dd>{amount(estimatedNet)} TCYCLES</dd>
            </>
          ) : null}
          {operation.feeAtoms !== null ? (
            <>
              <dt>Estimated ledger fee from review</dt>
              <dd>{amount(operation.feeAtoms)} TCYCLES</dd>
            </>
          ) : null}
          {operation.attachedCyclesAtoms !== null ? (
            <>
              <dt>Cycles sent</dt>
              <dd>{amount(operation.attachedCyclesAtoms)} T cycles</dd>
            </>
          ) : null}
          {operation.chargedCyclesAtoms !== null ? (
            <>
              <dt>Cycles charged</dt>
              <dd>{amount(operation.chargedCyclesAtoms)} T cycles</dd>
            </>
          ) : null}
          {operation.refundedCyclesAtoms !== null ? (
            <>
              <dt>Cycles returned</dt>
              <dd>{amount(operation.refundedCyclesAtoms)} T cycles</dd>
            </>
          ) : null}
          {operation.ledgerBlockIndex !== null ? (
            <>
              <dt>Mint block</dt>
              <dd>{operation.ledgerBlockIndex}</dd>
            </>
          ) : null}
          {complete && operation.recipientBalanceAtoms !== null ? (
            <>
              <dt>Recipient balance after conversion</dt>
              <dd>{amount(operation.recipientBalanceAtoms)} TCYCLES</dd>
            </>
          ) : null}
        </dl>
      </details>
    </article>
  );
}
