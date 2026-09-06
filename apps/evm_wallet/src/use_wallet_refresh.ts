import { useEffect, useRef } from "react";
import type { Operation } from "./data";

export type WalletRefreshOptions = {
  enabled: boolean;
  load: () => Promise<void>;
  refreshBalance: () => Promise<void>;
  reconcile: (operation: Operation) => Promise<unknown>;
  pending: readonly Operation[];
  paused: boolean;
  onError: (error: unknown) => void;
};

function pendingTransactions(operations: readonly Operation[]): Operation[] {
  return operations.filter((operation) => operation.kind === "transaction" &&
    ["signing", "signed", "submitted", "unknown"].includes(operation.status));
}

/** Refresh saved transactions and balances while the wallet is visible. Never prepares or signs requests. */
export function useWalletRefresh(options: WalletRefreshOptions): void {
  const latest = useRef(options);
  latest.current = options;
  const running = useRef(false);
  const wake = useRef<(() => void) | null>(null);
  const hasPending = pendingTransactions(options.pending).length > 0;

  useEffect(() => {
    if (!options.enabled) return;
    let disposed = false;
    let queued = false;
    let timer: number | undefined;

    const visible = () => !disposed && latest.current.enabled && document.visibilityState === "visible";
    const clearTimer = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
    };
    const report = (error: unknown) => {
      if (!disposed && latest.current.enabled) latest.current.onError(error);
    };
    const schedule = () => {
      clearTimer();
      if (!visible()) return;
      const delay = pendingTransactions(latest.current.pending).length > 0 ? 6_000 : 30_000;
      timer = window.setTimeout(requestRefresh, delay);
    };

    async function refresh() {
      running.current = true;
      queued = false;
      try {
        if (latest.current.paused) return;
        // Reconciliation can rebroadcast saved bytes. Keep it out of an active
        // approval and leave preparing/prepared requests entirely to that flow.
        if (!latest.current.paused) {
          for (const operation of pendingTransactions(latest.current.pending)) {
            if (!visible() || latest.current.paused) break;
            try {
              await latest.current.reconcile(operation);
            } catch (error) {
              report(error);
            }
          }
        }
        if (!visible() || latest.current.paused) return;
        const results = await Promise.allSettled([
          latest.current.load(),
          latest.current.refreshBalance(),
        ]);
        for (const result of results) {
          if (result.status === "rejected") report(result.reason);
        }
      } catch (error) {
        report(error);
      } finally {
        running.current = false;
        // A disabled/re-enabled effect may be waiting for this older request.
        if (disposed) {
          wake.current?.();
        } else if (queued && visible()) {
          requestRefresh();
        } else {
          schedule();
        }
      }
    }

    function requestRefresh() {
      clearTimer();
      if (!visible()) {
        queued = false;
        return;
      }
      if (running.current) {
        queued = true;
        return;
      }
      void refresh();
    }

    wake.current = requestRefresh;
    window.addEventListener("focus", requestRefresh);
    document.addEventListener("visibilitychange", requestRefresh);
    return () => {
      disposed = true;
      queued = false;
      clearTimer();
      if (wake.current === requestRefresh) wake.current = null;
      window.removeEventListener("focus", requestRefresh);
      document.removeEventListener("visibilitychange", requestRefresh);
    };
  }, [options.enabled]);

  // Begin promptly when the account becomes available or a transaction starts
  // waiting. Callback and history object changes do not restart the timer.
  useEffect(() => {
    if (options.enabled) wake.current?.();
  }, [options.enabled, options.paused, hasPending]);
}
