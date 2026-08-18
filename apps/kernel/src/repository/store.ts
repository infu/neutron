import { create } from "zustand";
import type {
  RepositoryInfo,
  RepositoryManifest,
  RepositorySetupReference,
} from "neutron-tools/repository";
import type { AttestedInstallOfferRequester } from "../install_offers/types.ts";
import type { DeploymentBuildReviewInput } from "../install_review/deployment_build_review.ts";
import type {
  RepositoryReconciliation,
  RepositorySelection,
  VerifiedRepositoryPackage,
} from "./model.ts";

export type RepositorySetupPhase =
  | "idle"
  | "pending"
  | "loading"
  | "selecting"
  | "compiling"
  | "review"
  | "installing"
  | "success"
  | "error";

export type RepositorySetupProgress = {
  label: string;
  current: number;
  total: number;
};

export function canStartRepositoryLoad(
  phase: RepositorySetupPhase,
  errorStage: "load" | "compile" | "install" | null,
): boolean {
  return (
    phase === "pending" ||
    (phase === "error" &&
      (errorStage === "load" || errorStage === "install"))
  );
}

export type LoadedRepositorySetup = {
  info: RepositoryInfo;
  manifest: RepositoryManifest;
  packages: readonly VerifiedRepositoryPackage[];
  reconciliation: RepositoryReconciliation;
};

type RepositorySetupState = {
  phase: RepositorySetupPhase;
  reference: RepositorySetupReference | null;
  offeredBy: Readonly<AttestedInstallOfferRequester> | null;
  loaded: LoadedRepositorySetup | null;
  rootIds: readonly string[];
  selection: RepositorySelection | null;
  progress: RepositorySetupProgress | null;
  error: string | null;
  errorStage: "load" | "compile" | "install" | null;
  deploymentReview: DeploymentBuildReviewInput | null;
};

const initialState: RepositorySetupState = {
  phase: "idle",
  reference: null,
  offeredBy: null,
  loaded: null,
  rootIds: [],
  selection: null,
  progress: null,
  error: null,
  errorStage: null,
  deploymentReview: null,
};

export const useRepositorySetupStore = create<RepositorySetupState>(() => ({
  ...initialState,
}));

export const repositorySetupState = {
  pending(
    reference: RepositorySetupReference,
    offeredBy: AttestedInstallOfferRequester | null = null,
  ): void {
    useRepositorySetupStore.setState({
      ...initialState,
      phase: "pending",
      reference: Object.freeze({ ...reference }),
      offeredBy: offeredBy ? Object.freeze({ ...offeredBy }) : null,
    });
  },
  loading(progress: RepositorySetupProgress): void {
    useRepositorySetupStore.setState({
      phase: "loading",
      loaded: null,
      rootIds: [],
      selection: null,
      progress: Object.freeze({ ...progress }),
      error: null,
      errorStage: null,
      deploymentReview: null,
    });
  },
  progress(progress: RepositorySetupProgress): void {
    useRepositorySetupStore.setState({
      progress: Object.freeze({ ...progress }),
    });
  },
  loaded(
    loaded: LoadedRepositorySetup,
    selection: RepositorySelection,
  ): void {
    useRepositorySetupStore.setState({
      phase: "selecting",
      loaded: Object.freeze({
        ...loaded,
        packages: Object.freeze([...loaded.packages]),
      }),
      rootIds: Object.freeze([]),
      selection,
      progress: null,
      error: null,
      errorStage: null,
      deploymentReview: null,
    });
  },
  selection(rootIds: readonly string[], selection: RepositorySelection): void {
    useRepositorySetupStore.setState({
      phase: "selecting",
      rootIds: Object.freeze([...rootIds].sort()),
      selection,
      error: null,
      errorStage: null,
      deploymentReview: null,
    });
  },
  compiling(): void {
    useRepositorySetupStore.setState({
      phase: "compiling",
      progress: { label: "Compiling selected applications", current: 0, total: 1 },
      error: null,
      errorStage: null,
      deploymentReview: null,
    });
  },
  review(deploymentReview: DeploymentBuildReviewInput): void {
    useRepositorySetupStore.setState({
      phase: "review",
      progress: null,
      error: null,
      errorStage: null,
      deploymentReview,
    });
  },
  installing(): void {
    useRepositorySetupStore.setState({
      phase: "installing",
      error: null,
      errorStage: null,
      deploymentReview: null,
    });
  },
  success(): void {
    useRepositorySetupStore.setState({
      phase: "success",
      progress: null,
      error: null,
      errorStage: null,
      deploymentReview: null,
    });
  },
  error(stage: "load" | "compile" | "install", error: unknown): void {
    useRepositorySetupStore.setState({
      phase: "error",
      progress: null,
      error: error instanceof Error ? error.message : String(error),
      errorStage: stage,
      deploymentReview: null,
    });
  },
  clear(): void {
    useRepositorySetupStore.setState({ ...initialState });
  },
};
