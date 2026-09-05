import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TileFrame } from "../src/workspace/TileFrame.tsx";

const frameProps = {
  title: "Notes",
  icon: "/app/notes/static/icon.png",
  focused: false,
  canClose: true,
  canSpotlight: true,
  spotlighted: false,
  onFocus: () => undefined,
  onClose: () => undefined,
  onMoveStart: () => undefined,
  onToggleSpotlight: () => undefined,
};

test("fully opaque tiles omit the opacity style", () => {
  const html = renderToStaticMarkup(
    <TileFrame {...frameProps} opacity={1}>
      content
    </TileFrame>,
  );

  expect(rootSectionTag(html)).not.toContain("style=");
});

test("translucent tiles apply opacity only to the existing tile root", () => {
  const html = renderToStaticMarkup(
    <TileFrame {...frameProps} opacity={0.7}>
      content
    </TileFrame>,
  );

  expect(rootSectionTag(html)).toContain('style="opacity:0.7"');
  expect(html.match(/opacity:/g)).toHaveLength(1);
});

test("spotlight control exposes its expand and restore states", () => {
  const expandedHtml = renderToStaticMarkup(
    <TileFrame {...frameProps} opacity={1}>
      content
    </TileFrame>,
  );
  const restoredHtml = renderToStaticMarkup(
    <TileFrame {...frameProps} opacity={1} spotlighted>
      content
    </TileFrame>,
  );

  expect(expandedHtml).toContain('aria-label="Expand tile temporarily"');
  expect(expandedHtml).toContain('aria-pressed="false"');
  expect(restoredHtml).toContain('aria-label="Restore tile size"');
  expect(restoredHtml).toContain('aria-pressed="true"');
});

function rootSectionTag(html: string): string {
  const start = html.indexOf("<section");
  return html.slice(start, html.indexOf(">", start) + 1);
}
