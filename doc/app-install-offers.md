# App And Agent Install Offers

[Back to the documentation index](./index.md).

## Status

Implemented. Installed apps and active Agent Mode invocations can now ask the
Kernel to present a package or repository-group offer. The caller can nominate
only a URL. The authenticated owner retains both the pre-contact decision and
the existing exact package or group installation approval.

## Installation Before Install Offers

Neutron currently has three browser installation sources.

### File

The authenticated owner opens the Kernel launcher, selects **File**, and
chooses one `.neutron` archive. The Kernel reads the exact bytes, applies the
manual package limits, and validates and prepares the package. It starts the
combined-actor compilation while presenting the Kernel-owned
package/capability review; approval remains unavailable until compilation
succeeds, and deployment begins only after the owner approves.

### Package URL

The authenticated owner opens the Kernel launcher, selects **URL**, and enters
one package URL. Production accepts HTTPS; local development additionally
accepts loopback HTTP. The browser:

- sends no credentials or referrer;
- bypasses its cache;
- rejects redirects;
- requires a CORS-readable response; and
- streams no more than the remote package limit.

The downloaded bytes then enter the same preparation, compilation, review,
checked install journal, runtime verification, and commit path as File. The
URL is not retained as publisher identity. Successful provenance records only
manual URL acquisition and the digest of the exact accepted package bytes.

The current owner-entered URL is fetched before the package review appears.
That is acceptable only because entering the URL and pressing **Install** is
the owner's contact decision. It is not safe to expose this entrypoint
directly to an app or agent: an untrusted caller could otherwise cause network
requests before the owner sees a Kernel prompt.

### Repository Setup

The existing multi-application system is Neutron Repository Protocol v1. Its
carrier is a setup URL whose fragment contains:

```text
#repo=<repository-canister>&manifest=<manifest-id>&digest=<manifest-sha256>
```

The outer web URL is transport for this pinned reference. The Kernel does not
download an arbitrary group JSON file from that URL. After the owner chooses
**Load setup**, the Kernel anonymously queries the named repository canister
through its fixed certified interface, verifies the pinned manifest, and
fetches every advertised package uniformly.

Installed application IDs are skipped. Missing dependency closure is selected
automatically. The owner chooses the desired applications, reviews the exact
verified packages and capabilities, and approves one combined compilation and
one atomic checked deployment. Repository setups cannot replace the Kernel.

No repository request occurs before **Load setup**.

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

The helper uses the ordinary five-minute message-bus timeout. The Kernel offer
itself expires after 60 seconds. The promise resolves after the owner chooses
**Review** and the exact Kernel-owned workflow has been handed off; it does
not wait for or report installation success. Dismissal, expiry, a stale
endpoint, or changed authorization rejects the call.

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

## Consent Sequence

1. The caller submits a closed, bounded offer to the discoverable Kernel tool.
2. The Kernel validates and canonicalizes the URL locally, derives the exact
   requester, admits one owner-attention request, and displays a Kernel-owned
   prompt.
3. No package host or repository canister is contacted before the owner
   approves inspection.
4. Immediately before the owner's decision is acted on, the Kernel revalidates
   the source endpoint and installation scope.
5. After approval, the workflow belongs to the Kernel. Closing or replacing
   the offering frame cannot convert, redirect, or cancel the approved exact
   offer.
6. A package URL is fetched under the existing remote bounds. The Kernel
   validates the `.neutron` archive, computes the digest of the exact fetched
   bytes, retains those bytes through review, and derives package identity
   from the package itself.
7. A repository setup URL is reduced to its existing pinned
   `repo + manifest + digest` reference; the outer URL is never fetched.
   **Review** is the contact decision for an offered group, so the Kernel then
   begins the existing certified repository load without showing a duplicate
   pre-contact prompt.
8. The Kernel presents the existing exact package or selected-batch review.
   This second approval, not the offer prompt, authorizes deployment.
9. Deployment uses the existing compiler, checked install journal, runtime
   identity verification, and atomic commit.

The tool response acknowledges that the owner accepted the request for
inspection. It does not promise installation success over an app endpoint
that may disappear while the Kernel-owned workflow continues.

## Enforced Policy

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
- The initial prompt times out after 60 seconds. Dismissal does not impose an
  automatic cooldown; owner, endpoint, app-version, registry-generation, and
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
  `offerAppInstall()`;
- `packages/neutron-tools/src/repository.ts`: strict full setup-URL parsing and
  trusted canonical pending-reference staging;
- `apps/kernel/src/expose.ts`: discoverable source-bound tool, app/agent
  admission, re-attestation, workflow handoff, and audit redaction;
- `apps/kernel/src/install_offers/`: one-request store, lifecycle service,
  owner-session controller, and Kernel-owned dialog;
- `apps/kernel/src/reducer/apps.ts`: observed package facts and authenticated
  install-only compiler-baseline enforcement;
- `apps/kernel/src/repository/`: offered-group admission and retained
  requester attribution; and
- focused SDK, URL, message-bus, consent, install-only, and repository tests.

The Motoko install API, package format, compiler actor assembly, checked
deployment journal, and stable memory do not need a new app-facing authority.
