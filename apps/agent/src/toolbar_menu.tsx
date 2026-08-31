import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  IoLogOutOutline,
  IoSettingsOutline,
  IoTrashOutline,
} from "react-icons/io5";

export function ToolbarMenu({
  anyGenerating,
  busy,
  conversationGenerating,
  hasMessages,
  onClear,
  onClearAll,
  onDisconnect,
}: {
  anyGenerating: boolean;
  busy: boolean;
  conversationGenerating: boolean;
  hasMessages: boolean;
  onClear: () => void;
  onClearAll: () => void;
  onDisconnect: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirmingClearAll, setConfirmingClearAll] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const initialFocusRef = useRef<"first" | "last">("first");
  const menuId = `${useId().replaceAll(":", "")}-agent-menu`;

  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    setConfirmingClearAll(false);
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
        aria-label="Agent settings"
        className="ora-icon-button"
        onClick={() => {
          initialFocusRef.current = "first";
          if (open) {
            close(false);
          } else {
            setConfirmingClearAll(false);
            setOpen(true);
          }
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          initialFocusRef.current = event.key === "ArrowUp" ? "last" : "first";
          setConfirmingClearAll(false);
          setOpen(true);
        }}
        ref={triggerRef}
        title="Agent settings"
        type="button"
      >
        <IoSettingsOutline aria-hidden="true" />
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
            disabled={conversationGenerating || busy || !hasMessages}
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
            disabled={anyGenerating || busy}
            onClick={() => {
              if (confirmingClearAll) {
                close(true);
                onClearAll();
              } else {
                setConfirmingClearAll(true);
              }
            }}
            role="menuitem"
            type="button"
          >
            <IoTrashOutline aria-hidden="true" />
            <span>
              <strong>
                {confirmingClearAll
                  ? "Confirm clear all"
                  : "Clear all conversations"}
              </strong>
              <small>
                {confirmingClearAll
                  ? "This permanently removes every Agent tile history"
                  : "Remove history from every Agent tile"}
              </small>
            </span>
          </button>
          <button
            className="is-danger"
            disabled={anyGenerating || busy}
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
