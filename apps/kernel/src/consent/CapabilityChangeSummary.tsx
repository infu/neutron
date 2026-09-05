import { CAPABILITY_CATALOG } from "neutron-tools/src/capabilities/catalog.js";
import type { CapabilityPlanDiffV1 } from "neutron-tools/src/capabilities/wire.js";
import { ConsentNotice, useConsentUiMode } from "./ConsentPresentation.tsx";
import type { KernelUiMode } from "../ui_mode.ts";

export function CapabilityChangeSummary({
  diff,
  mode,
}: {
  diff: CapabilityPlanDiffV1 | undefined;
  mode?: KernelUiMode;
}) {
  const uiMode = useConsentUiMode(mode);
  if (!diff) {
    return (
      <ConsentNotice tone="danger">
        {uiMode === "normal" ? (
          <>Previous permissions are unavailable. Review this app&apos;s access below.</>
        ) : <>
        <strong>Access changes cannot be compared.</strong>{" "}
        The installed capability plan is unavailable. Treat this update like a
        new permission decision.
        </>}
      </ConsentNotice>
    );
  }
  if (diff.entries.length === 0) {
    if (uiMode === "normal") {
      return <p className="consent-change-summary">Permissions unchanged.</p>;
    }
    return (
      <ConsentNotice tone="success">
        <strong>No capability authority changes.</strong>{" "}
        The package version changes, but its structured permission plan does
        not.
      </ConsentNotice>
    );
  }
  const counts = {
    added: diff.entries.filter(({ change }) => change === "added").length,
    changed: diff.entries.filter(({ change }) => change === "changed").length,
    removed: diff.entries.filter(({ change }) => change === "removed").length,
  };
  const labels = [
    ...new Set(diff.entries.map(({ id }) => CAPABILITY_CATALOG[id].title)),
  ];
  if (uiMode === "normal") {
    return (
      <p className="consent-change-summary">
        <strong>Permissions:</strong>{" "}
        {[
          counts.added ? `${counts.added} added` : "",
          counts.changed ? `${counts.changed} changed` : "",
          counts.removed ? `${counts.removed} removed` : "",
        ].filter(Boolean).join(", ")}.
      </p>
    );
  }
  return (
    <ConsentNotice tone="warning">
      <strong>
        Permission plan changed:{" "}
        {[
          counts.added ? `${counts.added} added` : "",
          counts.changed ? `${counts.changed} changed` : "",
          counts.removed ? `${counts.removed} removed` : "",
        ]
          .filter(Boolean)
          .join(", ")}
        .
      </strong>{" "}
      {formatCapabilityLabels(labels)}. A structural change is not assumed to
      be safer or narrower; exact before-and-after values remain in technical
      details.
    </ConsentNotice>
  );
}

function formatCapabilityLabels(labels: readonly string[]): string {
  if (labels.length <= 4) return labels.join(", ");
  return `${labels.slice(0, 4).join(", ")} and ${labels.length - 4} more`;
}
