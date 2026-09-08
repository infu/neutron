# Neutron Design System

Scoped dark UI styles for Neutron app frontends.

```scss
@use "neutron-design-system/styles.scss";

.nt-app.my-app {
  --nt-accent: #89e0aa;
}
```

```html
<main class="nt-app nt-app--fill my-app">
  <section class="nt-panel">
    <h1 class="nt-title">My app</h1>
    <button class="nt-button">Review in kernel</button>
  </section>
</main>
```

Rules:

- Styles are scoped under `.nt-app`.
- Dark mode only.
- Near-black neutral surfaces, restrained green action color, and cyan focus.
- Spacing follows the public 4/8/12/16/20/24/32px token rhythm.
- Routine surfaces, controls, inputs, rows, and state blocks separate by tonal
  fill, not visible borders.
- Structural separation uses stable one-pixel inset hairlines instead of
  perimeter component borders.
- Operational screens use compact `nt-section` headings, `nt-detail-grid`
  summaries, `nt-settings-list` rows, and `nt-disclosure` for secondary detail.
- Keep these surfaces unframed on the page background; do not turn every
  section into a card or panel.
- No gradients or remote fonts.
- Public radius tokens are capped at `5px`.
- Focus indication remains a single visible hairline outline.
- Apps should compose with app-prefixed classes instead of rewriting `nt-*`
  component classes.

The Kitchen Sink app is the living reference for forms, typed calls, data
display, alerts, and narrow tile behavior.

## Build Setup

Apps importing SCSS need Sass in their frontend build:

```ts
import { sassPlugin } from "esbuild-sass-plugin";

plugins: [sassPlugin()];
```

`public/index.html` should link the generated CSS as a package-local asset:

```html
<link rel="stylesheet" href="./main.css" />
```

## Accessibility Matrix

| Class or pattern | Element / role | Name source | State attributes | Keyboard / focus |
| --- | --- | --- | --- | --- |
| `nt-button` | Native `button` | Visible text | `disabled`, `aria-busy` on related region | Native Enter/Space, visible focus |
| `nt-icon-button` | Native `button` | `aria-label` or hidden text | `disabled` | Stable square target |
| `nt-app-header` | Native `header` with a heading | Visible app title; named native action controls | Native state on controls | Actions retain visible focus and wrap within the tile |
| `nt-field` + `nt-input` | Label + native input | Visible label | `aria-invalid`, `aria-describedby`, `readonly` | Native field behavior |
| `nt-form-grid` | Grid wrapper | Native field labels | None | Keeps compact field rows responsive |
| `nt-checkbox` / `nt-radio` | Native input | Associated label | `checked`, `disabled` | Space toggles |
| `nt-copy-field` | Readonly input + button | Label and button text | `readonly`, polite status | Input selectable, button native |
| `nt-disclosure` | Section + native button | Visible title and description | `aria-expanded`, `aria-controls` | Native toggle button with visible focus |
| `nt-settings-row` | Row inside a named section | Visible title and description | Native state on row actions | Row actions remain separate controls |
| `nt-table` | Native table | Caption or nearby heading | `aria-sort` only when sorting | Native table semantics |
| `nt-alert` | Section or `div` | Visible title/text | `role="alert"` only for urgent inserted errors | Not focusable by default |
| `nt-state--loading` + `nt-spinner` | Status `div` + decorative `span` | `aria-label` on status | `role="status"`; `aria-busy` on updated region | Not focusable; reduced motion stops rotation |
| `nt-tag` | Non-interactive span | Visible text | Tone/selected classes | Decorative metadata unless wrapped in a control |
| `nt-dialog` | Native `dialog` or named grouped panel | `aria-labelledby` | App-owned modal attributes | App code owns Escape/focus restore |

Tooltip text is not an accessible name. App UI must not imitate the kernel's
trusted approval, install, authorization, or signature dialogs.

## Recipes

- App root: `nt-app nt-app--fill` plus an app-prefixed class.
- App heading: use `nt-app-header` for a consistent icon, title, optional
  subtitle, and app-specific actions; see the compact header recipe below.
- Method call forms: use `nt-form-grid nt-form-grid--two` for compact field
  pairs, validate locally, show a request preview, then use
  `neutron-tools/app` and wording such as `Review in kernel`.
- Compact status panels: use `nt-metric`, `nt-metric-label`,
  `nt-metric-value`, and `nt-metric-detail` for non-interactive summaries.
- Operational settings: use `nt-section` with `nt-detail-grid` or
  `nt-settings-list`; use `nt-disclosure` for secondary app-owned content and
  wire its native button with `aria-expanded` and `aria-controls`.
- Dense inspectors: use `nt-table-wrap`, `nt-copy-field`, `nt-json`, and
  `nt-pre nt-pre--wrap`.
- Tags: use `nt-tag-list` and `nt-tag` for compact metadata; use buttons or
  checkboxes when the tag is interactive.
- Empty/error: use `nt-state` variants and `nt-alert` with visible recovery
  controls.
- Loading: use a compact `nt-state nt-state--loading` status containing only a
  centered `nt-spinner`; name the status with `aria-label` and mark the updated
  region `aria-busy="true"`. For a pending button or row, use only `nt-spinner`
  in that existing surface—never add a loading card.
- Destructive flows: use warning, danger, or critical severity with explicit
  consequence text; kernel approval remains kernel-owned.

### Compact App Header

```html
<header class="nt-app-header">
  <div class="nt-app-header-main">
    <img class="nt-app-header-icon" src="./icon.svg" alt="" />
    <div class="nt-app-header-copy">
      <h1 class="nt-app-header-title">My app</h1>
      <p class="nt-app-header-subtitle">Short description</p>
    </div>
  </div>
  <div class="nt-app-header-actions">
    <select class="nt-select nt-app-header-control" aria-label="Network">
      <option>Ethereum</option>
      <option>Arbitrum</option>
    </select>
    <button
      type="button"
      class="nt-icon-button nt-app-header-icon-button"
      aria-label="Refresh"
    >
      <svg aria-hidden="true" viewBox="0 0 24 24"><!-- Refresh icon --></svg>
    </button>
  </div>
</header>
```

Place the header inside `.nt-app`. Its default row is at least 48px tall:
32px content with 8px vertical padding. The icon slot is 32px; an image fills
the slot, while an inline SVG inside a decorative `nt-app-header-icon` span
is 20px. Titles use 16px medium text with a 20px line height. Subtitles use
11px muted text beside the title and disappear when the header's own width
is below 480px, including when a tile becomes narrow in a wide workspace.
Keep the subtitle supplementary; required account or trading state belongs
in visible content or controls.

Use `nt-app-header-control` with an existing `nt-button`, `nt-select`, or
`nt-input` class. Use `nt-app-header-icon-button` with `nt-icon-button` for
square actions. Controls are 32px tall by default and retain the shared
larger targets for coarse pointers. Actions wrap when they need another row;
the header has no fixed height or clipping. Keep action groups short.

An icon-and-text action may put its optional caption in
`nt-app-header-action-label` to hide that caption below 480px. Give the button
a persistent accessible name such as `aria-label="Refresh"` before hiding
visible text. Decorative icons need `alt=""` or `aria-hidden="true"`.
Keep native control semantics and choose the heading level appropriate to
the app's document.

Remove obsolete app-local header layout rules when adopting this recipe.
Exclude the shared title, subtitle, and control classes from broad app-local
`h1`, `p`, `button`, `select`, or `input` overrides so their sizes remain
consistent. Compose app-prefixed classes for behavior such as sticky
positioning rather than restyling the shared typography and spacing.
