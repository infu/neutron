# Spreadsheet

Neutron's agent-first spreadsheet app. A persistent resident owns one tagged,
sparse workbook; the tile and agent tools use the same revisioned command
engine. `.nsheet` is the only lossless writable workbook format. XLSX and CSV
open as bounded imports and export only as reviewed new snapshots, so they
never overwrite their source, become the native save destination, or
masquerade as lossless saves.

Workbook bytes move through Files v4 as transferable message-bus attachments.
Native saves use SHA-256 etag compare-and-swap, and nested agent file calls keep
their invocation provenance through a short-lived one-use kernel delegation.
The Files tile can hand `.nsheet`, `.xlsx`, and `.csv` directly to the resident.
Every Files success is bound to the requested path, canonical MIME type, byte
length, lowercase SHA-256 etag, and transferred bytes. Ambiguous write
responses are verified against exact Files bytes before a save is finalized;
an unverifiable result remains dirty as `SAVE_OUTCOME_UNKNOWN`.

The grid and tools share atomic revisioned commands for tagged values, formulas,
fill, copy/move, row and column structure, styles, explicit header-aware stable
sort, computed-value filters, sheets, and bounded undo/redo. Startup recovery
must be recovered or discarded before editing, and the tile uses sandbox-safe
in-app dialogs—including inline recovery failures—rather than browser modals.

The resident exposes `workbook_help`, `workbook_status`, `workbook_session`,
`workbook_read`, `workbook_find`, `workbook_apply`, and `workbook_save`.
`workbook_help` is a static, read-only reference that does not require or inspect
an open workbook. Call it with no arguments for an agent workflow overview, or
select `formulas`, `functions`, `function`, `errors`, `operations`, `files`, or
`concurrency`. The function catalog supports a name/text `query`, a category
filter, and exact case-insensitive function lookup; each result includes syntax,
argument bounds, a valid example, and implementation restrictions. JavaScript
formula functions remain deliberately disabled until the isolated-runtime gate
is met; there is no ambient `eval` fallback. `workbook_status.capabilities` lets
agents discover the supported operations, formula functions, formats, limits,
and concurrency requirements from live state instead of inferring them from the
human interface. The help catalog and live capability inventory share the same
formula and operation definitions, so documentation cannot silently drift from
the evaluator.
Session, apply/history, and save/export inputs use closed action-discriminated
schemas, and every successful tool result has a closed validated output schema.
Agents cannot submit fields that are missing or irrelevant for the selected
action. Range reads and searches are byte-bounded and cursor-paged. Every page
returns both `workbookId` and `revision`; callers must restart paging if either
changes. `workbook_read` is dense by default for agent compatibility; callers
that render sparse grids can set `includeBlanks: false` to omit absent blank
records while the cursor still advances across every scanned range position.
Search cursors additionally bind the query, sheet scope, and search
modes so agents cannot silently continue across changed state. Lookup signature limits are machine-readable:
the current v1 supports exact `MATCH`, forward exact `XLOOKUP`, and exact
`VLOOKUP`, and rejects unsupported modes instead of returning plausible wrong
answers.

## Human workflow

The tile supports New/Open, lossless `.nsheet` Save/Save As, reviewed CSV/XLSX
snapshot exports, find, cut/copy/paste, formula-aware fill, undo/redo,
formatting, sheet/row/column structure, sizing, stable sort, and computed-value
filters. Clipboard tables preserve quoted tabs, line breaks, and quotes; Ctrl/Cmd
+ Space and Shift + Space select whole columns and rows. File/Edit/Format/Data
menus use compact icon controls and remain usable in short and micro-width
Neutron tiles. A disabled gray Save icon means the native workbook is clean;
dirty/new work enables and accents the same control without a redundant visible
`Saved` label. Sort commands expose
a **Selection has header row** choice; the same `hasHeader` intent is mandatory
for agent sort operations. Paste Values preserves formula errors as errors, so
downstream `IFERROR` behavior remains correct. Count/Sum/Average metrics
are shown only when the complete selection is loaded; whole-row/column and
offscreen selections never present partial figures as complete. The active view and
uncommitted editor draft are checkpointed with a short debounce only as
best-effort browser-session `sessionStorage` state. Hardened tile storage may
be unavailable, and this is not a guarantee that a draft survives every tile
remount. A resident-owned view checkpoint remains planned.

The bottom status bar is deliberately small: Add Sheet, a horizontally
scrollable tablist, one Sheet Actions menu, selection/fill status, and a compact
workbook file indicator. Only tabs live inside the tablist; Rename and Delete
are grouped in the upward-opening actions menu. Arrow Left/Right and Home/End
move between sheet tabs.

Drag the right boundary of a column header or the bottom boundary of a row
header to resize it directly. The grid previews the real clamped size with a
pixel readout, Escape cancels without changing the workbook, and pointer release
creates exactly one undoable resize command. Resizing never selects the whole
row/column and is disabled while a cell draft is active. The Data menu's exact
pixel dialog remains available for keyboard use and resetting to defaults.

While editing a formula, clicking a cell inserts its reference without moving
the formula's origin or mutating the workbook. Dragging selects a reference
range, a repeated point replaces the active reference, typing an operator starts
the next reference, and F4 cycles relative/absolute forms. Enter, Tab, or the
accept icon commits the completed formula; Escape cancels it. A lone `=` stays
local and prompts for a reference instead of reaching the agent command schema.
The compact `?` beside the formula input opens searchable help for every
supported function, examples, exact lookup restrictions, and error meanings.
F1 opens the same nonmodal panel without discarding the current draft, puts
focus in search, and Escape closes it and returns focus to the editor. While a
formula is being typed, the bar shows the active function's signature and a
short contextual tip; this guidance is derived from the same catalog returned
by `workbook_help`.

New resident revisions trigger an authoritative refresh; already-loaded and
matching local-mutation invalidations are discarded so they cannot duplicate
the tile's own post-command read. The tile also uses a low-rate
workbook-identity-and-revision poll as recovery from a dropped notification or
a restarted resident. Revisions are compared only
within one workbook identity, so a fresh resident can surface its durable
recovery checkpoint even when its revision is lower. If an agent or another caller changes the same cell during a
human edit, the tile preserves both versions and asks whether to reapply the
draft or use the latest workbook value.

The first human binary read or write asks for Neutron App Tool access to Files.
Approve once or for the session; the spreadsheet deliberately waits rather than
bypassing that security boundary. Scoped agent calls retain their invocation
provenance through the attachment delegation bridge.

Choose **Kitchen Sink** to load the deterministic, editable six-sheet static
gallery of shipped workbook-state features. It contains sales and inventory
data, a live dashboard, supported formula and error examples, styles,
number/date formats, custom dimensions, and an active filter. Loading it is
explicit, replaces the current session only after confirmation, and never
writes to Files until `.nsheet` Save As is chosen. The static workbook cannot
by itself demonstrate actions such as undo, fill, sort, conflicts, recovery,
or file round trips; the separate 20-flow installed-browser tour exercises
those action and lifecycle paths.

The formula gallery is also an executable inventory: the installed-browser
tour verifies the raw formula and displayed result for every published v1
function plus the explicit error example. Function argument counts are checked
both on import and during live evaluation; aggregate coercion distinguishes
direct literals from values reached through cell/range references. `COUNTIF`
and `SUMIF` criteria support `*`, `?`, and Excel-style `~` escaping.

XLSX import recognizes Excel's `_xlfn.` compatibility prefix when the
underlying function is already supported, while still rejecting unknown future
functions. Dropped worksheet layout and table features—including frozen panes,
widths/heights, hidden dimensions, and tables—are reported explicitly in import
provenance instead of disappearing silently.

Native workbooks may contain at most 20,000 sparse custom row-height and
column-width overrides. This explicit limit keeps the complete status contract
well below Neutron's message-bus payload ceiling and is published through
`workbook_status.capabilities.limits`.

## Verification

Unit, codec, session, packaging, and schema checks:

```sh
npm --workspace neutron-spreadsheet test
```

The installed-browser suite contains exactly 20 action and lifecycle flows. It
resolves the primary Neutron canister and gateway from the selected format-3
config's single schema-3 local provision session. Its normal entry point first
hashes the packaged `main.js`/`service.js` and refuses to run if the installed
bytes are stale:

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chrome \
NEUTRON_NDEPLOY_CONFIG=SPREADSHEET-E2E.ndeploy.json \
  npm --workspace neutron-spreadsheet run test:e2e
```

Package Spreadsheet separately, put its exact pin in the separately named
archive-only `SPREADSHEET-E2E.ndeploy.json`, and use that config's `serve` and
`reinstall` commands before the browser gate. The current convenience command:

```sh
npm --workspace neutron-spreadsheet run test:e2e:fresh
```

still invokes the rejected legacy `local:deploy` alias and is intentionally
unavailable until its owner routes it through an explicit format-3 config.

Some test setup calls the Spreadsheet background directly. In particular,
flow 20 proves preservation and review of a human draft during an external
concurrent tool mutation; it is not yet evidence of a kernel-routed Agent Mode
caller or invocation-provenance path.

See [TEST_FLOWS.md](./TEST_FLOWS.md) for the release matrix.
