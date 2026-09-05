import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DEFAULT_NAVIGATION_LAYOUT,
  DEFAULT_TILE_GAP,
  DEFAULT_TILE_OPACITY,
  useAppearanceStore,
} from "../src/appearance.ts";
import { ThemeSettings } from "../src/settings/ThemeSettings.tsx";

afterEach(() => {
  useAppearanceStore.setState({
    backgroundError: null,
    backgroundImage: null,
    backgroundLoading: false,
    navigationLayout: DEFAULT_NAVIGATION_LAYOUT,
    tileGap: DEFAULT_TILE_GAP,
    tileOpacity: DEFAULT_TILE_OPACITY,
    workspaceColors: {},
  });
});

test("Theme settings are collapsed with current-layout defaults", () => {
  const html = renderToStaticMarkup(<ThemeSettings />);

  expect(html).toContain(">Theme</strong>");
  expect(html).toContain('data-tid="settings-theme-toggle"');
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain('data-tid="settings-theme" hidden=""');

  const navigation = inputMarkup(html, "settings-theme-navigation");
  expect(navigation).toContain('type="checkbox"');
  expect(navigation).toContain('role="switch"');
  expect(navigation).toContain(
    'aria-describedby="settings-theme-navigation-description"',
  );
  expect(navigation).not.toContain("checked");
  expect(html).toContain("Horizontal");

  const opacity = inputMarkup(html, "settings-theme-opacity");
  expect(opacity).toContain('type="range"');
  expect(opacity).toContain('min="70"');
  expect(opacity).toContain('max="100"');
  expect(opacity).toContain('value="100"');
  expect(html).toContain("100%");

  const gap = inputMarkup(html, "settings-theme-gap");
  expect(gap).toContain('type="range"');
  expect(gap).toContain('min="4"');
  expect(gap).toContain('max="24"');
  expect(gap).toContain('value="8"');
  expect(html).toContain("8px");

  const upload = inputMarkup(html, "settings-theme-background-file");
  expect(upload).toContain('type="file"');
  expect(upload).toContain('accept="image/*"');
  expect(html).toContain("Choose image");
  expect(html).not.toContain("<img");
});

function inputMarkup(html: string, testId: string): string {
  const match = html.match(
    new RegExp(`<input(?=[^>]*data-tid="${testId}")[^>]*>`),
  );
  if (!match) throw new Error(`Missing ${testId} input`);
  return match[0];
}
