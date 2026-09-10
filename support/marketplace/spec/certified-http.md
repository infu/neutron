# Certified HTTP delivery

## Selected transport

Packages and their offered-source artifacts are served through **certified HTTP**,
as requested. Public catalog/setup metadata can retain existing certified Candid
queries; authenticated Candid package chunks are not an alternative paid-byte
transport in this plan.

Preserve canonical digest-addressed paths and the existing closed release JSON:

```text
/repo/v1/releases/<app-id>.json
/repo/v1/packages/<sha256>.neutron
/repo/v1/sources/<sha256>.source.v1.msgpack.gz
```

The protocol stores immutable content, maintains hashes and certification,
checks access and streams content. Both new and legacy HTTP responses must pass
the normal certificate and complete-file hash/size verification before installation.

## Authentication without a Neutron byte proxy

A browser delegate authorizes private queries and HTTP reads only. Creating or
changing a source grant uses an update through the Neutron with native cycles
attached. Generic Kernel acquisition uses the same caller-funded
`repo_access_v1` boundary independently of the marketplace app. The source
authenticates the actual Neutron caller and checks its own entitlements/roles;
Kernel generates an opaque bearer and the source retains its hash. Queries can
inspect authorized grant status without creating a grant or recovering its secret.

Send the credential in an HTTP authorization header to the exact selected source
origin. Canonical package/source URLs stay credential-free. Do not put grants
in package manifests, provenance, displayed links or agent results. The browser
downloads every byte directly. Reuse valid read credentials rather than making a
backend call for each chunk or asset read. Ordinary grant-creation,
renewal or revocation update attaches native cycles through the Neutron; there
are no prepaid credits or general browser-direct user updates. Authorized
auditor access updates retain their direct CLI route and cycle exemption. The
separate four admin-only exemptions do not apply to `repo_access_v1` or ordinary
browser read-delegate changes.

Batch acquisition needs a generic HTTP package path after it reads the pinned
setup manifest. Settings and offered-source download use the same authenticated
HTTP reader. Existing compile/review/install journals stay unchanged. Private
downloads must continue working after the marketplace app is uninstalled.

## Generic acquisition contract

The source publishes a certified, read-only `/repo/v1/access.json` descriptor:

```json
{"protocol":"neutron-repo-access-v1","fee_version":"1","cycles":"1000000"}
```

The cycle amount above is illustrative. Both numeric fields use canonical
unsigned decimal strings. Existing Install, Upgrade, and source-download actions
show the actual descriptor's cost, source principal, and Neutron principal before
the user acts. The access request requires that exact shown fee revision and
amount; changed costs require another review through the existing action.
Background checks only read metadata. A certified descriptor absence keeps
legacy public downloads working, and a failed cost lookup never authorizes a
paid request.

The source method is:

```candid
repo_access_v1 : (record {
  request_id : text;
  token : text;
  paths : vec text;
  fee_version : nat;
}) -> (variant {
  ok : record { request_id : text; paths : vec text; accepted_cycles : nat };
  err : record { code : text; message : text };
});
```

Kernel generates a 32-character lowercase hexadecimal request ID and a
64-character lowercase hexadecimal bearer. Paths are exact canonical package
or offered-source paths; one grant can cover a selected bundle. Source
idempotency binds the actual Neutron caller, request ID, token hash, and paths.
Retrying an interrupted reply retains the original request. `accepted_cycles`
describes the current invocation, so an idempotent lookup that refunds the new
attachment returns zero.

The owner-only `kernel_repository_access_v1` broker forwards this fixed method
with native cycles. Its wrapper returns `result` and `charged_cycles : opt nat`:
an observed charge on a successful typed reply, or unknown after a rejected
native call whose refund is unavailable. It does not turn that unknown into
either a zero charge or the entire attachment. No persistent Kernel memory root
or marketplace policy is added.

For setup bundles, public certified Candid metadata remains unchanged. Public
legacy `repo_package` bytes also remain supported. Only a verified absence from
that legacy certified asset subtree selects the canonical HTTP package path;
an interrupted or invalid Candid proof does not. HTTP/access failure never
switches back to a public byte channel. The private HTTP certification tree and
the legacy public asset subtree serve different roles.

## Certification and streaming

Use request-bound HTTP certification v2 with the selected authorization
header, canonical path, response status, relevant headers and full body digest.
Measure certificate-tree growth, grant issuance/renewal and practical bundle
latency before selecting the representation. Do not assume a grant-by-entire-
catalog cross product is affordable.

The gateway's streaming callback receives its continuation token, not the
original authorization header. Tokens must preserve verifiable grant, artifact
and offset scope; the callback checks it before each content read. An internal
storage reference or guessed digest/index must not expose private bytes. Range
support, if offered, needs correct partial-response certification; a full-file hash alone
does not authenticate an isolated range before full assembly.

Private responses need authorization-aware certification and cache isolation.
Existing public immutable-cache expectations must be extended generically for
private assets. Test browser preflight/CORS with Authorization and the real
verification path. Neither blanket uncertified responses nor anonymous successful
fallbacks are acceptable for private content. Specify and test denial/OPTIONS
responses separately; they must not reveal artifact bytes.

An existing grant must not continue to authorize ordinary downloads of a revoked
release. Recheck current release eligibility on reads and continuations, and
invalidate its ordinary certified access paths when revocation commits. Preserve
the buyer's entitlement and authorized publisher/auditor review access; approved
replacement versions remain available to existing owners without repurchase.

Use the actual HTTP specification and verifier as the acceptance boundary rather
than assuming storage implies certification. Local compiled-canister tests use
the official response verifier against actual certificates, including private
multi-chunk responses, request authorization binding, tampered responses, HEAD,
denials, CORS, continuation scope, revocation, and state-preserving upgrades.
These tests are not a claim of production mainnet verification.

## Compatibility and verification

Keep already-public historical artifacts and the free transition set accessible
to old clients. Future private artifacts and their source must never be copied
into old public paths. Legacy `repo_package` and any debug/export readers must
not provide another route around paid HTTP access checks.

Test valid owner/role access, spoofed Neutron IDs, missing/wrong grants,
streaming continuation abuse, two browsers with different ownership, tampered
body/headers, source artifacts, cancellation/resume, key replacement and canister
upgrade. Verify public metadata/legacy free downloads still work. Access control
does not prevent an authorized buyer copying bytes already delivered.

Primary references:

- [HTTP Gateway Protocol](https://docs.internetcomputer.org/references/http-gateway-protocol-spec/)
- [DFINITY response verification, inspected revision](https://github.com/dfinity/response-verification/tree/1051695ec67b77105d25783e85f7bdaded4e4139)
- [Existing source verifier](../../../support/update-source/src/http.ts)
- [Existing repository contract](../../../packages/neutron-tools/src/repository.ts)
