# Neutron Design System

[Back to the documentation index](./index.md)

The Neutron design system is a shared app-developer package for building
consistent dark-mode app frontends inside kernel-managed iframe tiles. It is a
developer convenience, not a security boundary. The kernel still owns trusted
install, signature, authorization, and canister-call approval UI.

Source package:

- `packages/neutron-design-system/`

Live reference:

- `apps/kitchensink/`

## Usage

Import the SCSS entrypoint from an app stylesheet:

```scss
@use "neutron-design-system/styles.scss";

@layer nt.tokens, nt.base, nt.layout, nt.components, nt.utilities, app;

@layer app {
  .nt-app.my-app {
    --nt-accent: #8adf9d;
  }
}
```

The app root opts into shared styles:

```html
<main class="nt-app nt-app--fill my-app">
  <section class="nt-panel">
    <h1 class="nt-title">My app</h1>
    <button class="nt-button">Review in kernel</button>
  </section>
</main>
```

Apps should add an app-prefixed class such as `my-app` or `ks-app` on the same
root element and use app-prefixed classes for local composition. Do not target
kernel workspace classes, iframe elements, or other apps.

### Esbuild Setup

Apps that import SCSS need Sass support in their frontend build:

```ts
import esbuild from "esbuild";
import { sassPlugin } from "esbuild-sass-plugin";

await esbuild.build({
  entryPoints: ["./src/index.tsx"],
  outfile: "./dist/web/main.js",
  bundle: true,
  platform: "browser",
  plugins: [sassPlugin()],
});
```

The app HTML links the generated CSS with a package-local relative path:

```html
<link rel="stylesheet" href="./main.css" />
```

The design system is bundled into app assets. It is not a kernel extension, a
separate installed app, or a trusted approval surface.

## Public Entrypoints

- `neutron-design-system/styles.scss` - complete style entrypoint.
- `neutron-design-system/tokens.scss` - token declarations only.
- `neutron-design-system/base.scss` - scoped base rules only.
- `neutron-design-system/layout.scss` - layout primitives only.
- `neutron-design-system/components.scss` - component classes only.
- `neutron-design-system` - tiny TypeScript class-name helpers.

The package has no runtime dependencies on React, `neutron-tools`, icblast,
DFINITY packages, identity libraries, or kernel source.

## Visual Policy

- Dark mode only.
- The visual character is compact, technical, and quiet: near-black neutral
  surfaces, cool data text, a restrained green action accent, and cyan focus.
- Layout depth is tonal: the app background is the darkest layer, panels are a
  little lighter, and cards, controls, rows, and state blocks are lighter again.
- Operational pages should follow the Settings pattern: let the page background
  carry the layout, keep headings compact, group dense rows and metrics with
  inset hairlines, and reserve panels for genuinely framed tools. Do not wrap
  every section in a card.
- Spacing follows a 4/8/12/16/20/24/32px rhythm. Prefer the public gap and
  padding tokens instead of one-off values so edges and baselines stay aligned.
- Routine surfaces, controls, inputs, table rows, tags, badges, and status
  blocks do not use visible borders for separation.
- Structural separation uses one-pixel hairlines, usually inset shadows so
  component dimensions never change. Full perimeter lines are reserved for
  workspace framing; app components use top, bottom, or side hairlines only
  when hierarchy needs them.
- Borders are reserved for explicit divider primitives, native indicators,
  scrollbars, and the single visible focus outline. Do not add component
  borders just to frame a card, button, input, or panel.
- No gradients, remote fonts, decorative blobs, or page-art backgrounds.
- Border radius is capped at `5px`.
- Letter spacing stays `0`.
- Type does not scale with viewport units.
- Components keep stable dimensions across hover, focus, loading, and disabled
  states.
- Warning, danger, success, invalid, loading, and disabled states pair tonal
  fills with visible labels, messages, or state text.

The package tests compile the public SCSS entrypoint and scan source SCSS for
these policy rules.

## Scope And Cascade

All shared selectors are scoped under `.nt-app`. The package uses cascade
layers:

```scss
@layer nt.tokens, nt.base, nt.layout, nt.components, nt.utilities;
```

App CSS should load after the shared entrypoint. Apps may add a later `app`
layer and override documented CSS variables on `.nt-app.<app-class>`.

## Public Tokens

Core public semantic tokens:

- `--nt-bg`, `--nt-bg-panel`, `--nt-bg-elevated`, `--nt-bg-control`
- `--nt-line`, `--nt-line-subtle`, `--nt-line-strong`, `--nt-line-focus`
- `--nt-text`, `--nt-text-strong`, `--nt-text-muted`, `--nt-text-faint`
- `--nt-accent`, `--nt-info`, `--nt-success`, `--nt-warning`, `--nt-danger`
- `--nt-radius-1`, `--nt-radius-2`, `--nt-radius-3`
- `--nt-control-sm`, `--nt-control-md`, `--nt-control-lg`
- `--nt-gap-*`, `--nt-pad-*`
- `--nt-shadow-hairline`, `--nt-shadow-raised`

Core public component alias tokens:

- `--nt-panel-bg`
- `--nt-card-bg`
- `--nt-button-bg`
- `--nt-button-fg`
- `--nt-input-bg`
- `--nt-input-fg`
- `--nt-alert-info-bg`
- `--nt-alert-warning-bg`
- `--nt-alert-danger-bg`
- `--nt-alert-success-bg`

Apps can override these on their `.nt-app` root as long as the visual policy is
preserved.

## V1 Class Surface

Layout:

- `nt-app`, `nt-app--fill`
- `nt-page`, `nt-page-header`, `nt-page-main`, `nt-page-footer`
- `nt-command-bar`
- `nt-pane`, `nt-pane-header`, `nt-pane-body`, `nt-pane-footer`
- `nt-stack`, `nt-cluster`, `nt-toolbar`, `nt-grid`, `nt-split`
- `nt-scroll`, `nt-scroll-x`, `nt-table-wrap`, `nt-divider`
- `nt-section`, `nt-section-header`, `nt-section-heading`, `nt-section-count`

Typography and utilities:

- `nt-title`, `nt-subtitle`, `nt-section-title`, `nt-eyebrow`
- `nt-text`, `nt-muted`, `nt-meta`
- `nt-code`, `nt-pre`, `nt-pre--wrap`, `nt-sr-only`

Surfaces and controls:

- `nt-panel`, `nt-card`, `nt-metric`, `nt-result`, `nt-callout`,
  `nt-dialog`
- `nt-metric-label`, `nt-metric-value`, `nt-metric-detail`
- `nt-detail-grid`, `nt-detail`, `nt-detail-label`, `nt-detail-value`
- `nt-settings-list`, `nt-settings-row`, `nt-settings-icon`, `nt-settings-main`
- `nt-settings-title`, `nt-settings-description`, `nt-settings-meta`,
  `nt-settings-actions`
- `nt-disclosure`, `nt-disclosure-trigger`, `nt-disclosure-icon`,
  `nt-disclosure-copy`, `nt-disclosure-title`, `nt-disclosure-description`,
  `nt-disclosure-chevron`, `nt-disclosure-content`
- `nt-button`, `nt-icon-button`, `nt-button-group`
- `nt-segmented`, `nt-tabs`, `nt-tab-list`, `nt-tab`

Forms:

- `nt-form`, `nt-form-grid`, `nt-form-grid--two`
- `nt-field`, `nt-label`, `nt-help`, `nt-error`, `nt-required`
- `nt-fieldset`, `nt-input`, `nt-textarea`, `nt-select`
- `nt-checkbox`, `nt-radio`
- `nt-input-group`, `nt-input-prefix`, `nt-input-suffix`

Feedback and data:

- `nt-alert`, `nt-badge`, `nt-state`
- `nt-tag-list`, `nt-tag`
- `nt-state--empty`, `nt-state--loading`, `nt-state--error`,
  `nt-state--partial`, `nt-state--success`
- `nt-progress`, `nt-status-dot`
- `nt-table`, `nt-kv`, `nt-copy-field`, `nt-list`, `nt-json`

## Accessibility Matrix

| Class or pattern             | Element / role                         | Name source                         | State attributes                                           | Keyboard / focus                                                  | Kitchen Sink fixture        |
| ---------------------------- | -------------------------------------- | ----------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------- |
| `nt-button`                  | Native `button`                        | Visible text                        | `disabled`, `aria-busy` on related region                  | Enter and Space are native; `:focus-visible` ring                 | `design`, `form`, `calls`   |
| `nt-icon-button`             | Native `button`                        | `aria-label` or hidden text         | `disabled`                                                 | Stable square target, visible focus ring                          | `design`                    |
| `nt-metric`                  | `article`, `section`, or `div`         | Visible label/value text            | None                                                       | Non-interactive summary surface                                   | `hello`, `design`           |
| `nt-field` + `nt-input`      | `label` + native input                 | Visible label                       | `aria-invalid`, `aria-describedby`, `readonly`, `disabled` | Native text-field behavior                                        | `form`, `design`            |
| `nt-form-grid`               | Grid wrapper around fields             | Field labels inside children        | None                                                       | Native field behavior; layout preserves compact rows              | `form`, `calls`, `design`   |
| `nt-checkbox` / `nt-radio`   | Native input                           | Associated visible label            | `checked`, `disabled`                                      | Space toggles through native input                                | `form`, `design`            |
| `nt-segmented` / `nt-tab`    | Button group or ARIA tablist           | Visible button text and group label | `aria-selected` or `aria-pressed`                          | App code owns arrow-key behavior when using ARIA tabs             | `design`                    |
| `nt-copy-field`              | Readonly input + copy button           | Visible label and button text       | `readonly`, polite status text                             | Input remains focusable/selectable; button uses native activation | `data`                      |
| `nt-table`                   | Native table                           | Caption or surrounding heading      | `aria-sort` only when app code sorts                       | Native table navigation; sortable headers use buttons             | `data`, `design`            |
| `nt-alert`                   | Section or `div`                       | Visible title/text                  | `role="alert"` only for newly inserted urgent errors       | Not focusable by default                                          | `design`, runtime error     |
| `nt-result`                  | `output` or status region              | Surrounding heading or context      | `aria-live`, `aria-busy`                                   | Result text remains selectable                                    | `overview`, `form`, `calls` |
| `nt-dialog`                  | Native `dialog` or named grouped panel | `aria-labelledby`                   | `aria-modal` only for real modal behavior                  | App code owns Escape, trapping, and focus restore                 | `design`                    |
| `nt-progress`                | Native `progress`                      | Visible label or adjacent text      | `value`, `max`                                             | Native progress semantics                                         | `design`                    |
| `nt-disclosure`              | Section + native `button`              | Visible title and description       | `aria-expanded`, `aria-controls`                           | Enter and Space toggle; visible focus; app owns open state         | `design`                    |
| `nt-detail-grid`             | `dl` with grouped `dt` / `dd`          | Visible term and value              | None                                                       | Non-interactive summary; values remain selectable                  | `design`                    |
| `nt-settings-row`            | Row inside a named section             | Visible title and description       | Native state on any row actions                            | Row is not clickable by default; actions are separate controls     | `design`                    |
| `nt-status-dot` / `nt-badge` | Decorative span plus text              | Visible or hidden text              | Severity class only                                        | Not interactive unless wrapped in a control                       | `design`, `data`            |
| `nt-tag`                     | Non-interactive `span`                 | Visible text                        | Tone and selected classes only                             | Not interactive unless wrapped in a native control                | `form`, `design`            |

Tooltip text is never the accessible name. App-owned modal behavior is a
JavaScript contract inside the iframe; the CSS package only styles the surface.

## App Recipes

### Operational Settings Surface

For app-owned preferences, runtime data, inventories, and diagnostic screens,
use unframed sections on the page background. Keep headings small, put optional
counts beside them, and use hairline detail grids or setting rows instead of a
collection of floating cards:

```tsx
<section className="nt-section">
  <header className="nt-section-header">
    <h2 className="nt-section-heading">Installed services</h2>
    <span className="nt-section-count">2</span>
  </header>
  <div className="nt-settings-list">
    <div className="nt-settings-row">
      <span className="nt-settings-icon" aria-hidden="true">DB</span>
      <span className="nt-settings-main">
        <strong className="nt-settings-title">Local index</strong>
        <span className="nt-settings-description">Search and cached metadata</span>
      </span>
      <span className="nt-settings-meta">
        <span>v3</span>
        <span>resident</span>
      </span>
      <span className="nt-settings-actions">{/* icon buttons */}</span>
    </div>
  </div>
</section>
```

`nt-detail-grid` is the compact read-only companion for runtime values. Place
it inside `nt-section` or `nt-disclosure` so its container-responsive three,
two, and one-column layouts follow the tile width rather than the browser width.

### Disclosure Rows

Use disclosure rows for secondary or advanced content, not as the main page
navigation. The whole row is a native button. Keep its title and description
short, mark icons decorative, and connect the button to its content with
`aria-controls`. Keep that target mounted and use `hidden` when collapsed:

```tsx
const [open, setOpen] = useState(false);

<section className="nt-disclosure">
  <button
    aria-controls="runtime-details"
    aria-expanded={open}
    className="nt-disclosure-trigger"
    onClick={() => setOpen((value) => !value)}
    type="button"
  >
    <span className="nt-disclosure-icon" aria-hidden="true">{/* icon */}</span>
    <span className="nt-disclosure-copy">
      <strong className="nt-disclosure-title">Runtime</strong>
      <span className="nt-disclosure-description">Compiler and memory details</span>
    </span>
    <ChevronDown className="nt-disclosure-chevron" aria-hidden="true" />
  </button>
  <div className="nt-disclosure-content" hidden={!open} id="runtime-details">
    {/* detail grid, form, or compact rows */}
  </div>
</section>
```

These classes are for an app's own settings. App UI must not imitate Neutron's
trusted approval, installation, authorization, controller, or signature UI.

### App Tile Template

```tsx
import "./style.scss";

export function AppTile() {
  return (
    <main className="nt-app nt-app--fill my-app">
      <div className="nt-page">
        <header className="nt-page-header">
          <div>
            <p className="nt-eyebrow">My app</p>
            <h1 className="nt-title">Work queue</h1>
          </div>
        </header>
        <section className="nt-panel">
          <p className="nt-text">Tile content goes here.</p>
        </section>
      </div>
    </main>
  );
}
```

### Method Call Form

Use visible labels, local validation, request-preview wording, and
`neutron-tools/app` for kernel-mediated calls:

```tsx
import { createCanisterClient, loadNeutronCanisterId } from "neutron-tools/app";

const client = createCanisterClient(await loadNeutronCanisterId());
await client.callDialog("save_profile", [
  ["Ada", "ada@example.test", "Notes", true],
]);
```

App buttons should say `Review in kernel`, not `Approve`, `Accept`, `Sign`, or
`Authorize`.

### Dense Inspector

Use `nt-table-wrap` for tables, `nt-copy-field` for principals and hashes, and
`nt-json` or `nt-pre nt-pre--wrap` for schema and JSON inspection. Long values
must remain inside the tile through wrapping or an intentional scroll region.
Call `copyToClipboard()` from `neutron-tools/app` directly in the copy button's
click handler. App iframes must not call `navigator.clipboard`; the kernel owns
clipboard writes and their success toast.

### Empty, Loading, Error, Recovery

Use `nt-state nt-state--empty` for empty data, `nt-state--loading` with
`aria-busy="true"` on the updating region, `nt-alert nt-alert--danger` for
recoverable errors, and a visible retry button. Do not hide recovery controls
behind hover-only affordances.

### Destructive Confirmation

Use warning for reversible risk, danger for scoped destructive actions, and
critical for irreversible or security-sensitive actions. Critical app-side
flows should show consequence text and, in real workflows, require explicit
confirmation before opening a kernel-mediated request.

## Security Boundaries

The design system must not:

- load remote fonts, scripts, styles, images, workers, or modules;
- call the kernel, `postMessage`, IC agents, identity libraries, or icblast;
- style kernel install, authorization, dangerous-code, or signature dialogs;
- present app-side previews as trusted kernel approval UI.

Apps may use `neutron-tools/app` for approved calls, but the kernel derives
method schemas from the installed canister and owns the approval dialog.

## Kitchen Sink Reference

Kitchen Sink demonstrates the expected app-developer shape:

- one navigable workbench plus a compact companion tile from one app package;
- shared styles imported from `neutron-design-system/styles.scss`;
- app-local composition in `apps/kitchensink/src/style.scss`;
- responsive left navigation and independently scrolling demo content;
- forms and validation;
- JSON argument arrays sent through `neutron-tools/app`;
- kernel-mediated call wording such as `Review save in kernel`;
- kernel-derived method schemas displayed in a focused schema view;
- live endpoint discovery and same-app frontend tool calls;
- shared durable state presented by two independent tile frames;
- warning, danger, and critical states with visible explanatory text;
- compact settings sections, responsive detail grids, dense rows, and
  accessible disclosures;
- copy fields, nested JSON, dense text, and tables for iframe resize checks.

The app package test builds the frontend, writes `kitchensink.v0.3.3.neutron`,
verifies `web/main.css` is included, checks package paths against an allowlist,
and scans packaged text assets for remote or unsafe resource references.

## Testing

Run the design-system tests:

```sh
npm --workspace neutron-design-system test
```

Run the Kitchen Sink reference checks:

```sh
npm --workspace neutron-kitchensink test
```

Run the root fast suite:

```sh
npm test
```

Run the installed Kitchen Sink browser contract inside the Nix shell:

```sh
nix develop -c npm run test:e2e:kitchensink:fresh
```

The design-system tests assert:

- helper exports are compiled and importable;
- public SCSS entrypoints compile;
- no gradients, remote fonts, unsupported radius values, viewport-scaled type,
  or `!important` are introduced;
- public selectors stay scoped under `.nt-app`;
- helper source has no browser, kernel, identity, icblast, or canister-client
  coupling.
