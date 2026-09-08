import type { ComponentType, ReactNode } from "react";
import { useEffect, useState } from "react";
import { cx } from "neutron-design-system";
import { IoCompassOutline, IoPersonOutline, IoPeopleOutline } from "react-icons/io5";

type IconType = ComponentType<{ size?: number; "aria-hidden"?: boolean; className?: string }>;

// The three top-level views, each a tooltip'd icon button in the top nav.
export type TileView = "people" | "communities" | "browse";

export function Nav({ view, onNav }: { view: TileView; onNav: (v: TileView) => void }): ReactNode {
  const items: Array<{ id: TileView; label: string; icon: IconType }> = [
    { id: "people", label: "Direct messages", icon: IoPersonOutline },
    { id: "communities", label: "Servers & groups", icon: IoPeopleOutline },
    { id: "browse", label: "Browse & discover", icon: IoCompassOutline },
  ];
  return (
    <nav className="oc-nav" aria-label="Views">
      {items.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          type="button"
          className={cx("oc-nav__item", { "oc-nav__item--on": view === id })}
          aria-current={view === id}
          onClick={() => onNav(id)}
          title={label}
          aria-label={label}
        >
          <Icon size={17} aria-hidden />
        </button>
      ))}
    </nav>
  );
}

export function IconButton(props: {
  icon: IconType;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  active?: boolean;
  tone?: "neutral" | "danger";
  type?: "button" | "submit";
  size?: number;
  tid?: string;
}): ReactNode {
  const { icon: Icon, label, onClick, disabled, active, tone = "neutral", type = "button", size = 16, tid } = props;
  return (
    <button
      type={type}
      className={cx("nt-icon-button", "oc-icon-btn", {
        "oc-icon-btn--active": !!active,
        "oc-icon-btn--danger": tone === "danger",
      })}
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      data-tid={tid}
    >
      <Icon size={size} aria-hidden />
    </button>
  );
}

/** Surface rejected actions without leaving an unhandled promise in the tile. */
export function AsyncIconButton({ action, ...props }: Omit<Parameters<typeof IconButton>[0], "onClick" | "disabled"> & { action: () => Promise<void> }): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try { await action(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return <>
    <IconButton {...props} disabled={busy} onClick={() => void run()} />
    {error ? <div role="alert" className="oc-action-error">{props.label}: {error}<button type="button" aria-label="Dismiss error" onClick={() => setError(null)}>×</button></div> : null}
  </>;
}

export function Avatar(props: { seed: string; label?: string; size?: number; url?: string | null | undefined }): ReactNode {
  const { seed, label, size = 30, url } = props;
  const hue = hashHue(seed);
  const initial = (label ?? seed).trim().charAt(0).toUpperCase() || "?";
  const [failed, setFailed] = useState(false);
  // Reset the error state if the url changes (e.g. after an avatar update).
  useEffect(() => setFailed(false), [url]);
  const showImage = url && !failed;
  return (
    <span
      className="oc-avatar"
      aria-hidden
      style={{
        width: size,
        height: size,
        background: `hsl(${hue} 42% 26%)`,
        color: `hsl(${hue} 70% 82%)`,
        fontSize: Math.round(size * 0.42),
      }}
    >
      {showImage ? (
        <img className="oc-avatar__img" src={url} alt="" loading="lazy" onError={() => setFailed(true)} />
      ) : (
        initial
      )}
    </span>
  );
}

/**
 * A 2px indeterminate bar pinned to the top of its (relatively-positioned)
 * container. It fades in/out without shifting layout, so background refreshes
 * are barely noticeable and never replace content with a spinner box.
 */
export function TopProgress({ show }: { show: boolean }): ReactNode {
  return <div className={cx("oc-topprogress", { "oc-topprogress--on": show })} aria-hidden />;
}

/** Tiny inline spinner for the brief boot screen only. */
export function MiniSpinner({ label = "Loading" }: { label?: string }): ReactNode {
  return (
    <span className="oc-mini" role="status">
      <span className="oc-spin" aria-hidden />
      <span className="nt-sr-only">{label}</span>
    </span>
  );
}

export function EmptyState({ icon: Icon, title, hint }: { icon?: IconType; title: string; hint?: string }): ReactNode {
  return (
    <div className="oc-empty">
      {Icon ? <Icon size={22} aria-hidden /> : null}
      <p className="oc-empty__title">{title}</p>
      {hint ? <p className="oc-empty__hint">{hint}</p> : null}
    </div>
  );
}

/**
 * App tiles are sandboxed without `allow-forms`, so native <form> submission is
 * blocked by the browser (even with preventDefault). We never use <form>;
 * instead inputs submit on Enter via this handler and buttons are type="button".
 */
export function submitOnEnter(handler: () => void): (e: React.KeyboardEvent) => void {
  return (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handler();
    }
  };
}

export function relativeTime(ms: number): string {
  if (!ms) return "";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function hashHue(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return h;
}
