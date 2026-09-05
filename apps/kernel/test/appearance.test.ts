import { expect, test } from "bun:test";
import {
  APPEARANCE_STORAGE_KEY,
  DEFAULT_NAVIGATION_LAYOUT,
  DEFAULT_TILE_GAP,
  DEFAULT_TILE_OPACITY,
  MAX_TILE_GAP,
  MIN_TILE_GAP,
  MIN_TILE_OPACITY,
  WORKSPACE_COLORS,
  WORKSPACE_COLOR_VALUES,
  appearanceOpacityStyle,
  createAppearanceStore,
  parseAppearancePreferences,
  type AppearanceBackgroundStorage,
  type AppearanceStorage,
} from "../src/appearance.ts";

test("appearance preferences strictly default and retain valid workspace colors", () => {
  expect(parseAppearancePreferences(null)).toEqual({
    navigationLayout: DEFAULT_NAVIGATION_LAYOUT,
    tileOpacity: DEFAULT_TILE_OPACITY,
    tileGap: DEFAULT_TILE_GAP,
    workspaceColors: {},
  });
  expect(
    parseAppearancePreferences({
      navigationLayout: "vertical",
      tileOpacity: 0.72,
      tileGap: 12,
      workspaceColors: {
        1: "teal",
        20: "pink",
        21: "red",
        "01": "blue",
        2: "not-a-color",
      },
    }),
  ).toEqual({
    navigationLayout: "vertical",
    tileOpacity: 0.72,
    tileGap: 12,
    workspaceColors: { 1: "teal", 20: "pink" },
  });
  expect(
    parseAppearancePreferences({
      navigationLayout: "diagonal",
      tileOpacity: 2,
      tileGap: MIN_TILE_GAP - 1,
      workspaceColors: [],
    }),
  ).toEqual({
    navigationLayout: DEFAULT_NAVIGATION_LAYOUT,
    tileOpacity: DEFAULT_TILE_OPACITY,
    tileGap: DEFAULT_TILE_GAP,
    workspaceColors: {},
  });
  expect(
    parseAppearancePreferences({ tileGap: MAX_TILE_GAP + 1 }),
  ).toMatchObject({ tileGap: DEFAULT_TILE_GAP });
  expect(
    parseAppearancePreferences({ tileOpacity: MIN_TILE_OPACITY - 0.01 }),
  ).toMatchObject({ tileOpacity: DEFAULT_TILE_OPACITY });

  expect(WORKSPACE_COLORS).toHaveLength(16);
  expect(Object.keys(WORKSPACE_COLOR_VALUES)).toEqual([...WORKSPACE_COLORS]);
  expect(appearanceOpacityStyle(DEFAULT_TILE_OPACITY)).toBeUndefined();
  expect(appearanceOpacityStyle(MIN_TILE_OPACITY)).toEqual({
    opacity: MIN_TILE_OPACITY,
  });
});

test("appearance store hydrates and persists only small scalar and color preferences", () => {
  const values = new Map<string, string>([
    [
      APPEARANCE_STORAGE_KEY,
      JSON.stringify({
        navigationLayout: "vertical",
        tileOpacity: 0.85,
        tileGap: 6,
        workspaceColors: { 3: "amber" },
      }),
    ],
  ]);
  const store = createAppearanceStore({
    storage: memoryStorage(values),
    backgroundStorage: null,
  });
  expect(store.getState()).toMatchObject({
    navigationLayout: "vertical",
    tileOpacity: 0.85,
    tileGap: 6,
    workspaceColors: { 3: "amber" },
  });

  store.getState().setNavigationLayout("horizontal");
  store.getState().setTileOpacity(MIN_TILE_OPACITY);
  store.getState().setTileGap(10);
  store.getState().setWorkspaceColor(1, "cyan");
  store.getState().setWorkspaceColor(3, null);

  expect(JSON.parse(values.get(APPEARANCE_STORAGE_KEY)!)).toEqual({
    navigationLayout: "horizontal",
    tileOpacity: MIN_TILE_OPACITY,
    tileGap: 10,
    workspaceColors: { 1: "cyan" },
  });
});

test("appearance remains live when local preference storage is denied", () => {
  const denied: AppearanceStorage = {
    getItem() {
      throw new Error("storage denied");
    },
    setItem() {
      throw new Error("storage denied");
    },
  };
  const store = createAppearanceStore({
    storage: denied,
    backgroundStorage: null,
  });
  expect(store.getState()).toMatchObject({
    navigationLayout: DEFAULT_NAVIGATION_LAYOUT,
    tileOpacity: DEFAULT_TILE_OPACITY,
    tileGap: DEFAULT_TILE_GAP,
  });
  expect(() => store.getState().setNavigationLayout("vertical")).not.toThrow();
  expect(() => store.getState().setTileOpacity(0.75)).not.toThrow();
  expect(() => store.getState().setTileGap(4)).not.toThrow();
  expect(() => store.getState().setWorkspaceColor(2, "violet")).not.toThrow();
  expect(store.getState()).toMatchObject({
    navigationLayout: "vertical",
    tileOpacity: 0.75,
    tileGap: 4,
    workspaceColors: { 2: "violet" },
  });
});

test("appearance background uses independent blob storage and remains live on failure", async () => {
  let saved = new Blob(["old"], { type: "image/png" });
  const backgroundStorage: AppearanceBackgroundStorage = {
    async load() {
      return saved;
    },
    async save(image) {
      saved = image;
    },
    async clear() {
      saved = new Blob([], { type: "image/png" });
    },
  };
  const store = createAppearanceStore({
    storage: null,
    backgroundStorage,
  });

  await store.getState().hydrateBackground();
  expect(await store.getState().backgroundImage?.text()).toBe("old");

  const replacement = new Blob(["new"], { type: "image/webp" });
  expect(await store.getState().setBackgroundImage(replacement)).toBe(true);
  expect(saved).toBe(replacement);
  expect(store.getState().backgroundError).toBeNull();

  expect(await store.getState().clearBackgroundImage()).toBe(true);
  expect(store.getState().backgroundImage).toBeNull();

  const failingStore = createAppearanceStore({
    storage: null,
    backgroundStorage: {
      async load() {
        throw new Error("cache denied");
      },
      async save() {
        throw new Error("cache denied");
      },
      async clear() {
        throw new Error("cache denied");
      },
    },
  });
  expect(await failingStore.getState().setBackgroundImage(replacement)).toBe(
    false,
  );
  expect(failingStore.getState().backgroundImage).toBe(replacement);
  expect(failingStore.getState().backgroundError).toContain("cache denied");
});

test("appearance background persists overlapping changes in invocation order", async () => {
  let persisted: Blob | null = null;
  let releaseSave: () => void = () => undefined;
  let markSaveStarted: () => void = () => undefined;
  const saveGate = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  const saveStarted = new Promise<void>((resolve) => {
    markSaveStarted = resolve;
  });
  const store = createAppearanceStore({
    storage: null,
    backgroundStorage: {
      async load() {
        return persisted;
      },
      async save(image) {
        markSaveStarted();
        await saveGate;
        persisted = image;
      },
      async clear() {
        persisted = null;
      },
    },
  });
  const image = new Blob(["new"], { type: "image/png" });

  const saving = store.getState().setBackgroundImage(image);
  await saveStarted;
  const clearing = store.getState().clearBackgroundImage();
  releaseSave();

  expect(await saving).toBe(true);
  expect(await clearing).toBe(true);
  expect(persisted).toBeNull();
  expect(store.getState().backgroundImage).toBeNull();
});

function memoryStorage(values: Map<string, string>): AppearanceStorage {
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}
