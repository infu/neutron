import { CAPABILITY_CATALOG } from "neutron-tools/src/capabilities/catalog.js";
import type { CapabilityPlanDiffV1 } from "neutron-tools/src/capabilities/wire.js";
import { ConsentNotice } from "./ConsentPresentation.tsx";

export function CapabilityChangeSummary({
  diff,
}: {
  diff: CapabilityPlanDiffV1 | undefined;
}) {
  if (!diff) {
    return (
      <ConsentNotice tone="danger">
        <strong>Access changes cannot be compared.</strong>{" "}
        The installed capability plan is unavailable. Treat this update like a
        new permission decision.
      </ConsentNotice>
    );
  }
  if (diff.entries.length === 0) {
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
