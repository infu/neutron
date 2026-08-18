import { useEffect, useRef, useState } from "react";
import { IoCheckmark, IoCopyOutline } from "react-icons/io5";
import { clipboardService } from "../clipboard/service.ts";

export function CopyButton({
  className = "",
  label,
  maximumBytes,
  value,
}: {
  className?: string;
  label: string;
  maximumBytes?: number;
  value: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = async () => {
    try {
      await clipboardService.writeFromKernelUi(
        value,
        navigator.userActivation?.isActive === true,
        maximumBytes,
      );
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1_200);
    } catch {
      setCopied(false);
    }
  };

  return (
    <button
      aria-label={label}
      className={`icon-button settings-copy ${className}`.trim()}
      onClick={() => void copy()}
      title={label}
      type="button"
    >
      {copied ? (
        <IoCheckmark aria-hidden="true" />
      ) : (
        <IoCopyOutline aria-hidden="true" />
      )}
    </button>
  );
}
