import { expect, test } from "bun:test";
import type { AppRegistry } from "neutron-compiler/src/install.js";
import {
  positionWorkspacePreview,
  workspaceOccupancy,
  workspacePreviewEntryKey,
  workspacePreviewApps,
} from "../src/workspace/WorkspaceSwitcher.tsx";
import type { TileInstance } from "../src/workspace/types.ts";

test("workspace preview lists each app once in workspace order", () => {
  const apps = {
    alpha: { name: "Alpha", icon: "alpha-app.svg" },
    beta: { name: "Beta", icon: "beta-app.svg" },
  } as unknown as AppRegistry;
  const tiles = [
    tile("alpha-one", "alpha", "Alpha main", "alpha-tile.svg"),
    tile("beta-one", "beta", "Beta board", ""),
    tile("alpha-two", "alpha", "Alpha second", "alpha-second.svg"),
    tile("legacy-one", "legacy", "Legacy notes", "legacy.svg"),
  ];

  expect(workspacePreviewApps({ tiles }, apps)).toEqual([
    { appId: "alpha", icon: "alpha-tile.svg", name: "Alpha" },
    { appId: "beta", icon: "beta-app.svg", name: "Beta" },
    { appId: "legacy", icon: "legacy.svg", name: "Legacy notes" },
  ]);
});

test("workspace occupancy preserves compact switcher labels and four-cell cap", () => {
  expect(workspaceOccupancy(0)).toEqual({
    indicatorCount: 0,
    label: "empty",
    occupied: false,
  });
  expect(workspaceOccupancy(1)).toEqual({
    indicatorCount: 1,
    label: "1 open tile",
    occupied: true,
  });
  expect(workspaceOccupancy(7)).toEqual({
    indicatorCount: 4,
    label: "7 open tiles",
    occupied: true,
  });
});

test("workspace preview keyboard entry follows navigation orientation", () => {
  expect(workspacePreviewEntryKey("horizontal")).toBe("ArrowDown");
  expect(workspacePreviewEntryKey("vertical")).toBe("ArrowRight");
});

test("horizontal workspace preview aligns row icons with the workspace glyph", () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const properties = new Map<string, string>();
  const firstIcon = {
    getBoundingClientRect: () => ({ left: 6, top: 4 }),
  } as unknown as HTMLElement;
  const popover = {
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    querySelector: () => firstIcon,
    style: {
      setProperty(name: string, value: string) {
        properties.set(name, value);
      },
    },
  } as unknown as HTMLElement;
  const glyph = {
    getBoundingClientRect: () => ({ bottom: 30, left: 16, right: 34, top: 12 }),
  } as unknown as HTMLElement;
  const button = {
    getBoundingClientRect: () => ({ bottom: 34, left: 12, right: 38, top: 8 }),
    querySelector: () => glyph,
  } as unknown as HTMLElement;

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      innerHeight: 600,
      innerWidth: 200,
      visualViewport: { height: 300, offsetTop: 10 },
    },
  });
  try {
    positionWorkspacePreview(popover, button);
    expect(Object.fromEntries(properties)).toEqual({
      "--workspace-preview-top": "36px",
      "--workspace-preview-left": "10px",
      "--workspace-preview-available-width": "182px",
      "--workspace-preview-available-height": "266px",
    });
  } finally {
    if (originalWindow) {
      Object.defineProperty(globalThis, "window", originalWindow);
    } else {
      Reflect.deleteProperty(globalThis, "window");
    }
  }
});

test("vertical workspace preview opens right and aligns its first icon", () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const properties = new Map<string, string>();
  const firstIcon = {
    getBoundingClientRect: () => ({ left: 56, top: 64 }),
  } as unknown as HTMLElement;
  const popover = {
    getBoundingClientRect: () => ({ left: 50, top: 60 }),
    querySelector: () => firstIcon,
    style: {
      setProperty(name: string, value: string) {
        properties.set(name, value);
      },
    },
  } as unknown as HTMLElement;
  const glyph = {
    getBoundingClientRect: () => ({ bottom: 98, left: 13, right: 31, top: 80 }),
  } as unknown as HTMLElement;
  const button = {
    closest: () => ({
      getBoundingClientRect: () => ({ right: 44 }),
    }),
    getBoundingClientRect: () => ({ bottom: 98, left: 13, right: 31 }),
    querySelector: () => glyph,
  } as unknown as HTMLElement;

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      innerHeight: 700,
      innerWidth: 900,
      visualViewport: {
        height: 600,
        offsetLeft: 20,
        offsetTop: 10,
        width: 500,
      },
    },
  });
  try {
    positionWorkspacePreview(popover, button, "vertical");
    expect(Object.fromEntries(properties)).toEqual({
      "--workspace-preview-left": "37px",
      "--workspace-preview-available-width": "475px",
      "--workspace-preview-available-height": "526px",
      "--workspace-preview-top": "76px",
    });
  } finally {
    if (originalWindow) {
      Object.defineProperty(globalThis, "window", originalWindow);
    } else {
      Reflect.deleteProperty(globalThis, "window");
    }
  }
});

function tile(
  id: string,
  appId: string,
  title: string,
  icon: string,
): TileInstance {
  return {
    appId,
    icon,
    id,
    path: "index.html",
    tileId: "main",
    title,
  };
}
