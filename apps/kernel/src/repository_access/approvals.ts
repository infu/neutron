import {
  fetchRepositoryAccessApproval,
  type RepositoryAccessApproval,
} from "./client.ts";
import { UPDATE_CHECK_TIMEOUT_MS } from "../updates/model.ts";

type ReadApproval = (source: string) => Promise<RepositoryAccessApproval | null>;

/** Share simultaneous public metadata reads; never retain a payment approval. */
export function createRepositoryAccessApprovalLoader(
  read: ReadApproval = (source) =>
    fetchRepositoryAccessApproval(source, { timeoutMs: UPDATE_CHECK_TIMEOUT_MS }),
) {
  const pending = new Map<string, Promise<RepositoryAccessApproval | null>>();

  return async function load(
    sources: readonly string[],
    revision = "",
  ): Promise<readonly RepositoryAccessApproval[]> {
    const replies = await Promise.all(
      [...new Set(sources)].sort().map((source) => {
        const key = JSON.stringify([source, revision]);
        const existing = pending.get(key);
        if (existing) return existing;
        const request = Promise.resolve().then(() => read(source));
        pending.set(key, request);
        void request.finally(() => {
          if (pending.get(key) === request) pending.delete(key);
        }).catch(() => undefined);
        return request;
      }),
    );
    return Object.freeze(replies.filter((reply) => reply !== null));
  };
}

export const loadRepositoryAccessApprovals = createRepositoryAccessApprovalLoader();

export type RepositoryAccessApprovalSnapshot = Readonly<{
  key: string;
  approvals: readonly RepositoryAccessApproval[];
  error: string | null;
}>;

const EMPTY_APPROVALS: readonly RepositoryAccessApproval[] = Object.freeze([]);

/** Changing selection must invalidate consent in the render before effects run. */
export function currentRepositoryAccessApprovalSnapshot(
  key: string,
  hasSources: boolean,
  snapshot: RepositoryAccessApprovalSnapshot | null,
): Readonly<{
  approvals: readonly RepositoryAccessApproval[];
  loading: boolean;
  error: string | null;
  ready: boolean;
}> {
  if (!hasSources) {
    return { approvals: EMPTY_APPROVALS, loading: false, error: null, ready: true };
  }
  if (!snapshot || snapshot.key !== key) {
    return { approvals: EMPTY_APPROVALS, loading: true, error: null, ready: false };
  }
  return {
    approvals: snapshot.approvals,
    loading: false,
    error: snapshot.error,
    ready: snapshot.error === null,
  };
}
