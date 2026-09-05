import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { compileAsync } from "sass";

const packageDir = new URL("../", import.meta.url);
const stylesUrl = new URL("../styles.scss", import.meta.url);
const srcDir = new URL("../src/", import.meta.url);
const tokenSourceUrl = new URL("../src/_tokens.scss", import.meta.url);
const repoDesignDocUrl = new URL("../../../doc/design-system.md", import.meta.url);
const readmeUrl = new URL("../README.md", import.meta.url);

const REQUIRED_PUBLIC_CLASSES = [
  "nt-app",
  "nt-app--fill",
  "nt-page",
  "nt-page-header",
  "nt-page-main",
  "nt-page-footer",
  "nt-command-bar",
  "nt-pane",
  "nt-pane-header",
  "nt-pane-body",
  "nt-pane-footer",
  "nt-stack",
  "nt-cluster",
  "nt-toolbar",
  "nt-grid",
  "nt-split",
  "nt-scroll",
  "nt-scroll-x",
  "nt-table-wrap",
  "nt-divider",
  "nt-section",
  "nt-section-header",
  "nt-section-heading",
  "nt-section-count",
  "nt-title",
  "nt-subtitle",
  "nt-section-title",
  "nt-eyebrow",
  "nt-text",
  "nt-muted",
  "nt-meta",
  "nt-code",
  "nt-pre",
  "nt-pre--wrap",
  "nt-sr-only",
  "nt-panel",
  "nt-card",
  "nt-metric",
  "nt-metric-label",
  "nt-metric-value",
  "nt-metric-detail",
  "nt-detail-grid",
  "nt-detail",
  "nt-detail-label",
  "nt-detail-value",
  "nt-settings-list",
  "nt-settings-row",
  "nt-settings-icon",
  "nt-settings-main",
  "nt-settings-title",
  "nt-settings-description",
  "nt-settings-meta",
  "nt-settings-actions",
  "nt-disclosure",
  "nt-disclosure-trigger",
  "nt-disclosure-icon",
  "nt-disclosure-copy",
  "nt-disclosure-title",
  "nt-disclosure-description",
  "nt-disclosure-chevron",
  "nt-disclosure-content",
  "nt-result",
  "nt-callout",
  "nt-dialog",
  "nt-dialog-body",
  "nt-dialog-actions",
  "nt-button",
  "nt-icon-button",
  "nt-button-group",
  "nt-segmented",
  "nt-tabs",
  "nt-tab-list",
  "nt-tab",
  "nt-form",
  "nt-form-grid",
  "nt-form-grid--two",
  "nt-field",
  "nt-label",
  "nt-help",
  "nt-error",
  "nt-required",
  "nt-fieldset",
  "nt-input",
  "nt-textarea",
  "nt-select",
  "nt-checkbox",
  "nt-radio",
  "nt-input-group",
  "nt-input-prefix",
  "nt-input-suffix",
  "nt-alert",
  "nt-badge",
  "nt-tag-list",
  "nt-tag",
  "nt-state",
  "nt-state--empty",
  "nt-state--loading",
  "nt-state--error",
  "nt-state--partial",
  "nt-state--success",
  "nt-spinner",
  "nt-progress",
  "nt-status-dot",
  "nt-kv",
  "nt-copy-field",
  "nt-table",
  "nt-list",
  "nt-json",
];

const REQUIRED_PUBLIC_TOKENS = [
  "--nt-bg",
  "--nt-bg-panel",
  "--nt-bg-elevated",
  "--nt-bg-control",
  "--nt-line",
  "--nt-line-subtle",
  "--nt-line-strong",
  "--nt-line-focus",
  "--nt-text",
  "--nt-text-strong",
  "--nt-text-muted",
  "--nt-text-faint",
  "--nt-accent",
  "--nt-info",
  "--nt-success",
  "--nt-warning",
  "--nt-danger",
  "--nt-critical",
  "--nt-radius-1",
  "--nt-radius-2",
  "--nt-radius-3",
  "--nt-control-sm",
  "--nt-control-md",
  "--nt-control-lg",
  "--nt-gap-1",
  "--nt-pad-1",
  "--nt-panel-bg",
  "--nt-card-bg",
  "--nt-button-bg",
  "--nt-button-fg",
  "--nt-input-bg",
  "--nt-input-fg",
  "--nt-alert-info-bg",
  "--nt-alert-warning-bg",
  "--nt-alert-danger-bg",
  "--nt-alert-success-bg",
  "--nt-shadow-hairline",
];

async function collectFiles(dir: URL, suffix: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
      if (entry.isDirectory()) return collectFiles(child, suffix);
      return entry.name.endsWith(suffix) ? [child.pathname] : [];
    })
  );
  return files.flat();
}

async function compileStyles(): Promise<string> {
  const result = await compileAsync(stylesUrl.pathname, {
    loadPaths: [packageDir.pathname],
    style: "expanded",
  });
  return result.css;
}

function luminance(hex: string): number {
  const [r, g, b] = hex
    .match(/[0-9a-f]{2}/gi)!
    .map((channel) => parseInt(channel, 16) / 255)
    .map((value) =>
      value <= 0.03928
        ? value / 12.92
        : Math.pow((value + 0.055) / 1.055, 2.4)
    );
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(foreground: string, background: string): number {
  const fg = luminance(foreground);
  const bg = luminance(background);
  return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
}

test("SCSS compiles through the public entrypoint", async () => {
  const css = await compileStyles();

  expect(css).toContain("@layer nt.tokens");
  expect(css).toContain(".nt-app");
  expect(css).toContain("prefers-reduced-motion");
  expect(css).toContain("focus-visible");
});

test("shared styles stay scoped, dark, and within visual policy", async () => {
  const files = await collectFiles(srcDir, ".scss");
  const rootFiles = [
    "styles.scss",
    "tokens.scss",
    "base.scss",
    "layout.scss",
    "components.scss",
  ].map((file) => join(packageDir.pathname, file));

  for (const file of [...files, ...rootFiles]) {
    const source = await readFile(file, "utf8");
    expect(source).not.toMatch(/@import\b/);
    expect(source).not.toMatch(/gradient\s*\(/i);
    expect(source).not.toMatch(/@font-face\b/i);
    expect(source).not.toMatch(/https?:\/\//i);
    expect(source).not.toMatch(/border-radius\s*:\s*(?:[6-9]|\d{2,})px/i);
    expect(source).not.toMatch(/border-radius\s*:\s*999px/i);
    expect(source).not.toMatch(/border-radius\s*:\s*\d+%/i);
    expect(source).not.toMatch(/font-size\s*:\s*[^;]*(?:vw|vh|vmin|vmax)/i);
    expect(source).not.toMatch(/letter-spacing\s*:\s*-(?:\d|\.)/i);
    expect(source).not.toMatch(/!important\b/);
    expect(source).not.toMatch(/outline\s*:\s*none/i);
    expect(source).not.toMatch(/touch-action\s*:\s*none/i);
  }
});

test("public selectors are scoped under nt-app", async () => {
  const files = await collectFiles(srcDir, ".scss");

  for (const file of files) {
    const source = await readFile(file, "utf8");
    const publicSelectorLines = source
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith(".nt-"));

    for (const line of publicSelectorLines) {
      expect(line.startsWith(".nt-app")).toBe(true);
    }
  }
});

test("helper source has no browser, kernel, or canister coupling", async () => {
  const source = await readFile(new URL("../src/classes.ts", import.meta.url), "utf8");

  expect(source).not.toMatch(/\bwindow\b|\bdocument\b|\blocalStorage\b/);
  expect(source).not.toMatch(/from\s+["'](?:react|neutron-tools|icblast|@dfinity\/)/);
});

test("compiled CSS includes required v1 classes and public tokens", async () => {
  const css = await compileStyles();

  for (const className of REQUIRED_PUBLIC_CLASSES) {
    expect(css).toContain(`.${className}`);
  }

  for (const token of REQUIRED_PUBLIC_TOKENS) {
    expect(css).toContain(token);
  }
});

test("compiled CSS keeps responsive and interaction contracts visible", async () => {
  const css = await compileStyles();

  expect(css).toContain("container-type: inline-size");
  expect(css).toContain("overscroll-behavior: contain");
  expect(css).toContain("scrollbar-gutter: stable");
  expect(css).toContain("@media (pointer: coarse)");
  expect(css).toContain(".nt-button:focus-visible");
  expect(css).toContain(".nt-icon-button:focus-visible");
  expect(css).toContain(".nt-input:focus-visible");
  expect(css).toContain(".nt-textarea:focus-visible");
  expect(css).toContain(".nt-select:focus-visible");
  expect(css).toContain(".nt-checkbox:focus-visible");
  expect(css).toContain(".nt-radio:focus-visible");
  expect(css).toContain(".nt-tab:focus-visible");
  expect(css).toContain(".nt-scroll:focus-visible");
  expect(css).toContain(".nt-disclosure-trigger[aria-expanded=true]");
  expect(css).not.toMatch(/width:\s*100vw/i);
  expect(css).not.toMatch(/min-width:\s*(?:26[1-9]|[3-9]\d{2,}|\d{4,})px/i);
});

test("loading feedback is compact, quiet, borderless, and centered", async () => {
  const css = await compileStyles();
  const loading = css.match(
    /\.nt-app :where\(\.nt-state--loading\) \{(?<rules>[^}]*)\}/,
  )?.groups?.rules;
  const spinner = css.match(
    /\.nt-app :where\(\.nt-spinner\) \{(?<rules>[^}]*)\}/,
  )?.groups?.rules;

  expect(loading).toContain("background: var(--nt-bg-soft)");
  expect(loading).toContain("box-shadow: none");
  expect(loading).toContain("justify-content: center");
  expect(loading).toContain("min-height: var(--nt-control-md)");
  expect(loading).toContain("padding: var(--nt-pad-2)");
  expect(spinner).toContain("height: var(--nt-icon-sm)");
  expect(spinner).toContain("width: var(--nt-icon-sm)");
});

test("documented token pairs meet contrast policy", async () => {
  const source = await readFile(tokenSourceUrl, "utf8");
  const tokenMap = new Map(
    [...source.matchAll(/(--nt-[\w-]+):\s*(#[0-9a-f]{6})/gi)].map(
      ([, name, value]) => [name, value]
    )
  );

  const pairs = [
    ["--nt-text", "--nt-bg", 4.5],
    ["--nt-text", "--nt-bg-panel", 4.5],
    ["--nt-text-strong", "--nt-bg-panel", 4.5],
    ["--nt-text-muted", "--nt-bg-panel", 4.5],
    ["--nt-text-inverse", "--nt-accent", 4.5],
    ["--nt-danger", "--nt-danger-muted", 4.5],
    ["--nt-warning", "--nt-warning-muted", 4.5],
    ["--nt-success", "--nt-success-muted", 4.5],
    ["--nt-info", "--nt-info-muted", 4.5],
    ["--nt-critical", "--nt-critical-muted", 4.5],
  ] as const;

  for (const [foreground, background, minimum] of pairs) {
    expect(contrast(tokenMap.get(foreground)!, tokenMap.get(background)!)).toBeGreaterThanOrEqual(
      minimum
    );
  }
});

test("visual foundation keeps the shared spacing and hairline rhythm", async () => {
  const source = await readFile(tokenSourceUrl, "utf8");
  const css = await compileStyles();

  for (const declaration of [
    "--nt-gap-1: 4px",
    "--nt-gap-2: 8px",
    "--nt-gap-3: 12px",
    "--nt-gap-4: 16px",
    "--nt-gap-5: 20px",
    "--nt-gap-6: 24px",
    "--nt-gap-7: 32px",
    "--nt-radius-3: 4px",
  ]) {
    expect(source).toContain(declaration);
  }

  expect(source).toContain("--nt-shadow-hairline: inset 0 1px var(--nt-line-subtle)");
  expect(css).toContain("box-shadow: inset 0 -1px var(--nt-line-subtle)");
  expect(css).not.toContain("border: 1px solid");
});

test("docs cover accessibility matrix and app developer recipes", async () => {
  const docs = [
    await readFile(repoDesignDocUrl, "utf8"),
    await readFile(readmeUrl, "utf8"),
  ].join("\n");

  for (const term of [
    "Accessibility Matrix",
    "nt-button",
    "nt-icon-button",
    "nt-field",
    "nt-copy-field",
    "nt-table",
    "nt-dialog",
    "Esbuild Setup",
    "Method Call Form",
    "Dense Inspector",
    "Operational Settings Surface",
    "nt-disclosure",
    "Empty, Loading, Error, Recovery",
    "Destructive Confirmation",
    "App UI must not imitate",
  ]) {
    expect(docs).toContain(term);
  }
});
