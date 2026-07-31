import { create } from "zustand";

export type KernelUiMode = "normal" | "developer";

export const KERNEL_UI_MODE_STORAGE_KEY = "neutron-kernel-ui-mode-v1";
export const DEFAULT_KERNEL_UI_MODE: KernelUiMode = "normal";

export type KernelUiModeStorage = Pick<Storage, "getItem" | "setItem">;

type KernelUiModeState = {
  mode: KernelUiMode;
  setMode: (mode: KernelUiMode) => void;
};

export function parseKernelUiMode(value: unknown): KernelUiMode {
  return value === "developer" || value === "normal"
    ? value
    : DEFAULT_KERNEL_UI_MODE;
}

export function loadKernelUiMode(
  storage: KernelUiModeStorage | null = browserStorage(),
): KernelUiMode {
  if (!storage) return DEFAULT_KERNEL_UI_MODE;
  try {
    return parseKernelUiMode(storage.getItem(KERNEL_UI_MODE_STORAGE_KEY));
  } catch {
    return DEFAULT_KERNEL_UI_MODE;
  }
}

export function createKernelUiModeStore(
  storage: KernelUiModeStorage | null = browserStorage(),
) {
  return create<KernelUiModeState>((set) => ({
    mode: loadKernelUiMode(storage),
    setMode: (mode) => {
      const next = parseKernelUiMode(mode);
      set({ mode: next });
      if (!storage) return;
      try {
        storage.setItem(KERNEL_UI_MODE_STORAGE_KEY, next);
      } catch {
        // The live preference still works when browser persistence is denied.
      }
    },
  }));
}

export const useKernelUiModeStore = createKernelUiModeStore();

function browserStorage(): KernelUiModeStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
