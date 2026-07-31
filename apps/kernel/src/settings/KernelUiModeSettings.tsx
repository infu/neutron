import { useState } from "react";
import { IoOptionsOutline } from "react-icons/io5";
import {
  useKernelUiModeStore,
  type KernelUiMode,
} from "../ui_mode.ts";
import { SettingsDisclosure } from "./SettingsDisclosure.tsx";

export function KernelUiModeSettings() {
  const mode = useKernelUiModeStore((state) => state.mode);
  const setMode = useKernelUiModeStore((state) => state.setMode);
  const [open, setOpen] = useState(false);

  return (
    <SettingsDisclosure
      contentTestId="settings-interface"
      description="Control how much technical detail Kernel shows"
      icon={<IoOptionsOutline aria-hidden="true" />}
      id="settings-interface"
      onToggle={() => setOpen((current) => !current)}
      open={open}
      testId="settings-interface-toggle"
      title="Interface"
    >
      <KernelUiModeChoices mode={mode} onChange={setMode} />
    </SettingsDisclosure>
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
