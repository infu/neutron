# Marketplace operators

Run the repository operator scripts from `support/marketplace`. They require an
explicitly selected `icp` identity, network, protocol canister and, for charged
updates, Neutron. They do not create or upgrade canisters. These scripts default
to a review before updates; add `--execute` after inspecting that exact request.
The separate Blast syntax and immediate-call behavior are documented below.

Assigned auditors call audit endpoints directly. The four admin-only endpoints
listed below also accept direct authenticated CLI calls without attached cycles.
Publisher and ordinary user updates go
through the installed marketplace app's `marketplace_marketplace_call` method on
the selected Neutron, which attaches the reviewed cycles. Ingress cannot attach
cycles for those charged methods; do not substitute `icp --proxy` or a direct
protocol update. The CLI identity must be authorized by that Neutron, its marketplace app
must be configured for this protocol, and its backend reservation must permit the
exact method. An admin call authenticates the actual configured admin principal;
that may be an existing CLI identity or an existing canister principal. Knowing
the principal text does not confer authority. There is no admin or auditor UI.

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

These commands call the protocol directly as the configured admin identity:

| Operator command | Protocol endpoint | Effect |
|---|---|---|
| `admin-auditor` | `admin_auditor_set` | Assign or remove an auditor |
| `reserve-app` | `admin_reserve_app` | Reserve an app ID for an explicitly named publisher Neutron |
| `burn-account` | `admin_set_burn_account` | Set one token's forwarding recipient and optional 32-byte subaccount |
| `rates-refresh` | `rates_refresh` | Request an additional oracle refresh |

They display the exact request before `--execute` and require no `--neutron` or
attached-cycle payment. The Candid `feeVersion` field remains for compatibility;
these endpoints do not check a funding amount or charge that fee. Any attached
cycles remain unaccepted and are refunded. Oracle and execution costs still come
from the protocol's operating balance. No default recipient or publisher is
guessed. Existing canister-admin callers remain accepted. `operator.ts relay`
handles other allowed charged methods through Neutron; it is not an admin
impersonation mechanism.

### Blast CLI

The normal protocol build publishes `candid:service` metadata so assigned
operators can discover the interface without also being canister controllers.
Method authorization still checks the caller's assigned role.

The installed Blast syntax uses numeric identity selection `--id` (0–65535) and
`--host URL`; these are different from `icp`'s named `--identity` and `--network`.
Select an existing Blast identity whose principal is already in `admins`. This
workflow does not create an identity, add an administrator, or deploy a canister.
Use `blast help` for this installed CLI's global usage; it has no per-command
`--help` parser, and `blast scan --help` treats `--help` as a canister ID.

```sh
blast scan "$MARKETPLACE" --id "$BLAST_ADMIN_ID" --host "$IC_HOST"
blast schema "$MARKETPLACE" admin_auditor_set --id "$BLAST_ADMIN_ID" --host "$IC_HOST"
blast validate "$MARKETPLACE" marketplace_info '[]' --id "$BLAST_ADMIN_ID" --host "$IC_HOST"
```

`scan` discovers methods, and `schema` prints the selected method's argument and
result schemas. `args_json` is a JSON array of positional Candid arguments; each
of these admin endpoints takes one record. Keep its `feeVersion` field in that
record and use the types returned by `schema`.

**`blast validate` executes the selected method**, then checks its result against
the schema. It is not a dry run for an update. The example above calls only the
read-only `marketplace_info` query. For an authorized admin mutation, inspect the
schema and exact JSON array first, then submit it once with `call`:

```sh
blast call "$MARKETPLACE" admin_auditor_set "$REVIEWED_ADMIN_ARGS_JSON" --id "$BLAST_ADMIN_ID" --host "$IC_HOST"
```

Use the same form for the other three admin endpoints in the table. Blast sends
the call immediately and has no separate `--execute` review switch. Do not run
`validate` followed by `call` on an update intending to validate without effects.
No cycles or Neutron relay are needed for these four authenticated admin calls;
ordinary publisher/user operations still require their existing Neutron route.

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
