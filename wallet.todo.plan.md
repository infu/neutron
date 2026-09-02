# Wallet-owned funding UI: implementation and release plan

Status date: 2026-09-02

This is the authoritative plan for the corrective Wallet funding release. The
previous design in which Wallet supplied JSON for a Kernel approval dialog is
retained only as immutable release history and a narrow compatibility path for
Wallet 0.3.6. It is not the design for new Wallet code.

## Status and immutable release history

[PR #13](https://github.com/infu/neutron/pull/13) currently contains commit
`cf01ea4` and the already-published provider-funding work. Production
update-source batch 36 atomically published these exact packages and offered
sources:

| Package | Package bytes and SHA-256 | Offered-source bytes and SHA-256 |
| --- | --- | --- |
| Kernel 0.3.23 (323) | 2,448,813; `e2e5cea791af54a5052f227fcda57f07ecec1a5b4d11bfb5c79696c75d826334` | 3,007,430; `7dd544994c3caab7954a470de37ccc960ede16f181976a30b55011ddedffcab8` |
| Wallet 0.3.6 (306) | 666,413; `bea0d49e351bb8efa04bf03057b4f9175474a54bd198b382add790718b7b8aae` | 464,462; `f4ddaa4d0d1f93b58276656f391764224a5d0ee1f38216b3fb3acbb94faa3d1e` |
| Kitchen Sink 0.3.5 (305) | 428,073; `885fb6555d7a36e7856cad1c5ce31ad19922de1371ec26f81fc52052cf889602` | 398,027; `5429bc579003b9eee58f06d0713b01960482998f4ceebfe55005e49fca62ea0e` |

The second publication of those exact bytes returned `batch_id: null`; all 16
catalog package/source rows were `unchanged`. The release did not install
anything into existing Neutrons and did not change the Dispenser starter.

Those exact bytes were qualified with the full repository, typecheck,
security, and license gates. Kernel recorded 699 Bun tests, 31 Motoko programs,
the candidate binding check, and 12-sample certified-assets qualification.
Wallet recorded 65 Bun tests, its focused Motoko graph, and production-memory
qualification. The ICP Kitchen Sink scenario proved the 0.01 ICP transfer and
governance allowance. That historical scenario used the now-superseded raw
Kernel review dialog.

The corrective successors are frozen, packaged, release-qualified, and
published:

| Package | Package bytes and SHA-256 | Offered-source bytes and SHA-256 |
| --- | --- | --- |
| Kernel 0.3.24 (324) | 2,449,608; `6ae401a934160410ec7d099f9d3a7f62c94126ab491fc115cc2e38b5b27c067a` | 3,020,803; `ea7cd9a8d5b761e62445301a8c0ad2887a793a1337b3a521e7d94ee83dbfb30d` |
| Wallet 0.3.7 (307) | 677,271; `20ba3b00349e9386713a789622ce6a570fc7123e7daf89cda38daedcfc74fac1` | 473,458; `b5b22f50160cb1f048308c27ad3c29da4e9ebf83ab66b35d291c36f92bed6dd2` |
| Kitchen Sink 0.3.6 (306) | 429,282; `31f447052918fbfb848a32f649af5c0098a043149d52d0e14f759b58a4743f2f` | 400,668; `3cccf2ccd48b4421b3a48d089c8e6cf5e9dc1ab6395ece5e9cdc96db99a1dd94` |

The complete production-app and support-workspace test matrix passed, as did
repository typecheck, security, license, and diff checks. Kernel candidate
binding and certified-assets qualification passed. Exact-archive,
state-preserving K323 -> K324 and W306 -> W307 release tests passed with their
released memory roots intact. The final real-ICP browser test used the exact
three archives above and passed direct transfer Reject/Accept and allowance
Reject/Accept with exact ledger deltas and zero Kernel dialogs (`1 passed`,
10.6 seconds). Production update-source batch 37 atomically published exactly
Kernel, Wallet, and Kitchen Sink plus their offered sources; the other 13
catalog rows were verified unchanged. The immediate identical-byte postflight
returned `batch_id: null`, with all 16 package and source rows `unchanged`.
The verbatim receipt JSON files are retained under
`.neutron/release-receipts/wallet-provider-2026-09-01/`; their SHA-256 values
are `e6bb8b75b7e172e246c87f7ff9fa3851e90e74c89786543c2f41fb08d0eaf2bd`
for batch 37 and
`36b630e3a1a459a8c979370b774c897f739887c8d715f85bb572061e5963e107`
for the no-op postflight.

The Kernel correction exposed a second, previously unreachable Contacts reply
bug: API-1 correctly omits an absent optional field inside a returned record,
while Contacts 0.3.4 required the returned Account record to contain an
explicit `subaccount` key. Contacts 0.3.5 is the code-only candidate that
accepts both `{ owner }` and `{ owner, subaccount : null }` as the same default
account while retaining strict owner, 32-byte subaccount, and extra-field
validation. It is packaged and release-qualified but is not yet published.
The reproducible candidate is 297,477 bytes with SHA-256
`644720d915a34148f66b2b3aad8a82c619c16ec724b1704a45f5008bd1f0b7df`;
its 334,420-byte offered source has SHA-256
`17dbd15db746206890568361f71227a9242e7df242efb3fe5df10fd885769a14`.
An isolated browser run against those exact Kernel 0.3.24 and Contacts 0.3.5
archives saved, rendered, reloaded, reread, and removed the exact principal-only
account `togwv-zqaaa-aaaal-qr7aa-cai` (`1 passed`, 6.0 seconds).

## Required outcome

- Existing apps keep calling `app:wallet:background` / `wallet_fund_v1` with
  the released input and output contract. No caller migration, new grant, or
  SDK rebuild is required.
- A human action opens or focuses the installed Wallet tile. Wallet prepares
  authoritative ledger facts and presents a polished Wallet modal. The owner
  chooses **Accept** or **Reject** once.
- Accept executes through Wallet's exact preapproved self-call path. There is
  no Kernel frontend-tool, backend-call, or raw-JSON dialog.
- A live depth-zero root agent can call a separate Wallet tool and execute the
  same bounded operation with no user interface. Humans and nested agents
  cannot call that tool.
- Wallet continues to list discoverable ICP/ICRC allowances and lets its owner
  revoke them from the Wallet UI.
- Kernel remains token- and app-agnostic. It knows only generic endpoint,
  capability, audience, tile, cancellation, and invocation facts. Wallet alone
  knows ICRC methods, ledger principals, decimals, fees, symbols, accounts,
  allowance semantics, and display formatting.
- Kitchen Sink remains the executable Swap-app example: 0.01 ICP
  (`1_000_000` e8s) on ledger `ryjl3-tyaaa-aaaaa-aaaba-cai`, with Neutrinite
  governance `eqsml-lyaaa-aaaaq-aacdq-cai` as the direct destination or
  allowance spender.

## Normative architecture

### Human app flow

```text
Swap/Kitchen Sink
  -> app:wallet:background / wallet_fund_v1
  -> Wallet background validates caller + released request shape
  -> context.presentUserInterface({
       tileId: "wallet",
       tool: "wallet_funding_present_v1",
       arguments: original normalized request
     })
  -> Kernel opens/reuses/focuses the exact installed Wallet tile
  -> Kernel privately invokes the exact Wallet tile tool with
       audience = "foreground_tile" and the attested original caller
  -> Wallet prepares authoritative ledger facts
  -> Wallet modal: one Accept or Reject
  -> Wallet preapproved self call: execute or reject the exact command
  -> ledger receipt/result returns through Wallet to the caller
```

`wallet_fund_v1` keeps its released `{"neutron:consent":"provider_once"}`
annotation. Kernel uses that annotation to issue one invocation-scoped
provider capability, but it does not show a preliminary permission dialog or
create a reusable grant. Wallet must call `presentUserInterface` before any
prepare self call; an older Kernel therefore fails the new Wallet before any
financial effect.

The SDK exposes `context.presentUserInterface()` only with that active
capability. Kernel consumes the same one-use gate for either the new callback
or the deprecated `context.requestApproval()` compatibility callback, so one
invocation cannot use both.

Kernel reuses the existing workspace open/focus implementation. It derives the
provider app from the bound endpoint, opens only that app's declared tile,
waits for the exact tile endpoint, and rechecks installation scope, endpoint
version, session, cancellation, and capability bindings after awaits. The
presentation tool must declare both:

```json
{
  "neutron:visibility": "same_app",
  "neutron:audience": "foreground_tile"
}
```

Ordinary listing and calls cannot see or invoke that tool. Kernel injects the
closed audience attestation; Wallet checks it again. The request is opaque to
Kernel and Kernel renders none of it.

The Wallet tile, not the background service, performs preparation. It reads
the exact live token metadata, decimals, fees, current allowance, destination
or spender, expiry, and maximum debit through the existing durable Wallet
funding core, then renders the existing Wallet surface/modal. Reject calls
`wallet_funding_reject_v1`, which may change only a `prepared` command to the
existing durable rejected state. It cannot relabel pending, dispatched, or
terminal work. Accept calls `wallet_funding_execute_v1` for the same command.

### Root-agent flow

The Wallet background also exposes `wallet_fund_root_v1` with the same public
funding request/result schemas and these restrictions:

```json
{
  "neutron:visibility": "same_app",
  "neutron:audience": "agent_root",
  "neutron:audit": "metadata_only"
}
```

Kernel makes this tool visible and dispatchable only to the incoming active
depth-zero root invocation, before creating a child invocation, and injects
`audience = "agent_root"`. Wallet requires that attestation. The handler uses
the same prepare/execute functions and exact preapproved self calls as the
human path, but opens no Wallet or Kernel UI. A human call, a normal app call,
or a nested agent call is rejected before Wallet dispatch. An agent-driven Swap
must have its root agent call this tool directly; the public human tool never
falls back to silent agent execution.

### Wallet execution and approvals

Keep one backend implementation for direct ICRC-1 transfer, ICRC-2 approval,
revoke, durable command replay/reconciliation, fee handling, and history. The
human tile and root tool are two policy entry points into that shared core, not
two transaction implementations.

The Wallet manifest preapproves only the exact Wallet methods it calls,
including existing `wallet_transfer` and the versioned funding prepare,
execute, reject, and allowance-page methods. Wallet's own Send/Withdraw and
revoke buttons are the trusted decisions and use `updateSelf`; they do not ask
Kernel for a second backend-call approval.

The existing Approvals screen remains Wallet-owned:

- use draft `icrc103_get_allowances` behind the isolated bounded adapter for
  selected/access-approved ICRC ledgers;
- use the existing ICP legacy allowance listing/removal adapter for the ICP
  ledger only;
- show exact spender/account, formatted amount, expiry, ledger, and revoke fee;
- use CAS-style `icrc2_approve(amount = 0, expected_allowance = current)` for
  standard revocation and refresh on an allowance race;
- never describe history-derived or inaccessible-ledger results as a complete
  global allowance list.

Another token standard should be implemented by another trusted Wallet using
the same generic provider-UI primitive. No token-standard branch belongs in
Kernel.

## Compatibility contract

The already-published public tool and legacy callback make partial upgrades
fail closed without breaking old callers:

| Kernel / Wallet | Required behavior |
| --- | --- |
| K323 / W306 | Immutable batch-36 behavior continues: the released Wallet uses its raw Kernel review callback. |
| K323 / W307 | Existing Wallet features continue; new `wallet_fund_v1` requires `presentUserInterface`, which K323 lacks, and fails before prepare or execution. |
| K324 / W306 | K324 retains only the deprecated `requestApproval` lane needed by released W306. Funding works with its legacy raw Kernel dialog. |
| K324 / W307 | Normal path: Wallet tile/modal owns the one human decision and Kernel shows zero dialogs. Root tool is UI-free. |

Existing apps remain compatible because the exact endpoint, tool name, request
schema, result schema, provider annotation, and caller identity semantics of
`wallet_fund_v1` do not change. Existing ordinary tools, grants, Agent flows,
attachments, control calls, and self calls retain their behavior. New closed
audience fields are optional for old tools and are rejected when malformed or
forged.

The legacy Kernel JSON-review fields and `requestApproval` implementation must
remain only to run immutable W306. New Wallet code and new documentation must
not invoke or present that path. Do not add a second Kernel dialog store,
Wallet-specific Kernel API, token-shaped Kernel type, or duplicate Wallet
transaction executor.

## Trust and security invariants

The owner explicitly trusts the exact installed Wallet package, including its
tile, background service, backend, manifest, and upgrades. That trust permits
Wallet to present financial meaning and then invoke its own preapproved methods.
Source-review agents are useful defense in depth, but do not replace runtime
bindings or Wallet validation.

Kernel still guarantees:

- one random, bounded, invocation-scoped capability bound to exact caller,
  provider, tool, arguments digest, sessions, installation scopes, endpoint
  versions, owner/auth state, cancellation, expiry, and Agent invocation;
- no preliminary grant, session-grant bypass, public presentation-tool access,
  cross-installation tile substitution, or reuse of either interaction
  callback;
- exact provider tile open/reuse/focus and closed audience attestation;
- direct-root provenance for the no-UI tool, with human and nested calls denied
  before target dispatch.

Wallet still guarantees:

- closed, bounded request parsing and caller identity derived only from SDK
  context;
- selected/reserved ledger validation, exact ICRC Accounts, live metadata and
  fee checks, short expiry bounds, and no caller-supplied display authority;
- one exact durable `(caller app, request ID, intent)` command, frozen Candid
  arguments before dispatch, safe duplicate/reconciliation handling, and no
  automatic fresh mutation after an ambiguous result;
- exact closed ledger methods only, no arbitrary canister/method execution;
- rejection incapable of changing dispatched or terminal state.

Swap remains responsible for its quote, minimum output, deadline, DEX call,
and post-funding result. Wallet provides the direct transfer or allowance
needed by that swap; Kitchen Sink deliberately does not pretend it can consume
an allowance whose spender is the governance canister.

## Contacts boundary regressions

Contacts correctly supplies the structural Candid ICRC Account
`{ owner : principal; subaccount : opt blob }`. The regression came from
running icblast's public generated JSON schema after arguments had already been
materialized against the exact installed live-Candid method. That public schema
projects some Account records as strings, producing the reported `oneOf`
failure for `internet_computer`.

The generic self-call fix is to make the installed live-Candid signature the
authority and remove the redundant generated-JSON-schema assertion after
materialization. Retain exact method/mode/arity and recursive
record/variant/option/vector/scalar checks, binary sidecar/path binding, IDL
encoding, and raw Candid size/depth/allocation/blob preflight. Preserve only the
generic string-record shorthand contract exposed by the pinned ICBlast release,
with no sidecar beneath it; ICBlast encoding and exact raw-Candid preflight must
still reject strings unsupported by the live method.

On the reply path, Kernel's established API-1 projection omits an empty
`subaccount : opt blob` field. Contacts must therefore accept the exact records
`{ owner }` and `{ owner, subaccount : null }`, treat both as the default
account, and continue accepting only a 32-byte `Uint8Array` when the subaccount
is present. Raw strings, explicit `undefined`, malformed owners, wrong-length
bytes, and extra fields remain invalid. This is a narrow Contacts parser fix;
do not change Kernel's generic option projection or the public Contacts tool
contract.

Tests must cover the reported principal
`togwv-zqaaa-aaaal-qr7aa-cai`, default and present 32-byte subaccounts, W306's
published shorthand, rejection of shorthand plus a binary sidecar, and the
strict malformed reply cases above. Together the two fixes preserve exact
live-Candid authority without weakening external canister-call validation or
adding token-specific Kernel behavior.

## Managed memory

This is a code-only successor release:

- Kernel keeps its released memory roots and versions unchanged.
- Wallet keeps both released roots, `wallet` v1 and `wallet_commands` v1,
  unchanged. `apps/wallet/backend/memory/wallet_commands/v1.mo` and the lock
  lineage published in W306 are immutable; do not edit them or add a fake
  migration.
- Kitchen Sink keeps its released memory declaration unchanged.
- Contacts keeps its released `contacts` v2 root, schemas, v1-to-v2 migration,
  and lock lineage unchanged; the 0.3.5 parser correction needs no migration.

Qualify fresh installation and a real state-preserving upgrade from the exact
published archives. W306 -> W307 must restore representative Wallet state and
prepared, pending, and terminal command records without calling an initializer
or migration for either v1 root.

## Lean implementation and cleanup checklist

- Reuse `provider_once` capability creation, the existing workspace tile
  open/focus functions, endpoint registration, scoped `updateSelf`, Wallet's
  existing app surface, durable funding journal, allowance adapters, amount
  formatter, and shared transaction executors.
- Add only the generic SDK presentation callback and closed audiences, the
  generic Kernel route, Wallet tile presentation tool/modal, root-only Wallet
  tool, and prepared-command rejection method needed by this design.
- Keep the deprecated raw-review path only where W306 compatibility requires
  it. Remove any new code, tests, or prose that makes it the normative path.
- Review `git diff origin/main` file by file. Remove unrelated changes,
  duplicate helpers, dead exports, copied codecs, stale tests, generated churn,
  and obsolete design prose. The unrelated Mail package-test shim is removed;
  Mail source, manifest, memory, and released 0.3.5 archive remain unchanged,
  and that archive is restored to its released digest.
- Keep the released `wallet_commands/v1.mo`, old archives, receipts, lock
  records, and historical release evidence unchanged.
- Keep all token display and app-specific policy out of Kernel. Kernel source
  and tests should refer only to a generic provider presentation.

## Required verification

### Focused contracts

- SDK: exact `provider_ui.present` envelope; closed request; shared one-use gate
  with legacy approval; only `foreground_tile` and `agent_root`; audience tools
  require `same_app`; missing, invalid, or mismatched audience fails before the
  handler.
- Kernel human path: validates public arguments first; shows no Kernel dialog;
  opens/reuses/focuses only Wallet's exact tile; passes the original caller;
  invokes only a same-app foreground tool; rejects capability/tool/tile/scope/
  session/version forgery, callback replay, timeout, cancellation, replacement,
  and provider return without interaction completion.
- Kernel root path: only an active incoming depth-zero root can list/call the
  tool; human and nested attempts fail before endpoint dispatch; exact
  `agent_root` is injected; no Wallet or Kernel UI is opened.
- Legacy: K324/W306 still completes through the deprecated callback; the new
  W307 path never calls it; one invocation cannot call both callbacks.
- Wallet: background presentation happens before every prepare; tile/root
  audiences are checked; one modal Accept executes exactly once; Reject makes
  no ledger call; close/cancel safely rejects prepared work; pending and
  terminal replay cannot create a second mutation; direct and allowance facts
  are formatted from authoritative ledger data.
- Wallet approvals: bounded ICRC-103 and ICP pagination, exact source filtering,
  cursor progress, unsupported/reservation-required states, CAS revoke races,
  ambiguous ICP removal, and refresh after success.
- Contacts: structural default/present-subaccount calls work and malformed
  shapes, sidecars, Candid bytes, and returned account records still fail
  closed; missing and explicit-null returned subaccounts both normalize to the
  owner principal.

### Integration and browser gates

- Run all old-app compatibility suites and the four-version matrix above.
- Upgrade exact K323/W306/Kitchen305 installations to the corrective set
  through the checked product update path and verify durable state.
- Kitchen Sink direct: click once, Wallet opens/focuses, Wallet shows ICP,
  0.01, live fees, exact governance destination, Accept once, and the exact
  ledger balance delta occurs once.
- Kitchen Sink allowance: Wallet shows exact governance spender, current/new
  allowance, fees, five-minute expiry, and maximum debit; Accept once; query
  the exact live allowance; Kitchen Sink never calls `transfer_from`.
- Reject both routes and prove no transfer/allowance mutation.
- Assert zero `frontend-tool-dialog`, Kernel call dialog, and backend dialog on
  K324/W307 human flows; assert zero Wallet and Kernel UI for the root flow.
- Exercise Wallet Send/Withdraw and Approvals revoke with one Wallet decision
  and no Kernel dialog.
- Exercise Contacts add/edit with both default and non-default IC subaccounts.

### Repository and release commands

At minimum, rerun on the frozen final tree:

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

Then run each complete package workflow, not a lower-level pack script:

```sh
npm --workspace neutron-kernel run package
npm --workspace neutron-wallet run package
npm --workspace neutron-kitchensink run package
```

Also rerun each app's release-specific memory, Motoko, browser/PocketIC, Kernel
candidate-binding, certified-assets, and exact-archive compatibility gates.
Record command, result, exact archive path, byte length, SHA-256, and offered
source for the final candidates. A passing intermediate tree or package build
is not final release evidence.

## Release procedure

1. Complete the diff cleanup and security review; freeze source and tests.
2. Prove unchanged memory roots with fresh and exact-production upgrade tests.
3. Set manifests to exactly Kernel 324, Wallet 307, and Kitchen Sink 306 while
   retaining production `update_source` `233tv-xiaaa-aaaay-aacta-cai`.
4. Run all qualification and complete package commands against the same final
   source. Do not reuse or overwrite K323/W306/Kitchen305 bytes.
5. Update only active archive references and generated repository data from the
   exact successor archives. Preserve immutable historical archives and restore
   exact released dependency artifacts before any repository generation; do
   not repackage an old version.
6. Review the three archives and their offered-source artifacts, then publish
   Kernel 324, Wallet 307, and Kitchen Sink 306 together in one catalog
   transaction with `npm run updates:publish`.
7. Rerun that command against the exact same bytes. Require `batch_id: null`
   and every package/source row `unchanged`, with matching version, path, size,
   URL, and SHA-256.
8. Commit and push the reviewed result to PR #13 with the exact qualification
   and publication evidence.

Do not publish a Kernel-first phase, rebuild after an ambiguous publication,
or update/stage the Dispenser starter unless that separate rollout is
explicitly requested.

## Deferred

- Wallet-operated DEX execution, quote validation, or swap settlement.
- Standing/unlimited allowances, caller-selected long expiries, automatic
  post-swap revoke, and per-agent budgets.
- Native-chain and ERC-20 cross-app withdrawal protocols.
- Global allowance discovery for ledgers Wallet has never selected or cannot
  access.
- Generic wallet-provider discovery or wildcard tool listing.

These can be added later without changing the token-agnostic Kernel boundary.
