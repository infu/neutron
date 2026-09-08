// Shared presentation primitives.
//
// Every icon control carries both an `aria-label` and a matching `title`. The
// design system is explicit that a tooltip is never the accessible name, so the
// two are set together and kept identical rather than relying on hover text.

import type { ReactNode } from "react";

export type IconButtonProps = {
  label: string;
  onClick: () => void;
  children: ReactNode;
  active?: boolean | undefined;
  disabled?: boolean | undefined;
  tone?: "default" | "danger" | "accent" | undefined;
  badge?: string | undefined;
  testId?: string | undefined;
};

export function IconButton({
  label,
  onClick,
  children,
  active = false,
  disabled = false,
  tone = "default",
  badge,
  testId,
}: IconButtonProps) {
  const classes = ["nt-icon-button", "nuance-icon"];
  if (active) classes.push("is-active");
  if (tone !== "default") classes.push(`nuance-icon--${tone}`);
  return (
    <button
      aria-label={label}
      aria-pressed={active || undefined}
      className={classes.join(" ")}
      disabled={disabled}
      onClick={onClick}
      data-tid={testId}
      title={label}
      type="button"
    >
      <span aria-hidden="true" className="nuance-icon-glyph">
        {children}
      </span>
      {badge ? (
        <span aria-hidden="true" className="nuance-icon-badge">
          {badge}
        </span>
      ) : null}
    </button>
  );
}

export function StateBlock({
  kind,
  children,
  onRetry,
}: {
  kind: "empty" | "loading" | "error";
  children: ReactNode;
  onRetry?: () => void;
}) {
  return (
    <div
      aria-busy={kind === "loading" ? true : undefined}
      className={`nt-state nt-state--${kind} nuance-state`}
      data-tid={`nuance-state-${kind}`}
    >
      <span>{children}</span>
      {onRetry ? (
        <button className="nt-button nt-button--sm" onClick={onRetry} type="button">
          Retry
        </button>
      ) : null}
    </div>
  );
}

export function Tags({ tags }: { tags: string[] }) {
  if (tags.length === 0) return null;
  return (
    <span className="nt-tag-list nuance-tags">
      {tags.slice(0, 3).map((tag) => (
        <span className="nt-tag" key={tag}>
          {tag}
        </span>
      ))}
    </span>
  );
}

/// A one-line, non-blocking notice. Used for shard-access warnings and for the
/// "an agent edited this draft" banner, neither of which should interrupt work.
export function Notice({
  tone,
  children,
  action,
}: {
  tone: "info" | "warning" | "danger" | "success";
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div data-tid={`nuance-notice-${tone}`} className={`nt-alert nt-alert--${tone} nuance-notice`} role={tone === "danger" ? "alert" : undefined}>
      <span className="nuance-notice-text">{children}</span>
      {action ? <span className="nuance-notice-actions">{action}</span> : null}
    </div>
  );
}
