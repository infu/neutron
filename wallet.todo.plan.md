# Wallet-owned funding UI: corrective successor plan

Status date: 2026-09-02

This is the implementation and release plan for Wallet-owned funding approval.
Kernel provides generic, invocation-scoped routing. Wallet owns token meaning,
review UI, execution policy, and the authority of its exact preapproved self
calls.

## Current state

Production batch 37 is immutable history, not evidence for the current tree. It
published these versions together:

| Historical package | Package SHA-256 | Offered-source SHA-256 |
| --- | --- | --- |
| Kernel 0.3.24 (324) | `6ae401a934160410ec7d099f9d3a7f62c94126ab491fc115cc2e38b5b27c067a` | `ea7cd9a8d5b761e62445301a8c0ad2887a793a1337b3a521e7d94ee83dbfb30d` |
| Wallet 0.3.7 (307) | `20ba3b00349e9386713a789622ce6a570fc7123e7daf89cda38daedcfc74fac1` | `b5b22f50160cb1f048308c27ad3c29da4e9ebf83ab66b35d291c36f92bed6dd2` |
| Kitchen Sink 0.3.6 (306) | `31f447052918fbfb848a32f649af5c0098a043149d52d0e14f759b58a4743f2f` | `3cccf2ccd48b4421b3a48d089c8e6cf5e9dc1ab6395ece5e9cdc96db99a1dd94` |

The identical-byte postflight for batch 37 returned `batch_id: null`. Those
facts describe only those exact historical bytes. Do not rebuild, overwrite,
or republish those versions.

Post-batch fixes and cleanup change package or offered-source bytes. The next
release therefore requires new candidates:

| App | Next candidate | State |
| --- | --- | --- |
| Kernel | 0.3.25 (325) | Published atomically in production batch 38 and verified unchanged on postflight. |
| Wallet | 0.3.8 (308) | Published atomically in production batch 38 and verified unchanged on postflight. |
| Kitchen Sink | 0.3.7 (307) | Published atomically in production batch 38 and verified unchanged on postflight. |
| Contacts | 0.3.5 (305) | Published atomically in production batch 38 and verified unchanged on postflight. |

## Final release evidence

The frozen candidates and matching Complete App Source artifacts are:

| Package | Bytes | Package SHA-256 | Source bytes | Source SHA-256 |
| --- | ---: | --- | ---: | --- |
| Kernel 325 | 2,415,653 | `3f7293fb8ab0fe25fd59b2a02e20b66eb4c2920858ed660e163265a4481a098b` | 3,036,791 | `c23c9cb3a6152550e1629c1259b37e843415962f277d907505dcc4e0dfc5d8b5` |
| Wallet 308 | 677,493 | `2f3626d2800ddf3e6c0734268c66627931c934811722d39de41c8d1505873858` | 490,224 | `cd422b41222c23e6555f6eef7f00b34fa958a5f807cbd67c16b810c6bf043d8a` |
| Kitchen Sink 307 | 430,099 | `5610bd8d4ae94bb7caa9e38841561913efa09b800b7b17bff1c3b2bb154cdb50` | 409,422 | `4aebd86ede65e687401e0072ac7d5d29e5a3f050b539aa3914a081d610ca56a4` |
| Contacts 305 | 297,977 | `aa5e6ee225b0d2a2057e0a5678797d593745273553dcb9dca38a992f4134e15a` | 338,626 | `6f2f21e4a4f4f0d8ba68e56ec999d4c6d07449df09d51c9018439b2eff188cc4` |

All four complete workspace package commands were run twice and reproduced
these exact bytes. The final Certified Assets qualification completed in
121.07 seconds with all 12 operational samples, all three independent Motoko
gates, and 100/100 qualification tests passing. Its receipt file SHA-256 is
`4e0b0bc55a24cce8e3184f41b727cbc95552301e0f2619fa4ff8f3501f55cf9d`;
the candidate-binding SHA-256 is
`7420683120b8776e464d27c3f9ba6c51282b20e5f32072a53ad0048b3db268c0`.

The exact-archive upgrade matrix passed 11 cases, skipped five inapplicable
rows, and made 687 assertions. It covers every retained Kernel predecessor,
Wallet 307 and the skipped 306 path, Kitchen Sink 306, and Contacts 304. Full
Kernel, Wallet, Kitchen Sink, Contacts, SDK, compiler, security, provisioner,
update-source, VFS, Mail, and remaining production-app regression suites pass.
The VFS browser suite used its supported system-Chrome override because the
bundled browser lacked a host library. Playwright discovers all 11 focused
Kitchen Sink/Wallet/Contacts tests. A fresh installed browser run could not be
started because another workspace owned the provisioner's mandatory port 8000;
that unrelated process was not terminated and no destructive reinstall was
used. Deterministic routing, Wallet handler, exact-ledger-effect, transient-UI
observer, and exact-archive tests cover the blocked root-agent scenario.

Production publication committed atomic batch `38` at
`2026-09-02T04:14:17.817Z`. Contacts 305, Kernel 325, Kitchen Sink 307, Wallet
308, and all four source artifacts were reported `published` and then verified.
The identical-byte postflight at `2026-09-02T04:14:44.893Z` returned
`batch_id: null`; every package and source row was `unchanged` with the exact
version, path, size, and SHA-256 above. An earlier all-app invocation stopped
during read-only preflight because the repository's unrelated Chess 304 archive
does not match its already-published immutable digest; it created no batch. The
successful transaction therefore selected only these four intended successors,
without rebuilding or republishing unrelated same-version apps.

## Post-batch 38 corrective successor

Browser qualification found that a settled provider interaction could leave
the provider iframe with programmatic browser focus. Kernel 0.3.26 (326) is the
published generic correction; it releases only the exact still-focused frame
of an unchanged captured provider session and does not change provider
semantics or app contracts. The same gate exposed a Contacts 0.3.5 frontend
regression: scalar ICRC account input omitted the API-1 binary sidecar for a
present subaccount. Contacts 0.3.6 (306) restores its prior structural account
input without changing Candid or memory. A subsequent exhaustive self-call
audit found the same regression at the six Wallet ICRC-account input
boundaries: Wallet 0.3.8 had accidentally removed the structural encoder
already present in 0.3.7. Wallet 0.3.9 (309) restores one shared local encoder
for transfer destinations, direct and allowance funding, revocation, and
ICRC-103 cursors. Kernel's generic sidecar-integrity fence is unchanged.
Kitchen Sink 307 remains unchanged and compatible.

Those K326 focus semantics are immutable release history, not the desired
successor behavior. The current working tree removes both the source
focus/transient-activation admission gate and settlement blur. Exact endpoint,
session, AppScope, version, owner, cancellation, one-use callback, schema, and
audience binding remain authoritative.

| App | Corrective state |
| --- | --- |
| Kernel 0.3.26 (326) | Frozen, qualified from exact 0.3.25, and published in atomic production batch 39. |
| Wallet 0.3.9 (309) | Frozen, qualified by a checked exact-0.3.8 state-preserving upgrade, and published in batch 39. |
| Kitchen Sink 0.3.7 (307) | Existing published bytes; no successor required for this correction. |
| Contacts 0.3.6 (306) | Frozen, qualified by a checked exact-0.3.5 state-preserving upgrade, and published in batch 39. |

The frozen corrective candidates and matching Complete App Source artifacts
are:

| Package | Bytes | Package SHA-256 | Source bytes | Source SHA-256 |
| --- | ---: | --- | ---: | --- |
| Kernel 326 | 2,415,895 | `738aa64943c759b573d8dd5d9094c7ce9b3017768a9c2616f638a272a591bda4` | 3,042,172 | `2c5ac20bf2ae04ed08b567d746ea903c6f6004f1950b401126479d0cc46f202c` |
| Wallet 309 | 677,558 | `6deaf1dc0a05582dfc7cd9db56f7e2bb9705df14e825bd817689d31a1e9e0398` | 491,072 | `0356815ebbdbbce0986fb6ee080ed960b2a421af0c3025e6904e5c06f3bae145` |
| Contacts 306 | 298,018 | `2e420226252b93ce1ab1d4ee2ce4278c395c81324384fc4edebfd613a942885f` | 338,932 | `c8d5c6295930dd89799335413d2b5383b681cc9d47227714cb14e2c03bf3ebaf` |

All retained source files in those three artifacts are byte- and
mode-identical to the final worktree. The exact production predecessors were
retained as immutable test fixtures: Kernel 325
`3f7293fb8ab0fe25fd59b2a02e20b66eb4c2920858ed660e163265a4481a098b`,
Wallet 308
`2f3626d2800ddf3e6c0734268c66627931c934811722d39de41c8d1505873858`,
and Contacts 305
`aa5e6ee225b0d2a2057e0a5678797d593745273553dcb9dca38a992f4134e15a`.

The checked in-product upgrade gates kept all 13 managed-memory roots and
reported zero destructive roots, removals, compatibility errors, or compiler
errors. Contacts retained its v2 root and representative default/subaccount
records. Wallet retained both v1 roots, configured ledger state, and durable
funding commands. Kernel retained its complete memory contract and upgraded
from the exact 325 archive.

On the same upgraded K326/C306/W309 fixture, the final serialized browser gates
passed:

- Contacts created an owner-only account, reloaded it, edited it to the exact
  32-byte `.ff` subaccount, reloaded it again, discovered it in Wallet, sent
  0.001 ICP, and removed it: 1 passed in 7.0 seconds.
- Kitchen Sink used natural app clicks for four successive provider decisions
  (direct Cancel/Send and allowance Cancel/Approve), verified exact ICP ledger
  effects, listed and revoked the live approval, and observed no Kernel dialog:
  1 passed in 13.4 seconds.
- The direct depth-zero root Agent moved exactly one ICP atom through Wallet
  with no Wallet or Kernel UI, while human and nested calls had no effect:
  1 passed in 4.8 seconds.

The browser fixtures wait for the existing resident-readiness signal before
calling a background endpoint and explicitly refresh missing cached token
metadata/balances. These are deterministic test preconditions, not alternate
focus or authorization paths. The focused Kernel compatibility suite passed
212 tests/1,834 assertions; Wallet passed 84 Bun tests plus its three Motoko
suites and memory restore; Contacts passed all 26 frontend/package tests plus
its Motoko and memory gates; the focused SDK codec suites passed 89 tests.

Production publication committed atomic batch `39` at
`2026-09-02T15:25:09.515Z` through the production catalog publisher using a
reviewed catalog containing only Kernel, Contacts, and Wallet. All three
release pointers, exact packages, and matching Complete App Source artifacts
were reported `published`. Kitchen Sink 307 remained on its already-published
exact bytes. The publication receipt SHA-256 is
`aa43781e8b6daf04b04d593c6dbdbfc7a80354ed23decffbf911993ad4846de9`.

The first read-only postflight reached all three verification steps but the IC
gateway omitted the certified HTTP-v2 proof for the Wallet package response;
it created no batch and produced no receipt. The required exact-byte retry at
`2026-09-02T15:26:31.431Z` returned `batch_id: null`, with every package and
source row `unchanged` and matching the version, path, size, URL, and SHA-256
above. Its receipt SHA-256 is
`040f9dce9460f20eec02de7d2e06f4774fb033a0b69277268a66ea5ce7ef85e2`.
No package or source artifact was rebuilt between publication and either
postflight attempt.

## Kernel 327, Wallet 310, and Kitchen Sink 308 corrective successors (released)

Kernel 326, Wallet 309, Contacts 306, and Kitchen Sink 307 are immutable
published history. The completed correction released Kernel 0.3.27 (327),
Wallet 0.3.10 (310), and Kitchen Sink 0.3.8 (308):

- remove K326's source-focus/transient-activation admission gate and its
  post-settlement provider-frame blur while retaining exact live endpoint,
  session, installation, owner, cancellation, schema, one-use, and audience
  binding; and
- make Kernel frontend mutations use one asynchronous v2 signed request
  identity followed by certified request-status polling. Bootstrap actors,
  dynamic ICBlast actors, and raw self updates share that transport. An
  identical signed envelope may receive a transport retry, but a mutation is
  never recreated under a new request ID because a v3 response omitted a
  terminal reply. This covers Wallet-mediated execution and every ordinary or
  chunked install control call, including methods whose valid Candid result is
  `null`;
- keep Wallet Send bound to the selected ledger principal so an already-open
  Send view resolves each new balance snapshot instead of retaining a stale
  ledger object; and
- encode Kitchen Sink's four two-text backend methods as their declared single
  Candid tuple argument, eliminating the existing publish/delete/mutable-blob
  demo traps.

Kernel remains generic: it adds no Wallet, token, ledger, ICRC, Contacts, or
package-specific production branch. The Wallet and Kitchen Sink corrections
stay inside their owning apps. None of the three changes modifies a Candid
method or managed-memory schema; Contacts 306 remains on its exact published
package bytes.

Git-history diagnosis rules out an old-package format regression. The relevant
compiler installer, package decoder, Kernel backend, actor factory, manifest
schema, and package-record parser are byte-identical from pre-PR K322 through
published K326. The Agent 3.4 v3-default/202-only-polling defect was already
present in the initial `7a68349` snapshot. Commit `c18eb5c` (K316) exposed it
reliably by increasing the generated 13-app actor from an inline request with
11,963 bytes of headroom to a chunked request 7,400 bytes over the existing 2
MiB cutoff. The browser-origin isolation introduced there remains a required
security boundary; the correction belongs in shared update transport, not in
the package decoder, chunk protocol, or archive-specific compatibility code.

Release qualification completed before publication. The exact published K326,
W309, and Kitchen Sink 307 archives were retained for their state-preserving
upgrades to K327, W310, and Kitchen Sink 308. Qualification also included a
realistic old-package browser gate: provision a fresh local Neutron using the
three candidates, then install every exact archive in `test/old_packages/`
through the launcher file chooser, package review, browser compile, **Install**
action, real upload and activation, and committed-registry reconciliation. It
must verify Cast Away 114, Chipswap 127, Inspector Canister 106, and Principal
Miner 103 in the runtime and leave no install journal. Archive decoding or
preparation alone is not sufficient evidence.

The three versioned archives are now immutable predecessor fixtures. Their
publication is historical and must not be repeated or rebuilt.

## Required outcome

- Existing callers continue to use
  `app:wallet:background / wallet_fund_v1` with the released input and output
  contract.
- A human funding request opens or focuses Wallet. Wallet loads authoritative
  facts and shows one polished Wallet decision. Its concrete primary label is
  `Send` or `Approve allowance`; `Cancel` rejects the prepared command.
- Any exact live app tile, tray, or background endpoint may request that Wallet
  presentation without source-frame focus or transient activation. This only
  presents Wallet; the Wallet action remains the human decision.
- Opening or initially focusing Wallet is navigation, not continuing authority.
  Focus and workspace selection may move while the bound endpoint session stays
  live; the Wallet tile must remain mounted until private dispatch. Kernel
  performs no blur or caller-focus restoration at settlement.
- The affirmative action executes through Wallet's exact preapproved self-call
  path. Kernel shows no frontend-tool, raw-JSON, or backend-call dialog.
- A live depth-zero root agent may use the separate
  `wallet_fund_root_v1` tool without Wallet or Kernel UI. Humans and nested
  agents cannot invoke it.
- Wallet lists supported live approvals and lets its owner revoke them.
- Kitchen Sink remains the Swap-style example using 0.01 ICP
  (`1_000_000` e8s) on ledger `ryjl3-tyaaa-aaaaa-aaaba-cai`, with
  `eqsml-lyaaa-aaaaq-aacdq-cai` as the transfer destination or allowance
  spender.
- Existing apps remain compatible. The new path adds capabilities; it does not
  rename or remove released tools, schemas, or ordinary call routes.

## Architecture boundary

### Kernel is generic

Kernel may know only generic protocol facts:

- exact source and target endpoint, installation scope, version, session,
  cancellation, invocation, and owner/auth state;
- the closed `provider_once`, `same_app`, `foreground_tile`, and
  `agent_root` annotations;
- live JSON Schema validation, bounded opaque JSON, one-use callback state,
  tile open/reuse/initial-focus navigation, and audience attestation; and
- exact preapproved self-call method declarations and live Candid types.

Kernel must not contain Wallet, Swap, Contacts, token, ledger, ICRC, account,
decimal, fee, allowance, spender, destination, or app-specific UI branches.
Schema validation does not give Kernel domain meaning. Current
provider-presentation arguments and results remain opaque values that Kernel
routes and bounds but does not interpret or render. Only the deprecated generic
`requestApproval()` path renders its separate bounded review as inert JSON,
without domain interpretation.

Private self-call compatibility may leave a string opaque at a live record
position only for the pinned encoder's released record shorthand and only when
there is no binary sidecar at or below that path. Generated public schema does
not authorize the exception. Exact live-Candid encoding and raw preflight remain
authoritative, including equality with the materialized binary count and bytes.
There must be no Contacts, Wallet, Internet Computer Account, field-name, or
token special case in Kernel.

### Human provider flow

```text
Swap/Kitchen Sink
  -> app:wallet:background / wallet_fund_v1
  -> Wallet validates the caller and released request
  -> context.presentUserInterface({
       tileId: "wallet",
       tool: "wallet_funding_present_v1",
       arguments: normalizedRequest
     })
  -> Kernel opens/reuses/focuses the exact Wallet tile
  -> Kernel invokes the private Wallet tile tool with
       audience = "foreground_tile" and the attested original caller
  -> Wallet prepares and freezes authoritative ledger facts
  -> one Wallet action: Send or Approve allowance; Cancel rejects
  -> Wallet executes or rejects the exact durable command
  -> Kernel returns the Wallet result; normal workspace interaction owns focus
```

`wallet_fund_v1` retains
`{"neutron:consent":"provider_once"}`. Its handler must feature-detect and
consume `presentUserInterface` before preparation or execution. An older
Kernel therefore fails the successor Wallet before any financial effect.

The private tile tool declares both:

```json
{
  "neutron:visibility": "same_app",
  "neutron:audience": "foreground_tile"
}
```

Kernel derives the provider and caller; neither is accepted from app
arguments. It validates the public and private schemas, binds one presentation
to the exact live invocation, and rejects replay, replacement, cancellation,
wrong tile/tool/audience, or a handler that returns without completing the
interaction. Exact or wildcard session grants cannot replace the Wallet
decision.

`context.requestApproval()` remains a deprecated generic compatibility
surface. Published Wallet 0.3.6 depends on its Kernel raw-JSON review, but the
runtime does not app- or version-gate the member. Current providers must use
`presentUserInterface()`; both callbacks share one-use state and cannot be
stacked.

### Wallet owns financial policy

The attested Wallet tile uses the existing shared funding core to load metadata,
decimals, symbols, fees, accounts, current allowance, expiry, and maximum
debit. It prepares one durable command before display.

- `wallet_funding_execute_v1` may execute only that exact prepared command.
- `wallet_funding_reject_v1` may move only a prepared command to a definite
  rejected state; it cannot relabel pending, dispatched, or terminal work.
- Direct transfer, allowance creation/revocation, durable replay,
  reconciliation, fee handling, and history have one backend implementation.
  Human and root tools are policy entry points, not duplicate transaction
  engines.
- Wallet's own Send/Withdraw and Approvals actions use the same trusted Wallet
  UI and exact `updateSelf` calls, without a second Kernel prompt.

Wallet's Approvals view uses the bounded draft
`icrc103_get_allowances` adapter for supported selected ledgers and the
separate ICP approval API for the ICP ledger. It must show scope, formatted
amount, expiration, fee, permission-required and degraded/incomplete states,
and use the existing race-aware revoke policy. It must not claim global
completeness for inaccessible or non-enumerable ledgers.

For a pull-based Swap, one Wallet decision creates the reviewed short-lived
allowance; the reviewed Swap backend later performs `icrc2_transfer_from`
without another user decision. The current Kitchen Sink governance fixture is
not such a backend: it demonstrates creation, live query, Wallet display, and
revocation only.

Another asset standard belongs in another owner-trusted Wallet app using the
same generic Kernel primitive.

### Root-agent flow

`wallet_fund_root_v1` combines `same_app` visibility with the
`agent_root` audience. Kernel exposes it only to the active incoming
depth-zero root and injects that audience before dispatch. Wallet checks it,
then uses the same prepare/execute core and exact self calls without UI.
Ordinary app calls, humans, and delegated agent descendants fail before the
Wallet handler runs. The public human tool never silently falls back to root
automation.

## Compatibility through K327 and W310 (historical)

| Kernel \ Wallet | W306 | W307 | W308 | W309 | W310 |
| --- | --- | --- | --- | --- | --- |
| K323 | Human funding uses the released generic raw review. W306 has no root tool. | Human funding fails before preparation or effect. The root tool is unavailable cross-app. | Human funding fails before preparation or effect. The root tool is unavailable cross-app. | Human funding fails before preparation or effect. The root tool is unavailable cross-app. | Same public contract as W309; human funding fails before preparation or effect and the root tool is unavailable cross-app. |
| K324 | Human funding uses the deprecated generic raw review. W306 has no root tool. | Human funding uses one Wallet decision; direct-root funding is UI-free. | Human funding fails before preparation or effect because K324 lacks W308's explicit provider-UI feature marker. Direct-root funding remains UI-free. | Same provider-marker behavior as W308; direct-root funding remains UI-free. | Same public contract and provider-marker behavior as W309; direct-root funding remains UI-free. |
| K325 | Human funding uses the deprecated generic raw review. W306 has no root tool. | Human funding uses one Wallet decision; direct-root funding is UI-free. | Human funding works for default accounts, but non-default account inputs have the W308 hidden-sidecar regression. | Human funding uses one Wallet decision; direct-root funding is UI-free; all ICRC account inputs carry explicit sidecars. | Same public contract as W309; an open Send view also follows refreshed ledger state. |
| K326 | Human funding uses the deprecated generic raw review. W306 has no root tool. | Human funding uses one Wallet decision, then releases an unchanged settled provider session's frame focus; direct-root funding is UI-free. | Human funding has the focus correction but retains W308's non-default-account input regression. | Human funding uses one Wallet decision, then releases an unchanged settled provider session's frame focus; direct-root funding is UI-free; all ICRC account inputs carry explicit sidecars. | Same provider behavior as W309; an open Send view also follows refreshed ledger state. |
| K327 | Human funding uses the deprecated generic raw review. W306 has no root tool. | Human funding uses one Wallet decision without source-focus admission or settlement blur; direct-root funding is UI-free. | K327 presentation applies, but W308 retains its non-default-account input regression. | Human funding uses one Wallet decision without source-focus admission or settlement blur; direct-root funding is UI-free. | Same public contract as W309, with K327 presentation behavior and live Send-view refresh. |

Existing callers remain compatible with W310: the endpoint, tool name, schemas,
provider annotation, and caller semantics do not change. Durable retries also
survive caller tile replacement: Wallet normalizes only the disposable endpoint
UUID to the endpoint already stored with the command, retaining exact app,
role, Agent-mode, ledger, deadline, and financial-intent binding. This works
directly with released W306-W309 intent blobs and changes no memory schema.

The table records the compatibility contract, including successor cells that
require exact-archive qualification. K327 keeps the public contracts but
removes source-focus/activation admission and post-settlement blur; provider
endpoint/session provenance remains exact.

Contacts 0.3.6 retains the narrow API-1 reply-parser correction from 0.3.5. It
accepts a default account as either `{ owner }` or
`{ owner, subaccount: null }`, including the valid principal
`togwv-zqaaa-aaaal-qr7aa-cai`, while retaining canonical owner validation,
exact 32-byte present subaccounts, and rejection of extra or malformed fields.
For input it sends the live Candid account structurally, so a present
subaccount has the exact SDK binary sidecar instead of appearing only after
ICBlast conversion. The Kernel's generic sidecar-integrity fence remains
unchanged.
No Contacts-specific branch is added to Kernel; Contacts' public tool and v2
memory contracts remain unchanged.

## Security invariants

Kernel still guarantees generic routing and isolation:

- one bounded human-provider capability bound to the exact originating caller,
  provider, and public tool handler, plus endpoint sessions, installation
  scopes, versions, cancellation, and owner/auth state, and unavailable to
  Agent invocations;
- no preliminary grant, session-grant bypass, public private-tool access,
  cross-installation tile substitution, or callback reuse; and
- direct-root provenance for the UI-free tool.

Wallet still guarantees financial correctness:

- closed request parsing and caller/audience identity derived only from SDK
  context;
- selected/reserved ledger checks, exact accounts, live metadata and fees,
  bounded expiry, and no caller-supplied display authority;
- one durable `(caller app, request ID, intent)` command whose exact Candid
  arguments freeze immediately before its first ledger dispatch and are reused
  for duplicate replay or reconciliation, with no automatic fresh mutation
  after an ambiguous result;
- exact ledger methods only, never arbitrary canister/method execution; and
- rejection that cannot change dispatched or terminal state.

Source-review agents are defense in depth. They inform the owner's trust in an
installed provider but do not replace runtime bindings or Wallet validation.

## Managed memory through K327, W310, and Kitchen Sink 308 (historical)

K327 retains Kernel's released roots and versions. Wallet 310 retains `wallet`
v1 and `wallet_commands` v1. Kitchen Sink 308 retains `kitchensink` v1.
Contacts 306 retains `contacts` v2 and its released v1-to-v2 migration lineage
and receives no new package in this correction.

Do not add a fake migration. Requalify clean initialization and state-preserving
upgrades from exact published K326, W309, and Kitchen Sink 307 archives, then
run the installed Wallet, Kitchen Sink, Contacts, and old-package compatibility
gates against that upgraded runtime.

## Lean implementation rules

- Reuse the existing provider capability, workspace tile open/focus path,
  endpoint registration, scoped self calls, Wallet funding journal, allowance
  adapters, formatter, and transaction executors.
- Let any exact live direct app endpoint use the generic workspace open/focus
  path without focus heuristics or a Kernel dialog. This is navigation authority
  only; delegated Agent calls retain their bounded decision policy, and Wallet
  retains the sole token decision.
- Keep one generic Kernel/SDK route and one Wallet transaction core. Do not add
  a second Kernel dialog store, Wallet-specific Kernel API, copied codec,
  duplicate executor, or parallel approval state.
- Keep the deprecated raw-review code only as generic compatibility. Current
  provider source and normative examples must not invoke it.
- Remove unrelated documentation or source changes and stale tests. Generated
  changes are accepted only when the release workflow requires them.
- Keep token and app policy out of Kernel production source and generic routing
  fixtures. Use neutral providers and hostile opaque values there; isolate
  exact released-archive compatibility fixtures so they cannot create
  production branches.

## Historical K327/W310/Kitchen Sink 308 verification

Before release, prove:

- SDK and Kernel schema/audience normalization, one-use callback behavior,
  exact binding, cancellation/replacement/replay failure, no Kernel dialog, and
  direct-root-only routing;
- admission from exact live tile, tray, and background endpoints without a
  source-focus or transient-activation gate; initial provider focus as
  navigation only; focus/workspace movement during a live presentation; no
  settlement blur or caller-focus restoration; and a natural Cancel-to-next
  action sequence;
- bootstrap, dynamic ICBlast, and raw-self-update paths issuing one logical v2
  request identity and polling that request ID to a certified terminal reply,
  with no v3 mutation request and no newly signed resubmission after ambiguity;
- the actual chunked install control sequence accepting successful `null`
  replies for clear, upload, activation, cleanup, and commit without reporting
  an absent transport result;
- W306 compatibility through the deprecated callback, state-preserving upgrades
  from exact W309 to W310 plus the W306 skip path, exact Kitchen Sink 307 to
  308 retention, and no legacy-callback call by W310;
- Wallet prepare/execute/reject ordering, durable replay and reconciliation,
  direct transfer, allowance create/query/revoke, authoritative formatting,
  race handling, and no duplicate effect;
- Kitchen Sink direct transfer of 0.01 ICP to the governance canister with one
  Wallet decision and exact balance delta;
- Kitchen Sink allowance creation, exact live query, Wallet Approvals display,
  revocation, and zero final allowance, without claiming a transfer-from pull;
- Wallet Send/Withdraw and Approvals revoke with one Wallet decision and no
  Kernel dialog;
- root execution with zero UI and rejection of human or nested-agent calls;
- Contacts default and exact 32-byte subaccount add/edit/reload/remove behavior;
  and
- all unchanged attachment, control, grant, Agent, and self-call compatibility
  suites, plus every pinned `test/old_packages/` archive installed through the
  real launcher file chooser, review, compile, upload, activation, and commit
  path on a fresh disposable local Neutron.

Run the full repository gates and each app's release-specific memory, Motoko,
browser/PocketIC, candidate-binding, Certified Assets, and exact-archive tests.
At minimum:

```sh
npm --workspace neutron-tools test
npm --workspace neutron-kernel test
npm --workspace neutron-wallet test
npm --workspace neutron-kitchensink test
npm --workspace neutron-contacts test
npm --workspace neutron-compiler test
npm run test:e2e:old-packages:fresh
npm run typecheck
npm run security:check
npm run license:check
npm test
```

Build each changed package through its complete workspace package command:

```sh
npm --workspace neutron-kernel run package
npm --workspace neutron-wallet run package
npm --workspace neutron-kitchensink run package
```

Do not rebuild or republish unchanged Contacts 306 bytes. Record final commands,
results, archive paths, byte lengths, SHA-256 values, and matching offered-source
artifacts for all three frozen candidates.

## Historical K327/W310/Kitchen Sink 308 release procedure

1. Finish the K327/W310/Kitchen Sink 308 diff cleanup and security review;
   freeze source and tests.
2. Audit all three managed-memory declarations and prove clean initialization
   and state preservation from exact published K326, W309, and Kitchen Sink
   307 predecessors. Retain those immutable archives as upgrade fixtures.
3. Build all three production-source packages through their complete workspace
   package commands.
4. Run Kernel qualification, each exact predecessor-to-successor upgrade,
   transport/provider compatibility, Kitchen Sink/Wallet regression flow, and
   `npm run test:e2e:old-packages:fresh` on the exact candidate bytes.
5. Review all three archives and matching offered-source artifacts, including
   paths, versions, byte lengths, and SHA-256 values.
6. Publish K327, W310, and Kitchen Sink 308 atomically through the production
   catalog publisher; Contacts 306 remains unchanged.
7. Rerun the exact same catalog command against the exact same bytes. Require
   `batch_id: null` and every package/source row `unchanged` with matching
   version, path, size, URL, and SHA-256.
8. Add exact qualification and publication evidence to the PR only after those
   steps succeed.

These are one compatible corrective catalog transaction, not a staged rollout.
Do not rebuild after an ambiguous publication or change the Dispenser starter
unless that separate rollout is explicitly requested.

## Kernel 328, Wallet 311, and Kitchen Sink 309 successor (current)

The current release keeps the Wallet-owned funding contract and adds the lean
read path that swap and commerce apps need:

- Kernel 328 evaluates whole-canister, method-wide, and exact backend-call
  reservations independently, so an app's exact ledger reservation is not
  hidden by another app's broader reservation. The implementation remains
  generic and contains no Wallet, ledger, token, or ICRC-specific branch.
- Kernel 328 removes automatic request pauses after ordinary rejection or
  cancellation and raises existing frontend backpressure ceilings. Explicit
  owner Pause controls remain; no new focus, cooldown, quota, or policy gate is
  introduced.
- Wallet 311 exposes `wallet_token_info_v1` from its resident background. It
  accepts one selected ledger and returns live name, symbol, decimals,
  authoritative `icrc1_fee`, and the Wallet default-account balance. The
  caller cannot select another account or reserve/call the ledger directly.
- Kitchen Sink 309 demonstrates that read separately, then demonstrates the
  existing one-decision Wallet-owned direct-transfer and allowance funding
  flows against ICP and the Neutrinite governance canister. Reading token
  information is not joined to the funding click and cannot add a second
  approval to it.

Existing apps retain their public contracts. Wallet funding still uses
`wallet_fund_v1`; root agents still use the UI-free `wallet_fund_root_v1` path;
older packages remain installable through the same chooser, review, compile,
chunked upload, activation, and commit flow. Kernel only authenticates and
routes Wallet presentation. Wallet alone interprets token standards and owns
the human token approval.

No persistent schema changes. Kernel retains `kernel` v3 and
`kernel_activation` v1, Wallet retains `wallet` v1 and `wallet_commands` v1,
and Kitchen Sink retains `kitchensink` v1. Exact released K327, W310, and
Kitchen Sink 308 archives are retained as the predecessor fixtures.

Before publication, build all three workspaces, pass their complete tests,
typecheck the repository, qualify the exact K328/W311/Kitchen Sink 309 archives
through the PocketIC predecessor upgrades, and pass the realistic Kitchen
Sink, old-package, and package-update browser flows. Publish the three packages
and offered-source artifacts in one production catalog transaction, then rerun
the publisher against the unchanged bytes and require `batch_id: null` with
every package and source reported `unchanged`. Do not rebuild between those two
publication calls and do not change the Dispenser starter without a separate
request.

## Deferred

- Wallet-operated DEX execution, quote validation, or settlement.
- Standing/unlimited allowances, caller-selected long expiries, automatic
  post-swap revoke, and per-agent budgets.
- Native-chain and ERC-20 cross-app withdrawal protocols.
- Global allowance discovery for ledgers Wallet has never selected or cannot
  access.
- Generic wallet-provider discovery or wildcard payment grants.
