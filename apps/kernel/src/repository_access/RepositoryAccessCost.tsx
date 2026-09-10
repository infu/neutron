import { useCallback, useEffect, useState } from "react";
import { getNeutronId } from "../config.ts";
import type { RepositoryAccessApproval } from "./client.ts";
import {
  currentRepositoryAccessApprovalSnapshot,
  loadRepositoryAccessApprovals,
  type RepositoryAccessApprovalSnapshot,
} from "./approvals.ts";

/** Cost discovery is a public read. The surrounding action is the consent. */
export function useRepositoryAccessApprovals(
  sources: readonly string[],
  refreshKey = "",
) {
  const [revision, setRevision] = useState(0);
  const [snapshot, setSnapshot] = useState<RepositoryAccessApprovalSnapshot | null>(null);
  const sourceKey = JSON.stringify([...new Set(sources)].sort());
  const key = JSON.stringify([sourceKey, refreshKey, revision]);
  const hasSources = sources.length > 0;

  useEffect(() => {
    if (!hasSources) return;
    let current = true;
    // Concurrent rows share the GET, so unmounting one row must not cancel it
    // for another. The HTTP timeout bounds the read; stale replies are ignored.
    void loadRepositoryAccessApprovals(
      JSON.parse(sourceKey) as string[],
      JSON.stringify([refreshKey, revision]),
    ).then(
      (approvals) => {
        if (current) setSnapshot({ key, approvals, error: null });
      },
      (cause: unknown) => {
        if (!current) return;
        setSnapshot({
          key,
          approvals: [],
          error: cause instanceof Error
            ? cause.message
            : "The package source access cost could not be checked.",
        });
      },
    );
    return () => { current = false; };
  }, [hasSources, key, refreshKey, revision, sourceKey]);

  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  return {
    ...currentRepositoryAccessApprovalSnapshot(key, hasSources, snapshot),
    refresh,
  };
}

export function RepositoryAccessCost({
  approvals,
  loading = false,
  error = null,
  neutronPrincipal,
  onRetry,
}: {
  approvals: readonly RepositoryAccessApproval[];
  loading?: boolean;
  error?: string | null;
  neutronPrincipal?: string;
  onRetry?: () => void;
}) {
  if (loading) {
    return <small className="repository-access-cost">Checking source access cost…</small>;
  }
  if (error) {
    return (
      <div className="repository-access-cost settings-warning" role="alert">
        <span>{error}</span>
        <span>Public downloads can continue. Paid downloads require a successful cost check.</span>
        {onRetry ? <button className="btn btn-sec" type="button" onClick={onRetry}>Retry cost lookup</button> : null}
      </div>
    );
  }
  if (approvals.length === 0) return null;
  const owner = neutronPrincipal ?? getNeutronId();
  const sources = [...new Map(approvals.map((approval) => [approval.source, approval])).values()];

  return (
    <div className="repository-access-cost" data-tid="repository-access-cost">
      <span>This action can pay the source access cost from your Neutron and identify it to the source.</span>
      <span>Neutron: <code>{owner}</code></span>
      {sources.map(({ source, descriptor }) => (
        <span key={source}>
          <strong>{BigInt(descriptor.cycles).toLocaleString("en-US")} cycles</strong>
          {" to "}<code>{source}</code>
        </span>
      ))}
      <span>Charged once per source if new download access is needed. Network costs are additional.</span>
    </div>
  );
}
