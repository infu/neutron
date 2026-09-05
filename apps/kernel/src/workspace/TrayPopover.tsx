import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { IoClose } from "react-icons/io5";
import {
  useAppearanceStore,
  type NavigationLayout,
} from "../appearance.ts";

const POPOVER_GAP_PX = 6;
const VIEWPORT_GAP_PX = 8;

type NavigationPopoverPosition = Readonly<{
  align: "start" | "end";
  anchor?: HTMLElement | null;
  anchorBlockOffset?: number;
  anchorInlineOffset?: number;
  placement: "below" | "right";
  propertyPrefix: string;
  gap?: number;
}>;

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
  subtitle?: ReactNode;
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
  const navigationLayout = useAppearanceStore(
    (state) => state.navigationLayout,
  );

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
      if (isOpen) {
        positionTrayPopover(popover, triggerRef.current, navigationLayout);
      }
      openChangeRef.current?.(isOpen);
    };
    popover.addEventListener("toggle", onToggle);
    return () => popover.removeEventListener("toggle", onToggle);
  }, [navigationLayout, popoverRef, triggerRef]);

  useEffect(() => {
    if (!open) return;
    const reposition = () =>
      positionTrayPopover(
        popoverRef.current,
        triggerRef.current,
        navigationLayout,
      );
    const trayScroller = triggerRef.current?.closest(".app-tray-apps");
    window.addEventListener("resize", reposition);
    trayScroller?.addEventListener("scroll", reposition);
    window.visualViewport?.addEventListener("resize", reposition);
    window.visualViewport?.addEventListener("scroll", reposition);
    return () => {
      window.removeEventListener("resize", reposition);
      trayScroller?.removeEventListener("scroll", reposition);
      window.visualViewport?.removeEventListener("resize", reposition);
      window.visualViewport?.removeEventListener("scroll", reposition);
    };
  }, [navigationLayout, open, popoverRef, triggerRef]);

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
          positionTrayPopover(
            popoverRef.current,
            triggerRef.current,
            navigationLayout,
          )
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
            {subtitle ? <small>{subtitle}</small> : null}
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
  navigationLayout: NavigationLayout = "horizontal",
): void {
  positionNavigationPopover(popover, button, {
    align: "end",
    placement: navigationLayout === "vertical" ? "right" : "below",
    propertyPrefix: "app-tray",
  });
}

export function positionNavigationPopover(
  popover: HTMLElement | null,
  button: HTMLElement | null,
  {
    align,
    anchor,
    anchorBlockOffset = 0,
    anchorInlineOffset = 0,
    placement,
    propertyPrefix,
    gap = POPOVER_GAP_PX,
  }: NavigationPopoverPosition,
): void {
  if (!popover || !button || typeof window === "undefined") return;
  const anchorRect = (anchor ?? button).getBoundingClientRect();
  const viewport = window.visualViewport;
  const visibleLeft = viewport?.offsetLeft ?? 0;
  const visibleTop = viewport?.offsetTop ?? 0;
  const visibleRight =
    visibleLeft + (viewport?.width ?? window.innerWidth);
  const visibleBottom = viewport
    ? viewport.offsetTop + viewport.height
    : window.innerHeight;
  const viewportBottomInset = Math.max(0, window.innerHeight - visibleBottom);
  const viewportRightInset = Math.max(0, window.innerWidth - visibleRight);

  if (placement === "right") {
    const left = clamp(
      anchorRect.right + gap,
      visibleLeft + VIEWPORT_GAP_PX,
      visibleRight - VIEWPORT_GAP_PX,
    );
    const availableWidth = Math.max(
      0,
      visibleRight - left - VIEWPORT_GAP_PX,
    );
    popover.style.setProperty(`--${propertyPrefix}-left`, `${left}px`);
    popover.style.setProperty(
      `--${propertyPrefix}-available-width`,
      `${availableWidth}px`,
    );
    if (align === "end") {
      const bottom = Math.max(
        viewportBottomInset + VIEWPORT_GAP_PX,
        window.innerHeight - anchorRect.bottom + anchorBlockOffset,
      );
      popover.style.setProperty(`--${propertyPrefix}-bottom`, `${bottom}px`);
      popover.style.setProperty(
        `--${propertyPrefix}-available-height`,
        `${Math.max(
          0,
          window.innerHeight - bottom - visibleTop - VIEWPORT_GAP_PX,
        )}px`,
      );
    } else {
      const top = clamp(
        anchorRect.top - anchorBlockOffset,
        visibleTop + VIEWPORT_GAP_PX,
        visibleBottom - VIEWPORT_GAP_PX,
      );
      popover.style.setProperty(`--${propertyPrefix}-top`, `${top}px`);
      popover.style.setProperty(
        `--${propertyPrefix}-available-height`,
        `${Math.max(0, visibleBottom - top - VIEWPORT_GAP_PX)}px`,
      );
    }
    return;
  }

  const top = clamp(
    anchorRect.bottom + gap,
    visibleTop + VIEWPORT_GAP_PX,
    visibleBottom - VIEWPORT_GAP_PX,
  );
  popover.style.setProperty(`--${propertyPrefix}-top`, `${top}px`);
  if (align === "end") {
    const right = Math.max(
      viewportRightInset + VIEWPORT_GAP_PX,
      window.innerWidth - anchorRect.right + anchorInlineOffset,
    );
    popover.style.setProperty(`--${propertyPrefix}-right`, `${right}px`);
  } else {
    const left = clamp(
      anchorRect.left - anchorInlineOffset,
      visibleLeft + VIEWPORT_GAP_PX,
      visibleRight - VIEWPORT_GAP_PX,
    );
    popover.style.setProperty(`--${propertyPrefix}-left`, `${left}px`);
    popover.style.setProperty(
      `--${propertyPrefix}-available-width`,
      `${Math.max(0, visibleRight - left - VIEWPORT_GAP_PX)}px`,
    );
  }
  popover.style.setProperty(
    `--${propertyPrefix}-available-height`,
    `${Math.max(0, visibleBottom - top - VIEWPORT_GAP_PX)}px`,
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}
