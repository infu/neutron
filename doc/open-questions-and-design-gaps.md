# Open Questions And Design Gaps

[Back to documentation index](./index.md)

This page synthesizes cross-cutting gaps from the expanded docs, root project
notes, and the relevant implementation paths. It is not a replacement for the
topic-specific docs; it collects the design questions that affect more than one
part of the system.

## Source Notes

Implementation facts below are drawn from the current repository state,
especially:

- [Security Model](./security-model.md)
- [Compiler And Actor Assembly](./compiler-and-actor-assembly.md)
- [Kernel Frontend Runtime](./kernel-frontend-runtime.md)
- [Kernel-App Communication](./kernel-app-communication.md)
- [Kernel Backend Runtime](./kernel-backend-runtime.md)
- [App Package Format](./app-package-format.md)
- [App-Isolated Chain-Key Assertion Signing](./app-isolated-chain-key-signing.md)
- [App-Isolated Stable Store](./app-isolated-stable-store.md)
- [Asset Storage And HTTP Serving](./asset-storage-and-http-serving.md)
- [Dispenser And Provisioning](./dispenser-and-provisioning.md)
- `README.md`
- `packages/neutron-security/`

Risk statements are inferences from those facts. They should be validated with
maintainers before becoming roadmap commitments.

## Implementation Facts

### Managed Memory Follow-Ups

- Format-3 manifests now provide immutable schema roots, migration DAGs, exact
  foreign requirements, global ownership checks, native Motoko migrations,
  stable-signature preflight, retirement, and full app uninstall.
- Migration execution is deliberately synchronous and bounded. Large online
  state transformations remain an app-level schema design problem.
- Memory ownership is tied to installed manifest state and content hashes, not
  to a publisher identity. Package provenance and signature policy remain open.
- Larger dynamic records now have the separate app-isolated `stable_store`
  development implementation. Its maximum-state upgrade, incremental-GC heap
  reuse, instruction, latency, and cycle benchmarks remain open release
  evidence; raw Regions and pointers remain blocked.

### Package Signing And Authenticity

- A `.neutron` package is a MessagePack map of gzip-compressed files from
  `dist/`.
- Motoko files are content-addressed and install-time code verifies that
  `mo/<sha256>.mo` filenames match decompressed file content.
- The manifest is validated against the shared JSON schema before install, and
  configs are validated again during browser compilation.
- No package-level signature, publisher identity, DAO/canister signature,
  trust root, revocation metadata, or signed manifest envelope was found in the
  install path.
- No canister/DAO package signature or authenticity-verification policy is
  implemented.

### Security Enforcement

- Security checks look for dangerous Motoko text and AST patterns such as actor
  creation, raw calls, cycles attachment, certified-data APIs, and direct stable
  memory primitives.
- The developer packaging and browser/CLI compile paths reject dangerous
  findings for non-whitelisted ordinary-app modules.
- The browser/CLI compile path returns a `danger` map and rejects non-whitelisted
  findings for ordinary app, schema, and selected migration roots.
- The install approval dialog currently shows manifest-derived permissions,
  package size, and compile status. Dangerous code is rejected before approval
  can complete.
- Generated ordinary-app query/update wrapper methods that exist assert
  `NeutronKernel.is_authorized(NeutronCaller)`. A synchronous handler used
  exclusively by paid canister public-ingress routes may opt into the exact
  handler-scoped `public_ingress_cycles` argument; that route-only opt-in emits
  no ordinary wrapper. `allow: "unauthorized"` is reserved for reviewed kernel
  entrypoints.
- Ordinary apps expose exact public Candid protocols only through
  `capabilities.public_ingress`. Queries retain declared caller policies;
  direct authenticated updates require a self-authenticating ingress principal
  and forbid payment, while canister updates require a positive static
  attached-cycle base charge and trap underpayment. The ambiguous legacy value `allow: "any"`,
  ordinary-app `allow`, and `allow` on internal functions are rejected before
  installation.
- The paid-handler binding is a generated function argument, never an
  app-environment field, and the canonical generated order with caller access
  is `["caller", "public_ingress_cycles"]`. Its `available()` value subtracts
  prior cumulative requests, over-request traps, and neither operation accepts
  cycles. The static floor is accepted before later admission and remains
  retained if that later admission rejects. After a handler mutation commits,
  the outer dispatcher attempts a requested supplement only after live
  route/lease/fingerprint/epoch/completion checks; the attempt is best-effort,
  non-atomic, and omitted after post-dispatch revocation.

### Request Windows And App Usage Accounting

- Every public-ingress update checks any declared real-caller fixed-hour
  window before its shared route/app/global windows. A successfully admitted
  call increments caller and shared counters together; caller-window rejection
  consumes no shared capacity. HTTP gateway POST windows remain
  limited to callers outside the
  kernel-authorized set; an authorized direct POST caller is neither limited
  nor counted. Query caller policies still apply to everyone.
- Other kernel capabilities have no temporal request-rate limits. Randomness,
  HTTPS outcalls, chain-key signing, Stable Store, vetKeys, backend calls,
  certified writes, and scheduled invocation handles retain payload/storage
  quotas, CAS, concurrency/in-flight bounds, per-invocation attenuation,
  per-call cost ceilings, low-cycle reserves, and replay/capacity safety where
  appropriate. Backend calls additionally have manifest-owned gross per-call
  and charged-plus-unresolved UTC-day cycle-transfer ceilings; zero-cycle calls
  do not consume a request window.
- Compiler-generated wrappers meter ordinary app updates, scheduled callbacks,
  and public-ingress/HTTP POST broker and handler messages with call-context
  performance counter `1`. The same exact installation owns a separate net
  explicit outgoing-cycle total fed by paid brokers and a separate accepted
  incoming-cycle total for paid public updates. Queries are excluded,
  nested canister execution is independently metered where wrapped, and a trap
  rolls back the final per-message instruction accounting for the trapping
  message; broker-owned transfer and income records follow their own persisted
  lifecycle. The raw instruction and outgoing-cycle fields remain separately
  typed. Installed Apps uses the low-side 13-node rates of
  one cycle per instruction, 5,000,000 cycles per measured update execution,
  1,200,000 cycles of ingress reception per owner-authorized or
  direct-authenticated update, and 260,000 cycles per brokered call or measured
  timer/handler self-call plus net explicit transfers for its four-decimal `TC`
  overview. Paid canister updates omit the ingress fee; direct authenticated
  ingress records it. Variable byte fees,
  response-callback bases, shared global-timer dispatch, storage, billing-grade
  trap attribution, and exact canister burn remain unsolved.

### MessagePort And Browser Isolation

- Under the browser-surface-origin runtime, a selected ordinary package becomes eligible
  for originful surfaces only when it contains the generic packer-owned
  `.neutron/browser-surface-origins.v1.json` marker or declares the inherently
  new `browser_permissions` capability. The checked install transaction
  copies the complete package, certifies its surface hosts, and records the
  app in `/system/browser-surface-origins.json`; there are no app-name or
  version exceptions.
- Each eligible installation derives a separate exact origin for every tile
  ID, tray, and ordinary background from its browser nonce. Those surfaces run
  in credentialless `sandbox="allow-scripts allow-same-origin"` iframes while
  remaining cross-origin from the Kernel. Historical packages without the
  readiness evidence, the explicit predecessor bridge, and the unsupported-browser fallback
  retain credentialless `sandbox="allow-scripts"` frames with opaque
  `origin: "null"`. Backgrounds may instead use one of the mutually exclusive
  credentialless-ephemeral or persistent dedicated modes specified in
  [Dedicated Resident Origins](./kernel-http-v2-and-certified-assets.md#dedicated-resident-origins).
- Browser features are denied by default. The closed V1
  `browser_permissions` manifest capability may request only `camera` and
  `microphone` for exact tile IDs. After install/update review, the Kernel
  delegates only the accepted features through intersecting Host-bound child
  and exact iframe policies; the tile uses browser media APIs directly, and
  the browser or operating system retains the final permission decision. No
  media-session backend is involved, and tray/background delegation is not
  available in V1.
- For an originful frame, the kernel binds the handshake to both its registered
  `contentWindow` and exact expected origin, then transfers a private
  `MessagePort`. Retained opaque frames remain source/port-bound, but their
  indistinguishable `origin: "null"` and retained `WindowProxy` cannot prove a
  cryptographically distinct document generation across reload; observed
  loads retire and reprobe the port. All operational traffic uses the current
  private port.
- Tool arguments/results are draft-07 validated and JSON/size/time/concurrency
  bounded. Same-app calls are automatic. Ordinary cross-app calls require a
  one-call or session grant and are audited in memory. An exact
  `provider_once` tool instead requires the target provider to prepare one
  bounded review and consume its invocation-scoped callback before returning;
  that decision ignores session grants, creates no grant, and is routed to the
  owner or live root agent.
- The launcher checks required iframe/Window credentialless state and fails
  closed on a mismatch. Persistent grant management, storage quotas, and
  uninstall cleanup remain open.

### App Install, Uninstall, And Versioning

- Install and uninstall use one stable staged journal, runtime verification,
  idempotent promotion, app-prefix cleanup, credential cleanup, and module GC.
- Settings exposes reviewed, atomic deletion of the selected app set, and the
  workspace removes every tile belonging to those apps after verified commit.
  The launcher exposes no deletion control, and the developer CLI has no
  package-level uninstall command.
- Public Candid methods live in one generated actor, but ordinary-app wrappers
  that exist now use a deterministic `app_<id>__<method>` physical name.
  Route-only handlers opting into `public_ingress_cycles` have no such wrapper
  or compatibility alias. Logical method names remain app-local, while kernel
  methods stay unmangled. A future friendly global alias would need a separate
  reservation and lifecycle model; V1 creates no compatibility alias.
- Managed memory rejects downgrades and incompatible lineage. App releases use
  packed semantic versions beginning at `0.1.0` (`100`): browser updates must
  be strictly higher, trusted local development may redeploy an equal version,
  and all paths reject downgrades. Shared-function compatibility remains an
  app/provider contract beyond the enforced `min_version`, export, and Motoko
  type checks.
- `kernel_install_code` accepts Candid but the management call ignores it;
  staged commit stores the matching compiled Candid after actor verification.

### Dispenser, Provisioning, And Ownership

- The product invariant is one Neutron canister for one human owner. There are
  no additional users, teams, roles, or per-user partitions inside an instance.
- The dispenser frontend generates a local Ed25519 provisioning identity and
  independent activation code. It stores both in local storage before exposing
  the caller-derived ICP account, so reloads resume the same registration.
- The dispenser maps that signed caller principal to one activation hash,
  durable provisioning phase, and eventual Neutron canister id.
- The frontend renders one caller-derived ledger account in canonical ICRC-1
  and legacy account-identifier formats. Both frontend and backend enforce a
  `2 ICP` minimum; the UI asks for one transfer of 2 ICP or more, polls the
  ledger, and automatically starts or resumes provisioning.
- Provisioning sends the full observed balance less the ledger fee to the
  official CMC for burning and conversion to cycles. There is no change output
  or later sweep into an already-created canister.
- The dispenser creates canisters through ledger and CMC calls, installs a
  global starter Wasm, seeds global starter files, arms the kernel activation
  hash, and retires its authorization and controller authority.
- Atomic staged starter-maintenance methods verify the caller against the
  dispenser's actual controller list through `canister_info`; direct
  Wasm/runtime/file mutators do not exist.
- A commit publishes one immutable, monotonic starter revision. A funded
  registration retains that exact Wasm/runtime/files value across awaits even
  if a controller publishes a newer current starter, then releases the heavy
  value after seeding. The selected production payload contains the Kernel and
  source-bearing app manifests tied to the certified production updater; its
  authoritative inventory is in
  [Dispenser And Provisioning](./dispenser-and-provisioning.md).
- Completed Neutrons retain only their own canister principal as IC controller.
- `kernel_activation` is one public update with `#set(hash)` and `#use(code)`.
  Controllers alone can arm it. A valid code atomically authorizes the actual
  Neutron-origin caller and destroys the activation hash.
- The flat authorization set currently mixes the owner with installer/self
  authorities and has no labels or roles. Settings now manages additional
  entries as equivalent full-trust credentials for the same human owner and
  separately manages IC controllers; neither list is multi-user membership.
- The raw activation code remains a bearer until consumed. It is held in the
  dispenser origin's local storage and transferred in a fragment that the
  kernel strips before Internet Identity startup; only its SHA-256 hash is
  stored on the backend.
- Durable phases and fixed ledger transaction metadata recover duplicate
  transfers, CMC processing, lost install replies, replayable asset writes, and
  a lost final controller-removal reply.
- The current CMC create request leaves `subnet_type` null and selects one
  immutable target subnet supplied when the Dispenser backend is installed.
  Production deployment supplies the reviewed `re2t4…-zae` subnet; local
  deployment supplies the Application subnet attested by the supervised
  PocketIC runtime. There is no per-user selection, fallback, or multi-subnet
  policy.
- No delete, ownership-transfer, recovery, or registry-removal flow exists in
  the dispenser backend.

### Testing And Documentation

- The repository has focused dispenser tests for account derivation, secret
  persistence, handoff validation, provisioning-state shape, starter
  authorization, frontend/backend mapping, and compilation. A paid
  deposit-to-activation mainnet run is still separate release evidence.
- The security package has fixture-checking code for allowed and disallowed
  Motoko AST patterns, but text-check fixtures are still missing.
- `apps/kernel/test/config_perm.test.ts` covers permission output.
- Expanded docs now cover the major implementation, operations, product, and
  testing areas, but many of those docs still identify behavior that needs
  source-level clarification or automated verification.

## Inferred Risks

### Memory And Upgrade Risk

Managed memory now has explicit immutable schemas, migration paths, ownership,
and stable-signature checks. Because app code is assembled into one actor, app
authors still need realistic migration fixtures: a semantically wrong but
type-correct migration can affect the whole Neutron canister.

Private memory is an enforced app-id ownership boundary. Cross-app composition
uses declared internal function dependencies. The remaining trust question is
package authorship, not memory injection authority.

### Authenticity Risk

Content hashes protect individual Motoko module integrity after packaging, but
they do not answer who authored or approved the package. A user can install a
package that is structurally valid and content-consistent without any verified
publisher or DAO signature.

Direct-root installed-artifact inspection improves review of an exact current
installation, including Wallet and Swap code, but remains defense in depth.
The catalog is transformed build output: frontend bundles may be minified and
generated, unretained, or binary material may be unavailable. A favorable
review cannot replace AppScope isolation, exact runtime decisions, amount and
account validation, or durable ambiguous-outcome handling.

### Security Gate Risk

The install compiler hard-rejects dangerous AST findings for ordinary apps.
The effective security boundary still depends on those checks remaining
complete enough to catch Motoko escape paths and on reviewed package/library
whitelists.

Ordinary-app public exposure is disclosed from exact normalized
`public_ingress` routes, while kernel-only `"unauthorized"` remains a reviewed
root-package fact. The remaining security-gate risk is that static
dangerous-code detection and reviewed dependency whitelists must continue to
cover every Motoko escape path; permission disclosure does not replace
compiler enforcement.

### Browser Boundary Risk

The kernel frontend is the trusted parent window and holds the authenticated
icblast identity. The message bus has exact-origin and source/port binding for
adopted originful frames, retained source/port binding for legacy opaque
frames, schema validation, and cross-app approval. An opaque frame's
`origin: "null"` cannot distinguish document generations behind a retained
`WindowProxy` across reload, so that compatibility path remains a lifecycle
risk and never receives camera or microphone delegation. Other remaining risk
is concentrated in unsupported browser behavior, unbounded browser resources,
and hostile tool metadata shown to an AI agent. The direct canister `call`
action remains unavailable.

`provider_once` adds provider-authored review content to trusted Kernel chrome.
That content is bounded canonical JSON rendered as inert text and visibly
attributed to the exact provider; it never becomes HTML, policy, identity, or
backend arguments. Kernel binds the one-use callback to both endpoint sessions,
versions, AppScopes, cancellation, and Agent invocation. The residual risk is
intentional: an owner-trusted provider could misuse its own preapproved
authority without requesting the review, just as its resident could misuse
that authority independently. Source review and install disclosure help the
owner decide whether to trust that package, but Kernel does not understand or
prove provider-specific ordering.

### Install Consistency Risk

App install stages mutable assets and uses a persistent journal around actor
activation and metadata promotion. Remaining risk is recovery behavior across
replica/browser failure combinations and long-term garbage collection of
unreferenced content-addressed Motoko modules.

Backend dependency versions are minimum versions with a documented monotonic
provider contract. Neutron checks current metadata and Motoko types but cannot
prove semantic compatibility.

### Threshold Signing Boundary

- Development V1 now exposes only app-installation-scoped, domain-separated
  assertion signing. It deliberately omits caller-selected digests, threshold
  key names, derivation paths, BIP341 auxiliary data, cycle attachment,
  transactions, and automatic retries.
- This closes the generic chain-key slice; it does **not** answer how a future
  Kernel-provided raw Bitcoin, EVM, Solana, credential, or package-signing
  adapter should encode and present its protocol-specific operation.
- A future raw threshold-transaction signing adapter must require
  transaction-shaped bounds and one-shot owner presence immediately before
  signing. An install-time `chain_key_signing` grant or ordinary agent/tool
  grant cannot be reused as that consent.
- This stricter raw-signing rule does not prohibit an exact installed Wallet
  app from owning another protocol's semantics, preparing a bounded
  `provider_once` review, and exercising only its own preapproved backend
  methods. ICRC Wallet funding follows that app-level model and adds no raw
  transaction signer to Kernel.
- `canister_signatures` remain a separate proposed capability because their
  certificate-tree, seed, witness, expiry, and verification model is not the
  threshold ECDSA/Schnorr broker.

### Provisioning And Ownership Risk

The dispenser is a privileged bootstrap component. Its controller-gated global
starter state determines the Wasm and initial assets of every new instance, so
compromise of a dispenser controller is still a supply-chain compromise.

The browser's local Ed25519 key controls access to deposited ICP and the
durable registration, while the independent activation code controls the
one-time kernel handoff. Local storage makes refresh recovery possible but is
readable by same-origin script and can be erased. There is no server-side or
human recovery path if either value is lost before activation.

Completed instances remove the dispenser from both kernel authorization and IC
controllers. Recovery therefore depends on the authorized Internet Identity
principal, additional owner credentials/controllers the user later configures,
and the Neutron self-controller path; the shared dispenser cannot repair a
completed instance.

### Verification Risk

The project has broad fast checks plus local provisioner/browser evidence.
Dispenser helper, compilation, authority-boundary, and retry structure are
repeatable, but the paid CMC flow—including ambiguous ledger/CMC replies,
activation, and final controller retirement—still needs controlled end-to-end
release evidence. Certified package updates likewise still need a real local
fixture publish/discover/review/deploy browser test.

## Near-Term Clarification Questions

1. What package signature format and trust roots should Neutron support first?
2. Should unsigned packages be blocked, warned, or allowed only in developer
   mode?
3. Are dangerous Motoko findings intended to block packaging as well as
   browser install, or only the final install compile?
4. Which caller allowlist or proof-of-work policy, if any, should complement
   the implemented paid `public_ingress` update protocol?
5. What browser features are mandatory for app isolation, and how should the
   kernel detect and reject unsupported browsers?
6. Which frontend message-bus grants, if any, should persist across page
   reloads, and where should users review or revoke them?
7. What enforceable CPU, memory, network-byte, and GPU bounds should the kernel
   apply to resident browser processes without introducing capability request
   windows for the authorized user?
8. Should the backend verify or store `/pkg/neutron.did` as part of
    `kernel_install_code` instead of trusting the frontend write order?
9. Which principals or governance canister should control the dispenser's
    global starter Wasm and files in production?
10. Should the dispenser offer an encrypted/exportable backup of the local
    provisioning key and activation code, or is browser-profile loss an
    accepted pre-activation failure mode?
12. What operator/user recovery is appropriate for non-retriable CMC refunds,
    invalid notifications, or a controller list changed outside the durable
    handoff?
13. What is the intended subnet selection and multi-dispenser routing model?
14. Which automated tests are required before treating app install and security
    enforcement as production-ready?
15. If Kernel ever gains a raw threshold-transaction adapter, which network
    should be first, and which exact fields, value/network limits, one-shot
    owner-presence proof, simulation evidence, and ambiguous-outcome recovery
    must its Kernel confirmation bind?
16. Should package authenticity use IC canister signatures, threshold signing,
    or an external publisher scheme, and how should that trust root remain
    distinct from an installed app's assertion key?
17. What separate authority, budgets, recovery, and revocation model would be
    required before Agent Mode could start unattended background roots? The
    current `provider_once` Wallet flow is automatic only inside an
    owner-started live root turn.
