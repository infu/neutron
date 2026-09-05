import { useRef, useState, type ChangeEvent } from "react";
import { IoColorPaletteOutline } from "react-icons/io5";
import {
  MAX_TILE_GAP,
  MAX_TILE_OPACITY,
  MIN_TILE_GAP,
  MIN_TILE_OPACITY,
  useAppearanceStore,
} from "../appearance.ts";
import { SettingsDisclosure } from "./SettingsDisclosure.tsx";

const MIN_TILE_OPACITY_PERCENT = MIN_TILE_OPACITY * 100;
const MAX_TILE_OPACITY_PERCENT = MAX_TILE_OPACITY * 100;
export function ThemeSettings() {
  const navigationLayout = useAppearanceStore(
    (state) => state.navigationLayout,
  );
  const tileOpacity = useAppearanceStore((state) => state.tileOpacity);
  const tileGap = useAppearanceStore((state) => state.tileGap);
  const backgroundImage = useAppearanceStore((state) => state.backgroundImage);
  const backgroundLoading = useAppearanceStore(
    (state) => state.backgroundLoading,
  );
  const backgroundError = useAppearanceStore((state) => state.backgroundError);
  const setNavigationLayout = useAppearanceStore(
    (state) => state.setNavigationLayout,
  );
  const setTileOpacity = useAppearanceStore((state) => state.setTileOpacity);
  const setTileGap = useAppearanceStore((state) => state.setTileGap);
  const setBackgroundImage = useAppearanceStore(
    (state) => state.setBackgroundImage,
  );
  const clearBackgroundImage = useAppearanceStore(
    (state) => state.clearBackgroundImage,
  );
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);

  const opacityPercent = Math.round(tileOpacity * 100);

  const selectBackground = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (file) void setBackgroundImage(file);
  };

  return (
    <SettingsDisclosure
      contentTestId="settings-theme"
      description="Navigation, background, opacity, and desktop spacing"
      icon={<IoColorPaletteOutline aria-hidden="true" />}
      id="settings-theme"
      onToggle={() => setOpen((current) => !current)}
      open={open}
      testId="settings-theme-toggle"
      title="Theme"
    >
      <div className="settings-theme-controls">
        <label
          className="settings-theme-control"
          htmlFor="settings-theme-navigation"
        >
          <span className="settings-theme-control-copy">
            <strong>Vertical navigation</strong>
            <small id="settings-theme-navigation-description">
              Move the workspace and tray bar from the top to the left.
            </small>
          </span>
          <span className="settings-theme-toggle">
            <span>{navigationLayout === "vertical" ? "Vertical" : "Horizontal"}</span>
            <input
              aria-describedby="settings-theme-navigation-description"
              checked={navigationLayout === "vertical"}
              className="settings-theme-nav-switch"
              data-tid="settings-theme-navigation"
              id="settings-theme-navigation"
              onChange={(event) =>
                setNavigationLayout(
                  event.currentTarget.checked ? "vertical" : "horizontal",
                )
              }
              role="switch"
              type="checkbox"
            />
          </span>
        </label>

        <label
          className="settings-theme-control"
          htmlFor="settings-theme-opacity"
        >
          <span className="settings-theme-control-copy">
            <strong>Surface opacity</strong>
            <small id="settings-theme-opacity-description">
              Adjust app tiles, the launcher, and Settings together.
            </small>
          </span>
          <span className="settings-theme-slider">
            <input
              aria-describedby="settings-theme-opacity-description"
              data-tid="settings-theme-opacity"
              id="settings-theme-opacity"
              max={MAX_TILE_OPACITY_PERCENT}
              min={MIN_TILE_OPACITY_PERCENT}
              onChange={(event) =>
                setTileOpacity(Number(event.currentTarget.value) / 100)
              }
              step="1"
              type="range"
              value={opacityPercent}
            />
            <output htmlFor="settings-theme-opacity">{opacityPercent}%</output>
          </span>
        </label>

        <label className="settings-theme-control" htmlFor="settings-theme-gap">
          <span className="settings-theme-control-copy">
            <strong>Tile spacing</strong>
            <small id="settings-theme-gap-description">
              Adjust the gap between desktop tiles.
            </small>
          </span>
          <span className="settings-theme-slider">
            <input
              aria-describedby="settings-theme-gap-description"
              data-tid="settings-theme-gap"
              id="settings-theme-gap"
              max={MAX_TILE_GAP}
              min={MIN_TILE_GAP}
              onChange={(event) =>
                setTileGap(Number(event.currentTarget.value))
              }
              step="1"
              type="range"
              value={tileGap}
            />
            <output htmlFor="settings-theme-gap">{tileGap}px</output>
          </span>
        </label>

        <div className="settings-theme-control settings-theme-background">
          <span className="settings-theme-control-copy">
            <strong>Background image</strong>
            <small>
              {backgroundImage
                ? "A custom image fills the workspace background."
                : "Choose an image to fill the workspace background."}
            </small>
          </span>
          <span className="settings-theme-background-actions">
            <button
              className="btn btn-sec btn-sm"
              disabled={backgroundLoading}
              onClick={() => fileInputRef.current?.click()}
              type="button"
            >
              {backgroundImage ? "Replace image" : "Choose image"}
            </button>
            <input
              accept="image/*"
              data-tid="settings-theme-background-file"
              disabled={backgroundLoading}
              hidden
              onChange={selectBackground}
              ref={fileInputRef}
              type="file"
            />
            {backgroundImage ? (
              <button
                className="btn btn-sec btn-sm"
                data-tid="settings-theme-background-remove"
                disabled={backgroundLoading}
                onClick={() => void clearBackgroundImage()}
                type="button"
              >
                Remove
              </button>
            ) : null}
          </span>
        </div>

        {backgroundLoading ? (
          <small className="settings-theme-status" role="status">
            Updating background…
          </small>
        ) : null}
        {backgroundError ? (
          <div className="settings-field-error" role="alert">
            {backgroundError}
          </div>
        ) : null}
      </div>
    </SettingsDisclosure>
  );
}
