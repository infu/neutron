# Deprecated Compatibility Paths

The compatibility paths below are planned for removal. New apps should use the
replacements described here, and existing apps should migrate in future
releases. Do not add new dependencies on these legacy paths or assume that
their continued availability is a supported long-term integration contract.

This document records the removal plan; it does not change current runtime
behavior. No removal date or Kernel release has been set. Removal must account
for installed apps, existing links, browser support, and durable user data.

## App Content On The Kernel Hostname

**To be removed:** the compatibility hosting of app-owned assets and public
content on the Kernel hostname, including Kernel-host `/app/<app-id>/...` URLs.
The intended serving model reserves the Kernel origin for Kernel-controlled
content and serves app content from assigned app origins.

**Use instead:** installation-owned browser-surface origins. New apps should
build with the current workspace package command so the generated
`.neutron/browser-surface-origins.v1.json` readiness marker is included. Use
document-relative asset URLs and SDK runtime URL helpers; do not construct
Kernel-host URLs for app assets. Verify each tile, tray, and background on its
assigned origin.

The current HTTP sandbox headers protect Kernel-origin storage, including when
app HTML is opened directly. This planned removal reduces reliance on that
hosting compatibility. Public-data URLs, shared links, and Kernel asset
consumers need a coordinated migration: ordinary iframe surface URLs are not a
drop-in replacement for every public link. Existing apps must preserve managed
memory and publish a higher release version when updating their packages.

See [Installation-Owned Ordinary App Origins](./kernel-http-v2-and-certified-assets.md#installation-owned-ordinary-app-origins).

## Opaque App-Frame Compatibility

**To be removed:** the opaque `sandbox="allow-scripts"` app-frame compatibility
path retained for historical packages and browsers that cannot prove the
required credentialless framing support.

**Use instead:** the current installation-owned, per-surface origins with
credentialless `sandbox="allow-scripts allow-same-origin"` frames and exact
origin checks. App authors should adopt the current package readiness marker
and test their browser surfaces under this model.

This is separate from Kernel-host HTTP serving. An opaque frame reports
`origin: "null"`; navigating that existing frame to another website can result
in a new message port being assigned to the replacement document under the
original app's identity. Exact-origin mode rejects that replacement document.
Kernel-origin storage remains isolated.

Updating every app's package and URL alone does not remove the unsupported-
browser fallback. Browser support and the behavior shown when required support
is unavailable must be decided before retiring that path.

See [Browser Boundary Risk](./open-questions-and-design-gaps.md#browser-boundary-risk)
and the [current framing contract](./kernel-http-v2-and-certified-assets.md#installation-owned-ordinary-app-origins).

## Unversioned External-Canister Tools

**To be removed:** the unversioned external-canister routes
`canister.schema` and `canister.call_dialog`, together with SDK negotiation down
to those routes on older Kernels.

**Use instead:** `canister.schema_v2` and `canister.call_dialog_v2`. New external
integrations should require these tools. Current ordinary SDK helpers prefer
v2 but still fall back when its descriptors are absent; do not build new
reliance on that fallback. Invocation-scoped requests should use the supplied
`context.kernel` client, which already requires v2 for these operations.

The legacy path can perform owner-authenticated interface discovery before
operation approval, reviews arguments before legacy conversion, and lacks the
v2 cancellation handling. V2 uses anonymous discovery, prepares arguments
before review, and supports phase-aware cancellation. Cancellation after
dispatch cannot undo an operation; uncertain mutating results still need
reconciliation before retrying.

This deprecation concerns external targets. Calls to the app's own Neutron
continue to use the private self-call transport. Existing external callers
must migrate before removal.

See [App Method Access And Call Consent](./app-method-access-and-call-consent.md#calling-any-other-app-method).

## Update Responses With Hidden Certification Headers

**To be removed:** the update client's acceptance of HTTP responses when both
`IC-Certificate` and `IC-CertificateExpression` are invisible to browser code.
This is a compatibility exception inside the current update protocol, not a
separate legacy API or a deprecation of HTTP update transport.

**Use instead:** update sources that supply full response-certification v2,
including body certification, and expose both proof headers through
`Access-Control-Expose-Headers`. Do not rely on `no_certification` or on hidden
headers being accepted. New apps offering update sources should follow this
contract; app packages should use a source that does so.

The Kernel currently checks the visible v2 envelope and rejects
`no_certification`, but skips those checks when both headers are hidden. A
successful response from an ICP gateway alone does not establish this stronger
contract: the gateway also supports certified policies that opt out of content
certification. Removing the exception requires a Kernel acceptance change and
source compatibility checks; there is no separate replacement API to select.
Check a selected source's serving implementation and certified response policy
when assessing compatibility; a past live-response observation is not a
permanent guarantee.

See [Package Updates](./package-updates.md) for current behavior and the
[ICP gateway specification](https://docs.internetcomputer.org/references/http-gateway-protocol-spec/#the-certificate-expression-header)
for certification opt-out semantics.

## Legacy Wallet Transfers

**To be removed:** `wallet_transfer`, retained for old callers without a durable
request ID.

**Use instead:** generate and durably retain the caller's request ID before
using either v2 flow. `wallet_transfer_prepare_v2` followed by
`wallet_transfer_resume_v2` separates intent recording from execution;
`wallet_transfer_v2` combines those steps under the same caller-supplied ID.
Use the v2 status and recovery methods to reconcile an uncertain result and
resume the same operation. Current Wallet UI already uses the prepared,
resumable flow.

A successful legacy transfer whose response is lost can be paid again when
retried: each call creates a fresh ledger timestamp instead of replaying a
durable operation. New apps must use the v2 flow and retain its operation
identity across retries. Migrate old callers before removal and preserve all
pending operation records and released memory schemas.

See [Durable Send And Withdrawal Recovery](../apps/wallet/README.md#durable-send-and-withdrawal-recovery).
