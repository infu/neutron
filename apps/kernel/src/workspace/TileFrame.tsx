import type { PointerEvent, ReactNode } from "react";
import { IoClose, IoContractOutline, IoExpandOutline } from "react-icons/io5";
import { appearanceOpacityStyle } from "../appearance.ts";

type TileFrameProps = {
  title: string;
  icon: string;
  children: ReactNode;
  focused: boolean;
  canClose: boolean;
  canSpotlight: boolean;
  opacity: number;
  spotlighted: boolean;
  dragging?: boolean;
  movable?: boolean;
  onFocus: () => void;
  onClose: () => void;
  onMoveStart: (event: PointerEvent<HTMLElement>) => void;
  onToggleSpotlight: () => void;
};

export function TileFrame({
  title,
  icon,
  children,
  focused,
  canClose,
  canSpotlight,
  opacity,
  spotlighted,
  dragging = false,
  movable = true,
  onFocus,
  onClose,
  onMoveStart,
  onToggleSpotlight,
}: TileFrameProps) {
  return (
    <section
      className={[
        "workspace-tile",
        focused ? "workspace-tile--focused" : "",
        dragging ? "workspace-tile--dragging" : "",
        spotlighted ? "workspace-tile--spotlighted" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-label={title}
      onPointerDown={onFocus}
      style={appearanceOpacityStyle(opacity)}
    >
      <header
        className={movable ? "tile-header" : "tile-header tile-header--static"}
        onPointerDown={movable ? onMoveStart : undefined}
        title={movable ? "Move tile" : undefined}
      >
        <img className="tile-title-icon" src={icon} alt="" draggable={false} />
        <span className="tile-title">{title}</span>
        <span className="tile-header-actions">
          {canSpotlight ? (
            <button
              aria-label={
                spotlighted ? "Restore tile size" : "Expand tile temporarily"
              }
              aria-pressed={spotlighted}
              className="icon-button tile-header-action tile-spotlight-toggle"
              data-tid="tile-spotlight-toggle"
              onClick={(event) => {
                event.stopPropagation();
                onToggleSpotlight();
              }}
              onPointerDown={(event) => event.stopPropagation()}
              title={
                spotlighted ? "Restore tile size" : "Expand tile temporarily"
              }
              type="button"
            >
              {spotlighted ? (
                <IoContractOutline aria-hidden="true" />
              ) : (
                <IoExpandOutline aria-hidden="true" />
              )}
            </button>
          ) : null}
          <button
            aria-label="Close tile"
            className="icon-button tile-header-action tile-close"
            type="button"
            title="Close tile"
            disabled={!canClose}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onClose();
            }}
          >
            <IoClose aria-hidden="true" />
          </button>
        </span>
      </header>
      <div className="tile-content">{children}</div>
    </section>
  );
}
