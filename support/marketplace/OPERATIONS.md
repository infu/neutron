# Marketplace operators

Run these commands from `support/marketplace`. They require an explicitly selected
`icp` identity, network, protocol canister and, for charged updates, Neutron.
They do not create or upgrade canisters. All commands that send updates default
to a review; add `--execute` after inspecting that exact request.

Assigned auditors call audit endpoints directly. Publisher and admin updates go
through the installed marketplace app's `marketplace_marketplace_call` method on
the selected Neutron, which attaches the reviewed cycles. An ordinary ingress
call cannot attach cycles; do not substitute `icp --proxy` or a direct protocol
update. The CLI identity must be authorized by that Neutron, its marketplace app
must be configured for this protocol, and its backend reservation must permit the
exact method. Admin membership names the Neutron principal, not the CLI identity.

When an additional operator method needs a reservation, `operator.ts reserve-route`
prepares the existing Kernel's exact principal/method reservation. It does not
request an entire-principal grant or change ordinary marketplace UI permissions.

## Review and stamp a candidate

```sh
bun scripts/operator.ts queue --canister "$MARKETPLACE" --identity auditor --network ic
bun scripts/operator.ts candidate --candidate "$CANDIDATE" --canister "$MARKETPLACE" --identity auditor --network ic
bun scripts/operator.ts review --candidate "$CANDIDATE" --out "$REVIEW_DIR" --canister "$MARKETPLACE" --identity auditor --network ic
```

Run the last command with `--execute` to issue an auditor-only read grant and
download the exact package and declared offered source. The CLI verifies HTTP v2
certification over the complete streamed response, package digest, inner manifest,
declared dependencies, offered-source digest and its build inputs. It rejects
redirected streaming callbacks and uncertified results. Local replicas require
`--host` plus an explicit trusted `--root-key` file; production uses the pinned IC
root key. It never downloads files through the Neutron backend.

Use an empty review directory. Artifacts and `review.json` are created without
overwriting earlier evidence. The temporary HTTP bearer is passed in a private
binary argument file, removed after the call, and never included in command-line
arguments or saved review output. Certification/package compatibility checks are
not a malware assessment: inspect the saved package and source before stamping.

```sh
bun scripts/operator.ts stamp --candidate "$CANDIDATE" --digest "$PACKAGE_SHA256" --source-digest "$SOURCE_SHA256" --request "$REVIEW_REQUEST_ID" --decision approved --analysis "$ANALYSIS_FILE" --canister "$MARKETPLACE" --identity auditor --network ic
```

Take both digests from the exact inspected files and review output. Omit
`--source-digest` only when the package declares no offered-source artifact.
The protocol checks these digests against the candidate, so a query response
cannot substitute a different package for the stamp. Use `rejected` or `revoked`
with a nonempty `--reason FILE` where appropriate. Every stamp needs nonempty
analysis. Keep the same request ID and inputs if its update reply is interrupted;
a different decision requires a different request ID. `--execute` submits the
reviewed decision. One approval publishes that exact release; revocation blocks
ordinary downloads while retaining authorized audit access.

## Publisher uploads

```sh
bun scripts/publisher.ts --package "$PACKAGE_FILE" --listing "$LISTING_FILE" --journal "$PUBLICATION_JOURNAL" --request "$PUBLICATION_REQUEST_ID" --neutron "$PUBLISHER_NEUTRON" --canister "$MARKETPLACE" --identity publisher-owner --network ic
```

The shared package inspector requires the exact declared offered-source sidecar.
Listing JSON contains `appId`, `title`, `summary`, `description`, `priceUsdMicros`,
`iconArtifact`, `screenshots` and `expectedRevision`; explicitly use null for an
absent icon or a new listing revision. Omit `--listing` to retain an existing
listing. The package supplies its own app ID, version and dependencies.

The review reports processing and first-year storage costs through query calls.
Add `--execute --max-cycles NAT` to send the reviewed workflow. Every update is
charged separately through Neutron. The durable local journal retains exact
binary requests and responses before advancing. Resume with the same journal,
request ID, files and listing after an interruption. A completed upload/candidate
is not auditor approval. Do not invent new upload identities to recover lost
responses. Keep this journal private because it contains unpublished package bytes.

## Admin calls and initial source transition

`operator.ts admin-auditor` assigns/removes an auditor through the admin Neutron.
`operator.ts reserve-app` reserves an existing app ID for an explicitly named
publisher Neutron. `operator.ts burn-account` sets one accepted token's burn-service
recipient, including an optional 32-byte subaccount. These commands display the
exact request and attached cycles before `--execute`; no default recipient or
publisher is guessed. `operator.ts relay` accepts an already reviewed Candid binary
request for other allowed charged methods.

Use `migration-inventory.ts` to prepare the old-source transition:

```sh
bun scripts/migration-inventory.ts inventory --config "$MIGRATION_CONFIG"
bun scripts/migration-inventory.ts plan --config "$MIGRATION_CONFIG" --published "$PUBLISHED_SNAPSHOT"
```

The config supplies `publishers: [{appId,publisher}]` for every old catalog ID.
Planning also requires the real `marketplace` principal, current `feeVersion`,
and exact `transitions: [{appId,file}]`. `--live` may replace `--published` for
read-only certified old-source metadata requests. Local packed bytes are labelled
separately from published evidence. The deterministic plan rejects missing owner
mappings, stale versions, wrong new update sources and mismatched offered sources.
It emits `initReservations` plus reviewable `admin_reserve_app` arguments; it performs no reservation,
upload, approval, publication or app-manifest edit.

Put the complete reviewed `initReservations` into the initial canister config's
`reservations` field. Installation then reserves existing IDs atomically under
their correct publisher Neutrons, before any public submission can race them.
Later `admin_reserve_app` calls are available for controlled additions. Upload and audit the transition packages at the
new protocol, then publish those higher versions through the existing old-source
production workflow. Recheck live release records before publication. Keep old
public packages intact. No actual transition can be prepared without the real
new canister and publisher mappings, and future paid bytes must not be uploaded
to the old public source.

## Checks

```sh
bun test scripts/operator.test.ts scripts/publisher.test.ts scripts/migration-inventory.test.ts
bun scripts/test-integration.ts 'auditor CLI'
```

The unit tests cover routing and secret handling, artifact/candidate mismatches,
decision validation, resumable publisher requests and transition boundaries.
The Ash/PocketIC case runs the CLI's official HTTP verifier against real streamed
protocol responses, including revocation and auditor-role removal. No production
financial action or publication is part of these tests.
