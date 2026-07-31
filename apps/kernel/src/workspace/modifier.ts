import { useEffect, useState } from "react";

export function isLayoutModifierEvent(event: {
  metaKey?: boolean;
  altKey?: boolean;
  getModifierState?: unknown;
}): boolean {
  return Boolean(isSystemModifierEvent(event) || event.altKey);
}

export function isSystemModifierEvent(event: {
  metaKey?: boolean;
  altKey?: boolean;
  getModifierState?: unknown;
}): boolean {
  return Boolean(
    event.metaKey ||
      getModifierState(event, "Meta") ||
      getModifierState(event, "OS") ||
      getModifierState(event, "Super") ||
      getModifierState(event, "Hyper")
  );
}

export function isLauncherShortcutEvent(event: {
  key?: string;
  code?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  getModifierState?: unknown;
}): boolean {
  const key = (event.key ?? "").toLowerCase();
  return Boolean(
    (isSystemModifierEvent(event) && (key === "d" || key === "k")) ||
      (event.ctrlKey && key === "k") ||
      (event.ctrlKey && event.code === "Space")
  );
}

export function useLayoutModifierActive(enabled = true): boolean {
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (!enabled) return;

    function update(event: KeyboardEvent | PointerEvent): void {
      setActive(isLayoutModifierEvent(event));
    }
    function reset(): void {
      setActive(false);
    }

    window.addEventListener("keydown", update);
    window.addEventListener("keyup", update);
    window.addEventListener("pointermove", update);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("keydown", update);
      window.removeEventListener("keyup", update);
      window.removeEventListener("pointermove", update);
      window.removeEventListener("blur", reset);
    };
  }, [enabled]);

  return enabled && active;
}

function getModifierState(
  event: { getModifierState?: unknown },
  key: string
): boolean {
  if (typeof event.getModifierState !== "function") return false;
  return Boolean(
    (event.getModifierState as (keyArg: string) => boolean).call(event, key)
  );
}
