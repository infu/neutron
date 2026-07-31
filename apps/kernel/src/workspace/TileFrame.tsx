import type { PointerEvent, ReactNode } from "react";
import { IoClose } from "react-icons/io5";

type TileFrameProps = {
  title: string;
  icon: string;
  children: ReactNode;
  focused: boolean;
  canClose: boolean;
  dragging?: boolean;
  movable?: boolean;
  onFocus: () => void;
  onClose: () => void;
  onMoveStart: (event: PointerEvent<HTMLElement>) => void;
};

export function TileFrame({
  title,
  icon,
  children,
  focused,
  canClose,
  dragging = false,
  movable = true,
  onFocus,
  onClose,
  onMoveStart,
}: TileFrameProps) {
  return (
    <section
      className={[
        "workspace-tile",
        focused ? "workspace-tile--focused" : "",
        dragging ? "workspace-tile--dragging" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-label={title}
      onPointerDown={onFocus}
    >
      <header
        className={movable ? "tile-header" : "tile-header tile-header--static"}
        onPointerDown={movable ? onMoveStart : undefined}
        title={movable ? "Move tile" : undefined}
      >
        <img className="tile-title-icon" src={icon} alt="" draggable={false} />
        <span className="tile-title">{title}</span>
        <button
          aria-label="Close tile"
          className="icon-button tile-close"
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
      </header>
      <div className="tile-content">{children}</div>
    </section>
  );
}
