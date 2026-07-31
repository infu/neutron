import { create } from "zustand";
import { compareCanonicalText } from "neutron-tools/src/canonical.js";
import type {
  InstalledUpdateApp,
  UpdateCheckResult,
  UpdateReview,
  UpdateSourceProgress,
} from "./model.ts";

export type UpdateCheckPhase =
  | "idle"
  | "checking"
  | "ready"
  | "preparing"
  | "review"
  | "applying"
  | "success"
  | "error";

export type UpdateErrorStage = "check" | "prepare" | "apply";

export type UpdateCheckState = Readonly<{
  phase: UpdateCheckPhase;
  checkedAt: number | null;
  results: readonly UpdateCheckResult[];
  progress: Readonly<Record<string, UpdateSourceProgress>>;
  selectedAppIds: readonly string[];
  updatedAppCount: number;
  compiledSizeKiB: number | null;
  review: UpdateReview | null;
  error: string | null;
  errorStage: UpdateErrorStage | null;
}>;

const initialState: UpdateCheckState = {
  phase: "idle",
  checkedAt: null,
  results: Object.freeze([]),
  progress: Object.freeze({}),
  selectedAppIds: Object.freeze([]),
  updatedAppCount: 0,
  compiledSizeKiB: null,
  review: null,
  error: null,
  errorStage: null,
};

export const useUpdateCheckStore = create<UpdateCheckState>(() => initialState);

export const updateCheckState = {
  checking(): void {
    useUpdateCheckStore.setState({
      ...initialState,
      phase: "checking",
    });
  },
  retrying(): void {
    useUpdateCheckStore.setState({
      phase: "checking",
      progress: Object.freeze({}),
      error: null,
      errorStage: null,
    });
  },
  queue(apps: readonly InstalledUpdateApp[]): void {
    useUpdateCheckStore.setState({
      results: Object.freeze(
        [...apps]
          .sort((left, right) => compareCanonicalText(left.appId, right.appId))
          .map((app): UpdateCheckResult =>
            app.updateSource
              ? {
                  kind: "queued",
                  appId: app.appId,
                  name: app.name,
                  installed: app.version,
                  source: app.updateSource,
                }
              : {
                  kind: "manual_only",
                  appId: app.appId,
                  name: app.name,
                  installed: app.version,
                },
          ),
      ),
    });
  },
  result(result: UpdateCheckResult): void {
    useUpdateCheckStore.setState((current) => {
      const index = current.results.findIndex(
        ({ appId }) => appId === result.appId,
      );
      const results = [...current.results];
      if (index >= 0) results[index] = result;
      else results.push(result);
      return { results: Object.freeze(results) };
    });
  },
  progress(value: UpdateSourceProgress): void {
    useUpdateCheckStore.setState((current) => ({
      progress: Object.freeze({
        ...current.progress,
        [value.source]: Object.freeze({ ...value }),
      }),
    }));
  },
  ready(results: readonly UpdateCheckResult[], checkedAt: number): void {
    useUpdateCheckStore.setState({
      phase: "ready",
      checkedAt,
      results: Object.freeze([...results]),
      selectedAppIds: Object.freeze(
        results
          .filter(isSelectableUpdateResult)
          .map(({ appId }) => appId)
          .sort(compareCanonicalText),
      ),
      updatedAppCount: 0,
      compiledSizeKiB: null,
      review: null,
      error: null,
      errorStage: null,
    });
  },
  selection(appIds: readonly string[]): void {
    useUpdateCheckStore.setState({
      selectedAppIds: Object.freeze([...new Set(appIds)].sort()),
      compiledSizeKiB: null,
      review: null,
      error: null,
      errorStage: null,
    });
  },
  preparing(): void {
    useUpdateCheckStore.setState({
      phase: "preparing",
      compiledSizeKiB: null,
      review: null,
      error: null,
      errorStage: null,
    });
  },
  review(review: UpdateReview): void {
    useUpdateCheckStore.setState({
      phase: "review",
      compiledSizeKiB: review.compiledSizeKiB,
      review,
      error: null,
      errorStage: null,
    });
  },
  applying(): void {
    useUpdateCheckStore.setState({
      phase: "applying",
      error: null,
      errorStage: null,
    });
  },
  success(updatedAppCount: number): void {
    if (!Number.isSafeInteger(updatedAppCount) || updatedAppCount < 1) {
      throw new Error("Completed update count must be a positive integer");
    }
    useUpdateCheckStore.setState({
      phase: "success",
      checkedAt: null,
      results: Object.freeze([]),
      progress: Object.freeze({}),
      selectedAppIds: Object.freeze([]),
      updatedAppCount,
      compiledSizeKiB: null,
      review: null,
      error: null,
      errorStage: null,
    });
  },
  error(error: unknown, errorStage: UpdateErrorStage = "check"): void {
    useUpdateCheckStore.setState({
      phase: "error",
      error: error instanceof Error ? error.message : String(error),
      errorStage,
    });
  },
  cancelled(): void {
    const current = useUpdateCheckStore.getState();
    const results = current.results.map((result): UpdateCheckResult =>
      result.kind === "queued" || result.kind === "checking"
        ? { ...result, kind: "cancelled" }
        : result,
    );
    useUpdateCheckStore.setState(
      results.length > 0
        ? {
            phase: "ready",
            results: Object.freeze(results),
            selectedAppIds: Object.freeze(
              results
                .filter(isSelectableUpdateResult)
                .map(({ appId }) => appId)
                .sort(compareCanonicalText),
            ),
            compiledSizeKiB: null,
            review: null,
            error: null,
            errorStage: null,
          }
        : { ...initialState },
    );
  },
  clear(): void {
    useUpdateCheckStore.setState({ ...initialState });
  },
};

function isSelectableUpdateResult(result: UpdateCheckResult): boolean {
  return (
    result.kind === "available" ||
    result.kind === "failed" ||
    result.kind === "source_regression" ||
    result.kind === "cancelled"
  );
}
