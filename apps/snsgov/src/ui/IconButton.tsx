import type { ReactNode } from "react";

interface IconButtonProps {
  label: string;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
  pressed?: boolean;
}

/**
 * An icon button with a real accessible name and a visible tooltip.
 *
 * The tooltip is never the only name: `aria-label` carries it too, because a
 * `title` attribute is not announced reliably and is unreachable by touch.
 */
export function IconButton({ label, onClick, children, disabled, pressed }: IconButtonProps) {
  return (
    <button
      aria-label={label}
      {...(pressed === undefined ? {} : { "aria-pressed": pressed })}
      className="nt-icon-button snsgov-icon-button"
      disabled={disabled ?? false}
      onClick={onClick}
      title={label}
      type="button"
    >
      {children}
    </button>
  );
}
