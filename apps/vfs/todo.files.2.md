# Files V2: Encrypted Backend Files And Certified Public Sharing

Status: implementation specification. Files V1 is browser-local and is not a
release basis for this design. V2 replaces it with an app-owned encrypted
backend filesystem and explicit public snapshot sharing.

Updated: 2026-07-24

Kernel dependency: [`../kernel/todo.kernel.2.md`](../kernel/todo.kernel.2.md)

## Outcome

Files becomes the durable workspace filesystem for people, apps, and agents:

- private file and folder state lives in the Files Motoko backend;
- filenames, private metadata, text, and binary bodies reach that backend only
  as browser-encrypted ciphertext;
- the resident Files background owns volatile key custody and converts the
  existing path-oriented tool API to opaque backend IDs;
- users can upload ordinary operating-system files and download them again
  without changing their bytes;
- choosing **Share** creates a separate plaintext, certified, immutable
  snapshot with an ordinary browser URL;
- text shares display as inert plain text and binary shares download with a
  safe filename;
- unsharing removes the certified copy and produces a certified `404`.

There is no Files V1 IndexedDB or stable-memory migration. This is a
preproduction V2 cutover: reinstall Files and the coordinated kernel build,
then start with an empty filesystem.

Files V2 also has no wire-compatibility obligation to the unpublished Files V1
backend draft. The first released Files V2 `.did` becomes the compatibility
baseline. From that release onward, unchanged V2 methods retain bidirectional
old-encoder/new-decoder fixtures. The current kernel revokes an endpoint when
its app version or frontend generation changes, so this is release, rollback,
and staged-build safety—not a promise that a live stale resident may bypass
endpoint revocation and call a newer backend. Candid interface evolution,
managed-memory schema evolution, crypto format evolution, endpoint authority,
and product release versions are separate contracts.

## Current State Being Replaced

Files currently keeps its canonical tree and bodies in the resident
background's IndexedDB. The backend memory contains only an `installed` flag.
The resident loads the complete tree, several operations scan or clone the
whole in-memory map, and the tile requests a recursive snapshot.

Useful V1 product limits and tool behavior remain design inputs:

- 512 KiB maximum text file;
- 16 MiB maximum binary file;
- 64 MiB maximum private logical content;
- 100-character names and 240-character display paths;
- exact binary `readBinary` and `writeBinary` attachment transport;
- SHA-256 etags and compare-and-swap writes;
- at most 20 entries in a batch write.

V2 does not move those IndexedDB records into Motoko. It builds the indexed,
encrypted model below and never opens IndexedDB. Its credentialless ephemeral
dedicated origin gives the crypto worker an installation-isolated Host without
access to the ordinary persistent origin partition. Storage APIs may exist
inside the fresh ephemeral partition, but Files never uses them. A
ciphertext-only browser cache may be designed later, but it is not part of V2
and must never become authority.

## Locked Product Semantics

1. **Private files have no HTTP route.** A private read is an authorized Files
   operation that decrypts in the resident worker.
2. **A share is a public snapshot, not a live link.** Editing, moving, renaming,
   or deleting the private source does not silently change or revoke a share.
3. **Publishing is explicit.** The Share dialog binds one exact private content
   version and shows the public filename, byte count, and the fact that the
   resulting bytes are readable by anyone with the URL.
4. **A changed snapshot gets a new URL.** “Share latest version” allocates a
   new random token. The old snapshot remains unchanged until the user
   separately unshares it. A public path is never reused within an
   installation.
5. **Unshare is honest revocation.** It removes Neutron's public copy and
   certifies a `404`; it cannot recall bytes that somebody already downloaded.
6. **The URL token is not authentication.** It is 128 bits of browser
   randomness that prevents casual enumeration. Possession of the URL grants
   public read access.
7. **Public rendering is closed.** Stored text is served only as
   `text/plain; charset=utf-8`. Every other file is served as
   `application/octet-stream` with a kernel-generated
   `Content-Disposition: attachment`.
8. **User content never becomes active same-origin content.** HTML, SVG,
   Markdown, JavaScript, JSON, and uploaded media are not served with an active
   or browser-sniffable type.
9. **Cleanup never polls or schedules idle work.** Mutations and explicit
   maintenance reclaim bounded pages. Logical deletion does not prove that IC
   billed memory pages shrink, so V2 does not spend a timer callback based only
   on logical-byte rent arithmetic.
10. **There is no plaintext fallback.** If the Files vetKey slot or worker
    cannot be used, private operations fail closed. Public unshare remains
    available because it does not require private decryption.

## Privacy And Threat Model

### Encrypted private fields

The browser encrypts and authenticates all of these before a private backend
call:

- file and folder name;
- MIME type and Files text/binary classification;
- plaintext byte length and SHA-256 etag;
- created/modified user timestamps and future private metadata;
- text and binary body blocks;
- random per-file content-encryption keys.

The backend still observes bounded structural metadata:

- opaque node, content, stage, and cleanup IDs;
- parent/child topology, file-versus-folder kind, bounded subtree height, and
  declared name/path scalar counts used to enforce the product path bound;
- ciphertext lengths, block counts, entry counts, and quota consumption;
- mutations, reads, timing, and access patterns;
- all deliberately public share metadata and plaintext share blocks.

AES-GCM does not hide length. Without a future padding design, ciphertext size
reveals plaintext size within small framing overhead. Tree shape and access
patterns are explicit non-goals.

### Who can decrypt

The existing app-isolated vetKeys rules apply:

- every currently authorized Neutron principal can derive an enabled retained
  generation for the Files slot;
- the slot key holder controls lifecycle but is not the only reader;
- a permitted Files tool consumer deliberately receives the requested
  plaintext;
- an active controller, approved malicious Files upgrade, compromised browser
  or extension, authorized agent/app, or copied key can disclose plaintext;
- retirement, principal removal, and unshare cannot erase copied keys or
  downloaded files.

This is owner-set confidentiality, not a multi-user or per-file ACL system.
See [`../../doc/app-isolated-vetkeys.md`](../../doc/app-isolated-vetkeys.md) and
[`../kernel/todo.vetkeys.md`](../kernel/todo.vetkeys.md).

### Confidential-subnet truth

Client encryption is the primary private-file boundary. Confidential-subnet
execution is useful defense in depth for opaque metadata, access patterns, and
transient execution, but it does not replace encryption and it does not make a
public share private.

The current production target in `config.ndeploy.json` is
`brlsh-zidhj-3yy3e-6vqbz-7xnih-xeq2l-as5oc-g32c4-i5pdn-2wwof-oae`. As of this
specification, the ICP Dashboard classifies it as an ordinary 13-node
Application subnet, not a confidential subnet. The first confidential-subnet
proposal identifies
`re2t4-faa75-v3vhk-kdmdr-uyrkl-aik2l-ixd6u-p3fyr-zlfkc-6c5af-zae`.
Deployment code must use and verify the exact current registry value, not a
short display prefix.

Therefore the product, provision receipt, and documentation must not claim
TEE protection for the current deployment. Before such a claim is enabled, the
deployment workflow must verify the exact target against current registry
evidence and record that evidence in the receipt. The kernel has no runtime
subnet attestation API. The relevant governance record is
<https://dashboard.internetcomputer.org/proposal/142397>.

## Manifest And Authority

Files declares:

- one browser vetKeys slot named `files_vault`;
- one managed-memory `files` root at initial schema version 1;
- exact owner-authorized functions and exact preapproved self-call methods;
- one `shared_app_path` certified-store mount named `shares`, with `GET` and
  `HEAD`;
- the kernel's Certified Assets V2 backend capability with 256 entries and
  64 MiB committed bytes;
- its resident background and existing bounded frontend-tool request surface.

Files uses `dedicated_resident_origin` in
`credentialless_ephemeral_v1` mode for the Mail-style crypto worker. It is
mutually exclusive with persistent browser storage. The resident requires
`window.credentialless === true`; storage APIs may exist but see only a fresh
top-level-document-scoped ephemeral partition and Files must not call them.
The manifest does not declare `persistent_browser_storage`, `public_ingress`,
`kernel_static`, raw actors, raw calls, cycle primitives, or a private HTTP
mount.

The browser vetKeys API already supplies the slot's current/legacy public
information and performs private derivation. The backend does not need
`vetkeys_public` for V2 and must not receive a private derivation handle.

The manifest uses the final collection-aware kernel contract. There is one
store and no Files-specific certification tree:

```json
{
  "backend": {
    "capabilities": {
      "certified_assets": {
        "api": 2
      }
    }
  },
  "capabilities": {
    "background_ui_requests": {
      "api": 1,
      "categories": ["frontend_tool"]
    },
    "vetkeys": {
      "api": 1,
      "description": "Encrypt and decrypt private Files in this browser",
      "slots": [
        {
          "id": "files_vault",
          "purpose": "Unlock the private Files vault"
        }
      ]
    },
    "preapproved_self_calls": {
      "api": 1,
      "methods": [
        "files_bootstrap_v2",
        "files_list_v2",
        "files_lookup_v2",
        "files_read_chunk_v2",
        "files_operation_status_v2",
        "files_share_list_v2",
        "files_vault_write_v2",
        "files_write_block_v2",
        "files_mutate_v2",
        "files_remove_v2",
        "files_abort_v2",
        "files_cleanup_v2",
        "files_share_block_v2",
        "files_share_unshare_v2"
      ]
    },
    "dedicated_resident_origin": {
      "api": 1,
      "surface": "background",
      "mode": "credentialless_ephemeral_v1"
    },
    "http_routes": {
      "api": 2,
      "mounts": [
        {
          "id": "shares",
          "surface": "shared_app_path",
          "authority_mode": "exact_neutron_host_v1",
          "methods": ["GET", "HEAD"],
          "mode": "certified_store",
          "store": "certified_assets",
          "max_request_bytes": 0
        }
      ]
    },
    "certified_assets": {
      "api": 2,
      "max_entries": 256,
      "max_committed_bytes": 67108864,
      "max_object_bytes": 16777216,
      "max_pending_stages": 1,
      "max_staged_bytes": 16777216,
      "max_batch_operations": 1,
      "max_batch_bytes": 16777216,
      "max_idempotency_receipts": 1024,
      "lifecycle_group": "scope_v1",
      "clear_mode": "lifecycle_group_only_v1",
      "collections": [
        {
          "id": "shares",
          "mount": "shares",
          "path_rule": "files_publication_v2",
          "mutation_rule": "immutable_once_v1",
          "body_source": "staged_only",
          "response_profiles": [
            "files_inline_text_v1",
            "files_attachment_v1"
          ]
        }
      ]
    }
  }
}
```

The preapproved-self-call declaration is API 1 and grants only the exact named
owner calls. There is no attachment direction, positional body, per-method
binary authority, or browser-selected fallback. The real Files Candid records
own every binary field. The generated adapter and backend require
`files_lookup_v2.request.body` to be exactly zero bytes for ID lookup or
exactly 32 bytes for blind-tag lookup.

`files_publication_v2` is the only Files route rule. There is no token-only
route, spent-path map, app collection-clear method, or historical publication
cap.

Receipt accounting is fixed:

```text
256 consumed stage lanes
+ 256 publication-batch lanes
+ 256 independently aborted stage lanes
= 768 general lanes <= max_idempotency_receipts 1,024

256 precharged revocation lanes are filled by 256 deletes with zero new
general-lane use
```

`max_idempotency_receipts = 1,024` counts occupied plus reserved general lanes
only. The configured charged maximum is 1,024 general plus at most 256
revocation lanes, or 1,280 charged lanes. Stage begin consumes one stage lane
and reserves one future publication-batch lane; commit materializes that
reservation, while abort/expiry releases the future reservation but retains
the terminal stage lane for 24 hours. Delete materializes its
nonce/fingerprint/result in the target's precharged revocation lane. Exact
retries add no lane.

Stage terminal, publication-batch, and delete results each retain their exact
kernel-defined 24-hour window. Filled delete carriers continue occupying their
original entry slots. If all 256 are filled, Files reports zero live shares
but 256 occupied lifecycle slots and new publication returns `#quota` until
cleanup; the UI calls this rolling 24-hour capacity, not `receipt_full`.

The backend environment receives `CertifiedAssetsV2` only because the separate
`backend.capabilities.certified_assets.api = 2` selector is present. The
resource declaration alone does not inject a handle.

The optimized protocol uses 14 exact methods. It removes separate
begin/commit calls and leaves 18 preapproval slots for later major methods:

| Method | Mode | Binary in its ordinary Candid value | Files maximum |
|---|---|---|---:|
| `files_bootstrap_v2` | query | response `body : Blob` | 64 KiB out |
| `files_list_v2` | query | response `body : Blob` | 512 KiB out |
| `files_lookup_v2` | query | request `body : Blob`; response `body : Blob` | 32 B in, 8 KiB out |
| `files_read_chunk_v2` | query | response `body : Blob` | 1,900,000 B out |
| `files_operation_status_v2` | query | none | 64 KiB metadata |
| `files_share_list_v2` | query | none | 64 KiB metadata |
| `files_vault_write_v2` | update | request `body : Blob` | 64 KiB in |
| `files_write_block_v2` | update | request `body : Blob` | 1,900,000 B in |
| `files_mutate_v2` | update | request `body : Blob` | 256 KiB in |
| `files_remove_v2` | update | none | 64 KiB metadata |
| `files_abort_v2` | update | none | 64 KiB metadata |
| `files_cleanup_v2` | update | none | 64 KiB metadata |
| `files_share_block_v2` | update | request `body : Blob` | 1,900,000 B in |
| `files_share_unshare_v2` | update | none | 64 KiB metadata |

`files_lookup_v2` is a hard dependency: its request body is a zero-byte ID
selector or exact 32-byte private blind tag, and its result contains encrypted
metadata bytes. Encoding either as hex/base64/JSON bytes or scanning every
child violates the transport or performance contract. Both remain ordinary
fields in named Candid records:

```candid
type FilesLookupRequestV2 = record {
  locator : opt FilesLookupLocatorV2;
  body : blob;
};

files_lookup_v2 : (FilesLookupRequestV2) ->
  (FilesLookupOutputV2) query;
```

The five binary-bearing updates likewise place `body : blob` in their named
request record. Query output types may retain `{ value; body : blob }` as a
useful Files-owned result shape, but the labels have no kernel transport
meaning and other apps need not use them.

For every self call, structural metadata is capped at 65,536 bytes, aggregate
binary across at most 512 leaves at 1,900,000 bytes, raw structural Candid at
131,072 bytes, decoder allocation at 524,288 bytes, type entries at 256,
recursive depth at 32, and aggregate decoded elements at 4,096. The
independent private-port backstops remain 32 MiB per endpoint and 64 MiB
globally. Files' table limits are tighter application validation, not manifest
authority.

Raw-reply preflight must traverse the complete live Candid result and reject
an oversized/count/depth result before general IDL decoding. If the selected
agent API has already buffered the full reply, the transport reserves the full
1,900,000-byte aggregate maximum and Files/Settings makes no early
network-byte or small-method peak-memory claim.

The request/response fields, method mode, logical label, authorization,
payment, idempotency, and binary interpretation never change incompatibly
within V2. The kernel transports and redacts live-Candid binary leaves; it does
not freeze Files business records or decode Files frames.

### Candid evolution contract

Every method has one named request record and one named response record,
including methods whose initial request is `record {}`. Every response has an
`outcome : opt variant { ... }`; every rejection contains
`reason : opt variant { ... }`. A null outcome means unsupported or uncertain,
and a null reason means a known rejection whose reason this decoder does not
understand. Neither is success, a default mutation, or permission to retry.

Growing input discriminants—write intent, mutation action, requested node kind,
and share presentation—are also `opt variant`. An unknown/null mutating
discriminant is rejected as incompatible before allocation or mutation.
Growing output discriminants—returned node kind, operation state, cleanup
state, and binary frame kind—use the same boundary; unknown/null means
unsupported or uncertain, and the body is discarded whenever that
discriminant governs body decoding. This discard is owned by the generated
Files adapter after transport validation; the kernel does not decode an opaque
Files outcome. Existing required fields and labels remain on the wire. Later
V2 fields are optional and safe for an older implementation to ignore. A
change to identity, authorization, payer, charging,
deduplication, target selection, retention, binary meaning, or security
policy requires a new method or `_v3`, not an optional V2 field.

Control-bearing binary body fields use one copy-minimizing frame:

```text
FilesFrameV2 =
  u32be(control_candid_length) ||
  exact_control_candid_bytes ||
  raw_payload_bytes
```

The bounded inner Candid control contains offsets/lengths for every raw payload
slice. The decoder preserves and hashes the complete received frame, validates
the exact control and payload lengths before allocation, decodes the control
once, and never decodes/re-encodes to reconstruct an idempotency fingerprint.
The worker uses `ArrayBuffer` views for payload slices where the browser permits
it. The only unframed bodies are the exact 32-byte `files_lookup_v2` blind-tag
input and a plaintext `files_share_block_v2` body whose geometry is completely
bound by its named request and server stage.

The exact inner Candid definitions are checked in beside the outer `.did` and
follow the same optional-field/optional-variant rules. Decoders reject
oversized control/allocation claims, out-of-bounds/overlapping slices,
unaccounted payload bytes, duplicate logical entries, and unsupported mutating
variants.

Do not add a generic `schema_version` field to ordinary Candid records. Method
suffixes and crypto/storage profile discriminants exist only where semantics
or byte decoding genuinely branch. Stable-memory schema versions are governed
by the managed-memory system and are not Candid fields.

The first released logical Files V2 `.did`, every inner frame-control definition,
and generated Motoko/TypeScript bindings become fixtures. Release runs the
normal upgrade check and common-method checks in both directions, plus real
old-encoder/new-decoder and new-encoder/old-decoder messages. A newly added
optional-variant tag must decode as null in the old fixture. Special-`opt`
warnings require an explicit allowlisted null-fallback fixture.

The build also extracts the compiler-owned physical methods from the emitted
combined-actor `.did`, maps them back to the 14 logical Files labels through
the canonical compiler plan, and proves their modes/types structurally
identical to the logical fixture. A hand-maintained logical `.did` passing
while the deployed actor signature drifts is a release failure.

CI additionally runs both directions through the actual resident API-1
live-Candid/binary bridge and its generated bindings. This proves that a newly
added optional variant reaches an old adapter as null/unsupported rather than
as an unrecognized normalized-JSON tag, and that the adapter drops an
unknown/non-success body. Candid type names are source/fixture conventions,
not runtime wire labels: the kernel checks the structural physical signature.
Exact-byte preservation applies to `FilesFrameV2`; outer Candid compatibility
is structural and must not claim byte-for-byte message preservation.

## Vault And Client Cryptography

Reuse and generalize Mail's dedicated-origin worker, pinned official
`@dfinity/vetkeys` adapter, one-use transport verification, non-extractable
WebCrypto keys, and zeroization discipline. Do not create a JavaScript crypto
fallback.

### Vault initialization

1. From a focused Files tile, reserve and enable `files_vault` if necessary.
2. The dedicated worker generates a random 32-byte vault root key, a random
   16-byte vault ID, and a random 32-byte vault salt.
3. It IBE-wraps the root key to the current Files slot generation.
4. It encrypts the fixed all-zero filesystem root node's empty private
   metadata at metadata revision `1`.
5. It calls `files_vault_write_v2` with an expected-absent CAS and one frame
   containing the wrapper record plus root-node envelope.
6. The backend atomically stores only format, vault ID/salt, slot generation,
   public-key fingerprint, IBE wrapper, root commitment, record revision, and
   the structural/encrypted root node. The initial node count becomes one.
7. If another live Files endpoint wins the initialization race, the loser
   zeroes its candidate and unlocks the committed vault.

On unlock, the worker derives the retained slot generation once, unwraps the
root, verifies its committed root commitment, imports it as a non-extractable
HKDF base key, zeroes raw key bytes, and derives domain-separated keys for:

- deterministic filename blind tags;
- node metadata AES-256-GCM;
- per-file content-key AES-256-GCM wrapping.

The derived vetKey, vault root, subkeys, and per-file content keys stay inside
the worker. Decrypted filenames and requested plaintext necessarily cross the
worker boundary into bounded volatile resident/tile memory for path
resolution, display, editing, and authorized tool results. They are never
persisted in IndexedDB, localStorage, Cache Storage, logs, errors, audit
records, or backend state.

### Client-generated identities and one-update CAS

Reserve-before-encrypt is intentionally removed. It costs an extra replicated
update for every create, write, rename, and move even though all information
needed for safe optimistic concurrency already exists.

The credentialless resident generates these nonzero 128-bit values with
`crypto.getRandomValues`:

- `NodeId` for each new file or folder;
- `ContentId` for each immutable file version;
- `RequestId` for every logical mutation or publication.

The backend stores each ID as two fixed `Nat64` words, rejects a new ID that is
already live or belongs to a different request receipt, and treats an exact
same-request retry as idempotent. A collision returns a closed conflict; the
resident generates a new plan. IDs are never derived from a name, path,
plaintext, key, or backend counter.

These identifiers are nonsecret protocol identity and may be generated outside
the crypto worker to avoid an extra worker round trip and copy. Vault roots,
derived keys, content keys, plaintext cryptography, and retry ciphertext remain
worker-owned.

Every node has local structural, metadata, and children revisions. Given a
successful read at revision `r`, the only acceptable replacement revision is
`r + 1`; a new node starts at `1`. The worker may therefore construct the next
AAD before dispatch. The backend atomically verifies the expected current
revision, requires the proposed next revision, validates the complete
structural transition, and commits it. Racing callers construct the same next
number, but only one can satisfy CAS. Overflow fails closed instead of
wrapping.

This is not client authority over storage identity or revision history. The
backend still decides whether a target is reachable, current, unique,
within quota, structurally valid, and eligible for the requested mutation. A
client-chosen value merely removes a round trip from the cryptographic
handshake. No backend `next_node_id`, `next_content_id`, begin reservation, or
burned aborted ID set is required.

For a multi-block write, the first `files_write_block_v2` call validates the
complete plan, allocates a small server stage ID, reserves gross peak capacity,
and stores the first block directly under its final `ContentId`. The final
block call revalidates CAS and publishes the already stored content. A
one-block or empty file begins and commits in one update. Folder create,
rename, and move use one `files_mutate_v2` update.

### Canonical private paths and names

The path-oriented tool boundary canonicalizes before lookup or mutation:

1. trim surrounding Unicode whitespace from the complete input;
2. reject backslash, NUL, every Unicode control scalar, and invalid UTF-8;
3. split on `/`, ignore empty and `.` segments, and reject every `..` segment;
4. normalize each remaining segment to NFC;
5. require every segment to be nonempty, different from `.` and `..`, at most
   100 Unicode scalars, at most 400 UTF-8 bytes, and free of leading or trailing
   Unicode whitespace;
6. join with one `/`, using `/` for the root, and require the complete display
   path including separators to be at most 240 Unicode scalars.

Thus repeated and leading slashes are aliases only at the tool input boundary;
stored names and returned paths have one canonical spelling. Direct UI create
and rename validate the same exact segment grammar without first trimming the
segment, so leading/trailing whitespace rejects rather than being silently
changed. Names remain case-sensitive.

Only the root has an empty name, all-zero `NodeId`, all-zero parent ID, and
all-zero `name_tag`. It cannot be renamed, moved, or removed. The encrypted
backend cannot inspect private Unicode, so the worker owns text validation;
the backend independently enforces the protected root, nonzero non-root IDs,
32-byte non-root tags, depth, topology, index uniqueness, and CAS rules.

### Canonical encodings

`LP(x)` is exactly `u32be(byte_length(x)) || x`; `id128(x)` is
`u64be(x.hi) || u64be(x.lo)`; all text is NFC UTF-8; all integer fields below
are unsigned fixed-width big-endian. Freeze golden vectors for the complete
byte strings, not merely their logical fields. `node_kind` is `0` for folder
and `1` for file. The root `NodeId` and its reserved parent `NodeId` are both
the all-zero 128-bit value; every generated non-root ID is nonzero.

Define:

```text
vault_context =
  LP("neutron.files.vault.v2") ||
  LP(neutron_canister_principal_bytes) ||
  LP("files") ||
  LP(vault_id) ||
  LP(vault_salt)

root_commitment =
  SHA-256(
    LP("neutron.files.root-check.v2") ||
    LP(vault_context) ||
    vault_root[32]
  )

name_tag =
  HMAC-SHA-256(
    name_index_key,
    LP("neutron.files.name.v2") ||
    id128(parent_node_id) ||
    LP(NFC(filename_utf8))
  )

hkdf_salt = SHA-256(vault_context)

name_index_key =
  HKDF-SHA-256(vault_root, hkdf_salt, LP("name-index"), 32)

metadata_key =
  HKDF-SHA-256(vault_root, hkdf_salt, LP("metadata"), 32)

content_wrap_key =
  HKDF-SHA-256(vault_root, hkdf_salt, LP("content-wrap"), 32)

metadata_record_key =
  HMAC-SHA-256(
    metadata_key,
    LP("neutron.files.metadata-record-key.v2") ||
    id128(node_id) ||
    u64be(metadata_revision)
  )

content_record_wrap_key =
  HMAC-SHA-256(
    content_wrap_key,
    LP("neutron.files.content-record-key.v2") ||
    id128(node_id) ||
    id128(content_id)
  )
```

The vault root is uniformly random, so the commitment is not a password
verifier. It is immutable for the vault and is checked after every unwrap,
including a fresh browser session. For the filesystem root only,
`parent_node_id = id128(0)`, `name_tag = 32` zero bytes, and the encrypted
private name is the empty string.

Names are NFC-normalized and case-sensitive. The complete 32-byte tag is used;
it leaks equality only within the same parent because the parent ID is bound.
For a non-root node, after decrypting metadata the worker NFC-normalizes the
recovered name, recomputes the HMAC tag, and compares all 32 bytes without an
early exit. Root verification is a separate branch: node ID, parent ID,
`name_tag`, and recovered name must all be their exact empty/all-zero values;
the worker does not compare root against the ordinary HMAC formula.

Metadata encryption uses `metadata_record_key` once with AES-256-GCM and the
fixed all-zero 12-byte nonce. Its AAD is exactly:

```text
LP("neutron.files.metadata.v2") ||
LP(vault_context) ||
id128(node_id) ||
id128(parent_id) ||
u8(node_kind) ||
u64be(metadata_revision) ||
u16be(declared_name_scalars) ||
name_tag[32]
```

Encrypted metadata contains the private name and, for files, content kind,
MIME type, plaintext byte length, plaintext SHA-256, and user timestamps.
Its V2 plaintext schema is bounded before encryption: content kind is the
closed byte `text_v1` or `binary_v1`; text requires strict UTF-8 and at most
524,288 bytes; MIME is at most 128 printable ASCII bytes with no controls
(advisory only); SHA-256 is exactly 32 bytes; created/modified times are
unsigned `Nat64` IC nanoseconds with `created <= modified`; and the complete
encrypted metadata field remains at most 2,048 bytes. Unknown future kind
never defaults to text or inline publication.

The root declares zero name scalars; every non-root node declares `1..100`.
After decryption the worker requires the declaration to equal the actual NFC
name length. Binding the declaration into metadata AAD prevents an honest
ciphertext from being relabeled, while the backend uses only the declared
value for structural admission.

### File encryption

Every immutable file version receives a new random 32-byte content-encryption
key. The wrapping AAD is exactly:

```text
LP("neutron.files.content-key.v2") ||
LP(vault_context) ||
id128(node_id) ||
id128(content_id)
```

The worker:

1. wraps that key with `content_record_wrap_key` using AES-256-GCM, the fixed
   all-zero 12-byte nonce, and that exact wrapping AAD;
2. encrypts each plaintext block independently with AES-256-GCM;
3. uses `u64be(0) || u32be(block_index)` as the block nonce; the random
   content key is unique to this immutable version and is never used for
   another version;
4. binds every block to this exact AAD:

   ```text
   LP("neutron.files.content.v2") ||
   LP(vault_context) ||
   id128(node_id) ||
   id128(content_id) ||
   u32be(block_index) ||
   u32be(total_block_count) ||
   u32be(plaintext_block_length)
   ```

The canonical plaintext block geometry minimizes records. Let
`B = 1,889,984` and `P` be the file's exact plaintext length:

```text
if P == 0:
  block_lengths = [0]
else:
  n = ceil(P / B)
  block_lengths[0] = P - (n - 1) * B
  block_lengths[1 .. n - 1] = B
```

The empty file is one authenticated AES-GCM block: zero plaintext bytes and a
16-byte ciphertext tag. It is never represented as zero private blocks. For
every nonempty file, every block is nonempty, the vector is unique, and a
16 MiB file has nine blocks whose first length is 1,657,344 bytes.

The complete encoded `WriteBlockFrameV2` is at most 1,900,000 bytes. For actual
control length `C`, raw payload is at most `1,899,996 - C`; every accepted
frame checks this correlated bound.

- A single-file create/replace or continuation control is at most 9,996 bytes,
  so one maximum plaintext block produces 1,890,000 ciphertext bytes and fits
  exactly with the four-byte prefix.
- A batch first control is at most 196,608 bytes, leaving at most 1,703,388 raw
  bytes. Each maximum text-file block is 524,304 ciphertext bytes, so no frame
  packs more than three.
- Vault and mutation frames retain their separate 65,536/262,144 Files binary
  caps and exact control/payload fixtures.

The canonical maximum-file first plaintext block is 1,657,344 bytes; a
single-file control still uses the stricter 9,996-byte rule. Freeze
exact-limit and plus-one encoded fixtures for every frame class rather than
combining independent maxima.

One encrypted content block is always wholly contained in one frame; it is
never fragmented across frames or copied into a fragment accumulator. A frame
may pack several whole blocks. The first-frame plan pins each block to one
canonical frame ordinal and raw-payload slice, so a retry cannot repack or
reorder blocks. The stage retains one SHA-256 fingerprint per accepted frame,
not a second hash per private block. AES-GCM and the encrypted end-to-end
plaintext SHA-256 provide content integrity; the frame fingerprint provides
exact idempotent retry. All frame fingerprints disappear at commit.

Every metadata/wrapper derivation is unique by nonreused ID/revision and is
invoked once; every content key is confined to its indexed blocks. A retry
reuses the already produced identical ciphertext and never encrypts again.
This makes nonce uniqueness structural instead of relying on unbounded random
96-bit nonce draws under vault-global keys. Wrong vault, node, content, index,
count, length, key, nonce, tag, or reordered block fails authentication.

### Rotation

Only the vault root is IBE-wrapped. File blocks and per-file key wrappers are
independent of the vetKey generation.

Rotation is an idempotent state machine:

1. read the committed vault wrapper and current/legacy slot summary;
2. if the wrapper still names the retained legacy generation, derive legacy,
   unwrap the root, wrap the same root to current, and CAS-replace the record;
3. if the wrapper already names current, do not try to unwrap it with legacy;
   derive current and continue with verification;
4. read the committed current wrapper back, unwrap it with the current
   generation, recompute `root_commitment`, compare all 32 bytes with the
   immutable committed commitment without early exit, import the verified root
   as the non-extractable HKDF base key, and zero the raw copy;
5. mark Files rotation confirmed only after that current-generation read-back
   succeeds.

Rotation does not rewrite file blocks or every content-key wrapper. The UI
shows “vault migration required” until current-generation read-back succeeds
and then recommends legacy retirement. Files cannot prevent an owner from
retiring the generation directly through generic kernel Settings; that
destructive action must retain the kernel's unrecoverability warning.
Premature legacy retirement, loss of the slot namespace, reinstall, or
restoring Files ciphertext without the matching kernel vetKeys state makes the
vault unrecoverable.

## Backend Memory And Indexes

Files owns one managed-memory root named `files`. Because this is the first
shipped backend schema, its manifest memory version is `1`, even though the
product and crypto protocol are Files V2. Do not call the managed-memory root
“schema V2” merely to match the product name. Its immutable
`backend/memory/files/v1.mo` is the fresh-install baseline; later persistent
changes use the repository's explicit managed-memory schemas and migrations.
There is no Files V1 memory to import.

Do not use the generic kernel Stable Store as the filesystem. Its limits and
transaction model do not fit the indexed filesystem.

The compact schema is:

```motoko
type Id128 = { hi : Nat64; lo : Nat64 };
type Tag256 = (Nat64, Nat64, Nat64, Nat64);
type ChildNameKey = (Nat64, Nat64, Nat64, Nat64, Nat64, Nat64);
type BlockKey = (Nat64, Nat64, Nat32);
type ShareExpiryKey = (Nat64, Nat8, Nat64); // deadline, lifecycle kind, ShareId
type PrivateReceiptIdentityOwner = {
  node_count : Nat16;
  content_count : Nat16;
};

type Mem = {
  var next_stage_id : Nat64;
  var next_job_id : Nat64;
  var next_share_id : Nat64;

  var vault : ?VaultRecord;
  nodes_by_id : Map.Map<Id128, Node>;
  children_by_name : Map.Map<ChildNameKey, Id128>;
  blocks : Map.Map<BlockKey, Blob>;
  stages : Map.Map<Nat64, Stage>;
  stages_by_request : Map.Map<Id128, Nat64>;
  private_receipts : Map.Map<Id128, PrivateReceipt>;
  private_receipts_by_expiry : Map.Map<PrivateReceiptExpiryKey, ()>;
  private_receipt_identity_owners :
    Map.Map<Id128, PrivateReceiptIdentityOwner>;
  delete_jobs : Map.Map<Nat64, DeleteJob>;
  share_lifecycle_by_id : Map.Map<Nat64, ShareLifecycleCarrier>;
  share_by_publish_request : Map.Map<Id128, Nat64>;
  share_by_delete_request : Map.Map<Id128, Nat64>;
  share_lifecycle_by_expiry : Map.Map<ShareExpiryKey, ()>;

  var node_count : Nat;
  var committed_private_plaintext_bytes : Nat;
  var committed_ciphertext_bytes : Nat;
  var staged_ciphertext_bytes : Nat;
  var physical_private_bytes : Nat;
};
```

All server-assigned `Nat64` counters use checked increment. Exhaustion rejects
new allocation before mutation and never wraps or reuses an ID.

All map keys use fixed typed words and explicit lexicographic comparators. Do
not allocate composite `Blob` keys. The canonical byte encoding used for
charging and golden vectors remains:

```text
child_name_key = id128(parent_id) || name_tag[32]
block_key      = id128(content_id) || u32be(block_index)
```

`children_by_name` is the only child index. It supplies both exact
same-folder lookup and `Map.entriesFrom` direct-child pagination. Ordering by a
pseudorandom HMAC tag reveals no useful filename order beyond the equality
leak already accepted within one parent. Removing separate
`children_by_parent` and `name_index` maps saves one full tree entry per node.

The `nodes_by_id` key is the `NodeId`; the value does not duplicate it. Every
`Node` value retains:

- optional parent `NodeId`, kind, active/hidden state, and complete 32-byte
  `name_tag`;
- declared name-scalar count, structural, metadata, and children revisions,
  subtree height, and subtree plaintext bytes;
- encrypted metadata ciphertext (the per-record key uses the fixed nonce);
- for a folder: direct-child count, compact sorted count vectors for
  `child_subtree_height : Nat8` and
  `child_relative_path_scalars : Nat16`, plus cached
  `max_relative_path_scalars`;
- for a file: its optional inline active `ContentRecord`.

For a file, `subtree_plaintext_bytes` is its derived active plaintext length
and its relative-path maximum is `declared_name_scalars`. For a non-root
folder, the relative maximum is its declared name length when empty, otherwise
`declared_name_scalars + 1 + max(child_relative_max)`. For root it is zero when
empty and otherwise `max(child_relative_max)`. Folder plaintext is the checked
sum of direct child subtree totals.

Retaining `name_tag` in the primary record is required. Without it, rename,
move, deletion, and index verification cannot locate the old
`children_by_name` entry without scanning the parent.

An inline `ContentRecord` contains `ContentId`, wrapped content key, block
count, ciphertext byte count, and crypto profile.
It does not contain an aggregate ciphertext SHA-256. AES-GCM authenticates
every indexed block, while encrypted metadata contains the end-to-end
plaintext length and SHA-256. A stage retains only the canonical per-frame
fingerprints needed for retries; it does not hash the same ciphertext again
per block.

Blocks are stored under their final `ContentId` on first acceptance. A stage
record controls visibility and owns the reservation; commit changes the
node pointer and ownership metadata without copying, re-keying, or rehashing
body bytes.

`stages_by_request` contains only the at-most-three active private/public
stages and lets a lost first-call response retry recover the same server stage
ID. It is removed with the stage. A committed private retry reconciles against
the requested node/content identity.

Private write receipts retain their deduplicated target node and content IDs;
mutation and remove receipts retain their node ID; abort and expired receipts
retain every planned target node/content ID; vault receipts retain none. The
compact `private_receipt_identity_owners` map keeps independent checked
`Nat16` node/content refcounts under one `Id128` key. New write/batch content,
new write/batch nodes, and `mkdir` reject an ID owned by either an active stage
or a retained receipt. Receipt insertion charges only newly materialized owner
rows, cleanup decrements shared refcounts and charges/reclaims exact rows, and
the last retained owner releases the ID for reuse. Bootstrap reconstructs this
bounded index from the capped receipt set and rejects missing, extra, or
mismatched rows without scanning nodes or blocks.

Public state uses one `ShareLifecycleCarrier` per occupied Files entry slot.
It contains the typed kernel target, frozen publication identity, optional
live `ShareRecord`, and any retained committed/deleted outcome. The retained
outcome also stores the exact final publication-request fingerprint, so a
live reply replay or deleted `superseded` result is available only to the
same final nonce, options, block locator, and body digest. Separate
publish-request and delete-request pointer indexes let a lost reply for either
nonce find that same carrier; they do not duplicate the lifecycle result.
The ordered expiry index removes each pointer at its exact 24-hour deadline
and removes a deleted carrier when its delete window ends. A live carrier
continues without expired request pointers. Pending, live, and recently
deleted carriers together are capped at 256, and none of these indexes is an
unbounded historical ledger.

Initialized bootstrap first performs a bounded local integrity audit: exact
active-stage/reverse indexes, receipt expiry and identity-owner indexes,
public lifecycle/terminal graphs, cleanup-job cursors plus their point-read
block ownership, staged/reserved/physical counters, and the reachable root
plaintext total. Malformed sizes are rejected before traversal, and certified
usage is queried only after every local check succeeds.

Before a public mutation under lifecycle-slot pressure, Files advances at most
one synchronous scoped `CertifiedAssetsV2.maintenance_page()` before local
mutation, then one aggregate local page starting with due terminal rows and
continuing through lifecycle/private expiry work. Terminal-only pressure skips
kernel maintenance. Files does not scan all carriers or run a timer. If no
slot is freed, the mutation returns the rolling-capacity result unchanged.

The revisions have separate meanings:

- `structural_revision` changes whenever observable structure, active content,
  subtree height, path aggregate, or plaintext aggregate changes;
- `metadata_revision` changes only when the encrypted metadata envelope is
  replaced and is bound into metadata AAD;
- `children_revision` changes when direct-child membership changes and is
  bound into list cursors.

The backend accepts exactly `expected + 1`; aborted attempts consume no
revision. Height-only propagation may advance a bounded chain of structural
revisions without rewriting ancestor ciphertext or changing their metadata
revisions.

Structural frames do not carry client-proposed ancestor aggregates. They carry
the exact sorted union of potential old-parent and new-parent ancestor
witnesses, each containing only node ID plus expected structural and children
revisions. The backend reconstructs that union from current topology, rejects
missing, extra, duplicate, out-of-order, or stale witnesses, validates its
stored compact vectors, and derives the exact changed subset, revisions,
height, path, plaintext aggregate, quota delta, and physical charge. This keeps
the frame bounded at two depth-64 chains and avoids exposing or duplicating
server-owned count vectors.

### Required complexity and behavior

- exact child lookup is `O(log n)`;
- a direct-child page is `O(log n + page_size)`;
- node and block lookup are `O(log n)` plus a depth-bounded reachability check;
- rename or move changes one node, old/new child-index entries, and bounded
  ancestor height/path/plaintext aggregates; descendants are not rewritten;
- folder cycle detection and reachability walk at most 64 ancestors;
- moving a subtree requires
  `new_parent_depth + 1 + moved_subtree_height <= 64`;
- changing a child height updates its parent's compact height vector and walks
  at most 64 ancestors; it never scans a wide folder;
- folder `max_relative_path_scalars` is maintained from the changed child's
  declared name length and child aggregate. Removing the maximum uses the
  bounded distinct-length count vector, never a child scan. Root is special:
  its value is the maximum child-relative path. Rename/move walks at most 64
  old/new ancestors and rejects any result above 240 without scanning
  descendants;
- subtree plaintext aggregates are updated on create/replace/batch/remove and
  along old/new ancestor chains on move. A recursive detach reads the selected
  root aggregate and releases exactly that logical plaintext quota without a
  subtree scan;
- no lookup, list page, move, write, read, or remove scans the whole tree;
- metadata listing never reads content blocks.

The page cursor is a named Candid record binding parent ID, exact
`children_revision`, and the last blind tag. A response includes
`total_children`, `loaded_count`, `next_cursor`, and `has_more`. A concurrent
child mutation returns a restart conflict rather than silently skipping or
duplicating entries. The resident decrypts and sorts only loaded rows.
Page-local sorting is never presented as globally alphabetical.

Every read validates that the node remains reachable from the active root. A
recursive deletion removes the selected root's parent edge and marks it hidden
atomically, then reclaims a bounded page. Descendants are unreadable
immediately even if a cleanup job owns remaining records. The same transaction
subtracts the selected node's stored `subtree_plaintext_bytes` from committed
logical plaintext; physical charge remains until bounded reclamation.

A single-file replacement synchronously deletes the old content's at-most-nine
block records in the final commit. The previous grace period is removed: the
read protocol already requires the node to point at the requested
`ContentId`, so an old version could not actually use that grace. A racing
download receives one complete current version or a clean stale conflict and
restarts. A multi-file batch may enqueue one bounded reclaim job only when its
gross old-state removal exceeds the frozen final-call instruction ceiling.
Hidden, staged, and queued bytes remain physically charged until their records
are actually removed.

Persistent maps, counters, and roots restore directly after upgrade. Startup
does not enumerate nodes, rebuild indexes, rehash blocks, or recertify public
state.

## Hard Bounds

These are hard product limits, not UI suggestions.

The resident worker enforces private values that the ciphertext backend cannot
observe or trust:

| Private logical resource | V2 limit |
|---|---:|
| Name | 100 Unicode scalars and 400 UTF-8 bytes |
| Display path assembled in the resident | 240 Unicode scalars |
| Plaintext text file | 524,288 bytes |
| Plaintext binary file | 16,777,216 bytes |
| Private logical content | 67,108,864 bytes |
| Atomic batch plaintext | 20 text files and 10,485,760 bytes |

The backend independently enforces observable state:

| Backend resource | V2 limit |
|---|---:|
| Nodes, including root | 10,000 |
| Clear structural tree depth/subtree height | 64 |
| Declared non-root name / root name | 1–100 / 0 Unicode scalars |
| Declared maximum relative display path | 240 Unicode scalars |
| Encrypted metadata field | 2,048 bytes |
| Derived plaintext per private file | 16,777,216 bytes |
| Derived committed private plaintext | 67,108,864 bytes |
| Ciphertext body per private file | 16,777,360 bytes |
| Committed private ciphertext and metadata | 83,886,080 bytes |
| Total physical private charge, including indexes/staging/cleanup | 134,217,728 bytes |
| Concurrent private write/batch stages | 2 |
| Private staging ciphertext | 33,554,720 bytes |
| Active cleanup jobs across delete/batch/abort/expiry/orphan work | 8 |
| Write binary frame | 1,900,000 bytes |
| Normal plaintext block | 1,889,984 bytes |
| Content blocks per file | 9 |
| Batch content blocks / transport frames | 20 / 7 |
| Batch distinct node/index/CAS plan entries | 64 |
| Direct-child page | default 100, maximum 200 |
| Files public lifecycle slots: pending + live + recent deletion | 256 |
| Public-share list page | default 25, maximum 50 |
| Public bytes per certified asset | 16,777,216 bytes |
| Committed certified public bytes | 67,108,864 bytes |
| Concurrent certified public upload sessions | 1 |

Two maximum private ciphertext versions total exactly 33,554,720 bytes. Stage
records, frame fingerprints, indexes, jobs, and allocator overhead are charged
to the separate 128 MiB physical cap; a body-only staging counter cannot hide
them. None of the logical/node/metadata/content maxima promises that all other
independent maxima fit simultaneously. Gross physical admission is
authoritative, and Settings/UI shows the currently limiting counter. The
maximum-state fixture must prove the declared physical cap with conservative
encoding overhead before release.

Private stages expire after 30 minutes of inactivity; public certified-asset
stages expire after one hour. Expiry makes them unusable immediately but does
not release physical charge before deletion. Before a related positive
mutation, Files performs at most one aggregate cleanup page. Across all jobs
examined by that call, a page stops at the first of: nine content blocks,
16,777,360 ciphertext bytes, 128 metadata/index/stage/receipt entries, or the
frozen instruction ceiling. An explicit user cancel or the exact Files
maintenance action in Settings continues one more page; the limit is aggregate,
not once per expired stage or job.

No recurring or one-shot cleanup task is declared in V2. Stable/Region pages
normally grow and are reusable but do not shrink, so deleting 16 MiB of logical
records may save no GiB-second rent after the high-water allocation already
exists. A future state-triggered timer is justified only by measurement proving
that it reduces actual billed memory or satisfies a separately approved
cleanup deadline for less cost than piggyback/explicit work. Logical charged
bytes alone are not that proof.

The backend enforces ciphertext, metadata, hidden, staging, and cleanup
capacity with one frozen charging function:

```text
charged_entry(class, key, value) =
  byte_length(canonical_v2_key_encoding(key)) +
  byte_length(canonical_v2_value_encoding(value)) +
  CLASS_OVERHEAD_FILES_V1[class]
physical_private_bytes =
  sum(charged_entry(...)) over every private V2 map entry
```

Canonical V2 encodings use the fixed-width integer, length-prefix, variant-tag,
and UTF-8 rules frozen with managed-memory schema V1. The per-class overhead
table is derived from maximum-state enhanced-persistence measurements and then
frozen with golden vectors; it is conservative quota policy, not an assertion
about exact heap object layout. Separate release gates measure heap pages,
stable pages, transient allocation, allocator fragmentation, and reuse after
fill/delete/refill churn.

The first write block declares exact metadata, wrapper, block geometry, and
gross old/new state and reserves every possible stage, final node/index,
cleanup, and idempotency charge. AES-GCM and fixed frame bounds make those
lengths knowable before mutation. Batch reservation uses the gross peak, not
the net delta. Later blocks and commit never allocate beyond that reservation;
unused charge is released.

Because V2 adds no private padding, the backend derives plaintext length from
validated geometry as `sum(ciphertext_block_length - 16)`. It rejects a block
shorter than the AES-GCM tag, noncanonical or over-limit geometry, a file above
16 MiB, or projected committed plaintext above 64 MiB. It atomically
CAS-updates `committed_private_plaintext_bytes` for create, replace, batch,
and the logical detach of remove. Hidden data releases logical plaintext quota
but remains in `physical_private_bytes` until bounded deletion. The backend
never trusts the encrypted metadata's claimed length for quota; the worker
authenticates and compares that claim after decryption for end-to-end
integrity.

The backend releases charged physical bytes only after the corresponding
records are deleted. Claimed plaintext length inside encrypted metadata is not
trusted for resource admission. When a job or physical cap is reached, a
mutation performs at most one bounded cleanup page and otherwise returns a
closed busy/quota rejection.

## Private Backend Protocol

All methods remain owner-authorized and are listed exactly in
`preapproved_self_calls`. No private method is a public canister protocol.
Names below are normative logical names; the compiler still owns physical
method names.

### Vault and navigation

```text
files_bootstrap_v2
files_list_v2
files_lookup_v2
files_read_chunk_v2
files_operation_status_v2
```

`files_bootstrap_v2` combines status, quota/cleanup summary, current vault
record, and active operation reconciliation into one query. Its output `body`
field contains the bounded vault wrapper frame or is empty when the vault is
absent. Initialization or rotation uses one revision-CAS
`files_vault_write_v2` request whose `body` field carries the frame; the
operation discriminant is an optional variant and unknown/null rejects before
mutation.

`files_list_v2` is direct-child and paginated. Its small JSON-safe `value`
contains only outcome, parent/children-revision binding, item/total counts,
cursor presence, and exact body length. Its `FilesFrameV2` control contains the
ordered structural summaries and next cursor; raw payload slices contain the
corresponding encrypted metadata. This keeps a 200-row page comfortably below
the independent 64 KiB message-bus metadata limit.

`files_lookup_v2` accepts a locator optional variant. Lookup by child supplies
exactly one raw 32-byte blind tag in `request.body`; lookup by `NodeId` uses an
empty `body`. Its response combines stat with encrypted metadata and the active
wrapped content descriptor. This method is also the cold-cache implementation
of the path-oriented `stat` tool.

`files_operation_status_v2` reconciles an ambiguous mutation using required
`RequestId`, target IDs, and expected result identity. It reports bounded
active/staged/committed/aborted/expired/superseded/unknown state, staged bytes,
expiry, cleanup state, and a reconstructable receipt. A private write stage
reports its accepted-frame bitmap and first-frame-pinned
frame-to-content-block mapping; a public stage reports the exact normalized
kernel unordered block status. Bitmap bit `i` is least-significant bit
`i mod 8` of byte `floor(i / 8)` and unused high bits are zero. It never
accepts a `RequestId` alone as authority and never returns private bytes.

### Vault, private writes, and batches

```text
files_vault_write_v2(request including body : Blob)
files_write_block_v2(request including body : Blob)
files_abort_v2
```

Every `files_write_block_v2` request carries JSON-safe `RequestId` words,
optional server stage ID, frame ordinal, a final flag, and the exact bounded
`WriteBlockFrameV2` in `body`. The first frame pins the total frame
count and the exact content-block/index/raw-slice mapping for every frame. Its
control contains:

- an optional write-intent variant (`create`, `replace`, or `batch`);
- every client-generated node/content ID;
- expected and proposed `+1` revisions and all structural CAS;
- blind name tags, encrypted metadata, wrapped keys, and complete
  per-content block geometry;
- one or more whole ciphertext blocks packed without exceeding the
  binary-call or allocation limit.

Subsequent frames contain the same operation identity and additional indexed
ciphertext blocks as raw payload slices. No content block crosses a frame.
The backend hashes the exact received frame once, decodes only its bounded
control under the published bounds, and:

1. on the first call, validates the entire structural plan, every ID/tag/CAS,
   depth and uniqueness rule, all exact encoded lengths, gross-peak physical
   quota, and the complete batch conflict set;
2. reserves capacity, creates a small stage, and writes accepted blocks under
   their final `ContentId` keys;
3. on every retry, accepts only the same request/frame fingerprint and pinned
   frame/block allocation; a frame retry cannot change its block set, order, or
   raw slices;
4. on the call that supplies the final required block, revalidates all CAS,
   publishes the node/content/index changes atomically, deletes bounded old
   blocks, removes the stage, and returns the receipt;
5. returns no post-mutation application error; any unexpected invariant traps
   the outer update and rolls it back.

A one-block file, an empty file, and a packed batch whose complete encoded
state fits one body field each commit in one update. A 16 MiB file uses nine
updates. `writeMany` accepts at most 20 text files, 10,485,760 total plaintext
bytes, 20 canonical content blocks, seven transport frames, and 64 structural
plan entries. Every synthesized parent, target file, changed child-index row,
and existing parent/ancestor whose counter, revision, height, or height
histogram changes counts once toward those 64 entries. Twenty unrelated deep
missing paths therefore reject with `batch_structure_limit` instead of
creating an unbounded plan.
Each maximum 524,288-byte text file is one 524,304-byte ciphertext block; at
most three such whole blocks fit beside maximum first-frame control, so the
20-file worst case is seven updates. Frames may carry several complete files
and commit all-or-none. Duplicate or overlapping targets are rejected before
encryption/reservation, and the final-call instruction benchmark covers the
complete 64-entry atomic structural plan.

`write`, `writeBinary`, upload, and `writeMany` with
`createParents = true` plan every missing folder and file in one virtual tree
before encryption. Those synthesized folders are part of the same first-frame
CAS plan and never commit through preliminary `mkdir` calls, so a later path,
quota, encryption, or CAS failure leaves no parent behind. Private write
operation-target nodes include every explicit planned file or synthesized
folder; their `content_id` is optional and null only for folders.
Operation-target nodes, committed receipt nodes, and status comparisons use one
canonical ascending `(node_id.hi, node_id.lo)` order independent of caller
input order. The resident restores caller-facing results to input order only
after validating that canonical receipt.

At most one public share stage is active. Its provisional Files record pins
the exact source `NodeId`/`ContentId` until that stage commits, aborts, or is
observed expired. A replace/batch that would change the pinned content and a
remove whose subtree contains the pinned node return `share_in_progress`;
rename or move remains allowed because it does not change the immutable source
content. The check is constant work plus the existing at-most-64-ancestor
walk, not a share-table scan. This short pin makes restartable public sharing
honest without retaining old private versions.

`files_abort_v2` makes the stage invisible, removes one bounded page, and
enqueues only genuinely remaining work. A private upload cannot resume after
a browser restart because its volatile content key and exact retry ciphertext
were intentionally not persisted; bootstrap detects it and offers bounded
abort/cleanup. Same-session retry uses the original bytes.

Text `append` and `patch` are resident operations: read and authenticate the
bounded text file, edit locally, encrypt a new version, and commit it with CAS.
The backend never patches ciphertext.

### Reads

```candid
type Id128V2 = record { hi : nat64; lo : nat64 };

type ReadChunkRequestV2 = record {
  node_id : Id128V2;
  structural_revision : nat64;
  content_id : Id128V2;
  index : nat32;
};

type ReadChunkResponseV2 = record {
  outcome : opt variant {
    ok : record {
      node_id : Id128V2;
      structural_revision : nat64;
      metadata_revision : nat64;
      content_id : Id128V2;
      index : nat32;
      block_count : nat32;
      ciphertext_block_bytes : nat32;
      ciphertext_total_bytes : nat64;
      frame_kind : opt variant { first; continuation };
    };
    rejected : record {
      reason : opt variant {
        not_found;
        not_file;
        stale_revision;
        stale_content;
        invalid_index;
        corrupt_state;
        incompatible;
      };
      retry_after_ns : opt nat64;
    };
  };
};

service : {
  files_read_chunk_v2 :
    (ReadChunkRequestV2) ->
    (record { value : ReadChunkResponseV2; body : blob }) query;
};
```

At the resident SDK boundary, generated actor normalization represents each
Candid `nat64` as a canonical unsigned decimal string and each `nat32` as a
JSON number. The resident validates those forms before comparing them with its
bound operation state.

Index zero fuses stat, reachability validation, encrypted node metadata,
wrapped content descriptor, and ciphertext block zero into one response frame.
A small read therefore takes one query; a maximum read takes nine,
not stat plus nine. Later requests repeat the exact node revision, content ID,
and block index. Every request currently repeats the at-most-64-ancestor
reachability check. Add a stateless read ticket only if maximum-depth
benchmarks prove that work material; an unsigned epoch or forgeable shortcut
must never bypass a hidden ancestor.

A known successful response repeats every scalar binding and its body is the
bounded `ReadBlockFrameV2`. Null/unknown outcome, any rejection, or a scalar
or frame mismatch discards the body. A null/unknown `frame_kind` also
discards the body because the client cannot safely interpret its layout. A
rejection body is empty. A concurrent replacement yields the selected complete
version or a clean stale conflict, never mixed blocks.

After authenticating all blocks, the worker also recomputes the full plaintext
SHA-256 and byte length and compares them with encrypted metadata before
releasing a completed read/download.

### Tree mutations and cleanup

```text
files_mutate_v2(request, final body : Blob)
files_remove_v2
files_cleanup_v2
```

`files_mutate_v2` carries one frame whose control contains an optional
create-folder/rename/move action, name tag, expected revisions, proposed `+1`
revisions, and offsets for the new encrypted-metadata payload. It validates
the complete transition and commits in one update. Folder create uses
root-depth `0`, leaf-height `0`, and requires `parent_depth + 1 <= 64`. Move
checks both parent CAS values,
uniqueness, reachability, cycles, subtree height, and resulting depth.

`files_remove_v2` needs no encrypted binary body. It atomically hides the
subtree root, removes its parent index entry, updates compact height/path/
plaintext aggregates, reclaims the bounded first page, and records any
continuation. Repeating an exact desired-absent request is idempotent even when
the original response was lost.

`files_cleanup_v2(record {})` takes the canonical empty business request. It
deterministically advances the oldest eligible already-persisted Files-private
job by exactly one aggregate cleanup page and returns only aggregate counts,
charged bytes, remaining-job count, and `has_more`. It accepts no caller-chosen
action, job, target, cursor, or integrity-audit mode. The generated Settings
action is bound at install to the exact current `AppScope`, this exact method
and empty request, and one page; it is not a generic callback.

All rejection records use optional extensible bounded codes. They never echo
encrypted metadata, blind tags, filenames, paths, bodies, keys, wrappers, or
hash material. Null outcome/reason is surfaced as incompatible or uncertain,
not blindly retried.

## Resident, Tools, And Tile

The credentialless ephemeral Files background remains the privacy gateway. It
owns:

- vetKeys recovery orchestration and the dedicated crypto worker, while raw
  key material remains worker-only;
- a volatile decrypted metadata LRU bounded by both 2,000 entries and 4 MiB,
  plus only the body blocks needed by the current operation;
- path-to-opaque-ID traversal;
- paginated folder loading and local name sorting/search;
- private block encryption/decryption;
- the existing app/agent tool registrations.

On authorized-principal change, app installation/version binding change,
worker failure, inactivity lock, or resident shutdown, it drops decrypted
caches and worker key state. Principal/install/version change additionally
purges dirty tile buffers, opaque cursor handles, pending attachment transfers,
and every Blob URL; only an idle lock may retain a visibly dirty buffer for the
same authority epoch. It does not persist them for seamless restart.
Tests reject any Files call to IndexedDB, localStorage, or Cache Storage even
though the dedicated-origin capability makes those browser APIs technically
available. A future bounded ciphertext-only cache may be non-authoritative, but
it requires a separate privacy/eviction design and is not silently introduced
as part of this implementation.

The resident additionally requires `window.credentialless === true`. An
ordinary-origin storage sentinel is inaccessible there, and opening a new
top-level kernel document gives Files a blank ephemeral partition. Unsupported
browsers fail closed; there is no persistent-origin fallback.

### Path-oriented tool contract

Preserve the product operations, implemented over V2:

- `list`, `stat`, `read`, and `readBinary`;
- `write`, `writeBinary`, `writeMany`, `append`, and `patch`;
- `mkdir`, `move`, and `remove`;
- bounded pagination cursors. Help/status remains tile UI, not an additional
  path tool.

`list` and recursive traversal become explicitly page-bounded. Tool callers
receive paths and plaintext only after the kernel's normal cross-app/agent
authorization. They never receive vault material, internal IDs, wrappers, or
ciphertext framing.

Backend list cursors contain parent IDs/blind tags and stop at the resident
boundary. The resident wraps them in bounded opaque continuation handles
scoped to caller, endpoint/install generation, lock epoch, folder revision,
and short expiry. Another caller/session cannot redeem one; restart/expiry
returns `cursor_expired` and restarts paging. No tool cursor serializes an
internal ID, tag, or backend Candid cursor.

Every Files frontend tool descriptor opts into the kernel's
`metadata_only` sensitive-audit profile. The kernel records tool name, caller,
effects, outcome, duration, and transferred byte counts, but never JSON
arguments/results. The same redaction applies to both API-1 self-call tools,
including calls whose Candid values contain binary. This is a required kernel
change, not an assumption about the current generic audit implementation.

`readBinary` and `writeBinary` keep their one-attachment app-to-app surface up
to 16 MiB. That transfer is between app endpoints in the browser. The resident
then slices the body into at most 1,889,984-byte normal plaintext blocks for IC
updates; a 16 MiB attachment is never sent as one ingress message.

V2 does not expose Share as an ordinary agent tool. Turning private bytes into
public plaintext is a separate disclosure action initiated in a focused Files
tile. A future share tool needs a separate high-risk authorization contract,
not an extra option on `write`.

At Share and Unshare button dispatch, the tile also requires
`document.hasFocus()` and an active `navigator.userActivation` when the latter
is supported. This is a consent/attention UX defense, not a kernel authority
claim; the resident still rechecks the exact source etag and revision after
asynchronous reads, and backend CAS remains authoritative.

### Tile work

The tile adds:

- a multi-file operating-system picker and drag/drop target;
- strict UTF-8/text classification and binary fallback;
- streaming `File.slice` through one pinned incremental SHA-256 implementation,
  encryption, and upload without retaining complete plaintext and ciphertext
  simultaneously;
- one initial in-flight block; ordinary desktop may raise this to two only
  after reserving the measured working buffers below, while constrained/mobile
  remains at one. The worker evicts decrypted LRU entries before increasing
  concurrency, and backend stage count never substitutes for a browser heap
  reservation;
- lazy paginated folder expansion instead of loading the recursive tree;
- virtualized folder rows, “Loaded X of Y”, `has_more`, cursor restart that
  preserves selection only when it remains in the refreshed first page and
  otherwise clears the selection/editor and resets scroll without an unbounded
  page scan, exact-name lookup, and an explicit cancellable page-scan mode for
  prefix/fuzzy search;
- private binary download through authenticated blocks, a short-lived Blob
  URL, and revocation after browser handoff or a bounded delay—not immediately
  after the synthetic click;
- the existing bounded text editor over encrypted backend reads/writes;
- Share, Share latest as new link, Copy link, and Unshare;
- a visible stale-snapshot marker when source content ID differs from the share
  record;
- an explicit public-data explanation before publication.

The vault UI is a state machine:

```text
initializing -> locked -> unlocking -> ready
                         \-> rotating
                         \-> unrecoverable
```

Only one unlock runs and at most one prompt appears per lock epoch. After an
explicit or idle relock, the next focused action starts a new epoch. Agent/tool
calls return a specific needs-user-unlock outcome instead of spawning repeated
prompts. Public share
listing and unshare remain available while private state is locked. Idle lock
does not discard a dirty editor buffer without warning; it blocks further
private I/O until unlock.

Transfers expose queued, hashing, encrypting/decrypting, uploading/downloading,
checking-outcome, committed, cancelled, conflicted, failed, and cleanup-pending
states. Retry uses exponential backoff only for ambiguous transport failure,
never for a known rejection. A lost update response enters
checking-outcome and calls `files_operation_status_v2` before any retry.

The editor has no cycle-spending autosave. It keeps a visible dirty state and
unload warning. A CAS conflict preserves the local buffer and offers reload,
save as copy, or a separately confirmed overwrite based on a newly read
revision. Quota, lock, stale cursor, offline, busy, and incompatible outcomes
each map to one concrete user action. `share_in_progress` offers Resume Share
or Cancel Share before replacing/removing the pinned source.

Sharing exposes pending, current, stale, source-missing, temporarily
unavailable, unsharing, and unshared states. Copy Link remains disabled until
the certified commit receipt is reconciled. Route/store disable makes a
committed share temporarily unavailable but does not delete it or mark it
unshared; compatible re-enable restores it. The UI states that deleting the
private source does not remove its public snapshot, unshare cannot recall
downloads, and Share Latest leaves the previous URL online.

Browser release gates are operation-specific:

- OS `File` upload: at most 16 MiB working heap excluding the OS-backed source
  `File`, but including crypto/frame buffers and retained decrypted LRU;
- app-to-app `writeBinary`: at most 32 MiB including the incoming 16 MiB
  attachment and all working buffers;
- `writeMany`: at most 32 MiB including its complete 10 MiB logical input;
- share: at most 16 MiB working heap, with no whole-file plaintext and with the
  LRU evicted/adapted as necessary;
- Blob-fallback download: at most 32 MiB including the final 16 MiB output Blob,
  one ciphertext/plaintext block pair, hashing state, LRU, and copies made by
  the supported browser.

Buffers are transferred or viewed where supported; a claimed zero-copy path
still has to pass measured Chromium, Firefox, and WebKit fixtures. If a
supported browser copies during Blob construction or postMessage and exceeds a
gate, concurrency/LRU shrinks first; the release must revise the documented
gate rather than hiding that allocation. Direct File System Access download
streaming is not part of V2 because no user-visible bytes may be released
before the complete authenticated length/SHA check; the ordinary verified Blob
fallback is required. A future streaming path needs an invisible temporary
sink plus atomic reveal.

The resident never sends a private filename or plaintext in backend method
metadata. The share flow is the sole intentional exception for plaintext body
bytes and the user-approved public filename.

## Public Share Protocol

### URL and public metadata

A share URL is:

```text
https://<neutron-host>/app/files/_route/shares/<64-lowercase-hex-publication-id>/<safe-name>
```

The worker contributes a fresh 16-byte random token. The kernel combines it
with a kernel-memory route namespace, scope/collection identity, and a
single kernel-memory-global checked `Nat64` publication generation:

```text
publication_id =
  SHA256(
    LP("neutron.files.publication.v2") ||
    route_namespace[16] ||
    LP(app_id) ||
    u64be(app_installation_uid) ||
    LP(collection_id) ||
    u64be(collection_generation) ||
    u64be(publication_generation) ||
    random_token[16]
  )
```

`route_namespace` is initialized from IC cryptographic randomness before
certified publication is enabled and persists for the kernel-memory lifetime.
The global generation never wraps or repeats during that lifetime, including
after abort, unshare, lifecycle retirement, or Files reinstall. A coordinated
kernel-memory reset must bootstrap a fresh namespace before accepting a Files
stage. Within one namespace, generation gives anti-ABA; across resets,
SHA-256 over the fresh 128-bit namespace and token gives conventional
negligible collision probability, not mathematical uniqueness. Hashing keeps
the public ID at 32 bytes, hides the generation, and retains 128-bit
enumeration resistance. This O(1)-state identity has no permanent spent-path
map. Query parameters are ignored aliases and never carry authority.

`safe-name` is user-visible and editable in the Share dialog. It is 1-100
ASCII characters from `[A-Za-z0-9._-]`, is not `.` or `..`, contains no path
separator/control character, and falls back to `file`. Treat it as public
metadata. The dialog may prefill a sanitized private name only while making
that disclosure clear.

The local lifecycle key is `ShareId`. Its compact live `ShareRecord` stores:

- the exact kernel-returned typed `Target`, including collection generation,
  32-byte publication ID, publication generation, and safe public name;
- public presentation (`inline_text` or `attachment`);
- public byte count, immutable content tag, and kernel record revision;
- source `NodeId`, immutable source `ContentId`, and source structural revision;
- created time and Files share-record revision.

It does not copy the private path, private filename, private encrypted
metadata, wrapped key, ciphertext, constant mount, full path, absolute URL,
raw client token, or redundant public locator. The client token is
discarded immediately after the kernel derives the target. `ShareId`,
`PublicationId`, and the kernel published-object CAS identity are distinct
types even though V2 stores one of each per share.

Each share-list row returns those required opaque source node/content IDs and
the source structural revision so Share Latest retains durable identity across
resident restarts. It never returns a raw private path or private name. Only an
unlocked resident may resolve the opaque node chain into a path; locked tile
status keeps `sourcePath` null. Normal status caches at most the 256 opaque
share rows but follows no private ancestry. A focused Share latest click sends
the exact cached stale `ShareId` and Files revision through a tile-only
resident action, which resolves and returns that one current source entry
after unlock; the public recovery path separately keeps its exact stage
authority. A 50-row refresh therefore performs zero ancestry queries instead
of up to 3,200.

Files never supplies a raw path to a mutation. For display and Copy Link, the
kernel-generated resident adapter purely renders the closed route from the
stored typed locator and current approved origin; it accepts no arbitrary
mount or path component. This avoids storing a duplicate path while still
making links recoverable after reload.

### Staged publication

Logical backend methods are:

```text
files_share_block_v2(request, final body : Blob)
files_share_list_v2
files_share_unshare_v2
files_abort_v2
```

`files_share_list_v2` is revision-bound and paginated at at most 50 compact
records. Its exact normalized DTO contains share ID/revision, typed publication
ID/generations, safe name, presentation, public byte count, created time,
required opaque source node/content IDs and source structural revision, and
current/stale/source-missing/temporarily-unavailable state. It omits
absolute/relative URL, private names/paths, content tag, and body hashes.
Freeze the maximum 100-character-name JSON fixture below 64 KiB; Copy Link uses
the pure kernel-owned renderer above.

`inline_text` is allowed only when the worker validates the complete selected
snapshot as strict UTF-8, the Files content classification is text, and the
body is at most 524,288 bytes. An ill-formed sequence, binary classification,
oversize text, or uncertain/unknown classification forces `attachment`;
filename extension and supplied MIME text never override that decision.

The user-mediated transaction is:

1. Bind the exact reachable private node revision and immutable content ID.
2. Confirm safe public name/presentation and generate independent fresh
   16-byte client-token, begin-nonce, and later commit-nonce values.
3. Read, authenticate, and decrypt only that bound version in the worker.
4. On the first block, revalidate the source and synchronously call:

   ```motoko
   begin_stage({
     nonce = begin_nonce;
     target = #allocate_files_publication({
       collection = "shares";
       collection_generation;
       client_token;
       filename = safe_name;
       block_lengths;
     });
     presentation = ?presentation;
     expected_bytes;
   })
   ```

   The returned `BeginStageOk.identity.computed_target` must be present. Before
   returning, the kernel has preallocated one internal extent per pinned
   public block; Files receives and stores no extent identity or ownership
   field. Files persists the exact target, `stage_id`, geometry, and frozen
   retry identity, then discards the raw client token. An identical lost-begin
   retry returns the byte-for-byte original result and original idle deadline;
   there is no replay marker. Files then uses `stage_status`.
5. In that same first outer update, and then for later blocks, send each exact
   plaintext block with
   `put_chunk({ stage_id; index; body })`. Files normally sends in order, but
   the kernel accepts any order. Matching indexed length/hash retries replay;
   different bytes conflict. Put writes its preallocated extent and cannot
   introduce a quota/allocation failure. Only a newly accepted block extends
   the one-hour idle deadline.
6. On the final block, perform every fallible local check and synchronously
   call:

   ```motoko
   commit_batch({
     nonce = commit_nonce;
     operations = [#put({
       target;
       condition = #absent;
       body = #stage(stage_id);
       presentation = ?presentation;
     })];
     requires_present_after = [];
   })
   ```

   Files compares the returned `RecordIdentity` target, geometry, ordered
   hashes, and structural content tag with its frozen lengths and accepted
   hashes, then performs only infallible lifecycle assignment. A one-block or
   empty snapshot publishes in one Files update; a 16 MiB snapshot uses nine.
7. A mismatch or impossible post-capability invariant traps the outer update
   and rolls back kernel and Files state. Success returns the exact typed
   target. The generated resident renderer derives its one closed relative URL
   from that target; an optional backend URL, when present, must match it
   byte-for-byte. The tile adds the approved current origin and enables Copy
   Link.

The public block bound is the compiled kernel constant:

```text
FILES_PUBLIC_STAGE_BLOCK_MAX_V2 =
  min(FILES_CERTIFIED_HTTP_SAFE_BODY_MAX_V2, 1,900,000)
```

Release requires `FILES_PUBLIC_STAGE_BLOCK_MAX_V2 >= 1,889,984`. Files pins
the exact private plaintext vector: one to nine positive pinned lengths that
need not be equal, or `[0]` only for an empty object. The real header,
certificate/witness, and Candid renderer fixtures must cover maximum `200`,
worst `206`, `HEAD`, `404`, mainnet-shaped proof, the 65,536-byte safety
margin, transient allocation, and exact-limit/plus-one rejection. If the
compiled bound fails, public sharing is release-blocked and both
specifications are revised; there is no fixed-width, smaller-geometry,
carry-buffer, or runtime fallback.

An abort or failed content-tag check leaves no HTTP route. A public stage can
be reconciled and resumed after browser restart once the vault is unlocked,
because the immutable private source remains available; the user may instead
abort it. Retry identity binds app installation, `RequestId`, kernel stage,
typed target, begin/commit nonce fingerprints, block index, and exact body
SHA-256.

For Files stages, `stage_status.#active.progress` is
`#unordered { accepted_bitmap; block_hashes }`. The optional hash vector has
exactly one position per pinned block; missing blocks are null. Bitmap bit
`i` is least-significant bit `i mod 8` of byte `floor(i / 8)`, and unused high
bits are zero. Consumed, aborted, and expired states retain exact identity,
geometry, terminal time, and reconciliation deadline for 24 hours. Consumed
also returns the shared lifecycle result, including a later deletion.

The public stage-state behavior is exact: active accepts a valid new block or
matching replay; consumed still reconstructs a matching historical block
replay but rejects abort with `#conflict`; aborted rejects puts with
`#aborted` and accepts repeated abort; expired rejects put and abort with
`#expired`; unknown rejects both with `#not_found`. Wrong index/length/body
bound is `#invalid` before this state check. A replay, conflict, status read,
or begin retry never extends idle expiry.

`files_abort_v2` has an optional extensible private/public stage-kind
discriminant and exact request/stage/source identity; unknown/null rejects.
For a public stage it first asks the synchronous kernel handle for status. An
active stage is aborted; a repeated aborted-stage abort succeeds. Expired
returns `#expired`, so Files recognizes the retained expired terminal state,
releases its local source pin, and leaves physical reclamation to bounded
maintenance. Consumed abort conflicts and Files reconciles the returned
`LifecycleOutcome`; abort never deletes an already published route. Unknown or
cleaned stage status is reconciled with the stored typed target through
`record_status`. Only `#ok(#absent ...)` means absent; `#present` and
`#recently_deleted` reconcile their exact identities, and `#invalid`,
`#stale_scope`, or `#stale_generation` are errors, never absence.

Private mutation does not change a committed share. Sharing a newer private
version always generates another publication identity; it never overwrites or
recreates the old URL. Unshare uses local `ShareId` plus exact Files revision,
looks up the stored kernel target/revision/content tag, prevalidates every local
condition, and then synchronously calls:

```motoko
commit_batch({
  nonce = delete_nonce;
  operations = [#delete({
    target;
    condition = { revision = kernel_revision; content_tag };
  })];
  requires_present_after = [];
})
```

There is no mixed or multi-delete form. The infallible local transition removes
the live record and fills the same `ShareLifecycleCarrier` with its deleted
identity; kernel proof/body deletion shares the outer transaction. Exact
unshare retry returns that carrier outcome, and a late publication retry
resolves to committed-then-deleted without resurrecting local state.

The stage terminal, successful publication, and delete reconciliation windows
are each exactly 24 hours from the kernel-defined transition/apply time. Delayed
cleanup never extends them. After a window, Files calls `record_status` before
choosing a new nonce or condition; it never blindly retries.

### Browser response behavior

- A one-chunk `inline_text` asset produces certified status `200`,
  `Content-Type: text/plain; charset=utf-8`, the exact full body, no active
  rendering, and no attachment disposition. A multi-chunk asset is returned
  by the canister as certified `206` chunks that the supported gateway
  reassembles into the ordinary full `200` the browser sees.
- A one-chunk `attachment` asset produces certified status `200`,
  `Content-Type: application/octet-stream`,
  `Content-Disposition: attachment; filename="<kernel-sanitized safe-name>"`,
  and exact binary bytes. A multi-chunk attachment uses the same certified
  `206`/gateway reassembly contract.
- `HEAD` returns the same certified representation headers and full
  `Content-Length` with an empty body.
- responses include strong etag, `Cache-Control: no-store`, `nosniff`, strict
  referrer/permissions/CSP headers, and no permissive CORS;
- missing, aborted, expired, or unshared paths return a certified,
  non-cacheable `404`.

For a multi-block object, response certification proves that a returned `206`
is one member of the immutable certified response set; it does not by itself
prove that a malicious replica returned the range the client requested.
Files uses an ordinary GET. The pinned supported gateway must request,
validate, and reassemble contiguous blocks with one total length, ETag, and
publication generation. A different already-certified block can still verify
as a set member, so tests and product copy must not claim otherwise.

Anyone may navigate to the URL. Unrelated sites do not receive a new ambient
credential or permissive cross-origin read policy.

## Resource And Cycle Behavior

Files owns the private storage/staging counters; the scoped kernel
`CertifiedAssetsV2.usage()` result is authoritative for public staging,
committed bytes, live/occupied entry slots, and receipt lanes. A first block
reserves declared gross-peak capacity; commit converts the reservation to
committed usage; abort/expiry releases it exactly once after actual deletion.
Certified public paths are immutable and never replaced. Cleanup and retries
are idempotent.

All Files updates and synchronous certified-assets work remain attributable to
the Files app through the kernel's existing instruction/cycle usage meter.
Attachment bytes, private payloads, blind tags, names, and content hashes are
not copied into kernel audit records. Audit retains bounded method, outcome,
duration, and byte-count summaries only.

The required user-journey call counts are:

| Journey | Target |
|---|---:|
| Bootstrap status plus vault | 1 query |
| Small private read after opaque-ID resolution | 1 query |
| 16 MiB private read after opaque-ID resolution | 9 queries |
| Cold path read at depth `d` | `d` lookup queries plus 1–9 block queries |
| Empty or one-block write | 1 update |
| 16 MiB write | 9 updates |
| Folder create, rename, or move | 1 update |
| Packed text batch fitting one frame | 1 update |
| Maximum 20-file text batch | 7 updates |
| One-block public share, excluding private read | 1 update |
| 16 MiB public share, excluding private reads | 9 updates |
| Remove or unshare | 1 update |

The one/nine read targets apply when the resident already holds the exact
opaque node identity, as it normally does after folder navigation. A fresh
session resolves each path segment with one logarithmic blind-tag lookup; no
call-count claim hides that cold-path work. Cache-hit, cold depth-1, and
maximum-depth fixtures are reported separately.

Under the repository's current low-side 13-node accounting, an authorized
update contributes at least the 5,000,000-cycle measured execution base and
1,200,000-cycle ingress reception base before its actual instructions. A
small write therefore targets 6.2 million fixed estimated cycles instead of
the previous three-update 18.6 million. A nine-block write targets 55.8
million instead of eleven-update 68.2 million. These are attribution
estimates, not billing guarantees; variable message bytes, response callbacks,
storage, and omitted query work remain separately documented.

No cleanup timer is introduced. Persisted Settings figures are labeled
“mutation-attributed storage/cycle usage.” They include Files updates and
synchronous certified-assets mutations but exclude public HTTP query delivery;
exact persistent GET/download counts are unavailable, not zero or free. V2
adds no query-side update or stable per-GET counter. Optional traffic figures
must name their gateway/node/operator source and be labeled sampled/aggregate;
query concurrency admission remains a platform/gateway concern.

Hard quotas do not preallocate their maximum. An empty vault owns only small
map roots and records; payload state grows on demand. At maximum configured
Files use, up to the 128 MiB private physical admission cap, 64 MiB of committed
public bodies, and 16 MiB of active public staging may coexist before public
metadata/proofs, detached cleanup, arena allocation/fragmentation, indexes, and
transient overhead. Release therefore measures actual maximum state and does
not present logical body ceilings as startup or total physical memory.

## Failure, Recovery, And Lifecycle

- A failed or disabled vetKeys slot locks private reads and writes without
  deleting ciphertext.
- A failed public upload stays non-routable and can be reconciled, resumed
  after unlock from the immutable private source, or aborted.
- A browser crash loses volatile private-upload keys and exact retry
  ciphertext. Bootstrap detects those private stages and offers abort; it does
  not pretend the operating-system upload can resume. Committed files remain.
- Compatible app upgrades retain the managed-memory `files` root, app scope,
  vault, and shares. Persistent changes use a new immutable schema and an
  explicit migration edge; Candid-compatible record additions do not by
  themselves change the memory version.
- Committed uninstall/reinstall clears Files memory, pending public uploads,
  committed app-scoped shares, and the old vetKeys installation namespace.
- Kernel/Files snapshot restore must restore Files ciphertext, the matching
  kernel vetKeys registry, and certified-assets state as one deployment point.
- There is no V1 IndexedDB import, memory migration, legacy route adapter, or
  plaintext recovery path.

## Implementation Order

- [x] Implement the frozen Files dependencies in
      [`todo.kernel.2.md`](../kernel/todo.kernel.2.md): API-1 nested/multiple
      Candid blobs, credentialless ephemeral origin, lifecycle receipts, and
      generated publication routes.
- [x] Freeze the initial Files V2 logical `.did`, all 14 method modes and
      binary-bearing request/result fields and application caps, inner Candid
      controls, null fallbacks, and bidirectional fixtures.
- [x] Freeze canonical crypto, client-generated IDs, CAS revisions, AAD,
      blind-tag, nonce, frame, and idempotency vectors.
- [x] Add the kernel live-Candid API-1 binary bridge and aggregate capacity
      plan specified by the coordinated kernel work.
- [x] Add managed-memory Files schema V1, compact indexes, invariants,
      store-once private stages, bounded cleanup, and Motoko service tests.
- [x] Generalize Mail's vetKeys/crypto worker primitives without weakening
      origin or key-custody boundaries.
- [x] Replace IndexedDB authority with resident backend navigation and private
      fused encrypted reads/writes.
- [x] Add file picker, drag/drop, progress, private download, lazy folders, and
      the complete vault/transfer/conflict/share state machines.
- [x] Implement and release-validate kernel Certified Assets V2.
- [x] Add fused Files share blocks, snapshot state, Share latest/Unshare UI,
      and kernel-returned URL handling.
- [ ] Freeze measured call-count, instruction, cycle, browser-heap,
      maximum-state, fragmentation, cleanup-economics, and gateway budgets.
- [ ] Rebuild the Files package and coordinated kernel package from clean
      sources.
- [ ] Reinstall in local validation only after the complete private suite
      passes.
- [ ] Enable production sharing only after the gateway certification and
      deployment-truth gates below pass.

Private encrypted Files may be validated before public sharing. There is no
1 MiB compatibility share mode: Share stays disabled until the complete V2
kernel path supports the same 16 MiB product bound.

## Acceptance Tests And Release Gates

### Crypto and privacy

- Golden vectors cover vault wrapping, HKDF domains, name tags, metadata,
  client-generated IDs, content-key wrapping, every block AAD field, and
  rotation.
- Wrong app/canister, vault, node, content, parent, revision, chunk index/count,
  length, nonce, tag, or key fails closed.
- Bit flips, missing/reordered blocks, wrapper substitution, and replay across
  files fail authentication.
- Setup races retain only the committed vault; losing candidates are zeroed.
- Current and legacy recovery work; pre-CAS, post-CAS, and restarted rotation
  retries are idempotent; current-wrapper read-back succeeds before Files
  recommends retirement. Generic Settings retains a clear unrecoverability
  warning because Files cannot interlock an owner action there.
- Plaintext sentinels do not appear in canister private memory, browser
  persistence, method metadata, logs, errors, audit output, or snapshots.
- Public-share tests separately prove that only the exact selected snapshot and
  approved safe name become plaintext.

### Candid and binary ABI

- The checked-in initial V2 `.did` covers all 14 logical methods, exact modes,
  one named request/response record, each ordinary binary field, and Files'
  application-specific cap.
- The compiler-emitted combined-actor `.did` maps all 14 physical methods back
  to that logical fixture with structurally identical modes and types.
- Normal `didc check` and common-method checks in both directions pass against
  every supported V2 fixture. Real old/new message fixtures cover missing
  optional record fields. Binary-bearing methods evolve only inside their
  named request/response records; there is no positional transport tail.
- A future tag in every extensible optional variant decodes as null in the old
  fixture. The same change in a plain variant fails in a negative fixture.
  Every generated binding handles null as unsupported/uncertain.
- Old/new fixtures run through the actual API-1 live-Candid/binary bridge in
  both directions, not only `didc`. An unknown adapter tag never
  escapes as an unhandled JSON variant, and an unknown/non-success outcome
  discards its body. Stale endpoint revocation remains enforced.
- Framed write/read/vault controls have allocation and byte limits, preserve
  exact received frame/control bytes for hashing, reject unsupported mutating
  variants, trailing inner-Candid values, and unaccounted raw payload bytes,
  and pass both-direction fixtures independently of the outer service check.
- Lookup round-trips arbitrary 32-byte tags through `request.body` and returns
  its binary result field;
  encrypted metadata/wrappers never appear as hex, base64, JSON byte arrays,
  or generic audit arguments.
- Wrong/missing/duplicate binary paths, binary at a non-blob live type, method
  mode, app/install binding, metadata cap, and byte boundary fail before
  dispatch.
- Fixtures independently enforce 65,536-byte normalized request/response
  metadata, 1,900,000 aggregate binary bytes across at most 512 leaves,
  131,072-byte raw structural Candid, 524,288-byte decoder allocation, 256
  type entries, depth 32, 4,096 decoded elements, and the 32-MiB
  endpoint/64-MiB global in-flight ceilings. Nested and repeated
  `blob`/`vec nat8` fields are valid when live Candid declares them.
- Oversized raw replies fail before body-sized decode/copy. If early limiting
  is unavailable, lookup reserves the full 1,900,000 bytes and no 8-KiB
  peak-memory/concurrency reduction is claimed.

### Storage and protocol

- A 10,000-node tree lists in stable bounded pages without a full scan.
- Exact lookup/uniqueness, NFC/case rules, rename, cross-folder move, depth,
  root/leaf depth conventions, create-at-depth-64 acceptance, depth-65
  rejection, ancestor-cycle rejection, subtree-height propagation,
  compact height-vector recomputation, and cursor invalidation are
  deterministic.
- Root protection, complete-path trim, repeated slash/`.` canonicalization,
  `..`/backslash/control rejection, NFC, case sensitivity, scalar/byte/path
  bounds, whole-input surrounding-whitespace trimming, and whitespace inside a
  stored segment have distinct golden fixtures; direct create/rename and a
  post-split segment with leading/trailing whitespace reject.
- Client-generated node/content/request IDs cover collision, replay, duplicate,
  and concurrent-CAS races. The backend accepts only exact proposed `+1`
  revisions, and no operation requires a reserve-before-encrypt update.
- Every `Node` retains the exact `name_tag` and authenticated declared scalar
  count. Index removal never scans a parent. One `children_by_name` map supplies
  lookup and paging.
- Rename/move maintain the 240-scalar maximum-relative-path aggregate through
  at most 64 ancestor updates without a descendant scan. Recursive detach uses
  the selected subtree plaintext aggregate to release logical quota exactly.
- Create/replace/batch CAS conflicts publish nothing.
- Block retries, wrong hashes, gaps, over-limit frames, abort, expiry, staging
  accounting, quota release, and cleanup are idempotent.
- Canonical block vectors cover empty plaintext as one 16-byte ciphertext
  block, every boundary through 16 MiB, whole-block frame packing, and exact
  seven-frame/20-block maximum batches. Exact-limit/plus-one fixtures enforce
  `4 + control_bytes + raw_payload_bytes <= 1,900,000`, including the
  9,996-byte single-file and 196,608-byte batch control classes. A frame retry
  cannot repack a block.
- Blocks are stored once under final content IDs. Commit performs no body-sized
  copy/re-key/rehash, and committed content retains no aggregate ciphertext
  digest or separate content-map entry.
- Single replacement deletes at most nine old blocks synchronously. Batch
  reclamation remains page-bounded and has no ineffective read-grace state.
- Recursive deletion hides a subtree immediately and reclaims it in bounded
  work; guessed descendant IDs cannot bypass hiding.
- Staged, hidden, replaced, and orphan bytes remain physically charged until
  bounded deletion; repeated abort/replace/delete cannot exceed physical or job
  caps.
- Concurrent residents cannot exceed per-file/global derived-plaintext,
  ciphertext, staging, physical, job, or 64-entry batch-plan quotas. The
  backend derives plaintext from tag-bearing geometry and never trusts the
  encrypted metadata claim.
- A replacement/read race returns one complete immutable version or a clean
  conflict, never mixed blocks.
- Text operations round-trip every valid UTF-8 boundary case. Binary operations
  round-trip arbitrary bytes at zero length, block boundaries, and 16 MiB.
- Call-count gates enforce one update for empty/one-block write and folder
  mutation, nine for a 16 MiB write, seven for the maximum text batch, and
  one/nine queries for a small/maximum read after opaque-ID resolution. Cold
  depth-`d` reads separately prove `d + 1..9` queries. Lost replies reconcile
  before retry.
- Files app/agent tool permission tests prove exact plaintext release and
  cross-app denial without exposing key/ciphertext internals.
- Self-call audit plus Files tool audit contain only metadata/counts; plaintext
  path/body/list sentinels never appear.
- The dedicated resident has `window.credentialless === true`, cannot read an
  ordinary-origin storage sentinel, sees a blank ephemeral partition after a
  new top-level kernel document, and never calls IndexedDB, localStorage, or
  Cache Storage. Unsupported mode fails closed with no persistent fallback.
- Empty-start, 10,000-node metadata-only, full private quota, and mixed
  private/public maximum states measure actual heap/stable pages. Repeated
  fill/delete/refill and alternating block sizes reach a reuse plateau rather
  than leaking map or allocator state.
- Foreground cleanup performs one aggregate page. No timer runs while idle;
  abandoned bytes remain bounded and physically charged until the next related
  mutation, explicit cancel, or Settings maintenance page. Cleanup stops at
  nine blocks, 16,777,360 ciphertext bytes, 128 other entries, or its measured
  instruction ceiling across all jobs.
- The Settings binding invokes only exact current `AppScope`
  `files_cleanup_v2(record {})`; one call advances one deterministic private
  page and exposes no action, target, job, cursor, or generic callback.

### UX and browser resources

- Vault initialization, lock, unlock, rotation, and unrecoverable states have
  deterministic transitions and at most one unlock prompt per lock epoch.
- Folder pages display Loaded X of Y and virtualize rows. Cursor restart
  preserves selection only when it remains in the refreshed page; otherwise it
  truthfully clears selection/editor and resets scroll rather than scanning
  thousands of pages. Page-local sort is never presented as globally
  alphabetical.
- Tool continuation handles are caller/session/install/lock-epoch bound,
  expire within their cap, and reveal no parent ID, blind tag, or backend
  cursor.
- Private crash recovery detects but does not falsely resume an OS upload;
  public share recovery can resume from the immutable private source.
- Dirty editor buffers survive lock, offline failure, quota rejection, and CAS
  conflict; reload/save-copy/confirmed-overwrite actions behave as specified.
  Principal/install/version changes instead purge them, transfers, cursor
  handles, decrypted caches, and Blob URLs.
- Copy Link cannot race publication. Pending/current/stale/source-missing/
  temporarily-unavailable/unshared states and public-data/revocation warnings
  are covered on desktop, mobile, keyboard, and screen-reader paths. Route
  disable does not alter the share record; compatible re-enable restores it.
- OS upload/share working heap, attachment/batch input-inclusive heap, and
  fallback-download heap pass their separate 16/32 MiB gates in Chromium,
  Firefox, and WebKit. Adaptive concurrency/LRU behavior is exercised.
  Cancellation releases attachment reservations and delayed Blob-URL
  revocation does not cancel the browser download.

### Public HTTP

- Share is an immutable snapshot across private edit, move, rename, and delete.
  While a public stage is active, source replacement/ancestor removal is
  blocked, rename/move remains allowed, and commit/abort/expiry/lost-response
  reconciliation releases the pin exactly once.
- A bootstrapped 128-bit route namespace, scope/collection identity,
  kernel-memory-global burned generation, and client token hash to a new opaque
  publication ID. The token is not persisted after derivation. Upgrade and
  Files reinstall retain the global sequence; a coordinated kernel-memory
  reset requires a fresh namespace. More than 4,096 publish/unshare cycles,
  with receipt windows advanced, grow no spent ledger. Every old URL remains
  `404`.
- Exact typed begin/put/commit/delete shapes are frozen. Lost begin returns the
  original `BeginStageOk` without a replay flag. Files status uses an LSB-first
  bitmap and position-aligned optional hashes; consumed status can report
  committed-then-deleted. Only `record_status #ok(#absent)` means absence, and
  stale/invalid results remain errors.
- Publishing and unsharing 256 one-byte shares plus aborting 256 independent
  stages inside 24 hours uses exactly 768 general lanes and fills 256
  precharged revocation lanes without `receipt_full`; identical retries add no
  lane. Deleting all 256 reports zero live but 256 occupied lifecycle slots,
  and replacement publication returns `#quota` until the delete window is
  cleaned. The UI describes rolling 24-hour capacity.
- A 50-row maximum share-list DTO fits its frozen JSON bound and the pure
  generated renderer reconstructs the exact link after restart without Files
  supplying a raw mutation path.
- Strict valid UTF-8 text containing HTML/SVG/script payloads displays as inert
  plain text; invalid UTF-8 and binary/unknown classification force download.
- Arbitrary binary forces download with the safe kernel-generated filename and
  exact bytes.
- `GET`, `HEAD`, every certified `206` range chunk, full 16 MiB gateway
  reassembly, etag, content length, wrong method, malformed path, ignored query
  alias, wrong host, forbidden path reuse, and revoked path behavior are
  covered.
- Response certification V2 verifies through a real local IC HTTP gateway and
  a production-style gateway, not only direct canister query unit tests.
- A test proves that another already-certified block remains a valid V2
  response-set member. Separately, every supported gateway rejects gaps,
  overlap, reordering, changed total/ETag/publication generation, cross-app or
  static bytes while reassembling the ordinary full GET. Responses already
  evaluated or in flight may still arrive and cannot be recalled. Fabricated
  static callback tokens remain rejected for every app route.
- Private-aligned public block geometry transfers each decrypted source block
  without concatenation/repartition allocation and still reproduces the exact
  16 MiB body only after the compiled
  `FILES_PUBLIC_STAGE_BLOCK_MAX_V2` proves at least 1,889,984 bytes. Real
  renderer/proof/Candid fixtures include the 65,536-byte margin, transient
  allocation, exact maximum, and plus-one rejection. Failure blocks release;
  there is no geometry fallback.
- The generated Files adapter exposes no collection-clear/unshare-all method.
  Exact conditional unshare is the only ordinary revocation. Write freeze still
  allows unshare, abort, and cleanup; route disable is temporary
  unavailability, not deletion.
- App uninstall/reinstall clears committed and staged certified records for the
  old installation.

### Deployment truth

- The package/build receipt binds the exact Files and kernel sources tested.
- The current production subnet is described as ordinary unless a current
  registry-backed confidential-subnet check proves otherwise.
- Any confidential-subnet claim records exact subnet principal and evidence in
  the provision/reinstall receipt and fails closed on mismatch.
- Public sharing is not released while
  [`todo.kernel.2.md`](../kernel/todo.kernel.2.md)'s certified
  range/gateway gate remains open.

## Non-Goals

- V1 IndexedDB or stable-memory migration;
- private-file HTTP serving or secret query-token URLs;
- live shares, folder shares, passwords, expiry links, ACLs, or collaborative
  editing;
- server-side plaintext search, indexing, preview generation, MIME sniffing,
  deduplication, or thumbnails;
- hiding topology, ciphertext length, chunk count, timing, or access patterns;
- globally alphabetical backend pagination over encrypted names;
- protection from a malicious controller/frontend, compromised authorized
  browser, copied key, or explicitly permitted plaintext consumer;
- arbitrary response headers, active public MIME types, or app-owned
  certification trees;
- exposing `kernel_static` to Files;
- resumable operating-system uploads after browser reload;
- a periodic cleanup or cross-canister polling timer;
- an agent-callable Share tool in V2.
