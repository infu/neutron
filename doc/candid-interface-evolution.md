# Candid Interface Evolution

[Documentation index](./index.md)

Use this contract when changing a Candid interface used by independently
upgraded clients or canisters. It defines rolling compatibility, including
Candid values nested inside blobs. Persistent Motoko memory follows the
separate [memory migration contract](./memory-migrations-and-uninstall.md).

## Compatibility Contract

For each supported release pair, verify both old caller → new callee and new
caller → old callee. A normal service-upgrade subtype check covers only the
first direction. For example, adding a required result works for an old client
that ignores it, but a new client cannot obtain that result from an old service.

Apply these rules to every existing rolling-compatible method and nested type:

- Preserve field labels, variant tags, positional meanings, and existing types.
  Record labels and variant tags are wire identifiers; declaration order and
  named type aliases are not version markers. Never reuse a retired label.
- Add record fields as `opt T`, and keep populating old required fields while
  supported receivers still require them. Prefer one named request record and
  one named response record for new methods.
- Append only optional method arguments, results, or tuple-record elements.
  Never insert or remove a positional element in the middle, even when the
  affected types happen to match.
- Wrap variants expected to gain tags in `opt` from their first release. Handle
  unsupported values explicitly; do not translate them into a default mutation.
- Keep authorization, actor and target selection, charging, deduplication,
  idempotency, retention, and query/update semantics unchanged. Successful
  decoding does not establish semantic compatibility.
- An optional extension must be safe for old code to ignore. A field required
  for a security decision or correct mutation needs a new method or protocol
  major version, even if Candid accepts it.
- Validate recognized values under the protocol's existing rules. Introducing
  or changing bounds requires the approval described in [AGENTS.md](../AGENTS.md).

Do not add a schema-version field merely to permit optional additions. Use a
version discriminator only for incompatible semantic encodings that require
decoder branching. Major changes may require a new method, route, certified
path, or hash domain; a renamed source type alias does not change the wire type.

New methods require support discovery or a safe method-not-found path when
calling old peers. A failed mutation or lost response is not evidence that a
method is absent. Any fallback must preserve the operation's semantics and
follow the [deprecation policy](./deprecated.md).

## Change Matrix

These are wire-level outcomes. Every apparently safe entry still requires the
semantic checks above and tests through the bindings actually used by the app.

| Change | Old caller → new service | New caller → old service | Rolling rule |
| --- | --- | --- | --- |
| Add a method | Existing methods remain available | Added method is absent | Discover support before depending on it |
| Add required input record field | Missing field fails decoding | Extra field is ignored | Use an optional field or a new method |
| Add optional input record field | Missing field becomes absent | Extra field is ignored | Safe only if ignoring it is safe |
| Remove required input record field | Old extra field is ignored | Old service requires the missing field | Keep sending it |
| Add required output record field | Extra field is ignored | Missing field fails decoding | Make rolling output additions optional |
| Add optional output record field | Extra field is ignored | Missing field becomes absent | Handle absence explicitly |
| Remove required output record field | Old client requires the missing field | New client ignores it | Keep returning it |
| Add plain input-variant tag | Old tags remain accepted | New tag fails decoding | Use an optional variant boundary |
| Add plain output-variant tag | New tag can fail decoding | Old tags remain accepted | Use an optional variant boundary |
| Add tag inside `opt variant` | Unknown tags can become absent | Unknown tags can become absent | Preserve known tags and handle unsupported values |
| Append required argument | Old caller omits a required value | Extra value is ignored | Do not use for rolling methods |
| Append optional argument | Missing value becomes absent | Extra value is ignored | Preserve all earlier positions |
| Append optional result | Extra value is ignored | Missing value becomes absent | Preserve all earlier positions |
| Append optional tuple-record element | Missing element becomes absent | Extra element is ignored | Preserve all earlier numeric labels |

The normal upgrade relation allows some scalar widenings, such as accepting
`int` where an old service accepted `nat`. Do not infer bidirectional safety
from those one-way changes. Test the exact old and new types and their value
ranges, or use a new field/method.

## Optional Variants And Boundary Representations

Candid's special option rule lets an unknown variant tag decode as an empty
option. Known tags must retain their meaning. Place the option at the smallest
boundary allowed to become unsupported:

```candid
// Only status is lost when it contains an unknown tag.
record { status : opt variant { active; paused }; name : text }

// An unknown status can discard the entire optional record.
opt record { status : variant { active; paused }; name : text }
```

Likewise, `vec opt variant { ... }` can preserve known elements when another
element is unsupported; `opt vec variant { ... }` can discard the entire vector.
The special rule also permits other type mismatches to become absent. Do not
use `opt` to conceal arbitrary schema changes.

An empty option does not identify why data is absent: the sender may have
omitted it, sent an unknown tag, or encountered another permitted mismatch.
For a required operation selector, treat absence as incompatible and reject
before business mutation. For a response, retain an unsupported or uncertain
outcome rather than retrying a mutation blindly. Presentation-only fragments
may be omitted when the protocol permits that behavior.

Do not assume a Candid empty option is a JavaScript `null` at every boundary.
Raw JavaScript Candid bindings use `[]` for an empty option and `[value]` for a
present option. The Kernel's API-1 self-call projection omits absent optional
record fields, while absent top-level values and tuple/vector slots become
`null`. Inspect `normalizeCandidBoundaryValue` and its projector in
[self_calls.ts](../apps/kernel/src/self_calls.ts), and test the app's parser
after projection as well as raw Candid decoding. The
[Files method compatibility tests](../apps/vfs/test/abi/files_v2_method_compat.test.ts)
exercise this complete boundary.

## Deprecation And Exact Bytes

For field deprecation, keep the published label and type, send valid values
to supported old peers, and let newer receivers stop using the field. Remove
it only after a deliberate protocol transition excludes those peers.
`reserved` and `opt empty` can express retirement in Candid, but do not prove
the opposite rolling direction or preserve application meaning automatically.

For nested Candid inside `blob`, the outer interface check sees only bytes.
Maintain explicit inner types and old/new encode-decode fixtures. Apply the
protocol's byte/allocation checks before decoding, and retain the received
bytes when they define identity, certification, storage, forwarding, or retry.
Never decode and re-encode to reconstruct a digest or signed/certified preimage.
Compatible optional additions can change exact bytes and therefore change a
byte-derived identifier even when an old decoder ignores them.

[Wagyu codecs](../apps/wagyu/src/protocol/codecs.ts) preserve and hash received
bytes before decoding; their
[golden protocol tests](../apps/wagyu/test/protocol_golden.test.ts) verify that
an extended encoding remains decodable while retaining a distinct digest.

## Release Evidence And Existing Automation

The following checks are release work for the changed protocol; do not assume
packaging or the root test command creates a compatibility corpus for it.
Preserve released `.did` files and message fixtures without rewriting history.
Select the supported release pairs explicitly.

Run the ordinary service-upgrade check:

```sh
didc check current.did previous.did
```

For rolling methods, also check both directions using interfaces containing
only their common methods. Whole-service reverse subtyping can fail solely
because a newer service adds methods:

```sh
didc check current-common.did previous-common.did
didc check previous-common.did current-common.did
```

Use `didc check` for files. `didc subtype` accepts inline types; this pair checks
the optional positional-extension pattern:

```sh
didc subtype \
  'func (nat64, blob, opt text) -> (bool, opt nat64)' \
  'func (nat64, blob) -> (bool)'
didc subtype \
  'func (nat64, blob) -> (bool)' \
  'func (nat64, blob, opt text) -> (bool, opt nat64)'
```

Keep message-level evidence for the changed shapes, not only subtype results:

- Supported old encodings decode with current types; current base-feature
  encodings decode with supported old types.
- Missing optional fields/tails and unknown optional-variant tags reach the
  intended absent/unsupported state through each binding and app parser used.
- Known tags and all required identity/security fields survive decoding.
- Negative fixtures demonstrate rejection of incompatible required fields,
  plain unknown variants, and unsafe positional or scalar changes. Do not
  expect every semantic incompatibility to fail Candid decoding.
- Nested blobs retain exact-byte hashes and have separate inner compatibility
  fixtures.

Review special-option subtype warnings against explicit fallback fixtures.
There is no repository-wide warning-rejection/allowlist gate in the root
scripts. The Files compatibility tests deliberately accept these warnings for
reviewed optional-variant extensions. Use those tests as examples, not as proof
that another app's interface has been checked:

- [Files optional-field/tag fixtures](../apps/vfs/test/abi/files_v2_compat.test.ts)
  test known-tag preservation, unknown-tag fallback, missing optional fields,
  and a plain-variant negative control.
- [Files method fixtures](../apps/vfs/test/abi/files_v2_method_compat.test.ts)
  check both service directions, generated JavaScript bindings, Kernel
  projection, and app response parsers.
- [Wagyu protocol fixtures](../apps/wagyu/test/protocol_golden.test.ts) cover
  nested exact-byte identity and optional extension decoding.

Read each workspace's `package.json` and test runner for its actual coverage.
Add the applicable missing fixtures to that workspace's release tests when
changing a protocol; do not infer cross-language coverage from one binding.

## Primary References

- [Candid specification](https://github.com/dfinity/candid/blob/master/spec/Candid.md)
- [Candid type and upgrade reference](https://docs.internetcomputer.org/references/candid-spec/)
