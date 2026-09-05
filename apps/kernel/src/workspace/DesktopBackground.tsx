import { useEffect, useState } from "react";
import { useAppearanceStore } from "../appearance.ts";

export function DesktopBackground() {
  const image = useAppearanceStore((state) => state.backgroundImage);
  const hydrate = useAppearanceStore((state) => state.hydrateBackground);
  const [source, setSource] = useState<string | null>(null);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (!image) {
      setSource(null);
      return;
    }
    const nextSource = URL.createObjectURL(image);
    setSource(nextSource);
    return () => URL.revokeObjectURL(nextSource);
  }, [image]);

  return source ? (
    <img
      alt=""
      aria-hidden="true"
      className="desktop-background-image"
      draggable={false}
      src={source}
    />
  ) : null;
}
