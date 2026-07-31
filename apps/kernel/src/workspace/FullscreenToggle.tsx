import { useCallback, useEffect, useState } from "react";
import { IoContractOutline, IoExpandOutline } from "react-icons/io5";

export function FullscreenToggle() {
  const [fullscreen, setFullscreen] = useState(
    () => typeof document !== "undefined" && document.fullscreenElement !== null,
  );
  const supported =
    typeof document !== "undefined" &&
    document.fullscreenEnabled &&
    typeof document.documentElement.requestFullscreen === "function" &&
    typeof document.exitFullscreen === "function";

  useEffect(() => {
    const syncFullscreen = () => setFullscreen(document.fullscreenElement !== null);
    syncFullscreen();
    document.addEventListener("fullscreenchange", syncFullscreen);
    return () => {
      document.removeEventListener("fullscreenchange", syncFullscreen);
      if (document.fullscreenElement === document.documentElement) {
        void document.exitFullscreen().catch(() => undefined);
      }
    };
  }, []);

  const toggleFullscreen = useCallback(() => {
    const operation = document.fullscreenElement
      ? document.exitFullscreen()
      : document.documentElement.requestFullscreen();
    void operation.catch(() => {
      setFullscreen(document.fullscreenElement !== null);
    });
  }, []);

  const label = fullscreen ? "Exit full screen" : "Enter full screen";

  return (
    <button
      aria-label="Full screen"
      aria-pressed={fullscreen}
      className="icon-button desktop-fullscreen-button"
      data-tid="fullscreen-toggle"
      disabled={!supported}
      onClick={toggleFullscreen}
      title={supported ? label : "Full screen is unavailable"}
      type="button"
    >
      {fullscreen ? (
        <IoContractOutline aria-hidden="true" />
      ) : (
        <IoExpandOutline aria-hidden="true" />
      )}
    </button>
  );
}
