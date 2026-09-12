# Neutron Design System

[Back to the documentation index](./index.md)

The Neutron design system is a shared app-developer package for building
consistent dark-mode app frontends inside kernel-managed iframe tiles. It is a
developer convenience, not a security boundary. The kernel still owns trusted
install, signature, authorization, and generic canister-call approval UI. An
exact provider app may own a domain-specific decision in its authenticated
foreground tile; that modal remains provider UI, not Kernel UI.

## Source map

| Concern | Authoritative source |
| --- | --- |
| Public imports and commands | `packages/neutron-design-system/package.json` |
| Cascade, tokens and helpers | `packages/neutron-design-system/src/styles.scss`, `src/_tokens.scss`, `src/classes.ts` |
| Layout and component selectors | `packages/neutron-design-system/src/_layout.scss`, `src/components/` |
| Enforced visual and accessibility-related CSS contracts | `packages/neutron-design-system/test/policy.test.ts` |
| Rendered examples and app packaging | `apps/kitchensink/src/`, `apps/kitchensink/build.ts`, `apps/kitchensink/test/` |
| Trusted call routing and provider callbacks | `packages/neutron-tools/src/app.ts`, `packages/neutron-tools/src/protocol.ts`, `apps/kernel/src/expose.ts` |

Read those files for the complete class/token inventory, exact values and
available scripts. This document records integration and interaction contracts
that are not supplied by CSS alone.

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

The root TypeScript import supplies class-name helpers; styles enter through
the exported SCSS paths. The package has no runtime dependencies on React, `neutron-tools`, icblast,
DFINITY packages, identity libraries, or kernel source.

## Visual Policy

- Dark mode only.
- The visual character is compact, technical, and quiet: near-black neutral
  surfaces, cool data text, a restrained green action accent, and cyan focus.
- Layout depth is tonal: the app background is the darkest layer, panels are a
  little lighter, and cards, controls, rows, and state blocks are lighter again.
- Operational pages should follow the Settings pattern: let the page background
  carry the layout, keep headings compact, group dense rows and metrics with
  inset hairlines, and reserve panels for framed tools. Do not wrap
  every section in a card.
- Use the public gap and padding tokens so edges and baselines stay aligned.
  Read their scale from the token source rather than copying numeric values.
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
- Use the radius tokens and preserve the small-radius policy enforced by tests.
- Letter spacing stays `0`.
- Type does not scale with viewport units.
- Components keep stable dimensions across hover, focus, loading, and disabled
  states.
- Warning, danger, success, invalid, and disabled states pair tonal fills with
  visible labels, messages, or state text. Loading uses the compact shared
  spinner with an accessible status name instead of a highlighted state card.

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

## Component selection

Choose exported classes and semantic tokens from the source map. Override
semantic variables on the app-prefixed `.nt-app` root instead of copying shared
component rules. Use the layout primitives for tile composition and the
component selectors for individual controls; neither provides application state
or JavaScript behavior.

## Accessibility Matrix

| Class or pattern             | Element / role                         | Name source                         | State attributes                                           | Keyboard / focus                                                  |
| ---------------------------- | -------------------------------------- | ----------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------- |
| `nt-button`                  | Native `button`                        | Visible text                        | `disabled`, `aria-busy` on related region                  | Enter and Space are native; `:focus-visible` ring                 |
| `nt-icon-button`             | Native `button`                        | `aria-label` or hidden text         | `disabled`                                                 | Stable square target, visible focus ring                          |
| `nt-metric`                  | `article`, `section`, or `div`         | Visible label/value text            | None                                                       | Non-interactive summary surface                                   |
| `nt-field` + `nt-input`      | `label` + native input                 | Visible label                       | `aria-invalid`, `aria-describedby`, `readonly`, `disabled` | Native text-field behavior                                        |
| `nt-form-grid`               | Grid wrapper around fields             | Field labels inside children        | None                                                       | Native field behavior; layout preserves compact rows              |
| `nt-checkbox` / `nt-radio`   | Native input                           | Associated visible label            | `checked`, `disabled`                                      | Space toggles through native input                                |
| `nt-segmented` / `nt-tab`    | Button group or ARIA tablist           | Visible button text and group label | `aria-selected` or `aria-pressed`                          | App code owns arrow-key behavior when using ARIA tabs             |
| `nt-copy-field`              | Readonly input + copy button           | Visible label and button text       | `readonly`, polite status text                             | Input remains focusable/selectable; button uses native activation |
| `nt-table`                   | Native table                           | Caption or surrounding heading      | `aria-sort` only when app code sorts                       | Native table navigation; sortable headers use buttons             |
| `nt-alert`                   | Section or `div`                       | Visible title/text                  | `role="alert"` only for newly inserted urgent errors       | Not focusable by default                                          |
| `nt-state--loading` + `nt-spinner` | Status `div` + decorative `span` | `aria-label` on the status region | `role="status"`; `aria-busy` on the region being updated | Not focusable; animation stops with reduced motion |
| `nt-result`                  | `output` or status region              | Surrounding heading or context      | `aria-live`, `aria-busy`                                   | Result text remains selectable                                    |
| `nt-dialog`                  | Native `dialog` or named grouped panel | `aria-labelledby`                   | `aria-modal` only for real modal behavior                  | App code owns Escape, trapping, and focus restore                 |
| `nt-progress`                | Native `progress`                      | Visible label or adjacent text      | `value`, `max`                                             | Native progress semantics                                         |
| `nt-disclosure`              | Section + native `button`              | Visible title and description       | `aria-expanded`, `aria-controls`                           | Enter and Space toggle; visible focus; app owns open state         |
| `nt-detail-grid`             | `dl` with grouped `dt` / `dd`          | Visible term and value              | None                                                       | Non-interactive summary; values remain selectable                  |
| `nt-settings-row`            | Row inside a named section             | Visible title and description       | Native state on any row actions                            | Row is not clickable by default; actions are separate controls     |
| `nt-status-dot` / `nt-badge` | Decorative span plus text              | Visible or hidden text              | Severity class only                                        | Not interactive unless wrapped in a control                       |
| `nt-tag`                     | Non-interactive `span`                 | Visible text                        | Tone and selected classes only                             | Not interactive unless wrapped in a native control                |

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

For a generic Kernel-mediated backend call, app buttons should say
`Review in kernel`, not `Approve`, `Accept`, `Sign`, or `Authorize`.

An app may still use a concrete domain verb such as **Send**, **Approve
allowance**, or **Revoke** for an operation which its own trusted UI fully
reviews and then performs through an exact preapproved self call. It must not
imitate Kernel chrome or imply that another app or Kernel verified its domain
facts. On the provider-UI lane, a cross-app `provider_once` resident
first calls
`context.presentUserInterface()` without preparing an effect. Kernel then
opens or focuses the exact provider tile and routes a bounded opaque request to
its private `same_app` + `foreground_tile` tool. The provider may use
`nt-dialog` and its own components to show normalized domain facts with one
accept/reject decision expressed through concrete action and cancel labels.
Kernel owns the routing, tile open/focus, and audience attestation, not the
modal's focus management, token formatting, or decision.
The provider must implement Escape handling, focus trapping and restoration,
cancellation, loading/error states, and prevention of duplicate acceptance.

### Dense Inspector

Use `nt-table-wrap` for tables, `nt-copy-field` for principals and hashes, and
`nt-json` or `nt-pre nt-pre--wrap` for schema and JSON inspection. Long values
must remain inside the tile through wrapping or an intentional scroll region.
Call `copyToClipboard()` from `neutron-tools/app` directly in the copy button's
click handler. App iframes must not call `navigator.clipboard`; the kernel owns
clipboard writes and their success toast.

### Empty, Loading, Error, Recovery

Use `nt-state nt-state--empty` for empty data. Loading is not a skeleton or a
message card: use one compact, borderless `nt-state nt-state--loading` status
with a centered `nt-spinner`, an accessible name, and `aria-busy="true"` on the
region being updated:

```html
<div class="nt-state nt-state--loading" role="status" aria-label="Loading items">
  <span class="nt-spinner" aria-hidden="true"></span>
</div>
```

For a pending button or row action, put only `nt-spinner` inside that existing
control or row; do not add a state box. Use `nt-alert nt-alert--danger` for
recoverable errors and keep a visible retry button. Do not hide recovery
controls behind hover-only affordances.

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

On the provider-owned UI path, Kernel does not render the modal. It
authenticates and focuses the exact provider tile, while the owner chooses to
trust that installed provider's UI and domain checks. The design system does
not define provider policy or token fields and does not make the modal a Kernel
security surface.

Apps may use `neutron-tools/app` for approved calls. On the generic
`callDialog()` path, Kernel derives method schemas from the installed canister
and owns that approval dialog; the provider-owned path above is deliberately
separate.

## Kitchen Sink reference

Use Kitchen Sink for working examples of shared styles, app-local composition,
multiple tiles, resident tools and tray integration. Read its source and browser
fixtures for current examples rather than copying a snapshot of its navigation
or demo inventory. Its package test verifies bundled styles and assets and
checks resource references; it does not make app UI a trusted Kernel surface.

## Testing

Run the design-system tests:

```sh
npm --workspace neutron-design-system test
```

When changing shared selectors or recipes, inspect the affected Kitchen Sink
fixtures and scripts in `apps/kitchensink/package.json`. Its full app test command
runs packaging as well as checks; do not rebuild production archives merely to
validate prose. For a documentation-only change, the design-system suite checks
its documentation contract and compiles the public styles without packaging an
app.

The policy tests cover SCSS scoping, responsive layouts, stable interaction
styles, contrast pairs, dependency isolation and recipe/accessibility guidance.
CSS checks cannot establish keyboard behavior, focus restoration, duplicate
submission prevention or correct consent routing; test those in the owning app
when changing behavior.
