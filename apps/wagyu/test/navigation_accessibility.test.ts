import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  MobileNavigation,
  Sidebar,
} from "../src/app/App.tsx";
import { createPreviewWagyuService } from "../src/app/demo_data.ts";

const NAVIGATION_LABELS = [
  "Home",
  "Profile",
  "Notifications",
  "People",
  "Post",
] as const;

test("compact and mobile navigation buttons keep stable accessible names", async () => {
  const snapshot = await createPreviewWagyuService().loadSnapshot();
  const sidebar = renderToStaticMarkup(
    createElement(Sidebar, {
      snapshot,
      view: "feed",
      onCompose: () => undefined,
      onNavigate: () => undefined,
    }),
  );
  const mobile = renderToStaticMarkup(
    createElement(MobileNavigation, {
      snapshot,
      view: "feed",
      onCompose: () => undefined,
      onNavigate: () => undefined,
    }),
  );

  for (const label of NAVIGATION_LABELS) {
    expect(sidebar).toContain(`aria-label="${label}"`);
    expect(mobile).toContain(`aria-label="${label}"`);
  }
  expect(sidebar).toContain('aria-label="Home" aria-current="page"');
  expect(mobile).toContain('aria-label="Home" aria-current="page"');
  expect(sidebar.indexOf('aria-label="Home"')).toBeLessThan(
    sidebar.indexOf('aria-label="Profile"'),
  );
  expect(mobile.indexOf('aria-label="Home"')).toBeLessThan(
    mobile.indexOf('aria-label="Profile"'),
  );
  expect(mobile.indexOf('aria-label="Profile"')).toBeLessThan(
    mobile.indexOf('aria-label="Post"'),
  );
  expect(mobile.indexOf('aria-label="Post"')).toBeLessThan(
    mobile.indexOf('aria-label="Notifications"'),
  );
  expect(sidebar).not.toContain('aria-label="Feed"');
  expect(mobile).not.toContain('aria-label="Feed"');
});

test("the 900px layout uses the compact named-button sidebar", async () => {
  const stylesheet = await readFile(
    new URL("../src/style.scss", import.meta.url),
    "utf8",
  );
  const compactStart = stylesheet.indexOf("@media (max-width: 1050px)");
  const mobileStart = stylesheet.indexOf("@media (max-width: 780px)");
  const compactRules = stylesheet.slice(compactStart, mobileStart);

  expect(compactStart).toBeGreaterThan(-1);
  expect(mobileStart).toBeGreaterThan(compactStart);
  expect(900).toBeLessThanOrEqual(1050);
  expect(900).toBeGreaterThan(780);
  expect(compactRules).toContain(".wg-sidebar nav button > span");
  expect(compactRules).toContain("display: none");
  expect(compactRules).not.toContain(".wg-sidebar {\n      display: none;");
});

test("the expanded shell centers one content lane between equal side lanes", async () => {
  const [app, feed, stylesheet] = await Promise.all([
    readFile(new URL("../src/app/App.tsx", import.meta.url), "utf8"),
    readFile(
      new URL("../src/app/components/FeedView.tsx", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../src/style.scss", import.meta.url), "utf8"),
  ]);

  expect(app).toContain('className="wg-context-rail"');
  expect(stylesheet).toContain(
    "grid-template-columns: minmax(200px, 1fr) minmax(0, 640px) minmax(200px, 1fr);",
  );
  expect(stylesheet).toContain("max-width: 1264px;");
  expect(stylesheet).toContain("justify-content: center;");
  expect(stylesheet).toContain(".wg-context-rail {\n    border-left: 1px");
  expect(feed).toContain('"wg-timeline-thread",');
  expect(stylesheet).toContain("padding: 9px 0 0 40px;");
  expect(stylesheet).toContain(
    ".wg-thread__parent.wg-thread__target .wg-feed-card__actions",
  );
  expect(stylesheet).not.toContain(
    ".wg-thread__parent .wg-feed-card__actions",
  );
  expect(stylesheet).toContain(
    ".wg-thread__ancestor,\n  .wg-thread__selected {\n    padding: 8px 0;",
  );
  expect(stylesheet).toContain(
    ".wg-thread__reply {\n    padding: 6px 0;",
  );
  expect(stylesheet).toContain(
    "border-left: 2px dashed var(--wg-line-strong);",
  );
  expect(stylesheet).not.toContain("border-radius: 0 0 0 8px;");
  expect(stylesheet).not.toContain(".wg-feed-card__thread-link:hover");
  expect(stylesheet).not.toContain(
    ".wg-thread__composer {\n    border-bottom:",
  );
});

test("mobile reply content stays clear of thread connector lines", async () => {
  const stylesheet = await readFile(
    new URL("../src/style.scss", import.meta.url),
    "utf8",
  );
  const mobileStart = stylesheet.indexOf("@media (max-width: 540px)");
  const mobileRules = stylesheet.slice(mobileStart);

  expect(mobileStart).toBeGreaterThan(-1);
  expect(mobileRules).toContain(
    ".wg-home-thread > .wg-feed-card .wg-feed-card__body,",
  );
  expect(mobileRules).toContain(
    ".wg-thread__reply .wg-feed-card__body,",
  );
  expect(mobileRules).toContain("margin-left: 44px;");
  expect(mobileRules).toContain(
    ".wg-home-thread > .wg-feed-card .wg-feed-card__actions,",
  );
  expect(mobileRules).toContain(
    ".wg-thread__reply .wg-feed-card__actions {",
  );
  expect(mobileRules).toContain("padding-left: 40px;");
});
