# Open Questions And Design Gaps

[Back to documentation index](./index.md)

Use this page to identify unresolved trust boundaries and the source needed to
investigate them. Topic documents describe implemented contracts. This page
does not authorize new restrictions, declare a release qualified, or maintain
a backlog. Put task-specific plans and TODO files in gitignored `tmp/`.

Before treating a gap as current, inspect its owning implementation and tests.
A test file establishes coverage intent; only a result tied to the candidate
bytes establishes that a release passed. Historical receipts and transient
test counts do not belong in this reference.

## Source Entry Points

| Boundary | Inspect |
| --- | --- |
| Package bytes, installed state, and upgrade planning | `packages/neutron-compiler/src/package_decoder.ts`, `install.ts`, `memory_migrations.ts` |
| Package/deployment records | `packages/neutron-tools/src/package_record.ts`, `packages/neutron-compiler/src/deployment_record.ts` |
| Motoko enforcement | `packages/neutron-security/src/`, its fixtures and tests |
| Frame identity and tool authority | `apps/kernel/src/app_frame_security.ts`, `frame_context.ts`, `expose.ts` |
| External discovery and approval | `apps/kernel/src/reducer/auth.ts`, `apps/kernel/src/expose.ts` |
| Update discovery and certification | `apps/kernel/src/updates/client.ts` |
| Install recovery | `apps/kernel/backend/install/Service.mo`, `packages/neutron-compiler/src/install.ts` |
| Signing domains and custody | `apps/kernel/backend/chain_key_signing/`, `wallet_custody_signing/` |
| Usage attribution | `apps/kernel/backend/app_usage/Service.mo`, `apps/kernel/src/settings/AppUsagePanel.tsx` |
| Provisioning and owner handoff | `support/dispenser/mo/main.mo`, `support/dispenser/src/provisioning.ts`, `apps/kernel/backend/activation/Service.mo` |

## Memory And Upgrade Risk

Managed memory validates immutable schema history, ownership, and a unique
supported forward migration path. Those checks cannot prove that a
type-correct transformation preserves the meaning of stored data. Because
backends share one actor, migration tests must exercise representative retained
data and the whole checked installation transaction.

Use [Managed Memory Migrations And Uninstall](./memory-migrations-and-uninstall.md)
for the release contract. Larger app state can use
[App-Isolated Stable Store](./app-isolated-stable-store.md); assess realistic
capacity, upgrade cost, and cleanup behavior with the target implementation.
Do not turn a past benchmark or a development-status label into a claim about
the current release. Destructive reinstall is not migration or recovery for
production user data.

## Authenticity Risk

Module hashes, package records, deployment records, and certified repository
responses bind particular bytes and provenance. They do not by themselves
establish a general cryptographic publisher-signature policy for arbitrary
packages. Distinguish transport/repository authenticity, content integrity,
license declarations, and trust in the app author when reviewing an install.

Source inspection helps review an exact installed package, but generated
bundles and retained artifacts have different inspection limits. It does not
replace app isolation, permission enforcement, amount/account validation, or
recovery of uncertain effects. See [License And Deployment Records](./license-and-deployment-records.md)
and [Security Model](./security-model.md).

Any future package-signature design needs explicit trust roots, revocation,
and ownership semantics. This document does not select a signing scheme or
authorize blocking unsigned packages.

## Security Gate Risk

The compiler rejects dangerous ordinary-app Motoko findings and projects only
declared capabilities. Soundness still depends on the checker, the compiler,
reviewed dependency exemptions, and generated wrappers agreeing about
authority. A new language construct or library change must be evaluated at
that boundary, not merely added to an allowlist to make packaging pass.

Public-ingress declarations and owner approval disclose and constrain access;
they do not replace compilation enforcement. Use the checked-in security
fixtures and the actual packaging/compiler entrypoints when testing a change.
The current gates are implemented behavior, not an unresolved choice about
whether dangerous findings should be rejected.

## Browser Boundary Risk

The Kernel parent holds authenticated browser authority. Exact-origin app
frames bind their handshake to the registered window and expected origin.
The legacy/unsupported-browser opaque path cannot distinguish documents that
share a retained `WindowProxy` and report `origin: "null"`. A replacement site
reached by navigation inside an app frame can receive a new port attributed to
the original app. This is separate from HTTP sandbox protection of Kernel
storage.

[Deprecated Compatibility Paths](./deprecated.md) records planned removal of
both Kernel-host app content and opaque-frame compatibility. Package adoption
alone does not settle unsupported-browser behavior. Do not describe removal
as enforced or quietly change browser support while editing documentation.

Owner-trusted provider apps also retain a deliberate trust boundary:
`provider_once` binds the invocation and its private provider UI, but the
provider controls its domain presentation and preapproved backend authority.
The Kernel does not prove the provider's financial interpretation.
`agent_root` applies only to an admitted live root invocation; it is not
standing permission for unattended work. See
[App Method Access And Call Consent](./app-method-access-and-call-consent.md).

## External Calls And Update Evidence

The legacy external-canister routes can discover an interface using the
owner's identity before operation approval, review arguments before conversion,
and retain a dialog after caller cancellation. Their v2 replacements improve
those boundaries; they cannot undo a mutation dispatched before cancellation.

The update client also accepts responses whose certification headers are both
hidden from browser code. That compatibility exception weakens the visible
full-certification requirement. The planned replacement requires compatible
source headers and a Kernel acceptance change. Read the precise conditions in
[Deprecated Compatibility Paths](./deprecated.md); do not infer that every
current update source is affected.

## Install Consistency Risk

A staged journal spans asset staging, actor replacement, runtime verification,
and metadata promotion. Review recovery across each await and interruption,
including ambiguous management-call replies and cleanup after promotion.
A successful compilation alone proves none of those transitions.

Backend dependency metadata and Motoko type checks also cannot prove semantic
compatibility of a provider's new implementation. Keep provider contracts
monotonic or expose a deliberate new API. See
[Backend App Dependencies](./backend-app-dependencies.md).

## Threshold Signing Boundary

The implemented signing capabilities have different purposes:
`chain_key_signing` signs a domain-separated app assertion, while
`wallet_custody_signing` permits an explicitly trusted wallet to sign an exact
digest. Do not treat the assertion grant as custody authority or describe
custody as an unimplemented future adapter.

Key identity and live installation authority have different lifecycles.
Read the namespace implementation and
[App-Isolated Chain-Key Signing](./app-isolated-chain-key-signing.md) before
changing derivation, reinstall behavior, or wallet recovery. Retained pending
transactions and ambiguous signing/broadcast outcomes need app-level durable
handling. A future signing protocol needs an explicit authority and recovery
design; this page does not impose a new generic confirmation policy.

## Provisioning And Ownership Risk

The Dispenser's controller-approved starter determines new-instance code and
initial assets. Inspect the selected starter manifest and its publication
workflow rather than copying a live controller list, subnet, app inventory, or
funding threshold into architecture docs.

The local provisioning identity controls the durable registration; the
independent activation code controls the one-time owner handoff. Browser
storage enables reload recovery but is not a backup. Completed instances retire
the Dispenser's authority, so it cannot act as a standing recovery administrator.
Use [Dispenser And Provisioning](./dispenser-and-provisioning.md) for the exact
flow and [Production Provisioning](./production-provisioning.md) for operator
constraints.

Before proposing a recovery or ownership feature, distinguish an unfinished
registration, an uncertain external call, lost local secrets, and a completed
sovereign instance. They require different authority and evidence.

## Usage And Verification Limits

App usage counters attribute measured execution and explicit cycle transfers.
The UI estimate is not an authoritative canister bill: runtime pricing,
unmeasured overhead, traps, callbacks, and shared costs need separate analysis.
Read current formulas and counters from their owners instead of freezing prices
or display precision here.

For release evidence, select tests by the contract and failure paths changed.
Unit checks, browser fixtures, local-replica integrations, and production
observations prove different things. The existence of a wrapper or a past
receipt does not establish an end-to-end paid provisioning, upgrade, or
transaction recovery result for new bytes. See
[Testing And Verification](./testing-and-verification.md).

Unresolved product policy belongs with the owner. In particular, audit advice
does not authorize new Kernel quotas, cooldowns, focus requirements, persistent
grants, or unattended agent authority; follow `AGENTS.md`.
