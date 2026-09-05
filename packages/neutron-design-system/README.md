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
