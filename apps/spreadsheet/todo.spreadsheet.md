# Spreadsheet App-Scoped Implementation And Audit Record

Updated: 2026-07-14

This is the implementation-facing record for work constrained to
`apps/spreadsheet/`. The repository-root `todo.spreadsheet.md` remains the
broader research and architecture plan. It was intentionally left untouched by
this app-folder-only pass.

## Verified 2026-07-14 Shared Formula Help Release

- One typed help catalog now describes the complete set of 20 shipped formula
  functions. Human tips, searchable function cards, agent help, examples, and
  argument bounds consume that catalog; names and arities are checked against
  the live evaluator inventory so help cannot silently drift from execution.
  Every documented example passes the real formula parser.
- The evaluator and capability contract now agree that exact `VLOOKUP` requires
  four arguments and an explicit `FALSE`. Help also states the supported exact
  `MATCH` and forward exact `XLOOKUP` modes, wildcard behavior, date formatting,
  unsupported JavaScript/custom functions, formula limits, and all seven error
  codes.
- The formula bar has a compact `?` control and F1 shortcut. Its nonmodal panel
  preserves the active draft and workbook revision, focuses searchable help,
  returns focus on Escape, and fits desktop, short, compact, and 240-pixel tile
  layouts. The search field is placed before the scrollable tips so the primary
  action remains initially visible at 320×480. Formula drafts show contextual
  pointing guidance or the active function signature through `aria-describedby`.
- Agents now have a static, read-only `workbook_help` tool. Empty arguments
  return a safe workflow overview; structured topics cover formulas, the full
  function catalog, exact function lookup, errors, operations, Files formats,
  and concurrency. Function queries and category filters are closed-schema,
  case-insensitive, deterministic, and do not open, inspect, or mutate a
  workbook. The overview includes tagged `set_cells` formula input and the
  revision/command-id workflow.
- Installed Flow 02 proves F1, search, draft/origin/focus preservation, no
  revision, contextual bare-`=` and `SUM(...)` tips, and the existing formula
  pointing workflow. Flow 19 calls the live `workbook_help` tool, verifies its
  full catalog and exact VLOOKUP restriction, and proves the workbook revision
  is unchanged. Flow 01 checks help/search geometry at all release viewports.
  Flow 17 now synchronizes the asynchronous Files handoff on authoritative
  `nativeSource.path` instead of racing an intentionally transient spinner.
- Packaged app validation and unit/contract suite: **134 passed, 0 failed**
  (**834 assertions**); app and scripts TypeScript projects are clean.
- Release archive: **185,178 bytes**, SHA-256
  `e9c9471dc4900d3d7450770781736437794c12dfdf86163a5c72c68f84e3484d`.
- The scoped atomic installer deployed the release to canister
  `efadq-gl777-77774-aaaba-cai`. Installed-asset attestation matched `main.js`
  (**356,665 bytes**, SHA-256
  `1a4afbc2749536d0aa51f2345e999b88a39564071de8e7e9663855bd4eb56857`)
  and `service.js` (**234,250 bytes**, SHA-256
  `49831f1839aa9d792ac80aea1016feca0684be309b418aa0f235f4426b7981bc`)
  byte-for-byte to the archive.
- The installed release suite passed **exactly 20 of 20** user flows in one
  **2.0-minute**, single-worker run with **zero retries** and no Spreadsheet
  console errors, page errors, failed requests, or HTTP errors.

## Verified 2026-07-14 Interaction-Performance Release

- Installed profiling isolated the edit/click-away freeze to the resident's
  post-command viewport read, not the write: a single `workbook_apply` took
  about 6ms while the dense `A1:T50` read took roughly 0.56–0.96 seconds and
  produced a 0.5-second background-frame long task. The reader copied and
  serialized its cumulative result for every returned cell, making the
  1,000-cell refresh quadratic.
- `workbook_read` now performs exact incremental response-byte accounting.
  Dense reads remain the default agent contract, while the public
  `includeBlanks: false` mode omits absent blank records, retains populated and
  style-only blank cells, preserves filtered-row metadata, and advances bounded
  cursors across every scanned position. The human tile uses this sparse mode.
- Local dense `A1:T50` reads improved from about 303ms to 17ms (roughly 18×),
  and a sparse blank viewport reads in about 5ms with no 1,000-record transport
  or output-schema validation cost. The installed changed-edit → clicked-cell
  path now satisfies a real-browser 500ms focus deadline that caught the former
  0.9–1.0 second stall.
- State invalidations are revision-filtered and matching local notifications no
  longer race the command's authoritative refresh. Selection metrics are
  memoized, draft/view `sessionStorage` writes are debounced, and mouse range
  focus updates are coalesced to one animation frame.
- Large-workbook commands retain the engine's immutable current/candidate
  snapshots directly for undo history instead of cloning both again. History
  byte sizing serializes the snapshots once, and IndexedDB recovery relies on
  its required structured-clone step rather than cloning once before `put`.
  Undo bounds, checkpoint durability, revision semantics, and recovery behavior
  remain unchanged.
- Packaged app validation and unit/contract suite: **131 passed, 0 failed**
  (**715 assertions**); app and scripts TypeScript projects are clean. Tests
  cover sparse pagination, style-only blank records, dense compatibility, exact
  byte bounds, and closed `includeBlanks` input validation.
- Release archive: **173,562 bytes**, SHA-256
  `712573c3c7feed6742ee5b44bc053fefcb8bc9b8f1250eb83c2731a20a3a368c`.
- The scoped atomic installer deployed the release to canister
  `efadq-gl777-77774-aaaba-cai`. Installed-asset attestation matched `main.js`
  (**337,626 bytes**, SHA-256
  `b017c29d583f916e7462e0d2e5857c5d367016f57b7d879aefc2c8f867477ae0`)
  and `service.js` (**220,065 bytes**, SHA-256
  `83b9de704707068501d8cd8f2d52ef055a81d12d2574c7b24a7e59f28d371c5e`)
  byte-for-byte to that archive.
- The installed release suite passed **exactly 20 of 20** user flows in one
  **2.0-minute**, single-worker run with **zero retries**, down from 3.6 minutes
  for the preceding installed release.

## Verified 2026-07-14 Minimal Footer And Direct-Resize Release

- The bottom bar is now a compact 34-pixel workbook footer instead of a mixed,
  horizontally scrolling tablist. Fixed icon controls add a sheet and open an
  upward Rename/Delete menu; only actual sheet tabs live in the scrollable
  tablist; selection/fill status and a compact workbook-file indicator remain
  outside it. The visible label is the filename while the complete VFS path is
  preserved in its title and accessible name.
- Sheet tabs use a roving focus model and support Left/Right plus Home/End.
  The active tab remains reachable in compact tiles, and the 240-pixel layout
  keeps Add, the active sheet, sheet actions, and file identity visible without
  document overflow.
- Every visible column and row header now has a direct mouse resize boundary.
  Dragging starts from the rendered size, previews geometry and a pixel readout
  live, captures the pointer, clamps columns to 24–600 pixels and rows to
  18–300 pixels, and issues exactly one workbook operation on release. Escape,
  pointer cancellation, or lost capture restores the original size without a
  revision. Resizing does not select the header and is unavailable while a cell
  or formula draft is active; the exact-size Data dialogs remain available.
- Installed Flow 01 verifies footer height, tabs-only semantics, icons, compact
  geometry, the upward actions menu, and keyboard focus. Flow 02 verifies the
  formula-draft resize lockout. Flow 11 verifies arrow navigation and sheet
  actions. Flow 12 uses real mouse drags to verify live sizing, bounds, revision
  timing, cancellation, selection preservation, and persisted row/column
  metadata. Flow 17 verifies compact filename presentation plus the full VFS
  path metadata through native save and Files reopen.
- Packaged app validation and unit/contract suite: **130 passed, 0 failed**
  (**707 assertions**); app and scripts TypeScript projects are clean.
- Release archive: **172,993 bytes**, SHA-256
  `9407fa6e026910249116edbc7f622dce365f7c085078faddfeea3e698fb8dbf1`.
- The scoped atomic app installer deployed the release to canister
  `efadq-gl777-77774-aaaba-cai`. Installed-asset attestation matched `main.js`
  (**336,362 bytes**, SHA-256
  `647d8e4f7a6078422b4e33429339cd821ad7ef1977d20366a2865f1fac75a7e6`)
  and `service.js` (**219,611 bytes**, SHA-256
  `6b7c80acaa390c652d64c149b5aa4155e074e8cd6011275b375eb207ad2bb94d`)
  byte-for-byte to that archive.
- The installed release suite passed **exactly 20 of 20** user flows in one
  **3.6-minute**, single-worker run with **zero retries**.

## Verified 2026-07-14 Formula-Pointing And Command-Bar Release

- Formula editing now has a local reference-point mode. Starting with `=`, then
  clicking a cell or dragging a range edits the draft while keeping the origin
  cell active and the editor focused. Repointing replaces the active token,
  operators begin another token, F4 cycles absolute forms, and only Enter/Tab or
  the accept icon creates a workbook revision.
- A lone `=` is rejected locally with useful guidance, so it can no longer leak
  through `workbook_apply` and surface the transport validator's opaque
  `oneOf`/subschema error. Escape cancels pointed formulas without a mutation.
- The command bar now has compact File/Edit/Format/Data disclosures, Io5 icons,
  icon-only common actions, consistent 30-pixel hit targets, grouped menu
  commands, hidden shortcut text for assistive technology, and responsive
  icon-only summaries in narrow tiles.
- The persistent visible `Saved`/`Unsaved changes` label is removed. Save is
  gray and disabled when clean, enabled/accented when new or dirty, exposes a
  deterministic `data-state`, and retains a concise accessible name and title.
- The formula bar has explicit cancel/accept controls, a formula-start affordance,
  compact icon paging, an accented formula-edit state, and a visible reference
  highlight in the grid. Filter detail remains available through its full
  accessible label while the command bar shows only a compact badge.
- Installed flow 02 now proves click pointing, replacement, F4, operator
  chaining, range dragging, cancellation, stable origin/focus, no revision while
  pointing, exactly one revision on commit, and no schema-error banner. Flow 01
  verifies icon semantics, titles, hit targets, responsive menu rectangles, and
  the absence of a duplicate save-status label. Existing VFS, formatting,
  filter, export, and Kitchen Sink paths were updated to exercise the refined
  menu contract.
- Packaged app validation and unit/contract suite: **130 passed, 0 failed**
  (**707 assertions**); app and scripts TypeScript projects are clean.
- Release archive: **170,530 bytes**, SHA-256
  `fcb6f5b53d2ffc9d3c7f590c2ad7f7edd35ebc904cbe45425371480d45213fb5`.
- The root `npm run local:bootstrap` installed the complete app set, followed by
  the scoped atomic app installer for the final accessibility copy change.
  Installed-asset attestation on canister `efadq-gl777-77774-aaaba-cai` matched
  `main.js` (**329,240 bytes**, SHA-256
  `d7f743d23cf084a74efdd1c8ecda5408a614529262d127bc9838780bb14ceb94`)
  and `service.js` (**219,611 bytes**, SHA-256
  `6b7c80acaa390c652d64c149b5aa4155e074e8cd6011275b375eb207ad2bb94d`)
  byte-for-byte to that archive.
- The installed release suite passed **exactly 20 of 20** user flows in one
  **3.3-minute**, single-worker run with zero retries.

## Verified 2026-07-14 Fourth-Wave Release

- Independent Neutron-docs, spreadsheet-pro/correctness, installed-Playwright,
  and senior-development audits were completed and consolidated before the
  release gate.
- Ordinary Files reads/writes and Files-tile handoffs are now bound to the exact
  path, extension/media type, declared length, lowercase SHA-256 etag, and
  transferred bytes. Contradictions fail atomically without replacing the live
  workbook.
- Cancellation now reaches queued mutations, open/recovery, save/export, and
  attachment delegation. Work stops before not-yet-issued I/O, while a write
  that has already started still completes reconciliation and save finalization.
- Paged `workbook_read` and `workbook_find` results carry `workbookId` as well as
  revision; the tile refuses to combine pages from different workbook snapshots.
- Paste Values preserves formula errors as error literals, offscreen whole-axis
  selections report that metrics are unavailable instead of inventing partial
  totals, and the workbook path remains visible in compact and micro tiles.
- `COUNTIF`/`SUMIF` support `*`, `?`, and `~` escaping. `SUMIF` now aligns its
  sum range from the supplied top-left cell across the criteria dimensions and
  propagates only matched aligned errors.
- XLSX import normalizes `_xlfn.` only for supported functions, rejects unknown
  compatibility functions, leaves quoted text untouched, and reports dropped
  worksheet layout/table metadata. The deterministic six-sheet Kitchen Sink
  pins representative state plus every published formula function through XLSX
  round trip.
- Packaged app validation and unit/contract suite: **130 passed, 0 failed**
  (**706 assertions**); app and scripts TypeScript projects are clean.
- Release archive: **165,700 bytes**, SHA-256
  `1f4fab0f79f9445646a5b72c7d74a0f3c3403b97df4d5501fd43ea2dc51bab61`.
- The root `npm run local:bootstrap` rebuilt and installed Spreadsheet into
  canister `efadq-gl777-77774-aaaba-cai`. Installed-asset attestation matched
  `main.js` (**312,503 bytes**, SHA-256
  `5415ad01023377903b17feb4c63e7fd64427016e97b987b58f53680bdc19498b`)
  and `service.js` (**219,611 bytes**, SHA-256
  `6b7c80acaa390c652d64c149b5aa4155e074e8cd6011275b375eb207ad2bb94d`)
  byte-for-byte to that archive.
- The installed release suite passed **exactly 20 of 20** user flows in one
  **3.2-minute**, single-worker run with **zero retries**. Flow 17 asserts that
  the final Files retry produced no alert before accepting the workbook.

## Verified 2026-07-14 Third-Wave Hardening

- Fresh independent Neutron-integration, spreadsheet-correctness, and installed-
  Playwright audits were consolidated, then a senior developer reviewed the
  integrated spine.
- Resident convergence is keyed by workbook identity plus revision. A restarted
  background can have a lower revision without wedging an already-open tile;
  installed flow 20 now restarts that real background and recovers the durable
  checkpoint.
- Files flow 17 now drives the real Files tree and **Open in Spreadsheet**
  command. It proves denial is non-destructive before approving the attachment
  handoff and reopening the latest `.nsheet` bytes.
- `workbook_session`, `workbook_apply`, and `workbook_save` publish closed,
  action-discriminated input variants. Missing and irrelevant fields are
  rejected by the actual transport validator.
- Formula aggregates now distinguish direct literals from referenced values,
  blanks compare contextually, and all 20 supported functions enforce a single
  runtime/import arity table.
- One-dimensional fill rejects accidental cross-axis transposition. Stable sort
  keeps blank keys last in both directions and requires explicit `hasHeader`
  intent from agents; the human Data menu exposes the same choice.
- Kitchen Sink flow 19 asserts its fixed workbook identity, representative state
  from all six sheets, and every published formula function/raw formula/display
  result rather than sampling only a few gallery rows.
- Packaged app validation and unit suite: **110 passed, 0 failed** (587
  assertions); app and scripts TypeScript checks are clean.
- Fresh package: **163,289 bytes**, SHA-256
  `47ac3638a958dabe6fe878ea7a8100e22ce9516615d914785154bd8dca3e9d98`.
- The repository `local:bootstrap` npm script rebuilt and installed the current
  app set into local Neutron canister `efadq-gl777-77774-aaaba-cai`.
- The installed-browser release suite passed **exactly 20 of 20** independent
  flows in 3.1 minutes against that fresh bootstrap.

## Verified 2026-07-14 Second-Wave Hardening

- Three fresh independent audits covered Neutron integration/contracts,
  spreadsheet correctness, and installed Playwright false passes.
- Packaged app validation and unit suite: **103 passed, 0 failed** (440
  assertions); app and scripts TypeScript checks are clean.
- Fresh package: **162,435 bytes**, SHA-256
  `0432454c06bbd77d1641cc5819feb73a2fc60ab115dce882fc49910bfff1e3c0`.
- Reinstalled into local Neutron canister `efadq-gl777-77774-aaaba-cai`.
- Strengthened installed-browser suite: **exactly 20 passed, 0 failed** in 3.8
  minutes against that reinstalled package.
- Irregular numeric fill no longer overwrites its own seed. Auto-linear fill is
  admitted only for a consistent finite step.
- `COUNT`/`COUNTA` handle range errors correctly; unsupported `MATCH`,
  `XLOOKUP`, and `VLOOKUP` modes are rejected and their supported signatures
  are published to agents.
- XLSX literal-percent formats no longer become percent scaling, imported error
  cells retain propagation semantics, and human opens surface import warnings.
- Every successful public tool result now has a closed validated schema.
  `workbook_find` has deterministic revision/query/options-bound cursor paging.
- Sparse custom dimensions have an explicit 20,000-entry workbook limit, which
  keeps full status safely below the message-bus ceiling and is discoverable in
  capabilities.
- Status and cells commit as one reconciled tile snapshot. A failed read leaves
  the loaded revision unchanged so the poll fallback retries even at revision
  zero.
- Clipboard TSV preserves quoted tabs, multiline fields, and doubled quotes;
  keyboard whole-row/column selection and decimal formatting from General are
  implemented.
- Compact menus fit and scroll in real short/micro tile rectangles, keyboard
  menu opens close peers, and Escape restores focus to the owning summary.
- Kitchen Sink browser evidence now covers representative state on every one of
  its six sheets before and after XLSX round trip.

## Verified 2026-07-14 Hardening Pass

- Packaged app validation and unit suite: **90 passed, 0 failed**.
- Installed Neutron browser suite: **20 passed, 0 failed** in 2.4 minutes.
- App TypeScript check: clean.
- Installed target: `efadq-gl777-77774-aaaba-cai` at the local Neutron host.
- Silent formula defects fixed: two-dimensional `INDEX`, exact arbitrary-width
  `VLOOKUP`, half-away-from-zero `ROUND`, and unsupported XLSX grammar rejection.
- XLSX time-only number formats no longer import as dates.
- Apply/undo/redo command identity includes the expected revision.
- `workbook_find` is encoded-byte bounded, and `workbook_status` publishes a
  machine-readable operation/function/format/limit/concurrency capability map.
- The clipped sheet strip and zero-width workbook path false passes are fixed.
  The command spine now uses labelled File/Edit/Format/Data menus and compacts
  to four menus below 900px.
- Humans now have decimal, text color, fill color, and clear-formatting controls.
- Toolbar copy/cut followed by keyboard paste retains rich formulas/styles and
  move semantics when the clipboard fingerprint matches.
- The Kitchen Sink filter visibly hides six non-North orders, sorting the exact
  filtered range preserves its header, and `NOW` visibly uses a time format.
- Dropped invalidations recover through low-rate visible-tile revision polling;
  refresh reconciliation does not combine status and cells from different
  revisions.

## Shipped Product Spine

- `.nsheet` is the only lossless writable workbook format and native save
  destination.
- XLSX and CSV are bounded imports and reviewed exports to new snapshot paths.
  They do not become a lossless source, overwrite an imported original, or mark
  the native workbook clean.
- One resident owns the live workbook/session. Human and tool operations use
  the same revisioned, atomic command engine.
- Kitchen Sink is the six-sheet static gallery for workbook-state features.
  The separate 20-flow installed-browser suite is the action and lifecycle
  tour; neither should claim evidence that its assertions do not provide.
- Tile view/draft storage is currently best-effort browser-session state, not a
  durable remount guarantee. Resident invalidations are hints; a low-rate
  workbook-identity-and-revision poll is the recovery path for dropped hints and
  restarted residents.

## Current Coordinated Pass

| Work | Status | Evidence or exit condition |
| --- | --- | --- |
| Make save/import/export wording truthful | Complete in docs | README names `.nsheet` as the only lossless save and XLSX/CSV as reviewed snapshots |
| Separate the static Kitchen Sink gallery from action/lifecycle coverage | Complete in docs | README assigns static evidence to the workbook and action evidence to the 20 browser flows |
| Correct the remount guarantee | Complete in docs | README describes `sessionStorage` behavior as best effort and names the resident checkpoint as planned |
| Add recovery from dropped invalidations and resident restart | Complete in app | Low-rate polling compares workbook identity plus loaded revision, retries incomplete reads, pauses while hidden, and installed flow 20 recovers after a real background restart |
| Audit all 20 installed-browser flows | Complete for the scoped installed suite | Exactly 20 independent flows passed against the newly packaged and installed app |
| Improve Kitchen Sink evidence | Complete for static workbook state | All six sheets, fixed demo identity, every published formula function, visible filter, styles/time/dimensions, declared XLSX losses, and round trip are asserted |
| Describe flow 20 accurately | Complete in docs | It is an external concurrent tool mutation test, not a kernel-routed Agent Mode provenance test |
| Repair compact command and footer geometry | Complete | Installed flow 01 asserts a full-height visible tab strip, visible path, and zero document overflow |
| Repair formula/XLSX semantic truth failures | Complete for audited defects | Reference/literal coercion, blank comparison, every supported function arity, and focused interchange fixtures pass; installed flow 03 checks the new evaluator behavior |
| Close agent input/result contracts | Complete | Session/apply/save inputs are closed action variants; all result variants validate against closed descriptors; lookup signatures, bounded dimensions, and pageable find are discoverable |
| Make header sorting explicit | Complete | `hasHeader` is mandatory in the engine and public operation schema; the Data menu exposes the same choice and installed flow 14 preserves the header |
| Repair compact and keyboard false passes | Complete | Real short/micro rect assertions and full F6/Shift+F6/menu Escape/whole-axis keyboard paths pass installed |
| Bind paged agent reads to one workbook snapshot | Complete | Read/find pages include workbook identity plus revision; tile reconciliation rejects mixed identities and installed flow 16 checks both paths |
| Verify ordinary Files and Files-tile bytes | Complete | Path, MIME, length, SHA-256 etag, and attachment bytes are checked before replacement; adversarial read/write/handoff tests pass atomically |
| Propagate cancellation without corrupting save state | Complete | Pre-I/O aborts consume no command identity; mid-read aborts cannot replace late; post-write reconciliation/finalization still completes |
| Make stale deployment impossible to mistake for a pass | Complete | `test:e2e` attests installed main/service bytes before listing or running the exact retry-free 20-flow suite |

Do not mark the parallel rows complete merely because code exists. Their exit
condition is a passing unit/package run plus the fresh installed-browser flow
that exercises the behavior.

## Prioritized Audit Queue

### P0 — Formula And XLSX Semantic Truth (Audited Defects Complete)

The audit found function-name admission without full semantic compatibility.
The confirmed defects below are fixed and covered by focused fixtures:

- two-dimensional `INDEX` does not honor both row and column;
- negative half-tie `ROUND` follows JavaScript rather than spreadsheet
  rounding;
- lookup/match optional arguments require explicit compatibility fixtures.

Completed in this pass:

- range dimensions survive evaluation and `INDEX(row,column)` is two-dimensional;
- exact `VLOOKUP` supports arbitrary bounded table widths, while approximate
  mode is explicitly rejected;
- negative midpoint `ROUND` uses spreadsheet half-away-from-zero behavior;
- XLSX formulas must pass the live grammar before import replaces the workbook;
- referenced logical/text values are ignored by numeric aggregates while direct
  literal coercion remains compatible, blanks compare contextually, and every
  supported function enforces one shared import/runtime arity contract.

Broader per-signature compatibility fixtures remain ongoing whenever the
supported formula inventory expands.

### P1 — Resident And Tile Lifecycle

- Low-rate fallback polling, atomic generation/revision guards, external-change
  draft preservation, and real resident-reload recovery are complete and
  installed-browser verified.
- Explicit recovery discard and dirty-target refusal/cancel/discard/retry through
  the Files-tile handoff are installed-browser verified. Remaining lifecycle
  fixtures are tile close/reopen and explicit injected notification loss.
- A clean saved workbook is not automatically reopened after resident restart;
  its bytes remain safe in Files, but durable last-open-document restoration
  requires a separate resident session manifest.

The resident-owned `TileViewState` checkpoint remains deferred from this pass.
Until it exists, selection, viewport, active sheet, and editor draft persistence
remain explicitly best effort.

### P1 — Complete Agent Contracts (Successful Results Complete)

- Session, apply/history, and native/export inputs use closed action-
  discriminated alternatives. Real transport validation rejects missing and
  action-irrelevant fields.
- Closed shared schemas cover status, normal/recovery session mutations,
  tagged reads, paged find, apply/history, native save, export preflight/commit,
  and Files handoff.
- Action-specific results use discriminated alternatives and contract tests run
  through the real transport validator, including rejection of partial and
  undocumented results.
- Formula signature restrictions, operation names, formats, concurrency
  requirements, and resource limits are machine-readable.
- Read/find pagination exposes workbook identity plus revision, Files handoffs
  verify attachment integrity before replacement, and long/side-effecting
  app-local operations observe cancellation at safe boundaries.
- Stable structured error variants and retry details remain a cross-cutting
  follow-up where the generic message bus currently flattens details.

Generic message-bus error-detail preservation requires changes in shared
`neutron-tools` and is therefore deferred by this app-folder-only constraint.
App-local schemas and tests can proceed independently.

### P1 — Bounded Results (Current Contract Complete)

- `workbook_find` enforces the shared 96 KiB encoded response budget and pages a
  deterministic populated-cell sequence with opaque revision/query/options-
  bound cursors; stale, mismatched, expired, and tampered tokens are rejected.
- `workbook_read` retains its existing workbook/revision/range-bound cursor.
- A 20,000-entry combined custom-dimension limit keeps complete status under
  1 MiB; exact-limit and over-limit native/command fixtures cover it.

### P1 — Installed-Browser Release Evidence

- A fresh repository bootstrap followed by all exact 20 flows is the current
  release evidence; this gate passed for the package recorded above.
- Denial, stale revision, resident remount/recovery, semantic formulas/fill,
  styles/types/dimensions/filter preservation, Files handoff, and save/conflict
  outcomes have installed evidence.
- Conditional-save conflict, ambiguous save outcome, explicit notification-loss
  injection, history-id rejection, and browser payload-boundary fixtures remain.
- Keep flow 20 described as an external mutation collision until the mutation
  travels through a real kernel-routed agent fixture.

### P2 — Kitchen Sink Evidence

- Keep the six sheets deterministic and map each static feature to an exact
  sheet/cell and expected result on the Read me sheet or in a test matrix.
- Make the active filter visibly hide at least one data row.
- Render `NOW` with the shipped time format so its time component is inspectable.
- Assert formula values and errors, styles, number/date formats, widths/heights,
  filters/hidden rows, and lossless native round trip.
- Treat fill, copy/move, undo/redo, stable sort, structural edits, find,
  import/export, recovery, conflict handling, and external mutation as guided
  actions or browser flows. A serialized static workbook cannot prove them.

### P2 — Documentation And Shared Infrastructure

The following remain important but cannot be completed under the current
app-folder-only write scope:

- update the repository docs index and canonical testing guide;
- document one canonical binary attachment, delegation, timeout, and structured
  error contract in the Neutron developer/message-bus docs;
- generalize the duplicated Spreadsheet and Files attachment transports into a
  shared `neutron-tools/app` implementation;
- add a root fresh-bootstrap Spreadsheet Playwright command and CI/release gate;
- build a real kernel-routed Agent fixture so caller identity,
  consent, provenance, and nested Files delegation are exercised end to end.

## Release Checkpoint

Current scoped release checkpoint:

1. Spreadsheet unit, codec, session, package, and schema tests pass. **Done.**
2. The exact 20-flow suite passes against a freshly installed current package.
   **Done.**
3. Audited formula/XLSX defects have semantic fixtures rather than name-only
   coverage. **Done for the current supported inventory.**
4. Tool operations/signatures/limits are discoverable; read and find are
   workbook-identity-bound, revision-bound, bounded, and pageable; successful
   results have closed schemas; status is bounded by the explicit custom-
   dimension limit. Generic structured error transport remains shared-
   infrastructure work.
5. Poll/restart recovery, conflicts, denial, native/CSV/XLSX Files permission
   paths, native resave, dirty-target refusal, and explicit recovery discard
   have installed-browser evidence. Resident-owned tile-view recovery, unknown-
   outcome injection, clean last-open restoration, and real Agent Mode
   provenance remain open.
6. Kitchen Sink claims only the static evidence it contains, while the browser
   tour owns action and lifecycle evidence. **Done.**

See [README.md](./README.md) for the user-facing contract and
[TEST_FLOWS.md](./TEST_FLOWS.md) for the current browser-flow matrix.
