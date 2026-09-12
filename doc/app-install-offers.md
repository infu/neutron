# App And Agent Install Offers

[Back to the documentation index](./index.md).

Installed apps and active Agent Mode invocations can ask the Kernel to present
a package or repository-group offer. URL offers retain a source-review decision
and exact installation approval. Recognized repository sources may be queried
anonymously for certified access pricing while the first dialog is open;
package acquisition and any access charge wait for its approval. Apps that
declare the prepared-install capability can instead supply an already prepared
repository selection for one final package and permission review.

## Prepared Selections

An app that manages its own package selection and source access declares:

```json
{"frontend_tools":{"api":1,"targets":[{"app":"kernel","tools":["apps.install_prepared"]}]}}
```

After its user chooses Install, it can use `reviewPreparedAppInstall()` from
`neutron-tools/app`, or call `apps.install_prepared`, with this input:

```ts
{
  url: setupUrl,
  appIds: ["notes", "calendar"],
  access: { source: repositoryPrincipal, token: privateBearer, paths: packagePaths }
}
```

`access` is optional for public packages. The caller owns any source preparation
and download-grant charges under its installed capabilities and should disclose
those costs on its Install action. The grant must cover every package in the
pinned repository manifest, including dependencies; it is restricted to the
canonical source and exact resource paths. The Kernel never buys or renews
access for this prepared flow, including after a denied or interrupted fetch.
It does not forward the bearer to other hosts or retain it in audit records,
application provenance, or browser storage.

The Kernel obtains certified metadata and package bytes, validates their hashes
and package manifests, selects the requested apps and required dependencies,
and compiles the combined deployment automatically. It then shows one final
review containing the actual packages and their manifest permissions. Only
approving that review installs anything; cancellation makes no installation.
The declared capability authorizes preparation and presentation, not deployment.
An asynchronous caller does not need a second physical click after preparing
the source request.

The reply `{ presented: true, requestId }` acknowledges the review handoff, not
installation success. The prepared review is transient: page reload abandons
an unapproved review, and the app can reopen its original saved source grant.
It must not create another charged preparation simply because handoff returned
or the review was canceled. Ordinary URL offers and external repository links
retain their existing selection and approval behavior.

## Underlying Installation Paths

Offers hand off to existing Kernel-owned installation paths. Keep their
acquisition and deployment authority separate when adding callers.

### File

The owner's manual file flow accepts one `.neutron` archive. The Kernel reads
the exact bytes, applies the manual package limits, and validates and prepares
the package. It starts the
combined-actor compilation while presenting the Kernel-owned
package/capability review; approval remains unavailable until compilation
succeeds, and deployment begins only after the owner approves.

### Package URL

The owner's manual URL flow accepts one package URL. Production accepts HTTPS;
local development additionally accepts loopback HTTP. The browser:

- sends no ambient browser credentials or referrer;
- bypasses its cache;
- rejects redirects;
- requires a CORS-readable response; and
- streams no more than the remote package limit.

Canonical private repository resources may additionally use a scoped bearer
grant. Acquiring that grant can identify the Neutron to the source and spend
the source access cost approved on the action. This is distinct from ambient
browser credentials; use `apps/kernel/src/repository_access/client.ts` for
Kernel download authorization.

The downloaded bytes then enter the same preparation, compilation, review,
checked install journal, runtime verification, and commit path as File. The
URL is not retained as publisher identity. Successful provenance records only
manual URL acquisition and the digest of the exact accepted package bytes.

The owner-entered URL is fetched before the package review appears: the manual
Install action authorizes acquisition. Do not expose the trusted install
orchestration entrypoint directly to apps or agents. Use an offer, or the
explicitly declared prepared-selection boundary, to establish the caller's
authority to begin that work.

### Repository Setup

The multi-application system is Neutron Repository Protocol v1. Its
carrier is a setup URL whose fragment contains:

```text
#repo=<repository-canister>&manifest=<manifest-id>&digest=<manifest-sha256>
```

The outer web URL is transport for this pinned reference. The Kernel does not
download an arbitrary group JSON file from that URL. The pending review may
query certified public access pricing before **Load setup**. That action then
authorizes metadata/package acquisition and the displayed source access cost
if a new private-download grant is needed. The Kernel verifies the pinned
manifest and fetches every advertised package uniformly. Public metadata uses
anonymous access; private package access can identify the Neutron.

Installed application IDs are skipped. Missing dependency closure is selected
automatically. The owner chooses the desired applications, reviews the exact
verified packages and capabilities, and approves one combined compilation and
one atomic checked deployment. Repository setups cannot replace the Kernel.

Do not describe this as a zero-contact boundary: cost discovery is already a
repository request. It does not itself buy access, download packages, or
authorize deployment.

## App And Agent Boundary

Installed app frontends communicate with the Kernel over a source-bound
message bus. The Kernel derives the requesting app, endpoint, installation
scope, version, and registry generation from the registered frame; an app
cannot nominate those authority fields.

The Kernel exposes the discoverable `apps.install_offer` tool alongside app
and endpoint discovery, canister calls, backend reservations, workspace
navigation, and other bounded tools. The tool is only an offer boundary. It
does not expose compiler, package staging, self-upgrade, or deployment
authority.

The compiler and deployment helpers deliberately have no caller-consent
concept. They are trusted Kernel orchestration primitives and must not be
exposed to apps directly.

## Tool And SDK Contract

The model-visible Kernel tool accepts this closed union:

```ts
type InstallOffer =
  | {
      kind: "package_url";
      url: string;
    }
  | {
      kind: "repository_setup_url";
      url: string;
    };
```

The result is:

```ts
type AppInstallOfferResult = {
  presented: true;
  requestId: string;
};
```

`neutron-tools/app` exports the same types and `offerAppInstall()`:

```ts
import { offerAppInstall } from "neutron-tools/app";

await offerAppInstall({
  kind: "package_url",
  url: "https://packages.example/mail.neutron",
});

await offerAppInstall({
  kind: "repository_setup_url",
  url:
    "https://apps.example/setup" +
    "#repo=aaaaa-aa&manifest=starter&digest=<64-lowercase-hex>",
});
```

The helper uses the ordinary message-bus timeout; the Kernel also expires its
pending offer independently (`INSTALL_OFFER_TIMEOUT_MS` in
`apps/kernel/src/install_offers/service.ts`). The promise resolves after the
owner approves source review and the exact Kernel-owned workflow has been
handed off; it does not wait for or report installation success. Dismissal,
expiry, a stale endpoint, or changed authorization rejects the call.

The tool derives the offering app and any Agent Mode invocation from the live
message-bus endpoint. It does not accept an app ID, publisher identity,
permission summary, custom prompt copy, package bytes, Wasm, or deployment
arguments. Agent attribution shows the attested root app and entrypoint plus
the currently executing app and scoped tool; the private invocation capability
is never retained or rendered.

Both ordinary apps and agents can initiate the workflow. Initiate
means only that the Kernel presents an owner decision. The tool must never let
an agent approve its own installation request, grant reusable install
authority, or bypass the existing final package/setup review.

## URL Offer Consent Sequence

1. The caller submits a closed, bounded offer to the discoverable Kernel tool.
2. The Kernel validates and canonicalizes the URL locally, derives the exact
   requester, admits one owner-attention request, and displays a Kernel-owned
   prompt.
3. For recognized repository sources, the dialog may query certified public
   access pricing without an identity or charge. Arbitrary package hosts are
   not contacted yet. Packages and the pinned setup manifest are not loaded
   before the owner approves inspection.
4. Immediately before the owner's decision is acted on, the Kernel revalidates
   the source endpoint and installation scope.
5. After approval, the workflow belongs to the Kernel. Closing or replacing
   the offering frame cannot convert, redirect, or cancel the approved exact
   offer.
6. A package URL is fetched under the existing remote bounds. Private repository
   downloads can acquire access under the approved source cost; ordinary URL
   downloads omit ambient browser credentials. The Kernel
   validates the `.neutron` archive, computes the digest of the exact fetched
   bytes, retains those bytes through review, and derives package identity
   from the package itself.
7. A repository setup URL is reduced to its existing pinned
   `repo + manifest + digest` reference; the outer URL is never fetched.
   Source review authorizes acquisition for an offered group, so the Kernel
   begins the certified repository load without showing a duplicate source
   prompt.
8. The Kernel presents the existing exact package or selected-batch review.
   This second approval, not the offer prompt, authorizes deployment.
9. Deployment uses the existing compiler, checked install journal, runtime
   identity verification, and atomic commit.

The tool response acknowledges that the owner accepted the request for
inspection. It does not promise installation success over an app endpoint
that may disappear while the Kernel-owned workflow continues.

## URL Offer Policy

The following rules describe `apps.install_offer`. Prepared selections use the
install-declared preparation authority described above, while retaining the
same final deployment approval and package validation.

- The tool is discoverable to Agent Mode and callable by ordinary installed
  apps.
- An ordinary app call requires an authorized owner, a focused tile or tray,
  and transient browser user activation.
- An Agent Mode call requires a valid live invocation. The owner, never the
  agent judge, decides whether to inspect and install the offered software.
- Background frames cannot create unsolicited install prompts.
- There is no manifest capability and no session or durable install grant.
- Only one owner-attention request is active; offers are never invisibly
  queued or allowed to supersede an existing app operation.
- The initial prompt expires. Dismissal does not impose an automatic cooldown;
  owner, endpoint, app-version, registry-generation, and
  agent-invocation changes cancel stale offers.
- All package offers are install-only. They cannot replace the Kernel or an
  already-installed application.
- A package offer needs only an HTTPS URL whose path ends exactly in
  `.neutron`; local deployments also permit loopback HTTP. No caller-supplied
  SHA-256 is accepted. The URL may be mutable; the Kernel computes and displays
  the digest of the exact fetched bytes and never re-fetches after review. That
  observed digest proves which bytes are being approved, not publisher
  authorship.
- The group form accepts the existing certified repository setup protocol. An
  arbitrary HTTPS group-manifest format is out of scope.
- Full URL query strings are browser-ephemeral and must not enter provenance,
  stable state, audit payloads, or error text. Consent and audit display only
  origin plus path; the pinned repository fragment is rendered as separate
  validated fields.
- Existing manual and repository provenance remain authoritative for
  acquisition. The app making the recommendation is not treated as the
  publisher or update source.

## Implementation Surface

The implementation consists of:

- `packages/neutron-tools/src/app.ts`: public SDK types and
  `offerAppInstall()` / `reviewPreparedAppInstall()`;
- `packages/neutron-tools/src/repository.ts`: strict full setup-URL parsing and
  trusted canonical pending-reference staging;
- `apps/kernel/src/expose.ts`: discoverable source-bound tool, app/agent
  admission, re-attestation, workflow handoff, and audit redaction;
- `apps/kernel/src/install_offers/`: one-request store, lifecycle service,
  owner-session controller, and Kernel-owned dialog;
- `apps/kernel/src/repository_access/`: anonymous cost discovery, approved
  access acquisition, prepared-grant validation, and exact-source downloads;
- `apps/kernel/src/tools/package_url.ts`: `parseOfferedPackageUrl` and
  `fetchPackageFromUrl`, including URL admission and streamed size bounds;
- `apps/kernel/src/reducer/apps.ts`: observed package facts and authenticated
  install-only compiler-baseline enforcement;
- `apps/kernel/src/repository/`: `startRepositorySetupFromOffer`,
  `startPreparedRepositorySetup`, certified acquisition, selection, and retained
  requester attribution.

When changing the boundary, inspect the SDK, URL, message-bus, offer-service,
repository-access, prepared-selection, and install-only tests alongside these
modules. They encode cancellation, requester changes, download retry, and
approval handoff behavior.

The Motoko install API, package format, compiler actor assembly, checked
deployment journal, and stable memory do not need a new app-facing authority.
