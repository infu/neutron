import { create } from "zustand";
import { isWorkspaceId, type WorkspaceId } from "./workspace/types.ts";

export const APPEARANCE_STORAGE_KEY = "neutron-kernel-appearance-v1";
export const APPEARANCE_BACKGROUND_CACHE = "neutron-kernel-appearance-v1";
export const APPEARANCE_BACKGROUND_PATH =
  "/.neutron/browser/appearance/background-v1";

export const DEFAULT_NAVIGATION_LAYOUT = "horizontal";
export const DEFAULT_TILE_OPACITY = 1;
export const MIN_TILE_OPACITY = 0.7;
export const MAX_TILE_OPACITY = 1;
export const DEFAULT_TILE_GAP = 8;
export const MIN_TILE_GAP = 4;
export const MAX_TILE_GAP = 24;

export const WORKSPACE_COLORS = [
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
] as const;

export type WorkspaceColor = (typeof WORKSPACE_COLORS)[number];

export const WORKSPACE_COLOR_VALUES: Readonly<Record<WorkspaceColor, string>> =
  {
    red: "#f87171",
    orange: "#fb923c",
    amber: "#fbbf24",
    yellow: "#facc15",
    lime: "#a3e635",
    green: "#4ade80",
    emerald: "#34d399",
    teal: "#2dd4bf",
    cyan: "#22d3ee",
    sky: "#38bdf8",
    blue: "#60a5fa",
    indigo: "#818cf8",
    violet: "#a78bfa",
    purple: "#c084fc",
    fuchsia: "#e879f9",
    pink: "#f472b6",
  };

export type WorkspaceColors = Partial<Record<WorkspaceId, WorkspaceColor>>;
export type NavigationLayout = "horizontal" | "vertical";

export type AppearancePreferences = Readonly<{
  navigationLayout: NavigationLayout;
  tileOpacity: number;
  tileGap: number;
  workspaceColors: WorkspaceColors;
}>;

export type AppearanceStorage = Pick<Storage, "getItem" | "setItem">;

export type AppearanceBackgroundStorage = Readonly<{
  load(): Promise<Blob | null>;
  save(image: Blob): Promise<void>;
  clear(): Promise<void>;
}>;

type AppearanceState = AppearancePreferences & {
  backgroundImage: Blob | null;
  backgroundLoading: boolean;
  backgroundError: string | null;
  setNavigationLayout: (layout: NavigationLayout) => void;
  setTileOpacity: (opacity: number) => void;
  setTileGap: (gap: number) => void;
  setWorkspaceColor: (
    workspaceId: WorkspaceId,
    color: WorkspaceColor | null,
  ) => void;
  hydrateBackground: () => Promise<void>;
  setBackgroundImage: (image: Blob) => Promise<boolean>;
  clearBackgroundImage: () => Promise<boolean>;
};

type AppearanceStoreOptions = Readonly<{
  storage?: AppearanceStorage | null;
  backgroundStorage?: AppearanceBackgroundStorage | null;
}>;

export function parseAppearancePreferences(
  value: unknown,
): AppearancePreferences {
  if (!isRecord(value)) return defaultAppearancePreferences();
  return {
    navigationLayout: parseNavigationLayout(value.navigationLayout),
    tileOpacity: parseTileOpacity(value.tileOpacity),
    tileGap: parseTileGap(value.tileGap),
    workspaceColors: parseWorkspaceColors(value.workspaceColors),
  };
}

export function loadAppearancePreferences(
  storage: AppearanceStorage | null = browserStorage(),
): AppearancePreferences {
  if (!storage) return defaultAppearancePreferences();
  try {
    const stored = storage.getItem(APPEARANCE_STORAGE_KEY);
    return stored === null
      ? defaultAppearancePreferences()
      : parseAppearancePreferences(JSON.parse(stored));
  } catch {
    return defaultAppearancePreferences();
  }
}

export function createAppearanceStore(options: AppearanceStoreOptions = {}) {
  const storage =
    options.storage === undefined ? browserStorage() : options.storage;
  const backgroundStorage =
    options.backgroundStorage === undefined
      ? browserBackgroundStorage()
      : options.backgroundStorage;
  let backgroundHydrated = false;
  let backgroundRevision = 0;
  let backgroundMutation = Promise.resolve();
  const queueBackgroundMutation = (mutation: () => Promise<void>) => {
    const result = backgroundMutation.then(mutation);
    backgroundMutation = result.catch(() => undefined);
    return result;
  };

  return create<AppearanceState>((set, get) => ({
    ...loadAppearancePreferences(storage),
    backgroundImage: null,
    backgroundLoading: false,
    backgroundError: null,

    setNavigationLayout(navigationLayout) {
      if (!isNavigationLayout(navigationLayout)) return;
      set({ navigationLayout });
      persistAppearancePreferences(storage, get());
    },

    setTileOpacity(opacity) {
      if (!isTileOpacity(opacity)) return;
      set({ tileOpacity: opacity });
      persistAppearancePreferences(storage, get());
    },

    setTileGap(gap) {
      if (!isTileGap(gap)) return;
      set({ tileGap: gap });
      persistAppearancePreferences(storage, get());
    },

    setWorkspaceColor(workspaceId, color) {
      if (
        !isWorkspaceId(workspaceId) ||
        (color !== null && !isWorkspaceColor(color))
      )
        return;
      const workspaceColors = { ...get().workspaceColors };
      if (color === null) delete workspaceColors[workspaceId];
      else workspaceColors[workspaceId] = color;
      set({ workspaceColors });
      persistAppearancePreferences(storage, get());
    },

    async hydrateBackground() {
      if (backgroundHydrated) return;
      backgroundHydrated = true;
      const revision = ++backgroundRevision;
      if (!backgroundStorage) return;
      set({ backgroundLoading: true, backgroundError: null });
      try {
        const image = await backgroundStorage.load();
        if (revision !== backgroundRevision) return;
        set({
          backgroundImage: image && isImageBlob(image) ? image : null,
          backgroundLoading: false,
        });
      } catch (error) {
        if (revision !== backgroundRevision) return;
        set({
          backgroundLoading: false,
          backgroundError: backgroundStorageError(error),
        });
      }
    },

    async setBackgroundImage(image) {
      if (!isImageBlob(image)) {
        set({ backgroundError: "Choose an image file." });
        return false;
      }
      backgroundHydrated = true;
      const revision = ++backgroundRevision;
      set({
        backgroundImage: image,
        backgroundLoading: Boolean(backgroundStorage),
        backgroundError: null,
      });
      if (!backgroundStorage) {
        set({
          backgroundLoading: false,
          backgroundError: "Browser background storage is unavailable.",
        });
        return false;
      }
      try {
        await queueBackgroundMutation(() => backgroundStorage.save(image));
        if (revision === backgroundRevision) set({ backgroundLoading: false });
        return true;
      } catch (error) {
        if (revision === backgroundRevision) {
          set({
            backgroundLoading: false,
            backgroundError: backgroundStorageError(error),
          });
        }
        return false;
      }
    },

    async clearBackgroundImage() {
      backgroundHydrated = true;
      const revision = ++backgroundRevision;
      set({
        backgroundImage: null,
        backgroundLoading: Boolean(backgroundStorage),
        backgroundError: null,
      });
      if (!backgroundStorage) {
        set({
          backgroundLoading: false,
          backgroundError: "Browser background storage is unavailable.",
        });
        return false;
      }
      try {
        await queueBackgroundMutation(() => backgroundStorage.clear());
        if (revision === backgroundRevision) set({ backgroundLoading: false });
        return true;
      } catch (error) {
        if (revision === backgroundRevision) {
          set({
            backgroundLoading: false,
            backgroundError: backgroundStorageError(error),
          });
        }
        return false;
      }
    },
  }));
}

export const useAppearanceStore = createAppearanceStore();

export function appearanceOpacityStyle(
  opacity: number,
): Readonly<{ opacity: number }> | undefined {
  return opacity < MAX_TILE_OPACITY ? { opacity } : undefined;
}

function defaultAppearancePreferences(): AppearancePreferences {
  return {
    navigationLayout: DEFAULT_NAVIGATION_LAYOUT,
    tileOpacity: DEFAULT_TILE_OPACITY,
    tileGap: DEFAULT_TILE_GAP,
    workspaceColors: {},
  };
}

function parseNavigationLayout(value: unknown): NavigationLayout {
  return isNavigationLayout(value) ? value : DEFAULT_NAVIGATION_LAYOUT;
}

function isNavigationLayout(value: unknown): value is NavigationLayout {
  return value === "horizontal" || value === "vertical";
}

function parseTileOpacity(value: unknown): number {
  return isTileOpacity(value) ? value : DEFAULT_TILE_OPACITY;
}

function isTileOpacity(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= MIN_TILE_OPACITY &&
    value <= MAX_TILE_OPACITY
  );
}

function parseTileGap(value: unknown): number {
  return isTileGap(value) ? value : DEFAULT_TILE_GAP;
}

function isTileGap(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= MIN_TILE_GAP &&
    value <= MAX_TILE_GAP
  );
}

function parseWorkspaceColors(value: unknown): WorkspaceColors {
  if (!isRecord(value)) return {};
  const colors: WorkspaceColors = {};
  for (const [key, color] of Object.entries(value)) {
    const workspaceId = Number(key);
    if (
      String(workspaceId) === key &&
      isWorkspaceId(workspaceId) &&
      isWorkspaceColor(color)
    ) {
      colors[workspaceId] = color;
    }
  }
  return colors;
}

function isWorkspaceColor(value: unknown): value is WorkspaceColor {
  return (
    typeof value === "string" &&
    (WORKSPACE_COLORS as readonly string[]).includes(value)
  );
}

function persistAppearancePreferences(
  storage: AppearanceStorage | null,
  state: AppearancePreferences,
): void {
  if (!storage) return;
  try {
    storage.setItem(
      APPEARANCE_STORAGE_KEY,
      JSON.stringify({
        navigationLayout: state.navigationLayout,
        tileOpacity: state.tileOpacity,
        tileGap: state.tileGap,
        workspaceColors: state.workspaceColors,
      }),
    );
  } catch {
    // Live appearance remains usable when browser persistence is denied.
  }
}

function browserStorage(): AppearanceStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function browserBackgroundStorage(): AppearanceBackgroundStorage | null {
  if (
    typeof globalThis.caches === "undefined" ||
    typeof globalThis.location === "undefined"
  )
    return null;
  let requestUrl: string;
  try {
    requestUrl = new URL(APPEARANCE_BACKGROUND_PATH, globalThis.location.origin)
      .href;
  } catch {
    return null;
  }
  return {
    async load() {
      const cache = await globalThis.caches.open(APPEARANCE_BACKGROUND_CACHE);
      const response = await cache.match(requestUrl);
      return response ? response.blob() : null;
    },
    async save(image) {
      const cache = await globalThis.caches.open(APPEARANCE_BACKGROUND_CACHE);
      await cache.put(requestUrl, new Response(image));
    },
    async clear() {
      const cache = await globalThis.caches.open(APPEARANCE_BACKGROUND_CACHE);
      await cache.delete(requestUrl);
    },
  };
}

function isImageBlob(value: unknown): value is Blob {
  return value instanceof Blob && value.type.toLowerCase().startsWith("image/");
}

function backgroundStorageError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    ? `Browser background storage failed: ${message}`
    : "Browser background storage failed.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
