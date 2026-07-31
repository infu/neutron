import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  IoEllipsisHorizontal,
  IoLogOutOutline,
  IoTrashOutline,
} from "react-icons/io5";

export function ToolbarMenu({
  busy,
  generating,
  hasMessages,
  onClear,
  onDisconnect,
}: {
  busy: boolean;
  generating: boolean;
  hasMessages: boolean;
  onClear: () => void;
  onDisconnect: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const initialFocusRef = useRef<"first" | "last">("first");
  const menuId = `${useId().replaceAll(":", "")}-agent-menu`;

  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) {
      window.setTimeout(() => triggerRef.current?.focus(), 0);
    }
  }, []);

  const enabledItems = () =>
    Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]:not(:disabled)',
      ) ?? [],
    );

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      const items = enabledItems();
      const target =
        initialFocusRef.current === "last" ? items.at(-1) : items[0];
      target?.focus();
    }, 0);
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close(true);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [close, open]);

  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = enabledItems();
    if (items.length === 0) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    let next = 0;
    if (event.key === "End") next = items.length - 1;
    else if (event.key === "ArrowUp") {
      next = current <= 0 ? items.length - 1 : current - 1;
    } else if (event.key === "ArrowDown") {
      next = current < 0 || current === items.length - 1 ? 0 : current + 1;
    }
    items[next]?.focus();
  };

  return (
    <div
      className="ora-toolbar-menu"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) close(false);
      }}
      ref={rootRef}
    >
      <button
        aria-controls={open ? menuId : undefined}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="More agent actions"
        className="ora-icon-button"
        onClick={() => {
          initialFocusRef.current = "first";
          setOpen((current) => !current);
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          initialFocusRef.current = event.key === "ArrowUp" ? "last" : "first";
          setOpen(true);
        }}
        ref={triggerRef}
        title="More agent actions"
        type="button"
      >
        <IoEllipsisHorizontal aria-hidden="true" />
      </button>
      {open ? (
        <div
          aria-label="Conversation and connection"
          className="ora-toolbar-menu-popover"
          id={menuId}
          onKeyDown={onMenuKeyDown}
          ref={menuRef}
          role="menu"
        >
          <button
            disabled={generating || busy || !hasMessages}
            onClick={() => {
              close(true);
              onClear();
            }}
            role="menuitem"
            type="button"
          >
            <IoTrashOutline aria-hidden="true" />
            <span>
              <strong>Clear conversation</strong>
              <small>Keep the connection and selected model</small>
            </span>
          </button>
          <button
            className="is-danger"
            disabled={generating || busy}
            onClick={() => {
              close(true);
              onDisconnect();
            }}
            role="menuitem"
            type="button"
          >
            <IoLogOutOutline aria-hidden="true" />
            <span>
              <strong>Disconnect OpenRouter</strong>
              <small>Remove the active credential connection</small>
            </span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
