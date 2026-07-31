import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { IoClose } from "react-icons/io5";

const POPOVER_GAP_PX = 6;
const VIEWPORT_GAP_PX = 8;

export type TrayPopoverControls = {
  close: () => void;
  open: boolean;
};

export function TrayPopover({
  buttonLabel,
  children,
  dataAppId,
  itemClassName = "",
  onOpenChange,
  popoverClassName = "",
  popoverId,
  popoverRef: providedPopoverRef,
  popoverTestId,
  subtitle,
  title,
  trigger,
  triggerRef: providedTriggerRef,
  triggerTestId,
}: {
  buttonLabel: string;
  children: ReactNode | ((controls: TrayPopoverControls) => ReactNode);
  dataAppId?: string;
  itemClassName?: string;
  onOpenChange?: (open: boolean) => void;
  popoverClassName?: string;
  popoverId: string;
  popoverRef?: RefObject<HTMLDivElement | null>;
  popoverTestId: string;
  subtitle: ReactNode;
  title: string;
  trigger: ReactNode;
  triggerRef?: RefObject<HTMLButtonElement | null>;
  triggerTestId: string;
}) {
  const internalTriggerRef = useRef<HTMLButtonElement>(null);
  const internalPopoverRef = useRef<HTMLDivElement>(null);
  const triggerRef = providedTriggerRef ?? internalTriggerRef;
  const popoverRef = providedPopoverRef ?? internalPopoverRef;
  const openChangeRef = useRef(onOpenChange);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    openChangeRef.current = onOpenChange;
  }, [onOpenChange]);

  useEffect(() => {
    const popover = popoverRef.current;
    if (!popover) return;
    const onToggle = (event: Event) => {
      const newState = (event as Event & { newState?: string }).newState;
      const isOpen =
        newState === "open" ||
        (newState === undefined && popover.matches(":popover-open"));
      setOpen(isOpen);
      if (isOpen) positionTrayPopover(popover, triggerRef.current);
      openChangeRef.current?.(isOpen);
    };
    popover.addEventListener("toggle", onToggle);
    return () => popover.removeEventListener("toggle", onToggle);
  }, [popoverRef, triggerRef]);

  useEffect(() => {
    if (!open) return;
    const reposition = () =>
      positionTrayPopover(popoverRef.current, triggerRef.current);
    window.addEventListener("resize", reposition);
    window.visualViewport?.addEventListener("resize", reposition);
    window.visualViewport?.addEventListener("scroll", reposition);
    return () => {
      window.removeEventListener("resize", reposition);
      window.visualViewport?.removeEventListener("resize", reposition);
      window.visualViewport?.removeEventListener("scroll", reposition);
    };
  }, [open, popoverRef, triggerRef]);

  const close = useCallback(() => {
    if (popoverRef.current?.matches(":popover-open")) {
      popoverRef.current.hidePopover();
    }
  }, [popoverRef]);

  return (
    <div
      className={`app-tray-item ${itemClassName}`.trim()}
      data-app-id={dataAppId}
    >
      <button
        aria-controls={popoverId}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={buttonLabel}
        className="app-tray-button"
        data-app-id={dataAppId}
        data-tid={triggerTestId}
        onClick={() =>
          positionTrayPopover(popoverRef.current, triggerRef.current)
        }
        popoverTarget={popoverId}
        ref={triggerRef}
        title={buttonLabel}
        type="button"
      >
        {trigger}
      </button>
      <div
        aria-labelledby={`${popoverId}-title`}
        className={`app-tray-popover ${popoverClassName}`.trim()}
        data-app-id={dataAppId}
        data-tid={popoverTestId}
        id={popoverId}
        popover="auto"
        ref={popoverRef}
        role="dialog"
      >
        <header className="app-tray-popover-header">
          <span className="app-tray-popover-identity">
            <strong id={`${popoverId}-title`}>{title}</strong>
            <small>{subtitle}</small>
          </span>
          <button
            aria-label={`Close ${title}`}
            autoFocus
            className="app-tray-popover-close"
            popoverTarget={popoverId}
            popoverTargetAction="hide"
            title="Close"
            type="button"
          >
            <IoClose aria-hidden="true" />
          </button>
        </header>
        <div className="app-tray-popover-content">
          {typeof children === "function"
            ? children({ close, open })
            : children}
        </div>
      </div>
    </div>
  );
}

export function positionTrayPopover(
  popover: HTMLElement | null,
  button: HTMLElement | null,
): void {
  if (!popover || !button || typeof window === "undefined") return;
  const rect = button.getBoundingClientRect();
  const viewport = window.visualViewport;
  const visibleBottom = viewport
    ? viewport.offsetTop + viewport.height
    : window.innerHeight;
  const top = Math.max(VIEWPORT_GAP_PX, rect.bottom + POPOVER_GAP_PX);
  const right = Math.max(VIEWPORT_GAP_PX, window.innerWidth - rect.right);
  const availableHeight = Math.max(
    0,
    visibleBottom - top - VIEWPORT_GAP_PX,
  );
  popover.style.setProperty("--app-tray-top", `${top}px`);
  popover.style.setProperty("--app-tray-right", `${right}px`);
  popover.style.setProperty(
    "--app-tray-available-height",
    `${availableHeight}px`,
  );
}
