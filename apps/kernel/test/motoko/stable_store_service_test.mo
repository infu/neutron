import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Map "mo:core/Map";
import Nat8 "mo:core/Nat8";
import Runtime "mo:core/Runtime";
import CapabilityTypes "../../backend/capabilities/Types";
import Service "../../backend/stable_store/Service";
import Types "../../backend/stable_store/Types";

let alpha : Types.AppScope = { app_id = "alpha_app"; installation_uid = 11 };
let beta : Types.AppScope = { app_id = "beta_app"; installation_uid = 12 };
let gamma : Types.AppScope = { app_id = "gamma_app"; installation_uid = 13 };
let alphaFresh : Types.AppScope = { app_id = "alpha_app"; installation_uid = 14 };

let alphaActive = true;
let betaActive = true;
var committed = true;
var allowed = true;
var replicated = true;
var cycles = Service.MIN_CYCLE_BALANCE + 1;
var recorded = 0;
var lastOperation = "";
var lastOutcome : CapabilityTypes.CapabilityOutcome = #ok;

func active(scope : Types.AppScope) : Bool {
    (scope == alpha and alphaActive) or (scope == beta and betaActive) or
    scope == gamma or scope == alphaFresh
};

let registry : CapabilityTypes.RuntimeRegistry = {
    allowed = func(
        scope : CapabilityTypes.AppScope,
        kind : CapabilityTypes.CapabilityKind,
        resource : Text,
    ) : Bool {
        allowed and active(scope) and kind == #stable_store and
        (resource == "notes" or resource == "pages")
    };
    lease = func(
        scope : CapabilityTypes.AppScope,
        kind : CapabilityTypes.CapabilityKind,
        resource : Text,
    ) : ?CapabilityTypes.RuntimeLease {
        if (
            not allowed or not active(scope) or kind != #stable_store or
            (resource != "notes" and resource != "pages")
        ) {
            return null;
        };
        ?{ active = func() { allowed and active(scope) } };
    };
    record = func(
        _scope : CapabilityTypes.AppScope,
        _kind : CapabilityTypes.CapabilityKind,
        _resource : Text,
        operation : Text,
        outcome : CapabilityTypes.CapabilityOutcome,
    ) : Bool {
        recorded += 1;
        lastOperation := operation;
        lastOutcome := outcome;
        true;
    };
};

func memory() : Types.Memory {
    {
        var next_namespace_uid = 1;
        var next_revision = 1;
        stores = Map.empty<Text, Types.StoreState>();
        usage_by_scope = Map.empty<Text, Types.UsageTotals>();
        var total_entries = 0;
        var total_bytes = 0;
    }
};

func store(
    schema : Nat,
    maxEntries : Nat,
    maxKeyBytes : Nat,
    maxValueBytes : Nat,
    maxBytes : Nat,
) : Types.StoreDeclaration {
    {
        id = "notes";
        purpose = "Private binary notes";
        schema_version = schema;
        max_entries = maxEntries;
        max_key_bytes = maxKeyBytes;
        max_value_bytes = maxValueBytes;
        max_bytes = maxBytes;
    }
};

func app(scope : Types.AppScope, declaration : Types.StoreDeclaration) : Types.AppDeclaration {
    { app_scope = scope; stable_store = ?{ stores = [declaration] } }
};

func noStore(scope : Types.AppScope) : Types.AppDeclaration {
    { app_scope = scope; stable_store = null }
};

func service(mem : Types.Memory, declarations : [Types.AppDeclaration]) : Service.Service {
    let result = Service.Service(
        mem,
        active,
        func() { committed },
        registry,
        func() { cycles },
        func() { replicated },
    );
    result.configure(declarations);
    result.commitConfiguration();
    result
};

func expectPut(result : Types.PutResult) : Types.PutReceipt {
    switch (result) {
        case (#ok(value)) value;
        case (#err(error)) Runtime.trap("Expected put success: " # debug_show(error));
    }
};

func expectUsage(result : Types.UsageResult) : Types.Usage {
    switch (result) {
        case (#ok(value)) value;
        case (#err(error)) Runtime.trap("Expected usage: " # debug_show(error));
    }
};

func expectPutError(result : Types.PutResult, expected : Types.Error) : () {
    switch (result) {
        case (#err(actual)) assert (actual == expected);
        case (#ok(_)) Runtime.trap("Expected put error");
    }
};

func expectDeleteError(result : Types.DeleteResult, expected : Types.Error) : () {
    switch (result) {
        case (#err(actual)) assert (actual == expected);
        case (#ok(_)) Runtime.trap("Expected delete error");
    }
};

func expectClearError(result : Types.ClearPageResult, expected : Types.Error) : () {
    switch (result) {
        case (#err(actual)) assert (actual == expected);
        case (#ok(_)) Runtime.trap("Expected clear error");
    }
};

// A staged declaration is not storage authority and does not allocate or
// expose a namespace before the checked deployment commits.
let pendingMem = memory();
committed := false;
let pending = Service.Service(
    pendingMem,
    active,
    func() { committed },
    registry,
    func() { cycles },
    func() { replicated },
);
pending.configure([app(alpha, store(1, 4, 8, 8, 40))]);
assert (pending.get(alpha, { store = "notes"; key = "p/a" }) == #err(#source_gone));
assert (Map.size(pendingMem.stores) == 0 and Service.validateMemory(pendingMem));
committed := true;

let mem = memory();
assert (Service.validateMemory(mem));
let initial = service(mem, [
    app(alpha, store(1, 4, 8, 8, 40)),
    app(beta, store(1, 4, 8, 8, 40)),
]);
assert (Map.size(mem.stores) == 2);
assert (mem.next_namespace_uid == 3);

// A query wrapper must never receive a success for a rolled-back mutation.
replicated := false;
expectPutError(initial.put(alpha, {
    store = "notes";
    key = "p/a";
    value = "111";
    condition = #if_absent;
}), #not_replicated);
replicated := true;
assert (mem.total_entries == 0);

expectPutError(initial.put(alpha, {
    store = "notes";
    key = Array.toBlob(Array.tabulate<Nat8>(257, func(_) { 0 }));
    value = "";
    condition = #unconditional;
}), #too_large);
expectPutError(initial.put(alpha, {
    store = "notes";
    key = "a";
    value = "123456789";
    condition = #unconditional;
}), #too_large);

let alphaA = expectPut(initial.put(alpha, {
    store = "notes";
    key = "p/a";
    value = "111";
    condition = #if_absent;
}));
assert (alphaA.schema_version == 1 and alphaA.usage.entries == 1);
let alphaB = expectPut(initial.put(alpha, {
    store = "notes";
    key = "p/b";
    value = "222";
    condition = #if_absent;
}));
assert (alphaB.revision > alphaA.revision);

expectDeleteError(initial.delete(alpha, {
    store = "notes";
    key = "p/a";
    expected_revision = ?alphaB.revision;
}), #conflict({ current_revision = ?alphaA.revision }));
replicated := false;
expectDeleteError(initial.delete(alpha, {
    store = "notes";
    key = "p/a";
    expected_revision = ?alphaA.revision;
}), #not_replicated);
expectClearError(initial.clearPage(alpha, {
    store = "notes";
    prefix = "p/";
    limit = 1;
}), #not_replicated);
replicated := true;

// Equal local ids and keys remain isolated by exact AppScope.
assert (initial.get(beta, { store = "notes"; key = "p/a" }) == #ok(null));
ignore expectPut(initial.put(beta, {
    store = "notes";
    key = "p/a";
    value = "beta";
    condition = #if_absent;
}));
switch (initial.get(alpha, { store = "notes"; key = "p/a" })) {
    case (#ok(?entry)) assert (entry.value == "111" and entry.revision == alphaA.revision);
    case (_) Runtime.trap("Expected alpha entry");
};

// Blob comparison, not UTF-8 text comparison, defines page order.
let binaryKeys : [Blob] = ["b/\00", "b/a", "b/\FF"];
for (key in binaryKeys.vals()) {
    ignore expectPut(initial.put(beta, {
        store = "notes";
        key;
        value = "";
        condition = #if_absent;
    }));
};
let binaryPage = switch (initial.list(beta, {
    store = "notes";
    prefix = "b/";
    cursor = null;
    limit = 10;
})) {
    case (#ok(page)) page;
    case (#err(error)) Runtime.trap("Expected binary page: " # debug_show(error));
};
assert (binaryPage.entries.size() == 3);
assert (binaryPage.entries[0].key == binaryKeys[0]);
assert (binaryPage.entries[1].key == binaryKeys[1]);
assert (binaryPage.entries[2].key == binaryKeys[2]);
switch (initial.clearPage(beta, { store = "notes"; prefix = "b/"; limit = 64 })) {
    case (#ok(receipt)) assert (receipt.removed_entries == 3 and not receipt.more);
    case (#err(error)) Runtime.trap("Expected binary clear: " # debug_show(error));
};

expectPutError(initial.put(alpha, {
    store = "notes";
    key = "p/a";
    value = "x";
    condition = #if_revision(alphaB.revision);
}), #conflict({ current_revision = ?alphaA.revision }));

let firstPage = switch (initial.list(alpha, {
    store = "notes";
    prefix = "p/";
    cursor = null;
    limit = 1;
})) {
    case (#ok(page)) page;
    case (#err(error)) Runtime.trap("Expected first page: " # debug_show(error));
};
assert (firstPage.entries.size() == 1 and firstPage.entries[0].key == "p/a");
let ?oldCursor = firstPage.next else Runtime.trap("Expected cursor");
assert (initial.list(alpha, {
    store = "notes";
    prefix = "q/";
    cursor = ?oldCursor;
    limit = 1;
}) == #err(#cursor_stale));
assert (initial.list(alpha, {
    store = "notes";
    prefix = "p/";
    cursor = ?{
        namespace_uid = oldCursor.namespace_uid + 1;
        prefix = oldCursor.prefix;
        after = oldCursor.after;
    };
    limit = 1;
}) == #err(#cursor_stale));
let secondPage = switch (initial.list(alpha, {
    store = "notes";
    prefix = "p/";
    cursor = ?oldCursor;
    limit = 1;
})) {
    case (#ok(page)) page;
    case (#err(error)) Runtime.trap("Expected second page: " # debug_show(error));
};
assert (secondPage.entries.size() == 1 and secondPage.entries[0].key == "p/b");

// Low cycles blocks growth, while a shrinking CAS rewrite remains available.
cycles := Service.MIN_CYCLE_BALANCE - 1;
expectPutError(initial.put(alpha, {
    store = "notes";
    key = "new";
    value = "x";
    condition = #if_absent;
}), #low_cycles);
let shrunk = expectPut(initial.put(alpha, {
    store = "notes";
    key = "p/a";
    value = "x";
    condition = #if_revision(alphaA.revision);
}));
cycles := Service.MIN_CYCLE_BALANCE + 1;
assert (shrunk.revision > alphaB.revision);

assert (Service.validateMemory(mem));

// A schema/quota narrowing keeps old bytes, marks overage (including an old
// oversized value), blocks growth, and permits a target-valid shrinking
// rewrite which stamps the current schema.
let narrowed = service(mem, [
    // Aggregate headroom remains: this overage is solely the retained p/b
    // value exceeding the newly narrowed individual value limit.
    app(alpha, store(2, 4, 8, 2, 20)),
    app(beta, store(1, 4, 8, 8, 40)),
]);
let narrowedUsage = expectUsage(narrowed.usage(alpha, "notes"));
assert (narrowedUsage.over_quota and narrowedUsage.schema_version == 2);

// Schema monotonicity is checked during actor configuration, before the
// management install can activate an invalid target.
assert (
    not Service.targetConfigurationCommitReady(
        mem,
        [
            app(alpha, store(1, 4, 8, 8, 40)),
            app(beta, store(1, 4, 8, 8, 40)),
        ],
    )
);
assert (Service.validateMemory(mem));

// Every missing target namespace consumes allocator headroom. One final uid
// remains admissible, but two new stores must be rejected during configure.
let exhaustedNamespaceMem = memory();
exhaustedNamespaceMem.next_namespace_uid := 18_446_744_073_709_551_614;
assert (Service.validateMemory(exhaustedNamespaceMem));
assert (Service.targetConfigurationCommitReady(
    exhaustedNamespaceMem,
    [app(alpha, store(1, 4, 8, 8, 40))],
));
assert (not Service.targetConfigurationCommitReady(
    exhaustedNamespaceMem,
    [
        app(alpha, store(1, 4, 8, 8, 40)),
        app(beta, store(1, 4, 8, 8, 40)),
    ],
));

// Commit uses a non-trapping recheck. This state change models retained
// stable memory differing after configuration; the install boundary can turn
// the false result into #blocked before beginning any commit mutation.
let recheckMem = memory();
ignore service(recheckMem, [app(gamma, store(2, 4, 8, 8, 40))]);
let recheck = Service.Service(
    recheckMem,
    active,
    func() { committed },
    registry,
    func() { cycles },
    func() { replicated },
);
recheck.configure([app(gamma, store(2, 4, 8, 8, 40))]);
assert (recheck.configurationCommitReady());
for (state in Map.values(recheckMem.stores)) {
    state.schema_version := 3;
};
assert (Service.validateMemory(recheckMem));
assert (not recheck.configurationCommitReady());

expectPutError(narrowed.put(alpha, {
    store = "notes";
    key = "p/c";
    value = "z";
    condition = #if_absent;
}), #quota_exceeded);
let migratedB = expectPut(narrowed.put(alpha, {
    store = "notes";
    key = "p/b";
    value = "y";
    condition = #if_revision(alphaB.revision);
}));
assert (migratedB.schema_version == 2);

allowed := false;
assert (narrowed.get(alpha, { store = "notes"; key = "p/a" }) == #err(#disabled));
allowed := true;

let cleared = switch (narrowed.clearPage(alpha, {
    store = "notes";
    prefix = "p/";
    limit = 1;
})) {
    case (#ok(receipt)) receipt;
    case (#err(error)) Runtime.trap("Expected clear: " # debug_show(error));
};
assert (cleared.removed_entries == 1 and cleared.more);

// Revision exhaustion cannot prevent destructive recovery.
mem.next_revision := 18_446_744_073_709_551_615;
switch (narrowed.delete(alpha, {
    store = "notes";
    key = "p/b";
    expected_revision = ?migratedB.revision;
})) {
    case (#ok(_)) {};
    case (#err(error)) Runtime.trap("Expected delete at revision exhaustion: " # debug_show(error));
};
assert (Service.validateMemory(mem));

// Checked removal drops only the exact outer namespace. A later same-id
// resource gets a never-reused uid and rejects the old cursor.
let removed = service(mem, [noStore(alpha), app(beta, store(1, 4, 8, 8, 40))]);
assert (removed.usage(alpha, "notes") == #err(#not_declared));
assert (Map.size(mem.stores) == 1 and mem.total_entries == 1);
assert (Service.validateMemory(mem));
let reinstalled = service(mem, [
    app(alpha, store(3, 4, 8, 8, 40)),
    app(beta, store(1, 4, 8, 8, 40)),
]);
switch (reinstalled.list(alpha, {
    store = "notes";
    prefix = "p/";
    cursor = ?oldCursor;
    limit = 1;
})) {
    case (#err(#cursor_stale)) {};
    case (_) Runtime.trap("Expected stale cursor after remove/re-add");
};
// A true uninstall/reinstall receives a fresh AppScope as well as a fresh
// namespace uid. It inherits neither records nor a retired continuation.
ignore service(mem, [noStore(alpha), app(beta, store(1, 4, 8, 8, 40))]);
let freshInstall = service(mem, [
    app(alphaFresh, store(1, 4, 8, 8, 40)),
    app(beta, store(1, 4, 8, 8, 40)),
]);
assert (expectUsage(freshInstall.usage(alphaFresh, "notes")).entries == 0);
switch (freshInstall.list(alphaFresh, {
    store = "notes";
    prefix = "p/";
    cursor = ?oldCursor;
    limit = 1;
})) {
    case (#err(#cursor_stale)) {};
    case (_) Runtime.trap("Expected stale cursor after fresh reinstall");
};
// Standalone memory validation fails closed on major counter/allocator drift.
let corrupt = memory();
assert (Service.validateMemory(corrupt));
corrupt.total_entries := 1;
assert (not Service.validateMemory(corrupt));
corrupt.total_entries := 0;
corrupt.next_namespace_uid := 0;
assert (not Service.validateMemory(corrupt));

assert (recorded > 0 and lastOperation != "" and lastOutcome == #ok);

// Five maximum-sized values force pagination by the 1 MiB byte ceiling before
// the 64-entry count ceiling. Clear pages obey the same bound.
let pageMem = memory();
let pages : Types.StoreDeclaration = {
    id = "pages";
    purpose = "Exercise byte-bounded pages";
    schema_version = 1;
    max_entries = 8;
    max_key_bytes = 8;
    max_value_bytes = Service.MAX_VALUE_BYTES;
    max_bytes = 2_097_152;
};
let pageService = service(pageMem, [app(gamma, pages)]);
let largeValue = Array.toBlob(
    Array.tabulate<Nat8>(Service.MAX_VALUE_BYTES, func(_) { 0 })
);
let largeKeys : [Blob] = ["k/0", "k/1", "k/2", "k/3", "k/4"];
for (key in largeKeys.vals()) {
    ignore expectPut(pageService.put(gamma, {
        store = "pages";
        key;
        value = largeValue;
        condition = #if_absent;
    }));
};
let largeFirst = switch (pageService.list(gamma, {
    store = "pages";
    prefix = "k/";
    cursor = null;
    limit = 64;
})) {
    case (#ok(page)) page;
    case (#err(error)) Runtime.trap("Expected large first page: " # debug_show(error));
};
assert (largeFirst.entries.size() == 3);
let ?largeCursor = largeFirst.next else Runtime.trap("Expected byte-bounded cursor");
let largeSecond = switch (pageService.list(gamma, {
    store = "pages";
    prefix = "k/";
    cursor = ?largeCursor;
    limit = 64;
})) {
    case (#ok(page)) page;
    case (#err(error)) Runtime.trap("Expected large second page: " # debug_show(error));
};
assert (largeSecond.entries.size() == 2 and largeSecond.next == null);
let clearLargeFirst = switch (pageService.clearPage(gamma, {
    store = "pages";
    prefix = "k/";
    limit = 64;
})) {
    case (#ok(receipt)) receipt;
    case (#err(error)) Runtime.trap("Expected large clear page: " # debug_show(error));
};
assert (clearLargeFirst.removed_entries == 3 and clearLargeFirst.more);
let clearLargeSecond = switch (pageService.clearPage(gamma, {
    store = "pages";
    prefix = "k/";
    limit = 64;
})) {
    case (#ok(receipt)) receipt;
    case (#err(error)) Runtime.trap("Expected final large clear: " # debug_show(error));
};
assert (clearLargeSecond.removed_entries == 2 and not clearLargeSecond.more);
assert (Service.validateMemory(pageMem));
