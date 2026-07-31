import type { ReactNode } from "react";
import { IoChevronDown } from "react-icons/io5";

export function SettingsDisclosure({
  children,
  contentTestId,
  description,
  icon,
  id,
  onToggle,
  open,
  testId,
  title,
}: {
  children: ReactNode;
  contentTestId?: string;
  description: string;
  icon: ReactNode;
  id: string;
  onToggle: () => void;
  open: boolean;
  testId: string;
  title: string;
}) {
  const contentId = `${id}-content`;

  return (
    <section className="settings-section settings-disclosure-section">
      <button
        aria-controls={contentId}
        aria-expanded={open}
        className="settings-disclosure-trigger"
        data-tid={testId}
        onClick={onToggle}
        type="button"
      >
        <span className="settings-disclosure-icon">{icon}</span>
        <span className="settings-disclosure-copy">
          <strong>{title}</strong>
          <small>{description}</small>
        </span>
        <IoChevronDown
          aria-hidden="true"
          className="settings-disclosure-chevron"
        />
      </button>

      <div
        className="settings-disclosure-content"
        data-tid={contentTestId}
        hidden={!open}
        id={contentId}
      >
        {children}
      </div>
    </section>
  );
}
