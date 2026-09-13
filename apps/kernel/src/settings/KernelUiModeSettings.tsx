import { useEffect, useState } from "react";
import { IoOptionsOutline } from "react-icons/io5";
import {
  useKernelUiModeStore,
  type KernelUiMode,
} from "../ui_mode.ts";
import { SettingsDisclosure } from "./SettingsDisclosure.tsx";
import {
  getReleasePreferences,
  setReleasePreferences,
  useReleasePreferencesStore,
} from "../release_preferences.ts";

export function KernelUiModeSettings() {
  const mode = useKernelUiModeStore((state) => state.mode);
  const setMode = useKernelUiModeStore((state) => state.setMode);
  const [open, setOpen] = useState(false);
  const preferences = useReleasePreferencesStore((state) => state.preferences);
  const loading = useReleasePreferencesStore((state) => state.loading);
  const saving = useReleasePreferencesStore((state) => state.saving);
  const error = useReleasePreferencesStore((state) => state.error);

  useEffect(() => {
    if (open) void getReleasePreferences().catch(() => undefined);
  }, [open]);

  return (
    <SettingsDisclosure
      contentTestId="settings-interface"
      description="Developer mode and beta updates"
      icon={<IoOptionsOutline aria-hidden="true" />}
      id="settings-interface"
      onToggle={() => setOpen((current) => !current)}
      open={open}
      testId="settings-interface-toggle"
      title="Advanced users"
    >
      <KernelUiModeChoices mode={mode} onChange={setMode} />
      <BetaUpdatesChoice
        betaEnabled={preferences?.betaEnabled ?? false}
        disabled={!preferences || loading || saving}
        onChange={(enabled) => {
          void setReleasePreferences(enabled).catch(() => undefined);
        }}
        saving={saving}
      />
      {error && (
        <div role="alert">
          <p>Could not load or save beta updates: {error}</p>
          <button
            disabled={loading || saving}
            onClick={() => void getReleasePreferences().catch(() => undefined)}
            type="button"
          >
            Retry
          </button>
        </div>
      )}
    </SettingsDisclosure>
  );
}

export function BetaUpdatesChoice({
  betaEnabled,
  disabled = false,
  onChange,
  saving = false,
}: {
  betaEnabled: boolean;
  disabled?: boolean;
  onChange: (enabled: boolean) => void;
  saving?: boolean;
}) {
  return (
    <div className="settings-ui-mode" data-tid="settings-beta-updates">
      <span className="settings-ui-mode-copy">
        <label htmlFor="settings-beta-updates-enabled">Beta updates</label>
        <small id="settings-beta-updates-description">
          Include beta releases in Settings updates and Marketplace. Turning this
          off keeps installed apps and their data.
        </small>
        {saving && <small role="status">Saving…</small>}
      </span>
      <input
        aria-describedby="settings-beta-updates-description"
        checked={betaEnabled}
        className="settings-ui-mode-switch"
        data-tid="settings-beta-updates-enabled"
        disabled={disabled}
        id="settings-beta-updates-enabled"
        onChange={(event) => onChange(event.currentTarget.checked)}
        role="switch"
        type="checkbox"
      />
    </div>
  );
}

export function KernelUiModeChoices({
  mode,
  onChange,
}: {
  mode: KernelUiMode;
  onChange: (mode: KernelUiMode) => void;
}) {
  const developerMode = mode === "developer";
  return (
    <div className="settings-ui-mode" data-tid="settings-ui-mode">
      <span className="settings-ui-mode-copy">
        <label htmlFor="settings-ui-mode-developer">
          Enable developer mode
        </label>
        <small id="settings-ui-mode-description">
          Show exact permissions, identifiers, hashes, and kernel diagnostics.
        </small>
      </span>
      <input
        aria-describedby="settings-ui-mode-description"
        checked={developerMode}
        className="settings-ui-mode-switch"
        data-tid="settings-ui-mode-developer"
        id="settings-ui-mode-developer"
        onChange={(event) =>
          onChange(event.currentTarget.checked ? "developer" : "normal")
        }
        role="switch"
        type="checkbox"
      />
    </div>
  );
}
