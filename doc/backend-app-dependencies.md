# Backend App Dependencies

[Back to the documentation index](./index.md)

Neutron apps compose through domain-owned backend functions. App memory is
private to its owner and is never injected into another app. A provider can
explicitly expose selected internal Motoko functions, and a consumer receives
only the exact functions named in its manifest.

Dependencies are static install-time authority. Calls are local function calls
inside the generated Neutron actor, so they do not open runtime permission
dialogs or use the frontend message bus.

## Export A Provider Function

Mark an `Init` method with `/*internal:apps*/`:

```motoko
module {
  public type Contact = { id : Text; name : Text };

  public type AppBackendEnvironment = {
    stable_memory : { contacts : Memory.Mem };
  };

  public class Init(env : AppBackendEnvironment) {
    let mem = env.stable_memory.contacts;

    public func /*internal:apps*/ list_contacts(
      request : { limit : Nat }
    ) : async* [Contact] {
      // The provider owns all access to its memory and validates the request.
      await* listFromMemory(mem, request.limit);
    };
  };
}
```

Run `npm run mogen`. It writes the provider metadata:

```json
{
  "func": {
    "list_contacts": {
      "type": "internal",
      "async": "async*",
      "expose": "apps"
    }
  }
}
```

Only `internal` functions may use `expose: "apps"`. The function remains
private in the generated actor and is absent from Candid. An unmarked internal
function cannot be requested by another app.

## Declare A Consumer Dependency

The consumer declares a local alias, provider app id, minimum provider version,
and exact function list:

```json
{
  "id": "calendar",
  "version": 100,
  "memory": {
    "calendar": {
      "version": 1,
      "schemas": {
        "1": { "src": "memory/calendar/v1.mo" }
      },
      "migrations": []
    }
  },
  "dependencies": {
    "contacts": {
      "app": "contacts",
      "min_version": 101,
      "functions": ["list_contacts"]
    }
  }
}
```

The alias must match `^[a-z][a-z0-9_]{0,29}$`. One manifest may declare up to
32 dependencies, and each dependency may name up to 64 unique functions. A
dependency is required: optional dependencies, wildcards, exact versions, and
maximum versions are not supported. Apps cannot depend on themselves or on the
kernel.

The assembler derives dependencies automatically. An ordinary app cannot
declare `init_arg`; it receives its exact dependency functions under
`AppBackendEnvironment.app_calls`. Memory, dependencies, and selected backend
capability interfaces are separate groups in that one environment.

## Receive The Typed Handle

The consumer defines the structural type it expects:

```motoko
module {
  public type Contact = { id : Text; name : Text };

  public type AppCalls = {
    contacts : {
      list_contacts : ({ limit : Nat }) -> async* [Contact];
    };
  };

  public type AppBackendEnvironment = {
    stable_memory : { calendar : Memory.Mem };
    app_calls : AppCalls;
  };

  public class Init(env : AppBackendEnvironment) {
    let mem = env.stable_memory.calendar;
    let appCalls = env.app_calls;

    public func /*update*/ refresh_contacts() : async* Nat {
      let contacts = await* appCalls.contacts.list_contacts({ limit = 50 });
      mem.contact_count := contacts.size();
      contacts.size();
    };
  };
}
```

The assembler initializes providers before consumers and injects a generated
record equivalent to:

```motoko
transient let NeutronAppEnvironment_a8_calendar = {
  installation = NeutronTrustedInstallationContextV1;
  stable_memory = {
    calendar = NeutronMemory_a8_calendar_r8_calendar;
  };
  app_calls = {
    contacts = {
      list_contacts = NeutronAppFunction_a8_contacts_r13_list_contacts;
    };
  };
};

transient let NeutronAppInit_a8_calendar =
  NeutronModule_a8_calendar.Init(NeutronAppEnvironment_a8_calendar);
```

The `NeutronAppFunction_...` helper is a compiler-owned, length-delimited physical
name for the provider app and local method. The dependency field exposed to the
consumer remains the logical `list_contacts` name.

The generated record always carries `installation`, even though the consumer's
own `AppBackendEnvironment` above does not declare it. Motoko record width
subtyping lets an app that does not consume the trusted installation context
simply omit that field from its local type. See
[Compiler And Actor Assembly](./compiler-and-actor-assembly.md).

The consumer does not receive the provider module, provider `Init` instance,
provider memory, kernel internals, or undeclared provider functions. Ordinary
apps cannot author constructor injection tokens, and compiler-owned function
helpers, foreign `memory_*`, `this`, `this.*`, and initialization identifiers
are never fields in the generated environment.

Use `async*` and `await*` through local dependency chains. They keep internal
composition inline until a real shared actor call introduces an ordinary
`await` and interleaving point.

## Version Contract

`min_version` uses the same packed app-release integer as the top-level
manifest version (`100` is `0.1.0`, `101` is `0.1.1`). Every installed provider
version at or above it is eligible. A provider release that exposes a function
creates a monotonic compatibility promise:

- later versions keep the function name;
- its Motoko type remains compatible with existing consumers;
- its meaning and authorization behavior remain compatible;
- a breaking API uses a new function name while the old function remains.

Neutron checks the current provider version, function presence, internal type,
export marker, dependency graph, and current Motoko types. It does not use API
hashes or attempt to prove semantic compatibility. A type-incompatible upgrade
fails normal Motoko compilation before activation; a type-compatible semantic
regression is a provider bug.

## Install, Upgrade, And Uninstall

The dependency planner evaluates the complete target app set before Motoko
compilation:

- a missing or old provider blocks consumer installation with a named error;
- removing or hiding a requested export blocks provider upgrade;
- nested acyclic dependencies are initialized provider-first;
- dependency cycles are rejected with the cycle path;
- uninstalling a provider is blocked while direct consumers remain;
- uninstalling a consumer removes its edge and can make its provider removable.

Settings shows `Requires` and `Required by`, exact functions, installed and
minimum versions, and exported internal methods. **Delete selected** permits a
provider only when all of its remaining consumers are selected too. The
launcher does not expose uninstall. The compiler repeats the dependency check
so stale frontend state cannot bypass it.

Neutron does not download missing provider packages automatically and does not
cascade uninstall into dependents.

## Frontend Tools Are Separate

Backend dependencies and frontend message-bus tools solve different problems.
Use backend dependencies for typed Motoko composition and domain-owned state.
Use the message bus for JSON-compatible calls among tiles, resident processes,
and agent tools. Exporting a backend function does not automatically expose it
to frontend agents.

## Verification

Before publishing a provider or consumer:

```sh
npm run validate
npm test
npm run typecheck
```

Provider tests should compile every supported consumer against the new provider
release. Consumer tests should cover the minimum version, a later compatible
version, missing functions, and expected nested dependency order.

Primary implementation files:

- `packages/neutron-tools/src/schema.ts`
- `packages/neutron-scripts/src/mogen.ts`
- `packages/neutron-compiler/src/app_dependencies.ts`
- `packages/neutron-compiler/src/assemble.ts`
- `packages/neutron-compiler/src/install.ts`
