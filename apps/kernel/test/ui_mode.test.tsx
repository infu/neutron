import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  KernelUiModeChoices,
  KernelUiModeSettings,
} from "../src/settings/KernelUiModeSettings.tsx";
import {
  DEFAULT_KERNEL_UI_MODE,
  KERNEL_UI_MODE_STORAGE_KEY,
  createKernelUiModeStore,
  parseKernelUiMode,
  useKernelUiModeStore,
  type KernelUiModeStorage,
} from "../src/ui_mode.ts";

afterEach(() => {
  useKernelUiModeStore.setState({ mode: DEFAULT_KERNEL_UI_MODE });
});

test("Kernel UI mode strictly defaults and hydrates from browser storage", () => {
  expect(parseKernelUiMode(null)).toBe("normal");
  expect(parseKernelUiMode("Developer")).toBe("normal");
  expect(parseKernelUiMode("\"developer\"")).toBe("normal");
  expect(parseKernelUiMode("normal")).toBe("normal");
  expect(parseKernelUiMode("developer")).toBe("developer");

  const values = new Map([[KERNEL_UI_MODE_STORAGE_KEY, "developer"]]);
  const storage = memoryStorage(values);
  const store = createKernelUiModeStore(storage);
  expect(store.getState().mode).toBe("developer");

  store.getState().setMode("normal");
  expect(store.getState().mode).toBe("normal");
  expect(values.get(KERNEL_UI_MODE_STORAGE_KEY)).toBe("normal");
});

test("Kernel UI mode remains usable when browser storage is denied", () => {
  const denied: KernelUiModeStorage = {
    getItem() {
      throw new Error("storage denied");
    },
    setItem() {
      throw new Error("storage denied");
    },
  };
  const store = createKernelUiModeStore(denied);
  expect(store.getState().mode).toBe("normal");

  expect(() => store.getState().setMode("developer")).not.toThrow();
  expect(store.getState().mode).toBe("developer");
});

test("Settings exposes developer mode as an accessible Interface switch", () => {
  const normalHtml = renderToStaticMarkup(<KernelUiModeSettings />);
  expect(normalHtml).toContain(">Interface</strong>");
  expect(normalHtml).toContain('data-tid="settings-interface-toggle"');
  expect(normalHtml).toContain('aria-expanded="false"');
  expect(normalHtml).toContain(
    "Control how much technical detail Kernel shows",
  );
  expect(normalHtml).toContain(
    "Enable developer mode",
  );
  const normalSwitch = inputMarkup(normalHtml, "settings-ui-mode-developer");
  expect(normalSwitch).toContain('role="switch"');
  expect(normalSwitch).toContain('type="checkbox"');
  expect(normalSwitch).not.toContain('checked=""');
  expect(normalHtml).not.toContain("settings-ui-mode-normal");

  const developerHtml = renderToStaticMarkup(
    <KernelUiModeChoices mode="developer" onChange={() => undefined} />,
  );
  expect(inputMarkup(developerHtml, "settings-ui-mode-developer")).toContain(
    'checked=""',
  );
});

function memoryStorage(values: Map<string, string>): KernelUiModeStorage {
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

function inputMarkup(html: string, testId: string): string {
  const match = html.match(
    new RegExp(`<input(?=[^>]*data-tid="${testId}")[^>]*>`),
  );
  if (!match) throw new Error(`Missing ${testId} input`);
  return match[0];
}
