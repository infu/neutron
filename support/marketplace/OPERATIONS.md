# Marketplace operators

Run the repository operator scripts from `support/marketplace`. They require an
explicitly selected `icp` identity, network, protocol canister and, for charged
updates, Neutron. They do not create or upgrade canisters. These scripts default
to a review before updates; add `--execute` after inspecting that exact request.
The separate Blast syntax and immediate-call behavior are documented below.

Assigned auditors call audit endpoints directly. The admin-only endpoints
listed below also accept direct authenticated CLI calls without attached cycles.
Ordinary publisher and user updates go
through the installed marketplace app's `marketplace_marketplace_call` method on
the selected Neutron, which attaches the reviewed cycles. Ingress cannot attach
cycles for those charged methods; do not substitute `icp --proxy` or a direct
protocol update. The CLI identity must be authorized by that Neutron, its marketplace app
must be configured for this protocol, and its backend reservation must permit the
exact method. An admin call authenticates the actual configured admin principal;
that may be an existing CLI identity or an existing canister principal. Knowing
the principal text does not confer authority. There is no admin or auditor UI.
The separately configured first-party publisher uses the direct catalog workflow
below; this exception is checked against its actual signing principal.

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
reviewed decision. One approval makes that exact release available as beta;
the publisher separately promotes it to stable. Revocation blocks ordinary
downloads through either channel while retaining authorized audit access.

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

## First-party beta catalog publication

The assigned existing Blast identity 0 is
`y7t6r-gtsqz-45ogs-2k3gk-l6hic-2h7wm-zosg6-uldzf-l4ams-2jaky-wqe`.
It owns the initial listings. Its current and future listing/upload/publication
updates attach no cycles. A different CLI identity cannot acquire this authority
through a command flag, and ordinary publishers still follow the charged flow
above. The script loads the existing identity without creating or exporting keys.

From the repository root:

```sh
npm --workspace neutron-marketplace-protocol run production:review -- --catalog "$RELEASE_CATALOG"
npm --workspace neutron-marketplace-protocol run production:publish -- --catalog "$RELEASE_CATALOG"
npm --workspace neutron-marketplace-protocol run production:publish -- --catalog "$RELEASE_CATALOG"
```

The catalog retains the existing `{format:1, update_source, packages:[{id,directory}]}`
format. Set `update_source` to the actual marketplace canister and build strictly
higher app releases with that same source before publication. There is no old-source
fallback or placeholder canister. The default catalog path is the ignored
`.private/production-release-catalog.trusted-id0.json` in this directory.
`--listings FILE` optionally supplies an array of `{appId,file}` mappings to the
same explicit listing JSON used by the ordinary publisher; omit it to preserve
existing listing details, prices, and images. These listing inputs apply only to
packages with changed releases. When a package is already current, this command
does not save metadata-only changes; the receipt names such supplied listings in
`skippedListingAppIds`.

Read `app_detail` or `publisher_apps` as the publisher before preparing listing
JSON for an existing or reserved app ID. Supply that app's current revision as
`expectedRevision`; null is for a new listing. A reserved name already has a
listing revision even before its first package is approved. After a lost save
reply, retain the original input: the protocol accepts an exact match of all
current listing fields before checking the older revision, without creating a
second listing revision. A conflicting intervening edit instead requires a new
review and must not be overwritten by the old saved request.

The channel-aware source protocol must be upgraded and verified before this
workflow can publish beta. It validates exact archives, manifests, dependencies
and memory migration structure, plus declared offered-source bytes and build
inputs. It stages changed candidates, then publishes the selected beta set in one atomic
`trusted_publish_beta_batch` update. Its audit analysis identifies these automated
checks; it never claims a manual malware or application-behavior review.
Stable heads remain unchanged. Exact existing stable releases in a catalog are
reported unchanged with their stable provenance; no duplicate beta is created.

Request IDs and private journals bind `operation: "publish"`, `channel: "beta"`,
the exact selected releases and listing inputs. `--request ID --journal FILE`
can instead select an explicit retained pair. After a lost response, rerun with
the same files and inputs. Do not rebuild or change versions to recover it. The journal reconciles
the original batch before any publication retry. A revoked or superseded release
does not trigger automatic reapproval.

Certified HTTP postflight verifies the channel descriptor, current selected
release records, every package, and every declared source artifact. The second
publication must report receipt-v2 `batch_id: null` and every package/source
`unchanged`, with matching version,
path, size, and SHA-256. This means no new upload, candidate, audit, or publication
batch. A new CLI process can still obtain a cycle-free own-publisher authorization
grant to verify private downloads; the credential stays in memory and does not
appear in the receipt. Local verification requires `--host URL --root-key FILE`
and checks against that explicit root key.

### Legacy Marketplace publication recovery

Rerun with the original catalog, listing inputs, archives and offered-source
bytes. Before choosing a beta identity, the CLI detects the predecessor's
`.neutron/marketplace-publications/<old-catalog-hash>.json` and uses its saved
request ID, including a previously custom ID. For a custom journal:

```sh
npm run updates:publish -- --journal "$LEGACY_PUBLICATION_JOURNAL"
```

Retain any original `--catalog` and `--listings` arguments. Omit `--request` to
read the saved ID. The root command already enables `--execute`; the workspace
`production:review` command keeps remote reads query-only and stops if private
artifacts require a new access grant. Execution may obtain the existing
cycle-free artifact-access grant for full certified verification.

Recovery uses `trusted_publish_status` and the original stable release,
package and source paths. It preserves the original journal bytes and never
stages candidates, replays a stable publication or starts beta. Success returns
receipt-v2 with `operation: "reconcile_legacy_publish"`, `channel: "stable"`,
`batch_id: null`, and every package/source `unchanged`; `reconciled_batch_id`
identifies the original batch, or is null for an originally unchanged catalog.
Keep this receipt with the original journal and repeat to verify the same result.

A missing original receipt after a requested commit remains unresolved. A
partial workflow that never requested commit is explicitly unfinished; it is
not converted into beta. Both block publication until resolved. Request,
artifact, source or proof mismatches also stop recovery. Never relabel or delete
the original journal to bypass that outcome. This is recovery within Marketplace,
separate from the legacy SushiOS source command.

### Stable promotion

From the repository root, select one app or an explicit compatible group:

```sh
npm run updates:promote -- kernel wallet
npm run updates:promote -- kernel wallet --execute
npm run updates:promote -- kernel wallet --execute
```

The default performs remote reads and writes a local frozen review journal.
It records current beta candidate IDs, versions, package/source digests and
sizes, dependencies, and expected beta/stable revisions. Review the output;
`--execute` uses that saved selection in `release_promote`, after querying
`promotion_status`. Promotion changes stable references atomically and
does not build, upload or alter artifacts. Stable dependencies must already be
available or be included in the same transaction, including transitive needs.
There is no implicit all-app selection.

The command uses the same catalog, source and Blast identity as publication.
`--catalog FILE`, `--journal FILE`, and `--request ID` select explicit retained
configuration; local verification requires `--host URL --root-key FILE`.
The default journal is
`.neutron/marketplace-publications/promote-stable-<group-digest>.json` at the
repository root, keyed by operation, channel, source and sorted app IDs.

If beta changes before commit, the frozen selection conflicts. A lost reply
must be reconciled under the same request and journal; a committed request
returns its original receipt without replaying its mutation. Later beta
publication does not change that receipt, and later stable publication cannot
be rolled back by retrying it. A changed stable head fails current postflight.
Use `--refresh` without `--execute` to review a later beta after the prior outcome
is verified, after a definitive protocol rejection without commit, or when the
old review was never executed. The previous journal is retained beside its
replacement. Network failures and lost responses remain unknown outcomes and
cannot be discarded through refresh.

Promotion emits `neutron-update-source-publish-v2` with `operation: "promote"`
and `channel: "stable"`. Changed rows are `promoted`; source artifacts remain
`unchanged`. Repeat `--execute` against the same saved selection and require
`batch_id: null`, every package/source `unchanged`, and exact matching paths,
versions, lengths and digests. Both operations share a local per-source lock,
including custom journal names. Operators must still ensure that no publisher
runs concurrently on another machine.

### First-party earnings and legacy source

The same Blast identity can read `earnings_query`, request `withdraw_quote`, and
call `withdraw` directly for its own credit. Inspect the live schema, choose the
ledger, destination and total debit, and submit the exact returned quote with
its original request ID. The ledger fee is included in that debit; this account's
protocol update accepts no cycles. After interruption, read `withdraw_status`
and continue the same quote/request when instructed. Do not substitute another
account as owner or create a new withdrawal to recover an uncertain one.

Use the old-source transition command only for the separately reviewed migration
of installed users' source pointers. This catalog command never mutates the old
source and never uploads paid package bytes there.

## Channel protocol rollout

The channel source upgrade and the compatible app release set are separate
deployment steps. The historical [production release record](spec/production-release.md)
does not establish that this successor is deployed or published.

1. Qualify a state-preserving protocol upgrade from the deployed predecessor.
   Preserve the existing database, publisher and certification roots. The new
   channel root bootstraps existing approved references as stable, retains
   revocation, and starts beta empty. Preserve grants, uploads, purchases and
   receipts. Verify the descriptor and unchanged stable v1 projection after
   upgrading the source, before publishing any app beta.
2. Package and test the compatible Kernel/Marketplace successor set, including
   all persistent roots and supported stable or beta schema predecessors.
   Publish the set atomically as beta and require its verified no-op repeat.
   Existing Kernels have no Beta updates setting, so initial testers need an
   intentional owner-reviewed staging path. Never use reinstall or downgrade.
3. Qualify those exact beta bytes and promote the compatible set together.
   Require the promotion no-op repeat. Old Kernels discover the successors
   through the stable v1 path and gain the default-off preference on upgrade.
4. Once the successor Marketplace client is available through stable, an
   administrator can explicitly call `admin_feedback_cutover({feeVersion})`.
   This rejects new nonempty versionless review text with an update-required
   error before restartable maintenance deletes legacy review text. It retains
   stars and all acquisition records. The source upgrade alone does not enable
   this cutover. See [Release Channels](spec/release-channels.md#feedback).

Stage a new Dispenser starter separately only when future Neutrons should start
with the new stable set. The complete release and starter workflow is
[App Package Updates](../../doc/package-updates.md).

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

The separately timed `admin_feedback_cutover` endpoint is also a direct,
authenticated, cycle-exempt administrator call. It has no dedicated operator
subcommand; inspect its live Candid and follow the rollout prerequisites above.

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
their correct publishers, before any public submission can race them. The initial
first-party entries belong to the exact Blast principal above; ordinary entries
continue to belong to their publisher Neutrons.
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
