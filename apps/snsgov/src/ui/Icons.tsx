/** Inline 16px icons. Bundled, never remote — app assets must be self-contained. */
import type { ReactNode } from "react";

interface IconProps {
  className?: string;
}

function svg(path: ReactNode, props: IconProps) {
  return (
    <svg
      aria-hidden="true"
      className={props.className}
      fill="none"
      height="16"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      viewBox="0 0 16 16"
      width="16"
    >
      {path}
    </svg>
  );
}

export const RefreshIcon = (props: IconProps) =>
  svg(
    <>
      <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
      <path d="M13.5 2.5V6H10" />
    </>,
    props,
  );

export const SearchIcon = (props: IconProps) =>
  svg(
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.5 10.5 3 3" />
    </>,
    props,
  );

export const BackIcon = (props: IconProps) =>
  svg(
    <>
      <path d="M10 3 5 8l5 5" />
    </>,
    props,
  );

export const CopyIcon = (props: IconProps) =>
  svg(
    <>
      <rect height="8.5" rx="1.4" width="8.5" x="5" y="5" />
      <path d="M3.2 10.6A1.5 1.5 0 0 1 2.5 9.3V3.9A1.4 1.4 0 0 1 3.9 2.5h5.4a1.5 1.5 0 0 1 1.3.7" />
    </>,
    props,
  );

export const ExternalIcon = (props: IconProps) =>
  svg(
    <>
      <path d="M9 2.5h4.5V7" />
      <path d="M13.5 2.5 7.5 8.5" />
      <path d="M12 9.8v2.9a1.3 1.3 0 0 1-1.3 1.3H3.8a1.3 1.3 0 0 1-1.3-1.3V5.3A1.3 1.3 0 0 1 3.8 4h2.9" />
    </>,
    props,
  );

export const WarnIcon = (props: IconProps) =>
  svg(
    <>
      <path d="M8 2.6 14.4 13H1.6z" />
      <path d="M8 6.6v3.1" />
      <circle cx="8" cy="11.4" fill="currentColor" r="0.5" stroke="none" />
    </>,
    props,
  );

export const ProposalIcon = (props: IconProps) =>
  svg(
    <>
      <path d="M4 2.5h5.5L12.5 5.5V13a.9.9 0 0 1-.9.9H4A.9.9 0 0 1 3.1 13V3.4A.9.9 0 0 1 4 2.5Z" />
      <path d="M9 2.6v3.1h3.3M5.4 9h5.2M5.4 11.2h3.4" />
    </>,
    props,
  );

export const NeuronIcon = (props: IconProps) =>
  svg(
    <>
      <circle cx="8" cy="4.2" r="1.7" />
      <circle cx="4" cy="11.4" r="1.7" />
      <circle cx="12" cy="11.4" r="1.7" />
      <path d="M6.9 5.7 5.1 9.9M9.1 5.7l1.8 4.2M5.7 11.4h4.6" />
    </>,
    props,
  );

export const TrashIcon = (props: IconProps) =>
  svg(
    <>
      <path d="M3.2 4.6h9.6M6.4 4.6V3.4a.9.9 0 0 1 .9-.9h1.4a.9.9 0 0 1 .9.9v1.2" />
      <path d="M4.4 4.6 5 12.7a.9.9 0 0 0 .9.8h4.2a.9.9 0 0 0 .9-.8l.6-8.1" />
      <path d="M6.9 7v4M9.1 7v4" />
    </>,
    props,
  );
