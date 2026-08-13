# Files

Files presents one familiar filesystem with three permanent root folders. The
root folder is the storage policy, and every nested folder and file inherits
that policy:

- **Shared** is public and unencrypted. File bodies live once in the kernel's
  scoped Certified Assets store; Files keeps their tree metadata and certified
  identity in managed memory. Creating or moving a file into Shared publishes
  it automatically and gives it a public URL. Text-like extensions use the
  inert inline-text presentation; other extensions download as
  attachments.
- **Vault** encrypts names, metadata, text, and binary bodies with the user's
  VetKey-derived keys in the Files background resident before anything
  reaches the Files Motoko backend. The backend stores ciphertext and bounded
  structural indexes.
- **Workspace** is unencrypted but not publicly routed. Its metadata and file
  blocks are stored directly by the Files backend.

The tile renders these roots as an expandable tree. Folders can be nested
inside any root, and moving an item across a root boundary converts it to the
destination policy: Vault encrypts it, Workspace stores it as backend
plaintext, and Shared publishes it. Shared files use **Get link** rather than a
separate sharing workflow.

Files runs its background resident on an installation-dedicated persistent
browser origin. The Files backend and the kernel's Certified Assets store remain
the authoritative stores for file metadata and bodies.

The resident may keep one 32-byte Vault root for up to seven days in its
encrypted browser-secret cache. The wrapping key is non-extractable, and a
restore is accepted only after a live enabled-slot check matches the exact
generation, public-key fingerprint, committed Vault context, wrapper, and root
commitment. The worker verifies the root commitment before deriving
non-extractable working keys. No filename, file metadata, file body, transport
secret, or raw VetKey is persisted. A miss falls back to one normal recovery
only after the user explicitly opens Vault; status refreshes and reconnects
never initiate recovery.

The resident preserves the path-oriented tool surface:

`list`, `stat`, `read`, `readBinary`, `write`, `writeBinary`, `writeMany`,
`append`, `patch`, `mkdir`, `move`, and `remove`.

Ordinary app and agent callers use `/Shared`, `/Vault`, and `/Workspace`
directly. Workspace is the tool default: `/`, an omitted list path, and paths
such as `/notes/today.md` resolve under `/Workspace`. There is no routing-mode
argument. The Files tile also uses these roots and reserves `/` for its root
index. Writing or moving into `/Shared` publishes the file and is accepted
only from the kernel-attested Files tile or an owner-authorized Agent Mode
turn. Tile-only Vault and transfer controls declare same-app visibility, so
other apps and agents neither discover nor invoke them.

Vault plaintext is exposed only to an authorized caller while Vault is open.
Workspace and Shared intentionally use bounded plaintext backend calls; Shared
bodies go directly to Certified Assets and are not duplicated in the Files
block store. The tile itself creates only explicitly rooted paths.

Shared and Workspace path segments use Unicode 16.0 NFC under the
Normalization Process for Stabilized Strings: every scalar must be assigned
in Unicode 16.0, C0/C1 controls and `/`/`\` reject, and the exact Unicode
`White_Space` set rejects at either name edge. Interior whitespace is allowed.
The generated Motoko and TypeScript tables are the shared authority and do not
depend on the browser, JavaScript engine, or Motoko compiler Unicode version.
Vault keeps its encrypted name policy while Workspace and Shared use the
pinned plain-name policy.

Shared selects the kernel's generic `publication` collection kind. That one
closed kind derives the host-bound read mount, opaque public path, staged
create-once behavior, conditional deletion, fixed response headers, range
behavior, and certified absence. Files declares the collection and receives a
Kernel-derived read route; it does not author a certified-read route. There is
no Files-specific Kernel path rule.

The resident reaches its backend through the API-1 `querySelf`/`updateSelf`
surface. Vault blind tags, encrypted frames, wrappers, and chunks remain
ordinary `Blob` fields in the Files V2 Candid records. Workspace and Shared use
the separate Files Plain V3 records, whose `Blob` body fields intentionally
carry plaintext.

## Release

Files v0.4.5 is manifest version 405 and managed-memory schema 2. It retains
the immutable schema-1 module and performs one managed `1 -> 2` migration,
preserving the encrypted Vault state while initializing the new Workspace and
Shared roots.

Use `npm run package` for normal rebuilds. The managed-memory lock remains
append-only release history and must not be deleted or regenerated.

Packaging starts from an empty `dist`, embeds release evidence for the exact
Files sources, dependency lock, both memory schemas, the migration and memory
lock, inline crypto worker, and payload bytes, then verifies every unpacked
archive path and byte. Files release evidence deliberately does not hash
Kernel source or Kernel Certified Assets qualification artifacts; the Kernel
qualifies its generic capability independently, while Files tests its own
integration. Normal packaging does not launch a browser or embed a
browser-generated artifact. Run `npm run release:browser` for the
explicit Playwright release gate that executes the exact inline worker in a
browser-isolated frame. `npm test` rebuilds and verifies
`files.v0.4.5.neutron` and runs the browser suites separately, so stale ignored
output cannot satisfy the package tests.

`npm run unicode:check` regenerates both Unicode table artifacts in memory
from the vendored, checksum-pinned Unicode 16.0 inputs and runs all 99,825 NFC
relations in the official normalization corpus. The Unicode License v3 notice
is in [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) and is copied into
every Files package.
