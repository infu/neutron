import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { BackIcon } from "./Icons";
import { IconButton } from "./IconButton";

export const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** Keep a refresh readable, but never show another account or community's data. */
export function useRead<T>(key: string | null, read: (signal: AbortSignal) => Promise<T>, refresh = 0) {
  const reader = useRef(read);
  reader.current = read;
  const [state, setState] = useState<{ key: string | null; data: T | null; error: string; loading: boolean }>({ key: null, data: null, error: "", loading: false });
  useEffect(() => {
    if (key === null) return;
    const controller = new AbortController();
    setState(previous => ({ key, data: previous.key === key ? previous.data : null, error: "", loading: true }));
    void reader.current(controller.signal).then(
      data => { if (!controller.signal.aborted) setState({ key, data, error: "", loading: false }); },
      error => { if (!controller.signal.aborted) setState(previous => ({ key, data: previous.key === key ? previous.data : null, error: errorMessage(error), loading: false })); },
    );
    return () => controller.abort();
  }, [key, refresh]);
  return state.key === key && key !== null ? state : { key, data: null, error: "", loading: key !== null };
}

export function ErrorNote({ message }: { message?: string | null | undefined }) {
  return message ? <p className="nt-alert nt-alert--danger snsgov-error" role="alert">{message}</p> : null;
}

export function PageHeading({ title, description, actions, onBack }: {
  title: string; description?: ReactNode; actions?: ReactNode; onBack?: () => void;
}) {
  return <header className="snsgov-page-heading">
    <div className="snsgov-heading-copy">
      {onBack && <IconButton label="Go back" onClick={onBack}><BackIcon /></IconButton>}
      <div><h2 className="nt-title" tabIndex={-1}>{title}</h2>{description && <p className="nt-text snsgov-muted">{description}</p>}</div>
    </div>
    {actions && <div className="nt-cluster snsgov-heading-actions">{actions}</div>}
  </header>;
}

export function Disclosure({ title, children, open, description }: {
  title: string; children: ReactNode; open?: boolean; description?: string;
}) {
  const [expanded, setExpanded] = useState(open ?? false);
  useEffect(() => { if (open !== undefined) setExpanded(open); }, [open]);
  return <details className="nt-disclosure snsgov-disclosure" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary className="snsgov-disclosure-summary"><span>{title}{description && <small>{description}</small>}</span><span aria-hidden="true">⌄</span></summary>
    <div className="snsgov-disclosure-body">{children}</div>
  </details>;
}

/** The explanation can be opened with a pointer, keyboard or touch. */
export function Help({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  const anchor = useRef<HTMLSpanElement>(null);
  const bubble = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 12, top: 12 });
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect();
      const tip = bubble.current?.getBoundingClientRect();
      if (!rect || !tip) return;
      setPosition({
        left: Math.max(12, Math.min(rect.left, window.innerWidth - tip.width - 12)),
        top: rect.bottom + tip.height + 12 <= window.innerHeight ? rect.bottom + 6 : Math.max(12, rect.top - tip.height - 6),
      });
    };
    place();
    const dismiss = (event: PointerEvent) => { if (!anchor.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); anchor.current?.querySelector("button")?.focus(); } };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);
  return <span className="snsgov-help" ref={anchor}>
    <button type="button" className="snsgov-help-button" aria-label={`About ${label}`} aria-expanded={open} aria-controls={id} aria-describedby={open ? id : undefined} onClick={() => setOpen(value => !value)}>?</button>
    {open && <span className="snsgov-help-content" role="tooltip" id={id} ref={bubble} style={position}>{children}</span>}
  </span>;
}

export function Dialog({ title, children, onClose, footer, className }: { title: string; children: ReactNode; onClose: () => void; footer?: ReactNode; className?: string }) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const element = dialog.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Main views retain their read state while hidden. A native modal cannot
    // remain in the top layer when navigation hides its owning view: that
    // leaves an invisible dialog making the new screen inert.
    const visibility = new MutationObserver(() => {
      if (element?.open && element.closest("[hidden]")) { element.close(); close.current(); }
    });
    for (let ancestor = element?.parentElement; ancestor; ancestor = ancestor.parentElement) visibility.observe(ancestor, { attributes: true, attributeFilter: ["hidden"] });
    element?.showModal();
    return () => { visibility.disconnect(); element?.close(); if (!opener?.closest("[hidden]")) opener?.focus(); };
  }, []);
  return <dialog className={`snsgov-dialog${className ? ` ${className}` : ""}`} ref={dialog} aria-labelledby={id} onCancel={event => { event.preventDefault(); close.current(); }}>
    <header className="snsgov-dialog-header"><h2 className="nt-title" id={id}>{title}</h2><button className="nt-button nt-button--ghost" type="button" onClick={onClose}>Close</button></header>
    <div className="snsgov-dialog-body">{children}</div>
    {footer && <footer className="snsgov-dialog-footer">{footer}</footer>}
  </dialog>;
}

export function safeExternalUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try { const url = new URL(value); return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined; } catch { return undefined; }
}
