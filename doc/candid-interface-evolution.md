# Evolving Candid Interfaces Across Versions

[Back to the documentation index](./index.md)

This guide defines how Neutron apps evolve Candid service methods and Candid
packages exchanged between independently upgraded canisters and clients. The
goal is rolling interoperability: an old caller can talk to a new canister, and
a new caller can still talk to an old canister, for every method and package
declared rolling-compatible.

This is an interface guide. It does not define Motoko stable-memory evolution,
app memory schema versions, or data migration. Those rules are covered by
[Managed Memory Migrations And Uninstall](./memory-migrations-and-uninstall.md).

## The Two Compatibility Directions

Candid's normal service-upgrade check asks one directional question:

> Can a client compiled against the old interface continue to call the newly
> upgraded service?

That is necessary, but a peer-to-peer Neutron protocol has a stronger
requirement. Different Neutron canisters may run different app releases for a
long time, so both directions matter:

1. old caller or frontend → new callee;
2. new caller or frontend → old callee.

Some Candid changes are safe for a single upgraded service but are not
bidirectionally safe. For example, a new service may append a required return
value because an old client ignores extra results. A new client expecting that
required result cannot decode a response from an old service that never sends
it. A rolling protocol therefore appends an optional result instead.

The project policy is:

- run the ordinary old-client/new-service subtype check;
- separately test new-client/old-service decoding for every shared method;
- do not call a change rolling-compatible merely because one direction passes.

## The Useful Candid Properties

Candid values carry their wire types. A receiver decodes those values against
its own expected types using structural subtyping.

The properties that make interface evolution possible are:

- Record fields are identified by labels, not declaration order. Extra fields
  are ignored by a receiver that does not know them.
- A missing record field decodes as `null` when the receiver expects
  `opt T`, `null`, or `reserved`.
- Candid tuples are records with consecutive numeric labels starting at zero.
- A method's argument and result lists may contain multiple Candid values.
  Extra values are ignored by a receiver expecting fewer values.
- A missing trailing method argument or result can decode as `null` when the
  receiver expects an `opt T`.
- A variant may gain tags in an input type accepted by a newer service, but an
  old decoder cannot decode a new tag in a plain variant.
- When an extensible variant is wrapped in `opt`, Candid's special option rule
  lets an old decoder receive an unknown tag as `null`.
- Method argument types are contravariant: an upgraded service may accept a
  supertype of the old argument.
- Method result types are covariant: an upgraded service may return a subtype
  of the old result.
- New service methods do not affect clients that use only existing methods.

Candid labels are hashed to 32-bit field identifiers. Renaming a field or
variant tag changes its identity; declaration order does not. Never reuse a
retired label for another meaning, and let the Candid tooling reject label-hash
collisions.

Names attached to method parameters and results are only documentation; their
positions carry the wire meaning. Record field labels are different: they are
hashed wire identifiers and are part of the contract.

## Neutron's Rolling-Compatibility Rules

For an existing rolling-compatible method or nested package:

1. Do not rename an existing record field or variant tag.
2. Do not change an existing field's type merely because the source-language
   types look convertible.
3. Add record fields as `opt T`. An old sender omits the field and a new
   receiver gets `null`; an old receiver ignores the extra field from a new
   sender.
4. Keep old required fields on the wire. A new receiver may stop using one,
   but a new sender must still populate it while old receivers exist.
5. Wrap any variant that may gain tags in `opt` from its first release.
6. Treat `null` for an extensible variant as `unsupported`, not as one of the
   known cases and not as permission to apply a default mutation.
7. Append only optional method arguments when retaining the same method.
8. Append optional method results when a new client may call an old service.
9. Append only optional tuple-record elements. Never insert an element into
   the middle of a published tuple, because that changes the numeric labels of
   later elements.
10. Do not remove a method, change query/update behavior, or change the
    authorization, payment, idempotency, or retention meaning of an existing
    method under the label of interface compatibility.
11. An added optional field must be safe for an old implementation to ignore.
    If ignoring it would change authorization, identity, charging, dedupe,
    target selection, or a security decision, the change needs a new method or
    protocol major version.
12. Bound and validate every newly recognized value. Successful Candid
    decoding is not application-level validation.

These rules deliberately leave some legal one-way Candid upgrades unused. The
cost is a few `opt` wrappers; the benefit is that old and new Neutron nodes can
continue talking directly.

## Change Matrix

| Change | Old client → new service | New client → old service | Rolling policy |
| --- | --- | --- | --- |
| Add a method | Existing calls work | New method is absent | Add only when callers feature-detect or tolerate method-not-found |
| Add required input record field | Fails when old client omits it | Old service ignores the extra field | Do not do this |
| Add `opt T` input record field | Missing field becomes `null` | Old service ignores it | Safe |
| Remove an input record field | New service ignores old extra field | Old service may require the omitted field | Keep sending the old field |
| Add required output record field | Old client ignores it | New client cannot decode an old response missing it | Add it as `opt T` for rolling use |
| Add `opt T` output record field | Old client ignores it | Missing field becomes `null` | Safe |
| Remove a required output field | Old client cannot decode the response | New client no longer needs it | Do not do this |
| Add a plain input-variant tag | New service accepts old tags | Old service fails on the new tag | Use `opt variant` if new senders may call old services |
| Add a plain output-variant tag | Old client can fail on the new tag | Old response has only known tags | Do not do this |
| Add a tag to `opt variant` | Old side receives an unknown tag as `null` | Known old tags still decode | Safe only with explicit `null = unsupported` handling |
| Append required method argument | Old caller omits it and decoding fails | Old callee ignores the extra value | Do not do this |
| Append `opt T` method argument | Missing value becomes `null` | Old callee ignores the extra value | Safe |
| Remove trailing method argument | Old caller's extra value is ignored | New caller omits a value the old callee may require | Avoid on a rolling method |
| Append method result | Old client ignores it | New client needs an old response fallback | Append `opt T` for rolling use |
| Append required tuple-record element | Old tuple cannot satisfy new decoder | Old decoder ignores the extra field | Do not do this |
| Append `opt T` tuple-record element | Missing element becomes `null` | Old decoder ignores it | Safe |

Changing a parameter from `nat` to `int`, for example, can be a legal
one-directional widening. Neutron still prefers a new optional field or a new
method over scalar type changes in a rolling protocol. Language bindings,
bounds, hashes, and application semantics can make an apparently legal
subtyping change surprising.

Adding a method does not give Candid callers a built-in feature-negotiation
mechanism. A new peer must discover support through a trusted capability
document or an explicitly safe probe, and must retain a fallback for an old
peer. Do not learn support by periodically polling every peer.

## Prefer One Request Record And One Response Record

A single named request record gives future releases room to add optional
fields without changing positional arguments:

```candid
type SendRequest = record {
  operation_id : blob;
  body : blob;
};

type SendResponse = record {
  outcome : opt variant {
    accepted;
    duplicate;
    rejected : record {
      reason : opt variant {
        invalid;
        blocked;
      };
    };
  };
};

service : {
  send : (SendRequest) -> (SendResponse);
};
```

A later rolling-compatible release can add:

```candid
type SendRequest = record {
  operation_id : blob;
  body : blob;
  client_context : opt record {
    trace_id : blob;
  };
};

type SendResponse = record {
  outcome : opt variant {
    accepted;
    duplicate;
    rejected : record {
      reason : opt variant {
        invalid;
        blocked;
        busy;
      };
    };
  };
  server_revision : opt nat64;
};
```

The old service ignores `client_context`. The new service receives `null` from
an old caller. An old client ignores `server_revision`. A new client receives
`null` when calling an old service. If either optional variant contains a tag
unknown to the receiver, the receiver gets `null` for that variant and handles
it as unsupported.

A plain top-level result variant does not provide this fallback. Put an
extensible outcome variant in an optional record field instead.

## Method Argument Lists And Tuples

There are two related but distinct positional forms.

### Multiple method arguments or results

This change is compatible:

```candid
// Initial
submit : (nat64, blob) -> (bool);

// Later
submit : (nat64, blob, opt text) -> (bool, opt nat64);
```

An old caller omits the third argument and the new callee receives `null`. A new
caller sends a third value that an old callee ignores. An old client ignores
the additional result, while a new client receives `null` for that result from
an old callee.

The new argument must be trailing and optional. This is not compatible:

```candid
submit : (nat64, blob, text) -> (bool);
```

An old caller has no third value, so a new callee expecting required `text`
cannot decode the call.

### Tuple records

The Candid tuple type:

```candid
record { nat64; blob }
```

is shorthand for:

```candid
record { 0 : nat64; 1 : blob }
```

It may evolve to:

```candid
record { nat64; blob; opt text }
```

because the new numeric field `2` is optional. A new tuple value's field `2`
is ignored by an old decoder, and a new decoder gets `null` for field `2` in an
old tuple.

Only append tuple elements. Inserting a field changes the numeric identity and
type of every later position. Prefer a named record when fields have meaning,
are likely to be deprecated independently, or are expected to grow more than
once.

## Extensible Variants

Start an expected-to-grow variant as optional:

```candid
type DeliveryKind = opt variant {
  post;
  share;
};
```

A later release may add:

```candid
type DeliveryKind = opt variant {
  post;
  share;
  tombstone;
};
```

An old decoder receiving `tombstone` sees `null`, while values using `post` or
`share` retain their known tags. Application code must distinguish:

- `null`: unsupported by this decoder;
- `opt variant { post }`: a known post;
- `opt variant { share }`: a known share.

Do not map `null` to a mutating default. For an ingress request, reject it as
`incompatible` without business mutation. For a response, mark the outcome
unsupported or uncertain and do not blindly retry. For presentation data,
omit only the unsupported presentation fragment.

Put `opt` at the exact extensibility boundary. These types have different
fallback scopes:

```candid
opt record {
  status : variant { active; paused };
}

record {
  status : opt variant { active; paused };
}
```

With the first shape, a future unknown `status` can make the whole record
decode as `null`. With the second, only `status` becomes `null` and the rest of
the record remains available. The same rule applies to containers: prefer
`vec opt variant { ... }` when one unknown element should become null, rather
than `opt vec variant { ... }`, which can discard the whole vector.

Candid's special option rule is intentionally permissive and can turn other
type mismatches into `null`, not only future variant tags. Treat the rule as a
designed compatibility boundary, keep the nested schema frozen, and test the
exact expected unknown-tag cases. Do not use `opt` to hide arbitrary type
changes.

## Deprecating Fields

The safest rolling deprecation is semantic:

- keep the published label and type;
- keep sending a valid value to old peers;
- let new receivers ignore it;
- remove it only in a new protocol major version after old peers are outside
  the supported compatibility window.

Candid also provides `reserved` and `opt empty` for explicit deprecation.
`reserved` accepts and discards any value and protects the label from reuse.
These are useful in a one-directional canister upgrade, but they do not
automatically make the opposite rolling direction safe. Use them only after
the compatibility matrix and generated bindings have been tested, and never
reuse the field label for another meaning.

## Do Not Add A Schema Version Field By Habit

A record such as:

```candid
record {
  a : nat64;
  b : text;
  c : blob;
}
```

does not need a `version` field merely so that a later release can add data.
Add `d : opt T`, preserve the old fields, and let Candid perform structural
decoding.

A version discriminator is justified only when the value can represent
multiple incompatible semantic encodings and a decoder must branch between
them. It is not a substitute for Candid-compatible evolution. Neutron protocol
major versions belong in method names, route identifiers, fixed paths, or
domain separators when those semantics genuinely change.

Named Candid type aliases are also not nominal wire versions. Candid is
structurally typed, so a source name such as `RequestV1` is documentation for a
major contract line; the name is not serialized.

## Candid Nested Inside `blob`

Some protocols place exact Candid bytes inside an outer Candid `blob` so they
can hash, certify, store, retry, or forward the original bytes.

That outer service interface sees only `blob`. `didc subtype` cannot inspect
the nested package, and an outer interface check cannot prove that inner
records evolved compatibly. Such a protocol must:

- publish the exact inner Candid type definitions;
- decode the blob with explicit byte and allocation bounds;
- preserve and hash the received bytes before decoding;
- never decode and re-encode to reconstruct a digest or certified preimage;
- apply the same optional-field and optional-variant rules to the inner types;
- keep old-encoder/new-decoder and new-encoder/old-decoder fixtures for every
  inner package.

Adding an optional inner field changes the exact encoded bytes and therefore
may change a content digest or action id derived from those bytes. That is
valid when identity is deliberately byte-based. An old verifier must hash the
received bytes directly and ignore only extension fields that are explicitly
safe to ignore.

## Semantic Compatibility Is Stricter Than Decoding

A Candid message can decode successfully and still be protocol-incompatible.
An old implementation ignores an unknown optional field, so that field cannot
be required to:

- identify the actor or target;
- authorize a call;
- select who pays or how many cycles are required;
- change a deduplication key;
- weaken a size, retention, or rate bound;
- reinterpret an existing variant tag;
- make an otherwise invalid mutation valid.

Compatible extensions may add advisory metadata, optional presentation data,
new hints that receivers may ignore, or bounded features whose absence
preserves the old behavior. A change to core meaning requires a new method,
route, certified path, hash domain, or protocol major version.

## CI And Release Checks

Keep the last released `.did` file as a fixture. For the normal canister-upgrade
direction, run:

```bash
didc check current.did previous.did
```

`didc check current.did previous.did` checks that the new service is a safe
replacement for clients compiled against the old service.
Use `didc check` for `.did` files; `didc subtype` below accepts inline Candid
type expressions, not file paths.

For rolling peer methods, also test the opposite communication direction.
Whole-service reverse subtyping may fail merely because the new service added
a method, so check a fixture containing only common methods in both directions,
then test the individual common method types and real messages:

```bash
didc check current-common.did previous-common.did
didc check previous-common.did current-common.did

didc subtype \
  'func (nat64, blob, opt text) -> (bool, opt nat64)' \
  'func (nat64, blob) -> (bool)'

didc subtype \
  'func (nat64, blob) -> (bool)' \
  'func (nat64, blob, opt text) -> (bool, opt nat64)'

didc subtype \
  'record { nat64; blob }' \
  'record { nat64; blob; opt text }'

didc subtype \
  'record { nat64; blob; opt text }' \
  'record { nat64; blob }'
```

The release corpus must include:

- every previous supported client encoding decoded by the current types;
- current base-feature encodings decoded by every supported old type;
- a new optional record field ignored by an old decoder;
- a missing optional field decoded as `null`;
- a new optional trailing method argument and result;
- a new optional tuple-record tail;
- a new tag in `opt variant` decoded by an old type as `null`;
- the same tag in a plain variant failing, proving the test can catch the
  unsafe shape;
- renamed labels, changed scalar types, missing required fields, and inserted
  tuple elements failing;
- nested-Candid-in-blob compatibility and exact-byte hash fixtures;
- generated Motoko, Rust, and TypeScript bindings handling every `null` path.

Warnings from `didc` about the special `opt` rule are design-review inputs, not
noise. CI should reject them by default and allowlist only a reviewed
optional-variant extension or field retirement with an exact null-fallback
fixture.

## Review Checklist

Before releasing a shared interface change:

- Is this an interface change rather than a stable-memory migration?
- Does the existing method keep one compatible meaning?
- Are all added request and rolling-response fields optional?
- Are all potentially extensible variants wrapped in `opt`?
- Does every unknown variant become an explicit unsupported state?
- Are positional additions trailing and optional?
- Are old required fields still sent to old peers?
- Can both old→new and new→old messages be decoded?
- Is every optional extension safe for old code to ignore?
- Are opaque nested Candid packages checked separately?
- Do exact-byte hashes use received bytes without re-encoding?
- Does `didc` pass, and are generated bindings tested?
- If any answer is no, does the change use a new method or protocol major
  version?

## Primary References

- [Candid interface guide and safe interface upgrades](https://docs.internetcomputer.org/guides/canister-calls/candid/)
- [Candid type reference: `opt`, records, variants, functions, and services](https://docs.internetcomputer.org/references/candid-spec/)
- [Candid language repository and specification](https://github.com/dfinity/candid)
