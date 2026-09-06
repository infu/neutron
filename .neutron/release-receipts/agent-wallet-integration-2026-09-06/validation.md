# Agent, Wallet and Uniswap integration release

Published atomically in batch 57: Kernel 344, Agent 318, IC Wallet 317, EVM Wallet 111, Uniswap 108. The identical-byte receipt-v2 postflight returned `batch_id: null`; all 18 package/source pairs are unchanged and match local identities. See [publication](production-publish.json), [no-op](production-publish-noop.json), and [verification](receipt-verification.json).

## Installation

Update Kernel and reload first, then update the apps. The exact published Kernel 343 validator rejects the new frontend_tools capability; it accepts the successor Kernel manifest. The successor validator accepts the app declarations. No compatibility shim or installation bypass was added. See kernel-installation-order.json and its reproducible script. All five packages are published together, without a separate Kernel-first publication phase.

## Changes

- Generic install-reviewed frontend_tools declarations name exact installed app IDs and tools. Runtime uses the approved capability plan and rechecks live endpoint/installation identity. No new backend registry, durable schema, quota, or app-specific Kernel routing was added. Private/root-only tools retain their audience rules.
- Public provider transactions during Agent invocations submit a fresh exact review to the root permission judge. The one-shot capability binds the caller, provider and provider child invocation. Ordinary users retain the Wallet transaction dialog. Direct root tools remain compatible.
- Agent permission context retains original owner messages and later steering, including retries and cancellations. It no longer blanket-denies sensitive but requested actions or invents authorization phrases. Model-window handling excludes assistant/tool messages as authority.
- Uniswap connects using its install-declared tools and refreshes automatically. The new uniswap_swap_v1 tool drives quoting, allowance approval, swap submission and receipt tracking, with a durable caller-bound flow identity. Earlier root-owned intents retain their existing continuation tools.
- EVM Wallet reviews expose exact bytes plus the same token/swap interpretation shown to an owner. Latest contract reads retry one missing-header observation with a newly read block; explicit historical reads and transaction broadcasts are not replayed by that read retry.
- IC Wallet wrapping uses a compact form and three progress steps. Old attempts are in closed Activity; unfinished requests have a Continue shortcut. Completed approval is retained when a later contract read fails. Ordinary allowance reads avoid fetching contract code. Confirmed deposits refresh mint status without initiating another transaction.

## State and validation

The managed-memory audit verifies all 11 roots, 134 backend files, 13 schema/migration files and five lock files against the exact published package/source baselines. Of those backend files, 133 remain identical; the only difference is the generated Kernel transient inventory line carrying the new release version and capability-plan fingerprint. All persistent schemas and lineage remain unchanged; no migration is needed. Clean initialization, same-schema restoration and the existing Kernel v3-to-v4 path pass the recorded memory tests.

Financial execution tests use mock wallets/RPC results and local test programs. The deposit browser check covers 12 states at 375px and 700px. No production transaction, production installation, reset or Dispenser update is performed by this release workflow.

Release checks:

- Complete workspace package commands passed for all five apps.
- Kernel message-bus fixture: 131 passed, including exact manifest grants and fresh Agent provider reviews. The remaining Kernel suite passed 671 cases; its one stale generated candidate-binding assertion was resolved after the canonical versioned build and binding regeneration. Final package/install/binding verification: 44 passed.
- Agent complete Bun suite: 129 passed.
- IC Wallet complete Bun suite: 173 passed.
- EVM Wallet complete Bun suite: 116 passed, including compiled local backend recovery programs; browser sandbox: 22 checks passed.
- Uniswap complete Bun suite: 116 passed, plus 10 mocked browser scenarios.
- App/SDK/Kernel TypeScript and focused SDK capability checks passed during implementation. The relevant memory programs passed as recorded in memory-audit.json.

All final package and offered-source identities are in preflight.json. It checks the five strictly higher successor versions and proves every other catalog row remains byte-identical to the previously reviewed 18-entry catalog.
