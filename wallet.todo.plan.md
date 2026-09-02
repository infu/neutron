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

## Required outcome

- Existing callers continue to use
  `app:wallet:background / wallet_fund_v1` with the released input and output
  contract.
- A human funding request opens or focuses Wallet. Wallet loads authoritative
  facts and shows one polished Wallet decision. Its concrete primary label is
  `Send` or `Approve allowance`; `Cancel` rejects the prepared command.
- When that interaction settles, Kernel releases browser focus only if the
  captured Wallet endpoint session remains current and its exact frame remains
  focused. It neither focuses the caller nor changes `focusedTileId`; a retry
  requires actual caller focus under transient user activation, normally
  supplied by a fresh caller click.
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
  tile open/reuse/focus, and audience attestation; and
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
  -> Wallet returns the result to the caller
  -> Kernel releases the exact Wallet frame if its captured session is still
     current and it still owns browser focus
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

## Compatibility

| Kernel \ Wallet | W306 | W307 | W308 | W309 |
| --- | --- | --- | --- | --- |
| K323 | Human funding uses the released generic raw review. W306 has no root tool. | Human funding fails before preparation or effect. The root tool is unavailable cross-app. | Human funding fails before preparation or effect. The root tool is unavailable cross-app. | Human funding fails before preparation or effect. The root tool is unavailable cross-app. |
| K324 | Human funding uses the deprecated generic raw review. W306 has no root tool. | Human funding uses one Wallet decision; direct-root funding is UI-free. | Human funding fails before preparation or effect because K324 lacks W308's explicit provider-UI feature marker. Direct-root funding remains UI-free. | Same provider-marker behavior as W308; direct-root funding remains UI-free. |
| K325 | Human funding uses the deprecated generic raw review. W306 has no root tool. | Human funding uses one Wallet decision; direct-root funding is UI-free. | Human funding works for default accounts, but non-default account inputs have the W308 hidden-sidecar regression. | Human funding uses one Wallet decision; direct-root funding is UI-free; all ICRC account inputs carry explicit sidecars. |
| K326 | Human funding uses the deprecated generic raw review. W306 has no root tool. | Human funding uses one Wallet decision, then releases an unchanged settled provider session's frame focus; direct-root funding is UI-free. | Human funding has the focus correction but retains W308's non-default-account input regression. | Human funding uses one Wallet decision, then releases an unchanged settled provider session's frame focus; direct-root funding is UI-free; all ICRC account inputs carry explicit sidecars. |

Existing callers remain compatible with W309: the endpoint, tool name, schemas,
provider annotation, and caller semantics do not change.

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

## Managed memory

The intended successors are code/frontend releases with unchanged managed
memory:

- Kernel retains its released roots and versions.
- Wallet retains `wallet` v1 and `wallet_commands` v1. Released schema,
  migration, lock, and lineage files are immutable.
- Kitchen Sink retains its released memory declaration.
- Contacts retains `contacts` v2 and its released v1-to-v2 migration lineage.

Do not add a fake migration. Requalify clean initialization and state-preserving
upgrades from the exact production archives, including representative Wallet
state and prepared, pending, and terminal command rows.

## Lean implementation rules

- Reuse the existing provider capability, workspace tile open/focus path,
  endpoint registration, scoped self calls, Wallet funding journal, allowance
  adapters, formatter, and transaction executors.
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

## Required verification

Before release, prove:

- SDK and Kernel schema/audience normalization, one-use callback behavior,
  exact binding, cancellation/replacement/replay failure, no Kernel dialog, and
  direct-root-only routing;
- session-bound exact provider-frame focus release, no caller auto-focus or
  selected-tile mutation, no focus theft, and caller focus plus transient
  activation before retry;
- W306 compatibility through the deprecated callback, state-preserving upgrades
  from exact W307 plus the W306 skip path, exact W308-to-W309 memory retention,
  and no legacy-callback call by W309;
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
- all unchanged old-app, attachment, control, grant, Agent, and self-call
  compatibility suites.

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
npm run typecheck
npm run security:check
npm run license:check
npm test
```

Build the changed package through its complete workspace package command:

```sh
npm --workspace neutron-kernel run package
npm --workspace neutron-wallet run package
npm --workspace neutron-contacts run package
```

Do not rebuild unchanged Kitchen Sink 307 bytes. Record final commands, results,
archive paths, byte lengths, SHA-256 values, and offered-source artifacts for
the frozen Kernel 326, Wallet 309, and Contacts 306 candidates.

## Release procedure

1. Finish the diff cleanup and security review; freeze source and tests.
2. Prove unchanged memory roots by clean initialization and exact-production
   upgrades.
3. Verify and retain the exact published Kernel 325, Wallet 308, and Contacts
   305 archives as predecessors. Prepare Kernel 326, Wallet 309, and Contacts
   306 with production `update_source` `233tv-xiaaa-aaaay-aacta-cai`; Kitchen
   Sink 307 remains an unchanged published package.
4. Run Kernel qualification, exact-325 upgrade, compatibility, and complete
   package workflows, plus Wallet exact-memory and checked 308-to-309 upgrade,
   Contacts clean-init and checked 305-to-306 upgrade, and browser
   CRUD/Wallet-discovery/send gates on the same final sources.
5. Review all three candidate archives and their matching offered-source
   artifacts.
6. Publish Kernel 326, Wallet 309, and Contacts 306 atomically with the
   production catalog publisher and a reviewed catalog containing exactly
   those three packages.
7. Rerun the exact same catalog command against the exact same bytes. Require
   `batch_id: null` and every selected package/source row `unchanged` with
   matching version, path, size, URL, and SHA-256.
8. Add the exact Kernel 326/Wallet 309/Contacts 306 qualification and
   publication evidence to the PR only after those steps succeed.

Kernel 326, Wallet 309, and Contacts 306 form one corrective catalog
transaction, not a staged rollout. Do not rebuild after an ambiguous
publication or change the Dispenser starter unless that separate rollout is
explicitly requested.

## Deferred

- Wallet-operated DEX execution, quote validation, or settlement.
- Standing/unlimited allowances, caller-selected long expiries, automatic
  post-swap revoke, and per-agent budgets.
- Native-chain and ERC-20 cross-app withdrawal protocols.
- Global allowance discovery for ledgers Wallet has never selected or cannot
  access.
- Generic wallet-provider discovery or wildcard payment grants.
