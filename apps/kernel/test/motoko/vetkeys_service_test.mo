import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Error "mo:core/Error";
import Nat "mo:core/Nat";
import Nat64 "mo:core/Nat64";
import Nat8 "mo:core/Nat8";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import AppUsageTypes "../../backend/app_usage/Types";
import CapabilityTypes "../../backend/capabilities/Types";
import Memory "../../backend/vetkeys/Memory";
import Namespace "../../backend/vetkeys/Namespace";
import Service "../../backend/vetkeys/Service";
import Types "../../backend/vetkeys/Types";

let canister = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");
let canisterActor : actor {} = actor ("ryjl3-tyaaa-aaaaa-aaaba-cai");
let otherCanister = Principal.fromText("r7inp-6aaaa-aaaaa-aaabq-cai");
let owner = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");
let otherOwner = Principal.fromText("renrk-eyaaa-aaaaa-aaada-cai");

var nextCycleReservationId : Nat = 1;
var reservedCycleCalls : Nat = 0;
var committedCycleCalls : Nat = 0;
var adapterDispatchCalls : Nat = 0;
var cancelledCycleCalls : Nat = 0;
var finalizedCycleCalls : Nat = 0;
var zeroAttachedCycleCalls : Nat = 0;
var lastReservedCycles : Nat = 0;
var lastReservationCallCount : Nat = 0;
var lastChargedCycles : Nat = 0;
var beforeCycleReserve : ?((Types.AppScope, Nat) -> ()) = null;
func reserveCycles(
    scope : Types.AppScope,
    attached : Nat,
    dailyLimit : ?Nat,
    callCount : Nat,
) : ?AppUsageTypes.OutgoingCycleReservation {
    reservedCycleCalls += 1;
    if (attached == 0) zeroAttachedCycleCalls += 1;
    lastReservedCycles := attached;
    lastReservationCallCount := callCount;
    let id = nextCycleReservationId;
    nextCycleReservationId += 1;
    switch (beforeCycleReserve) {
        case (?hook) {
            beforeCycleReserve := null;
            hook(scope, attached);
        };
        case null {};
    };
    ?{
        id;
        scope;
        day = 0;
        attached;
        daily_budgeted = dailyLimit != null;
        call_count = callCount;
    };
};
func commitCycles(
    reservation : AppUsageTypes.OutgoingCycleReservation,
) : Bool {
    assert (reservation.call_count > 0);
    // Constructing the saved adapter future must not run its body. The service
    // commits the reservation exactly once before awaiting and dispatching it.
    assert (committedCycleCalls < reservedCycleCalls);
    assert (adapterDispatchCalls == committedCycleCalls);
    committedCycleCalls += 1;
    true;
};
func cancelCycles(
    _reservation : AppUsageTypes.OutgoingCycleReservation,
) : () {
    cancelledCycleCalls += 1;
};
func finalizeCycles(
    _reservation : AppUsageTypes.OutgoingCycleReservation,
    charged : Nat,
) : () {
    finalizedCycleCalls += 1;
    lastChargedCycles := charged;
};
let cycleAccounting : AppUsageTypes.OutgoingCycleAccounting = {
    reserve = reserveCycles;
    commit = commitCycles;
    cancel = cancelCycles;
    finalize = finalizeCycles;
};

func authorized(principal : Principal) : Bool {
    Principal.equal(principal, owner) or Principal.equal(principal, otherOwner);
};

func appScope(appId : Text) : Types.AppScope {
    { app_id = appId; installation_uid = 1 };
};

func appScopeWithUid(appId : Text, installationUid : Nat64) : Types.AppScope {
    { app_id = appId; installation_uid = installationUid };
};

class FakeRegistry() {
    public var enabled = true;
    public var epoch : Nat = 0;
    public var records = 0;
    public var last_operation : ?Text = null;
    public var last_outcome : ?CapabilityTypes.CapabilityOutcome = null;

    public func setEnabled(value : Bool) : () {
        enabled := value;
        epoch += 1;
    };

    public func value() : CapabilityTypes.RuntimeRegistry {
        {
            allowed = func(
                _scope : CapabilityTypes.AppScope,
                kind : CapabilityTypes.CapabilityKind,
                _resourceId : Text,
            ) : Bool {
                enabled and kind == #vetkeys;
            };
            lease = func(
                _scope : CapabilityTypes.AppScope,
                kind : CapabilityTypes.CapabilityKind,
                _resourceId : Text,
            ) : ?CapabilityTypes.RuntimeLease {
                if (not enabled or kind != #vetkeys) return null;
                let capturedEpoch = epoch;
                ?{
                    active = func() : Bool {
                        enabled and epoch == capturedEpoch;
                    };
                };
            };
            record = func(
                _scope : CapabilityTypes.AppScope,
                kind : CapabilityTypes.CapabilityKind,
                _resourceId : Text,
                operation : Text,
                outcome : CapabilityTypes.CapabilityOutcome,
            ) : Bool {
                if (kind != #vetkeys) return false;
                records += 1;
                last_operation := ?operation;
                last_outcome := ?outcome;
                true;
            };
        };
    };
};

func testService(
    mem : Types.Memory,
    adapter : Types.Adapter,
    isAuthorized : Principal -> Bool,
) : Service.Service {
    Service.Service(
        mem,
        adapter,
        isAuthorized,
        func(appId) { ?appScope(appId) },
        func(_) { true },
        FakeRegistry().value(),
        cycleAccounting,
    );
};

func bytes(size : Nat, seed : Nat) : Blob {
    Array.toBlob(Array.tabulate<Nat8>(size, func(index) {
        Nat.toNat8((seed + index) % 256);
    }));
};

let nonceOne = bytes(32, 1);
let nonceTwo = bytes(32, 41);
let transportKey = bytes(Service.TRANSPORT_PUBLIC_KEY_BYTES, 71);

type RandomMode = { #ok : Blob; #err };
type PublicMode = { #ok : Nat; #err };
type DeriveMode = {
    #ok : { size : Nat; charged_cycles : Nat };
    #err : { charged_cycles : Nat };
};

class FakeAdapter() {
    public var random_mode : RandomMode = #ok(nonceOne);
    public var public_mode : PublicMode = #ok(Service.PUBLIC_KEY_BYTES);
    public var derive_mode : DeriveMode = #ok({
        size = Service.ENCRYPTED_KEY_BYTES;
        charged_cycles = Service.DERIVE_CYCLES;
    });
    public var balance : Nat = Service.DERIVE_CYCLES + Service.MIN_REMAINING_CYCLES;
    public var random_calls = 0;
    public var public_calls = 0;
    public var derive_calls = 0;
    public var last_public_request : ?Types.AdapterPublicKeyRequest = null;
    public var last_derive_request : ?Types.AdapterDeriveRequest = null;
    public var before_random_reply : ?(() -> async ()) = null;
    public var before_public_reply : ?(() -> async ()) = null;
    public var before_derive_reply : ?(() -> async ()) = null;
    public var throw_derive = false;

    public func value() : Types.Adapter {
        {
            random_nonce = randomNonce;
            public_key = publicKey;
            derive_key = deriveKey;
            cycle_balance = cycleBalance;
        };
    };

    func randomNonce() : async Types.AdapterBlobResult {
        assert (committedCycleCalls == adapterDispatchCalls + 1);
        adapterDispatchCalls += 1;
        random_calls += 1;
        switch (before_random_reply) {
            case (?hook) {
                before_random_reply := null;
                await hook();
            };
            case null {};
        };
        switch (random_mode) {
            case (#ok(value)) #ok(value);
            case (#err) #err;
        };
    };

    func publicKey(
        request : Types.AdapterPublicKeyRequest,
    ) : async Types.AdapterBlobResult {
        assert (committedCycleCalls == adapterDispatchCalls + 1);
        adapterDispatchCalls += 1;
        public_calls += 1;
        last_public_request := ?request;
        switch (before_public_reply) {
            case (?hook) {
                before_public_reply := null;
                await hook();
            };
            case null {};
        };
        switch (public_mode) {
            case (#ok(size)) #ok(bytes(size, 101));
            case (#err) #err;
        };
    };

    func deriveKey(
        request : Types.AdapterDeriveRequest,
    ) : async Types.AdapterDeriveResult {
        assert (committedCycleCalls == adapterDispatchCalls + 1);
        adapterDispatchCalls += 1;
        derive_calls += 1;
        last_derive_request := ?request;
        switch (before_derive_reply) {
            case (?hook) {
                before_derive_reply := null;
                await hook();
            };
            case null {};
        };
        if (throw_derive) throw Error.reject("fake derive adapter trap");
        switch (derive_mode) {
            case (#ok(value)) #ok({
                encrypted_key = bytes(value.size, 151);
                charged_cycles = value.charged_cycles;
            });
            case (#err(value)) #err(value);
        };
    };

    func cycleBalance() : Nat { balance };
};

func declaration(appId : Text, slots : [Text]) : Types.AppDeclaration {
    declarationForScope(appScope(appId), slots);
};

func declarationForScope(
    scope : Types.AppScope,
    slots : [Text],
) : Types.AppDeclaration {
    {
        app_scope = scope;
        vetkeys = ?{
            description = "Private key recovery for " # scope.app_id;
            slots = Array.map<Text, Types.SlotDeclaration>(slots, func(id) {
                { id; purpose = "Protect " # id };
            });
        };
    };
};

func configure(
    service : Service.Service,
    environment : Types.Environment,
    apps : [Types.AppDeclaration],
) : () {
    service.configure(environment, apps);
};

func requireSlot(mem : Types.Memory, appId : Text, slotId : Text) : Types.Slot {
    let ?slot = Memory.get(mem, appScope(appId), slotId) else {
        Runtime.trap("Expected reserved vetKeys slot " # appId # "/" # slotId);
    };
    slot;
};

func expectError<T>(result : Types.OperationResult<T>, expected : Types.VetKeyError) : () {
    switch (result) {
        case (#err(actual)) assert (actual == expected);
        case (#ok(_)) Runtime.trap("Expected vetKeys service error");
    };
};

func expectSlot(
    result : Types.OperationResult<Types.PublicSlotSummary>,
) : Types.PublicSlotSummary {
    switch (result) {
        case (#ok(value)) value;
        case (#err(_)) Runtime.trap("Expected vetKeys slot result");
    };
};

func expectPublicKey(result : Types.PublicKeyResult) : Types.PublicKeyInfo {
    switch (result) {
        case (#ok(value)) value;
        case (#err(_)) Runtime.trap("Expected vetKeys public-key result");
    };
};

func expectDerived(result : Types.DeriveResult) : Types.DeriveOutput {
    switch (result) {
        case (#ok(value)) value;
        case (#err(_)) Runtime.trap("Expected vetKeys derivation result");
    };
};

// Namespace V1 is domain separated by app, slot, generation, canister, and
// fresh install-instance nonce. Every management input is fixed at 32 bytes.
let #ok(mailNamespace) = Namespace.build({
    canister;
    app_id = "mail";
    installation_uid = 1;
    slot_id = "mailbox";
    namespace_nonce = nonceOne;
    generation = 1;
}) else Runtime.trap("Expected Mail namespace");
let #ok(otherAppNamespace) = Namespace.build({
    canister;
    app_id = "other_app";
    installation_uid = 1;
    slot_id = "mailbox";
    namespace_nonce = nonceOne;
    generation = 1;
}) else Runtime.trap("Expected other-app namespace");
let #ok(otherSlotNamespace) = Namespace.build({
    canister;
    app_id = "mail";
    installation_uid = 1;
    slot_id = "binding";
    namespace_nonce = nonceOne;
    generation = 1;
}) else Runtime.trap("Expected other-slot namespace");
let #ok(rotatedNamespace) = Namespace.build({
    canister;
    app_id = "mail";
    installation_uid = 1;
    slot_id = "mailbox";
    namespace_nonce = nonceOne;
    generation = 2;
}) else Runtime.trap("Expected rotated namespace");
let #ok(reinstalledNamespace) = Namespace.build({
    canister;
    app_id = "mail";
    installation_uid = 2;
    slot_id = "mailbox";
    namespace_nonce = nonceTwo;
    generation = 1;
}) else Runtime.trap("Expected reinstalled namespace");
let #ok(otherCanisterNamespace) = Namespace.build({
    canister = otherCanister;
    app_id = "mail";
    installation_uid = 1;
    slot_id = "mailbox";
    namespace_nonce = nonceOne;
    generation = 1;
}) else Runtime.trap("Expected other-canister namespace");
assert (mailNamespace.context.size() == 32);
assert (mailNamespace.derivation_input.size() == 32);
for (candidate in [
    otherAppNamespace,
    otherSlotNamespace,
    rotatedNamespace,
    reinstalledNamespace,
    otherCanisterNamespace,
].vals()) {
    assert (candidate.context != mailNamespace.context);
    assert (candidate.derivation_input != mailNamespace.derivation_input);
};
assert (
    Namespace.build({
        canister;
        app_id = "mail";
        installation_uid = 1;
        slot_id = "mailbox";
        namespace_nonce = bytes(31, 1);
        generation = 1;
    }) == #err(#invalid_input)
);

// Local service lifecycle, source isolation, lifecycle-manager enforcement,
// authorized-reader recovery, reply bounds, caching, status gating, and
// generation lifecycle.
// Backend-call-only apps do not consume the independent 128-slot vetKeys
// declaration budget.
let manyAppsMemory = Memory.init();
let manyAppsFake = FakeAdapter();
let backendOnlyApps = Array.tabulate<Types.AppDeclaration>(129, func(index) {
    { app_scope = appScope("backend_" # Nat.toText(index)); vetkeys = null };
});
let manyAppsService = testService(
    manyAppsMemory,
    manyAppsFake.value(),
    authorized,
);
configure(
    manyAppsService,
    #local,
    Array.concat<Types.AppDeclaration>(
        backendOnlyApps,
        [declaration("mail", ["mailbox"])],
    ),
);
ignore expectSlot(await* manyAppsService.reserve(
    { app_id = "mail"; slot_id = "mailbox" },
    owner,
    canisterActor,
));

// Randomness brokerage admits exactly four distinct apps at once. The fifth
// request is rejected before the adapter is called, and all four admitted
// reservations remain able to finish after the nested management awaits.
let randomLimitMemory = Memory.init();
let randomLimitFake = FakeAdapter();
let randomLimitDeclarations = Array.tabulate<Types.AppDeclaration>(5, func(index) {
    declaration("random_limit_" # Nat.toText(index), ["slot"]);
});
let randomLimitService = testService(
    randomLimitMemory,
    randomLimitFake.value(),
    authorized,
);
configure(randomLimitService, #local, randomLimitDeclarations);
let reservedBeforeRandomLimit = reservedCycleCalls;
let committedBeforeRandomLimit = committedCycleCalls;
let finalizedBeforeRandomLimit = finalizedCycleCalls;
let zeroBeforeRandomLimit = zeroAttachedCycleCalls;
let cancelledBeforeRandomLimit = cancelledCycleCalls;
var fifthRandomResult : Types.OperationResult<Types.PublicSlotSummary> =
    #err(#invalid_request);
func reserveNested(index : Nat) : async () {
    let appId = "random_limit_" # Nat.toText(index);
    if (index == 4) {
        fifthRandomResult := await* randomLimitService.reserve(
            { app_id = appId; slot_id = "slot" },
            owner,
            canisterActor,
        );
        return;
    };
    randomLimitFake.before_random_reply := ?(func () : async () {
        await reserveNested(index + 1);
    });
    ignore expectSlot(await* randomLimitService.reserve(
        { app_id = appId; slot_id = "slot" },
        owner,
        canisterActor,
    ));
};
randomLimitFake.before_random_reply := ?(func () : async () {
    await reserveNested(1);
});
ignore expectSlot(await* randomLimitService.reserve(
    { app_id = "random_limit_0"; slot_id = "slot" },
    owner,
    canisterActor,
));
expectError(fifthRandomResult, #busy);
assert (randomLimitFake.random_calls == 4);
assert (
    reservedCycleCalls == reservedBeforeRandomLimit + 4 and
    committedCycleCalls == committedBeforeRandomLimit + 4 and
    finalizedCycleCalls == finalizedBeforeRandomLimit + 4 and
    zeroAttachedCycleCalls == zeroBeforeRandomLimit + 4 and
    cancelledCycleCalls == cancelledBeforeRandomLimit and
    lastReservedCycles == 0 and
    lastReservationCallCount == 1 and
    lastChargedCycles == 0
);
for (index in [0, 1, 2, 3].vals()) {
    assert (
        Memory.get(
            randomLimitMemory,
            appScope("random_limit_" # Nat.toText(index)),
            "slot",
        ) != null
    );
};
assert (Memory.get(randomLimitMemory, appScope("random_limit_4"), "slot") == null);

// Public-key brokerage has the same exact four-call global boundary. Nested
// requests keep the first four adapter calls pending; request five must report
// busy without dispatching or caching a key for that generation.
let publicLimitMemory = Memory.init();
let publicLimitFake = FakeAdapter();
let publicLimitDeclarations = Array.tabulate<Types.AppDeclaration>(5, func(index) {
    declaration("public_limit_" # Nat.toText(index), ["slot"]);
});
let publicLimitService = testService(
    publicLimitMemory,
    publicLimitFake.value(),
    authorized,
);
configure(publicLimitService, #local, publicLimitDeclarations);
for (index in [0, 1, 2, 3, 4].vals()) {
    ignore expectSlot(await* publicLimitService.reserve(
        {
            app_id = "public_limit_" # Nat.toText(index);
            slot_id = "slot";
        },
        owner,
        canisterActor,
    ));
};
let reservedBeforePublicLimit = reservedCycleCalls;
let committedBeforePublicLimit = committedCycleCalls;
let finalizedBeforePublicLimit = finalizedCycleCalls;
let zeroBeforePublicLimit = zeroAttachedCycleCalls;
let cancelledBeforePublicLimit = cancelledCycleCalls;
var fifthPublicResult : Types.PublicKeyResult = #err(#invalid_request);
func publicKeyNested(index : Nat) : async () {
    let appId = "public_limit_" # Nat.toText(index);
    if (index == 4) {
        fifthPublicResult := await* publicLimitService.publicKey(
            appId,
            { slot = "slot"; generation = 1 },
            canister,
        );
        return;
    };
    publicLimitFake.before_public_reply := ?(func () : async () {
        await publicKeyNested(index + 1);
    });
    ignore expectPublicKey(await* publicLimitService.publicKey(
        appId,
        { slot = "slot"; generation = 1 },
        canister,
    ));
};
publicLimitFake.before_public_reply := ?(func () : async () {
    await publicKeyNested(1);
});
ignore expectPublicKey(await* publicLimitService.publicKey(
    "public_limit_0",
    { slot = "slot"; generation = 1 },
    canister,
));
expectError(fifthPublicResult, #busy);
assert (publicLimitFake.public_calls == 4);
assert (
    reservedCycleCalls == reservedBeforePublicLimit + 4 and
    committedCycleCalls == committedBeforePublicLimit + 4 and
    finalizedCycleCalls == finalizedBeforePublicLimit + 4 and
    zeroAttachedCycleCalls == zeroBeforePublicLimit + 4 and
    cancelledCycleCalls == cancelledBeforePublicLimit and
    lastReservedCycles == 0 and
    lastReservationCallCount == 1 and
    lastChargedCycles == 0
);
for (index in [0, 1, 2, 3].vals()) {
    let ?cached = Memory.generation(
        publicLimitMemory,
        appScope("public_limit_" # Nat.toText(index)),
        "slot",
        1,
    ) else Runtime.trap("Expected public-limit generation");
    assert (cached.cached_public_key != null);
};
let ?notDispatched = Memory.generation(
    publicLimitMemory,
    appScope("public_limit_4"),
    "slot",
    1,
) else Runtime.trap("Expected fifth public-limit generation");
assert (notDispatched.cached_public_key == null);

let fake = FakeAdapter();
let mem = Memory.init();
let service = testService(mem, fake.value(), authorized);
configure(service, #local, [
    declaration("mail", ["mailbox", "binding"]),
    declaration("other_app", ["mailbox", "foreign"]),
]);
assert (service.list("mail").size() == 0);

fake.random_mode := #ok(bytes(31, 1));
expectError(
    await* service.reserve(
        { app_id = "mail"; slot_id = "mailbox" },
        owner,
        canisterActor,
    ),
    #management_failure,
);
assert (Memory.get(mem, appScope("mail"), "mailbox") == null);

fake.random_mode := #err;
expectError(
    await* service.reserve(
        { app_id = "mail"; slot_id = "mailbox" },
        owner,
        canisterActor,
    ),
    #management_failure,
);

fake.random_mode := #ok(nonceOne);
let mailSummary = expectSlot(await* service.reserve(
    { app_id = "mail"; slot_id = "mailbox" },
    owner,
    canisterActor,
));
assert (mailSummary.environment == #local);
assert (mailSummary.current_generation == 1);
assert (mailSummary.generations.size() == 1);
assert (mailSummary.generations[0].key_name == "test_key_1");
let mailSlot = requireSlot(mem, "mail", "mailbox");
assert (service.binding("mail", "mailbox") == #ok(mailSlot.slot_uid));

expectError(
    service.transfer({
        app_id = "mail";
        slot_id = "mailbox";
        new_holder = canister;
    }, owner),
    #invalid_request,
);
assert (requireSlot(mem, "mail", "mailbox").key_holder == owner);

let otherSummary = expectSlot(await* service.reserve(
    { app_id = "other_app"; slot_id = "mailbox" },
    owner,
    canisterActor,
));
let otherSlot = requireSlot(mem, "other_app", "mailbox");
assert (service.binding("other_app", "mailbox") == #ok(otherSlot.slot_uid));
assert (otherSlot.slot_uid != mailSlot.slot_uid);
expectError(service.binding("mail", "foreign"), #not_declared);
assert (otherSummary.slot == "mailbox");
let transferredOther = expectSlot(service.transfer({
    app_id = "other_app";
    slot_id = "mailbox";
    new_holder = otherOwner;
}, owner));
assert (transferredOther.key_holder == otherOwner);
expectError(
    service.rotate({ app_id = "other_app"; slot_id = "mailbox" }, owner),
    #owner_required,
);
ignore expectSlot(service.transfer({
    app_id = "other_app";
    slot_id = "mailbox";
    new_holder = owner;
}, otherOwner));
assert (service.list("mail").size() == 1);
assert (service.list("other_app").size() == 1);

// A slot that only the other app declared is indistinguishable from a missing
// Mail slot, and another app's uid cannot authorize derivation.
let reservedBeforeInvalidRequests = reservedCycleCalls;
expectError(
    await* service.publicKey(
        "mail",
        { slot = "foreign"; generation = 1 },
        canister,
    ),
    #not_declared,
);
expectError(
    await* service.derive({
        app_id = "mail";
        slot_id = "foreign";
        expected_slot_uid = otherSlot.slot_uid;
        generation = 1;
        transport_public_key = transportKey;
    }, owner, canister),
    #not_declared,
);
expectError(
    await* service.derive({
        app_id = "other_app";
        slot_id = "mailbox";
        expected_slot_uid = mailSlot.slot_uid;
        generation = 1;
        transport_public_key = transportKey;
    }, owner, canister),
    #source_gone,
);
assert (fake.public_calls == 0 and fake.derive_calls == 0);
assert (reservedCycleCalls == reservedBeforeInvalidRequests);

expectError(
    service.rotate({ app_id = "mail"; slot_id = "mailbox" }, otherOwner),
    #owner_required,
);
expectError(
    service.disable({ app_id = "mail"; slot_id = "mailbox" }, otherOwner),
    #owner_required,
);

// Derivation follows Neutron's live authorized-principal set, not the single
// lifecycle manager. Use a separate service so this successful recovery does
// not populate the cache exercised by the reply-bound tests below.
let sharedReaderFake = FakeAdapter();
let sharedReaderMem = Memory.init();
let sharedReaderService = testService(
    sharedReaderMem,
    sharedReaderFake.value(),
    authorized,
);
configure(
    sharedReaderService,
    #local,
    [declaration("shared_reader", ["slot"])],
);
ignore expectSlot(await* sharedReaderService.reserve(
    { app_id = "shared_reader"; slot_id = "slot" },
    owner,
    canisterActor,
));
let sharedReaderSlot = requireSlot(sharedReaderMem, "shared_reader", "slot");
ignore expectDerived(await* sharedReaderService.derive({
    app_id = "shared_reader";
    slot_id = "slot";
    expected_slot_uid = sharedReaderSlot.slot_uid;
    generation = 1;
    transport_public_key = transportKey;
}, otherOwner, canister));
assert (requireSlot(sharedReaderMem, "shared_reader", "slot").key_holder == owner);
expectError(
    sharedReaderService.rotate(
        { app_id = "shared_reader"; slot_id = "slot" },
        otherOwner,
    ),
    #owner_required,
);

// Neutron authorizes its own canister principal for internal administration.
// That must never turn an app backend into a browser-key reader.
let selfDeniedFake = FakeAdapter();
let selfDeniedMem = Memory.init();
let selfDeniedService = testService(
    selfDeniedMem,
    selfDeniedFake.value(),
    func(principal : Principal) : Bool {
        authorized(principal) or Principal.equal(principal, canister);
    },
);
configure(selfDeniedService, #local, [declaration("self_denied", ["slot"])]);
ignore expectSlot(await* selfDeniedService.reserve(
    { app_id = "self_denied"; slot_id = "slot" },
    owner,
    canisterActor,
));
let selfDeniedSlot = requireSlot(selfDeniedMem, "self_denied", "slot");
expectError(
    await* selfDeniedService.derive({
        app_id = "self_denied";
        slot_id = "slot";
        expected_slot_uid = selfDeniedSlot.slot_uid;
        generation = 1;
        transport_public_key = transportKey;
    }, canister, canister),
    #invalid_request,
);
assert (selfDeniedFake.public_calls == 0 and selfDeniedFake.derive_calls == 0);

fake.public_mode := #ok(Service.PUBLIC_KEY_BYTES - 1);
expectError(
    await* service.publicKey(
        "mail",
        { slot = "mailbox"; generation = 1 },
        canister,
    ),
    #management_failure,
);
fake.public_mode := #ok(Service.PUBLIC_KEY_BYTES + 1);
expectError(
    await* service.publicKey(
        "mail",
        { slot = "mailbox"; generation = 1 },
        canister,
    ),
    #management_failure,
);
fake.public_mode := #err;
expectError(
    await* service.publicKey(
        "mail",
        { slot = "mailbox"; generation = 1 },
        canister,
    ),
    #management_failure,
);
fake.public_mode := #ok(Service.PUBLIC_KEY_BYTES);
let mailPublic = expectPublicKey(await* service.publicKey(
    "mail",
    { slot = "mailbox"; generation = 1 },
    canister,
));
assert (mailPublic.canister_principal == canister);
assert (mailPublic.suite == Service.SUITE);
assert (mailPublic.key_name == "test_key_1");
assert (mailPublic.public_key.size() == Service.PUBLIC_KEY_BYTES);
assert (mailPublic.public_fingerprint.size() == 32);
assert (mailPublic.derivation_input.size() == 32);
let publicCallsAfterFill = fake.public_calls;
let reservedAfterPublicFill = reservedCycleCalls;
ignore expectPublicKey(await* service.publicKey(
    "mail",
    { slot = "mailbox"; generation = 1 },
    canister,
));
assert (fake.public_calls == publicCallsAfterFill);
assert (reservedCycleCalls == reservedAfterPublicFill);
let otherPublic = expectPublicKey(await* service.publicKey(
    "other_app",
    { slot = "mailbox"; generation = 1 },
    canister,
));
assert (otherPublic.derivation_input != mailPublic.derivation_input);
let ?lastOtherRequest = fake.last_public_request else {
    Runtime.trap("Expected captured public-key request");
};
assert (lastOtherRequest.key_name == "test_key_1");
assert (lastOtherRequest.context == otherAppNamespace.context);

ignore expectSlot(service.disable(
    { app_id = "mail"; slot_id = "mailbox" },
    owner,
));
expectError(
    await* service.publicKey(
        "mail",
        { slot = "mailbox"; generation = 1 },
        canister,
    ),
    #disabled,
);
expectError(
    await* service.derive({
        app_id = "mail";
        slot_id = "mailbox";
        expected_slot_uid = mailSlot.slot_uid;
        generation = 1;
        transport_public_key = transportKey;
    }, owner, canister),
    #disabled,
);
expectError(
    service.rotate({ app_id = "mail"; slot_id = "mailbox" }, owner),
    #disabled,
);
ignore expectSlot(service.enable(
    { app_id = "mail"; slot_id = "mailbox" },
    owner,
));

ignore Memory.setStatus(
    mem,
    appScope("mail"),
    "mailbox",
    #manifest_suspended,
    owner,
    1,
);
expectError(
    await* service.publicKey(
        "mail",
        { slot = "mailbox"; generation = 1 },
        canister,
    ),
    #manifest_suspended,
);
expectError(
    await* service.derive({
        app_id = "mail";
        slot_id = "mailbox";
        expected_slot_uid = mailSlot.slot_uid;
        generation = 1;
        transport_public_key = transportKey;
    }, owner, canister),
    #manifest_suspended,
);
expectError(
    service.disable({ app_id = "mail"; slot_id = "mailbox" }, owner),
    #manifest_suspended,
);
ignore expectSlot(service.enable(
    { app_id = "mail"; slot_id = "mailbox" },
    owner,
));

let rotated = expectSlot(service.rotate(
    { app_id = "mail"; slot_id = "mailbox" },
    owner,
));
assert (rotated.current_generation == 2 and rotated.previous_generation == ?1);
expectError(
    service.rotate({ app_id = "mail"; slot_id = "mailbox" }, owner),
    #generation_unavailable,
);
ignore expectPublicKey(await* service.publicKey(
    "mail",
    { slot = "mailbox"; generation = 1 },
    canister,
));
let generationTwo = expectPublicKey(await* service.publicKey(
    "mail",
    { slot = "mailbox"; generation = 2 },
    canister,
));
assert (generationTwo.derivation_input != mailPublic.derivation_input);
let retired = expectSlot(service.retireGeneration({
    app_id = "mail";
    slot_id = "mailbox";
    generation = 1;
}, owner));
assert (retired.previous_generation == null);
expectError(
    await* service.publicKey(
        "mail",
        { slot = "mailbox"; generation = 1 },
        canister,
    ),
    #generation_unavailable,
);
let rotatedAgain = expectSlot(service.rotate(
    { app_id = "mail"; slot_id = "mailbox" },
    owner,
));
assert (rotatedAgain.current_generation == 3 and rotatedAgain.previous_generation == ?2);

// Retiring and re-reserving the same textual slot gets a fresh uid/nonce. A
// challenge bound to the old uid is rejected before any management dispatch.
fake.random_mode := #ok(nonceOne);
ignore expectSlot(await* service.reserve(
    { app_id = "mail"; slot_id = "binding" },
    owner,
    canisterActor,
));
let oldBinding = requireSlot(mem, "mail", "binding");
switch (service.retireSlot(
    { app_id = "mail"; slot_id = "binding" },
    owner,
)) {
    case (#ok(())) {};
    case (#err(_)) Runtime.trap("Expected slot retirement");
};
fake.random_mode := #ok(nonceTwo);
ignore expectSlot(await* service.reserve(
    { app_id = "mail"; slot_id = "binding" },
    owner,
    canisterActor,
));
let newBinding = requireSlot(mem, "mail", "binding");
assert (newBinding.slot_uid != oldBinding.slot_uid);
assert (newBinding.namespace_nonce != oldBinding.namespace_nonce);
let callsBeforeStale = fake.public_calls;
expectError(
    await* service.derive({
        app_id = "mail";
        slot_id = "binding";
        expected_slot_uid = oldBinding.slot_uid;
        generation = 1;
        transport_public_key = transportKey;
    }, owner, canister),
    #source_gone,
);
assert (fake.public_calls == callsBeforeStale and fake.derive_calls == 0);

// Capability changes mutate stable lifecycle state only when the install
// journal commits. An empty replacement is still configured, can suspend the
// last declared slot, and leaves permanent holder cleanup available.
let lifecycleMemory = Memory.init();
let lifecycleFake = FakeAdapter();
let lifecycleInitial = testService(
    lifecycleMemory,
    lifecycleFake.value(),
    authorized,
);
configure(lifecycleInitial, #local, [declaration("last_app", ["slot"])]);
ignore expectSlot(await* lifecycleInitial.reserve(
    { app_id = "last_app"; slot_id = "slot" },
    owner,
    canisterActor,
));
let lifecycleInitialSlot = requireSlot(lifecycleMemory, "last_app", "slot");

let lifecycleAborted = testService(
    lifecycleMemory,
    lifecycleFake.value(),
    authorized,
);
configure(lifecycleAborted, #local, []);
assert (requireSlot(lifecycleMemory, "last_app", "slot").status == #enabled);
assert (lifecycleInitial.list("last_app").size() == 1);

let lifecycleCommitted = testService(
    lifecycleMemory,
    lifecycleFake.value(),
    authorized,
);
configure(lifecycleCommitted, #local, []);
lifecycleCommitted.commitConfiguration([], owner, 50);
assert (
    requireSlot(lifecycleMemory, "last_app", "slot").status ==
    #manifest_suspended
);
assert (lifecycleCommitted.adminSnapshot().environment == ?#local);
switch (lifecycleCommitted.retireSlot(
    { app_id = "last_app"; slot_id = "slot" },
    owner,
)) {
    case (#ok(())) {};
    case (#err(_)) Runtime.trap("Expected suspended slot cleanup");
};
assert (Memory.get(lifecycleMemory, appScope("last_app"), "slot") == null);

lifecycleFake.random_mode := #ok(nonceTwo);
let lifecycleReinstalled = testService(
    lifecycleMemory,
    lifecycleFake.value(),
    authorized,
);
configure(lifecycleReinstalled, #local, [declaration("last_app", ["slot"])]);
ignore expectSlot(await* lifecycleReinstalled.reserve(
    { app_id = "last_app"; slot_id = "slot" },
    owner,
    canisterActor,
));
let lifecycleReinstalledSlot = requireSlot(lifecycleMemory, "last_app", "slot");
assert (lifecycleReinstalledSlot.slot_uid != lifecycleInitialSlot.slot_uid);
assert (
    requireSlot(lifecycleMemory, "last_app", "slot").namespace_nonce == nonceTwo
);

// Reinstalling the same app id binds the service to a fresh AppScope. An old
// slot can remain in stable memory without being listed, derived, or reused by
// the new installation.
let scopedMemory = Memory.init();
let oldScopedApp = appScopeWithUid("scoped_app", 41);
let newScopedApp = appScopeWithUid("scoped_app", 42);
let #ok(oldScopedSummary) = Memory.reserve(scopedMemory, {
    scope = oldScopedApp;
    slot_id = "slot";
    namespace_nonce = nonceOne;
    key_holder = owner;
    key_name = "test_key_1";
    now = 1;
    changed_by = owner;
}) else Runtime.trap("Expected old scoped slot");
let scopedFake = FakeAdapter();
scopedFake.random_mode := #ok(nonceTwo);
let scopedService = Service.Service(
    scopedMemory,
    scopedFake.value(),
    authorized,
    func(appId) {
        if (appId == newScopedApp.app_id) ?newScopedApp else null;
    },
    func(scope) { scope == newScopedApp },
    FakeRegistry().value(),
    cycleAccounting,
);
configure(
    scopedService,
    #local,
    [declarationForScope(newScopedApp, ["slot"])],
);
assert (scopedService.list("scoped_app").size() == 0);
ignore expectSlot(await* scopedService.reserve(
    { app_id = "scoped_app"; slot_id = "slot" },
    owner,
    canisterActor,
));
let ?newScopedSlot = Memory.get(scopedMemory, newScopedApp, "slot") else {
    Runtime.trap("Expected new scoped slot");
};
assert (newScopedSlot.slot_uid != oldScopedSummary.slot_uid);
assert (Memory.get(scopedMemory, oldScopedApp, "slot") != null);
assert (Memory.get(scopedMemory, newScopedApp, "slot") != null);
assert (
    Memory.getByUidForScope(
        scopedMemory,
        newScopedApp,
        oldScopedSummary.slot_uid,
    ) == null
);

// Deterministic hooks mutate stable state while the adapter call is awaited.
// The service must discard otherwise valid management replies after a status
// or holder change instead of caching/delivering stale cryptographic material.
let revokedReserveFake = FakeAdapter();
let revokedReserveMemory = Memory.init();
var reserveOwnerAuthorized = true;
let revokedReserveService = testService(
    revokedReserveMemory,
    revokedReserveFake.value(),
    func(principal : Principal) : Bool {
        Principal.equal(principal, otherOwner) or
        (reserveOwnerAuthorized and Principal.equal(principal, owner));
    },
);
configure(
    revokedReserveService,
    #local,
    [declaration("revoked_app", ["slot"])],
);
revokedReserveFake.before_random_reply := ?(func () : async () {
    reserveOwnerAuthorized := false;
});
expectError(
    await* revokedReserveService.reserve(
        { app_id = "revoked_app"; slot_id = "slot" },
        owner,
        canisterActor,
    ),
    #source_gone,
);
assert (Memory.get(revokedReserveMemory, appScope("revoked_app"), "slot") == null);

let revokedReaderFake = FakeAdapter();
let revokedReaderMemory = Memory.init();
var readerAuthorized = true;
let revokedReaderService = testService(
    revokedReaderMemory,
    revokedReaderFake.value(),
    func(principal : Principal) : Bool {
        Principal.equal(principal, owner) or
        (readerAuthorized and Principal.equal(principal, otherOwner));
    },
);
configure(
    revokedReaderService,
    #local,
    [declaration("revoked_reader", ["slot"])],
);
ignore expectSlot(await* revokedReaderService.reserve(
    { app_id = "revoked_reader"; slot_id = "slot" },
    owner,
    canisterActor,
));
let revokedReaderSlot = requireSlot(
    revokedReaderMemory,
    "revoked_reader",
    "slot",
);
revokedReaderFake.before_derive_reply := ?(func () : async () {
    readerAuthorized := false;
});
expectError(
    await* revokedReaderService.derive({
        app_id = "revoked_reader";
        slot_id = "slot";
        expected_slot_uid = revokedReaderSlot.slot_uid;
        generation = 1;
        transport_public_key = transportKey;
    }, otherOwner, canister),
    #source_gone,
);
assert (revokedReaderFake.derive_calls == 1);
expectError(
    await* revokedReaderService.derive({
        app_id = "revoked_reader";
        slot_id = "slot";
        expected_slot_uid = revokedReaderSlot.slot_uid;
        generation = 1;
        transport_public_key = transportKey;
    }, otherOwner, canister),
    #invalid_request,
);

let raceFake = FakeAdapter();
let raceMem = Memory.init();
let raceService = testService(raceMem, raceFake.value(), authorized);
configure(raceService, #local, [declaration("race_app", ["slot"])]);
ignore expectSlot(await* raceService.reserve(
    { app_id = "race_app"; slot_id = "slot" },
    owner,
    canisterActor,
));
let raceSlot = requireSlot(raceMem, "race_app", "slot");
raceFake.before_public_reply := ?(func () : async () {
    ignore Memory.setStatus(
        raceMem,
        appScope("race_app"),
        "slot",
        #disabled,
        owner,
        2,
    );
});
expectError(
    await* raceService.publicKey(
        "race_app",
        { slot = "slot"; generation = 1 },
        canister,
    ),
    #source_gone,
);
let ?uncachedAfterDisable = Memory.generation(
    raceMem,
    appScope("race_app"),
    "slot",
    1,
) else Runtime.trap("Expected race generation");
assert (uncachedAfterDisable.cached_public_key == null);
ignore expectSlot(raceService.enable(
    { app_id = "race_app"; slot_id = "slot" },
    owner,
));
ignore expectPublicKey(await* raceService.publicKey(
    "race_app",
    { slot = "slot"; generation = 1 },
    canister,
));
raceFake.before_derive_reply := ?(func () : async () {
    ignore Memory.transfer(
        raceMem,
        appScope("race_app"),
        "slot",
        owner,
        otherOwner,
        owner,
        3,
    );
});
expectError(
    await* raceService.derive({
        app_id = "race_app";
        slot_id = "slot";
        expected_slot_uid = raceSlot.slot_uid;
        generation = 1;
        transport_public_key = transportKey;
    }, owner, canister),
    #source_gone,
);
let afterHolderRace = requireSlot(raceMem, "race_app", "slot");
assert (afterHolderRace.key_holder == otherOwner);
assert (afterHolderRace.total_derivations == 1);
assert (afterHolderRace.approximate_cycle_spend == Service.DERIVE_CYCLES);
// The transfer raced and therefore withheld that reply. Once stable, the
// original principal remains an authorized reader even though it is no longer
// the lifecycle manager.
ignore expectDerived(await* raceService.derive({
    app_id = "race_app";
    slot_id = "slot";
    expected_slot_uid = raceSlot.slot_uid;
    generation = 1;
    transport_public_key = transportKey;
}, owner, canister));
assert (requireSlot(raceMem, "race_app", "slot").key_holder == otherOwner);

// Every destructive lifecycle mutation is revalidated after the derive
// adapter's management await. A syntactically valid encrypted reply is charged
// and accounted for, but never returned after the slot has changed underneath
// the in-flight request.
let disableRaceFake = FakeAdapter();
let disableRaceMemory = Memory.init();
let disableRaceService = testService(
    disableRaceMemory,
    disableRaceFake.value(),
    authorized,
);
configure(disableRaceService, #local, [declaration("disable_race", ["slot"])]);
ignore expectSlot(await* disableRaceService.reserve(
    { app_id = "disable_race"; slot_id = "slot" },
    owner,
    canisterActor,
));
let disableRaceSlot = requireSlot(disableRaceMemory, "disable_race", "slot");
ignore expectPublicKey(await* disableRaceService.publicKey(
    "disable_race",
    { slot = "slot"; generation = 1 },
    canister,
));
disableRaceFake.before_derive_reply := ?(func () : async () {
    ignore expectSlot(disableRaceService.disable(
        { app_id = "disable_race"; slot_id = "slot" },
        owner,
    ));
});
expectError(
    await* disableRaceService.derive({
        app_id = "disable_race";
        slot_id = "slot";
        expected_slot_uid = disableRaceSlot.slot_uid;
        generation = 1;
        transport_public_key = transportKey;
    }, owner, canister),
    #source_gone,
);
let disabledAfterAwait = requireSlot(
    disableRaceMemory,
    "disable_race",
    "slot",
);
assert (disabledAfterAwait.status == #disabled);
assert (disabledAfterAwait.total_derivations == 1);
assert (disabledAfterAwait.approximate_cycle_spend == Service.DERIVE_CYCLES);

let generationRaceFake = FakeAdapter();
let generationRaceMemory = Memory.init();
let generationRaceService = testService(
    generationRaceMemory,
    generationRaceFake.value(),
    authorized,
);
configure(
    generationRaceService,
    #local,
    [declaration("generation_retire_race", ["slot"])],
);
ignore expectSlot(await* generationRaceService.reserve(
    { app_id = "generation_retire_race"; slot_id = "slot" },
    owner,
    canisterActor,
));
let generationRaceSlot = requireSlot(
    generationRaceMemory,
    "generation_retire_race",
    "slot",
);
ignore expectPublicKey(await* generationRaceService.publicKey(
    "generation_retire_race",
    { slot = "slot"; generation = 1 },
    canister,
));
ignore expectSlot(generationRaceService.rotate(
    { app_id = "generation_retire_race"; slot_id = "slot" },
    owner,
));
generationRaceFake.before_derive_reply := ?(func () : async () {
    ignore expectSlot(generationRaceService.retireGeneration({
        app_id = "generation_retire_race";
        slot_id = "slot";
        generation = 1;
    }, owner));
});
expectError(
    await* generationRaceService.derive({
        app_id = "generation_retire_race";
        slot_id = "slot";
        expected_slot_uid = generationRaceSlot.slot_uid;
        generation = 1;
        transport_public_key = transportKey;
    }, owner, canister),
    #source_gone,
);
assert (
    Memory.generation(
        generationRaceMemory,
        appScope("generation_retire_race"),
        "slot",
        1,
    ) == null
);
let afterGenerationRetire = requireSlot(
    generationRaceMemory,
    "generation_retire_race",
    "slot",
);
assert (afterGenerationRetire.total_derivations == 1);
assert (
    afterGenerationRetire.approximate_cycle_spend == Service.DERIVE_CYCLES
);

let slotRaceFake = FakeAdapter();
let slotRaceMemory = Memory.init();
let slotRaceService = testService(
    slotRaceMemory,
    slotRaceFake.value(),
    authorized,
);
configure(slotRaceService, #local, [declaration("slot_retire_race", ["slot"])]);
ignore expectSlot(await* slotRaceService.reserve(
    { app_id = "slot_retire_race"; slot_id = "slot" },
    owner,
    canisterActor,
));
let slotRaceSlot = requireSlot(slotRaceMemory, "slot_retire_race", "slot");
ignore expectPublicKey(await* slotRaceService.publicKey(
    "slot_retire_race",
    { slot = "slot"; generation = 1 },
    canister,
));
slotRaceFake.before_derive_reply := ?(func () : async () {
    assert (
        slotRaceService.retireSlot(
            { app_id = "slot_retire_race"; slot_id = "slot" },
            owner,
        ) == #ok(())
    );
});
expectError(
    await* slotRaceService.derive({
        app_id = "slot_retire_race";
        slot_id = "slot";
        expected_slot_uid = slotRaceSlot.slot_uid;
        generation = 1;
        transport_public_key = transportKey;
    }, owner, canister),
    #source_gone,
);
assert (Memory.get(slotRaceMemory, appScope("slot_retire_race"), "slot") == null);

let manifestRaceFake = FakeAdapter();
let manifestRaceMemory = Memory.init();
let manifestRaceService = testService(
    manifestRaceMemory,
    manifestRaceFake.value(),
    authorized,
);
configure(
    manifestRaceService,
    #local,
    [declaration("manifest_race", ["slot"])],
);
ignore expectSlot(await* manifestRaceService.reserve(
    { app_id = "manifest_race"; slot_id = "slot" },
    owner,
    canisterActor,
));
let manifestRaceSlot = requireSlot(
    manifestRaceMemory,
    "manifest_race",
    "slot",
);
ignore expectPublicKey(await* manifestRaceService.publicKey(
    "manifest_race",
    { slot = "slot"; generation = 1 },
    canister,
));
// This models the replacement service created from an upgraded manifest that
// no longer declares the slot. Its commit performs the stable suspension.
let replacementManifestService = testService(
    manifestRaceMemory,
    manifestRaceFake.value(),
    authorized,
);
configure(replacementManifestService, #local, []);
manifestRaceFake.before_derive_reply := ?(func () : async () {
    replacementManifestService.commitConfiguration([], owner, 5);
});
expectError(
    await* manifestRaceService.derive({
        app_id = "manifest_race";
        slot_id = "slot";
        expected_slot_uid = manifestRaceSlot.slot_uid;
        generation = 1;
        transport_public_key = transportKey;
    }, owner, canister),
    #source_gone,
);
let suspendedAfterAwait = requireSlot(
    manifestRaceMemory,
    "manifest_race",
    "slot",
);
assert (suspendedAfterAwait.status == #manifest_suspended);
assert (suspendedAfterAwait.total_derivations == 1);
assert (
    suspendedAfterAwait.approximate_cycle_spend == Service.DERIVE_CYCLES
);

// Production fixes key_1 and rejects stable generations created for another
// environment rather than falling back to a local key.
let productionFake = FakeAdapter();
let productionMem = Memory.init();
ignore Memory.reserve(productionMem, {
    scope = appScope("prod_app");
    slot_id = "mismatch";
    namespace_nonce = nonceOne;
    key_holder = owner;
    key_name = "test_key_1";
    now = 1;
    changed_by = owner;
});
let production = testService(productionMem, productionFake.value(), authorized);
configure(production, #production, [
    declaration("prod_app", ["primary", "mismatch"]),
]);
productionFake.random_mode := #ok(nonceOne);
let productionSummary = expectSlot(await* production.reserve(
    { app_id = "prod_app"; slot_id = "primary" },
    owner,
    canisterActor,
));
assert (productionSummary.environment == #production);
assert (productionSummary.generations[0].key_name == "key_1");
let productionPublic = expectPublicKey(await* production.publicKey(
    "prod_app",
    { slot = "primary"; generation = 1 },
    canister,
));
assert (productionPublic.key_name == "key_1");
let ?productionRequest = productionFake.last_public_request else {
    Runtime.trap("Expected production public-key request");
};
assert (productionRequest.key_name == "key_1");
let productionCalls = productionFake.public_calls;
expectError(
    await* production.publicKey(
        "prod_app",
        { slot = "mismatch"; generation = 1 },
        canister,
    ),
    #key_unavailable,
);
assert (productionFake.public_calls == productionCalls);

// Derivation validates transport/reply bounds, enforces the cycle floor before
// dispatch, and records lifetime derivation/cycle accounting on paid rejects.
let accountingFake = FakeAdapter();
let accountingMem = Memory.init();
let accountingService = testService(
    accountingMem,
    accountingFake.value(),
    authorized,
);
configure(accountingService, #local, [declaration("accounting_app", ["quota"])]);
ignore expectSlot(await* accountingService.reserve(
    { app_id = "accounting_app"; slot_id = "quota" },
    owner,
    canisterActor,
));
let accountingSlot = requireSlot(accountingMem, "accounting_app", "quota");
expectError(
    await* accountingService.derive({
        app_id = "accounting_app";
        slot_id = "quota";
        expected_slot_uid = accountingSlot.slot_uid;
        generation = 1;
        transport_public_key = bytes(Service.TRANSPORT_PUBLIC_KEY_BYTES - 1, 1);
    }, owner, canister),
    #invalid_request,
);
assert (accountingFake.public_calls == 0 and accountingFake.derive_calls == 0);

accountingFake.balance := Service.DERIVE_CYCLES + Service.MIN_REMAINING_CYCLES - 1;
expectError(
    await* accountingService.derive({
        app_id = "accounting_app";
        slot_id = "quota";
        expected_slot_uid = accountingSlot.slot_uid;
        generation = 1;
        transport_public_key = transportKey;
    }, owner, canister),
    #low_cycles,
);
assert (accountingFake.public_calls == 1 and accountingFake.derive_calls == 0);
let afterLowCycles = requireSlot(accountingMem, "accounting_app", "quota");
assert (afterLowCycles.total_derivations == 0);
assert (afterLowCycles.approximate_cycle_spend == 0);

accountingFake.balance := Service.DERIVE_CYCLES + Service.MIN_REMAINING_CYCLES;
accountingFake.derive_mode := #err({ charged_cycles = 17 });
let finalizedBeforeReject = finalizedCycleCalls;
expectError(
    await* accountingService.derive({
        app_id = "accounting_app";
        slot_id = "quota";
        expected_slot_uid = accountingSlot.slot_uid;
        generation = 1;
        transport_public_key = transportKey;
    }, owner, canister),
    #management_failure,
);
assert (
    finalizedCycleCalls == finalizedBeforeReject + 1 and
    lastChargedCycles == 17
);
let afterReject = requireSlot(accountingMem, "accounting_app", "quota");
assert (afterReject.total_derivations == 1);
assert (afterReject.approximate_cycle_spend == 17);

accountingFake.derive_mode := #ok({
    size = Service.ENCRYPTED_KEY_BYTES - 1;
    charged_cycles = 23;
});
expectError(
    await* accountingService.derive({
        app_id = "accounting_app";
        slot_id = "quota";
        expected_slot_uid = accountingSlot.slot_uid;
        generation = 1;
        transport_public_key = transportKey;
    }, owner, canister),
    #management_failure,
);
let afterShortReply = requireSlot(accountingMem, "accounting_app", "quota");
assert (afterShortReply.total_derivations == 2);
assert (afterShortReply.approximate_cycle_spend == 40);

accountingFake.derive_mode := #ok({
    size = Service.ENCRYPTED_KEY_BYTES + 1;
    charged_cycles = 29;
});
expectError(
    await* accountingService.derive({
        app_id = "accounting_app";
        slot_id = "quota";
        expected_slot_uid = accountingSlot.slot_uid;
        generation = 1;
        transport_public_key = transportKey;
    }, owner, canister),
    #management_failure,
);
let afterLongReply = requireSlot(accountingMem, "accounting_app", "quota");
assert (afterLongReply.total_derivations == 3);
assert (afterLongReply.approximate_cycle_spend == 69);

accountingFake.derive_mode := #ok({
    size = Service.ENCRYPTED_KEY_BYTES;
    charged_cycles = 31;
});
var successCount = 0;
while (successCount < 8) {
    let derived = expectDerived(await* accountingService.derive({
        app_id = "accounting_app";
        slot_id = "quota";
        expected_slot_uid = accountingSlot.slot_uid;
        generation = 1;
        transport_public_key = transportKey;
    }, owner, canister));
    assert (derived.encrypted_key.size() == Service.ENCRYPTED_KEY_BYTES);
    assert (derived.public_info.derivation_input.size() == 32);
    successCount += 1;
};
let afterSuccess = requireSlot(accountingMem, "accounting_app", "quota");
assert (afterSuccess.total_derivations == 11);
assert (
    afterSuccess.approximate_cycle_spend ==
    69 + 31 * 8
);
let ?deriveRequest = accountingFake.last_derive_request else {
    Runtime.trap("Expected captured derive request");
};
assert (deriveRequest.transport_public_key == transportKey);
assert (deriveRequest.key_name == "test_key_1");
assert (deriveRequest.cycles == Service.DERIVE_CYCLES);
assert (deriveRequest.context.size() == 32);
assert (deriveRequest.derivation_input.size() == 32);

let audit = accountingService.auditSnapshot();
assert (audit.size() >= 13);
assert (audit[audit.size() - 1].outcome == #ok);
assert (Array.find<Types.AuditEntry>(audit, func(entry) {
    entry.action == #public_key and entry.generation == ?(1 : Nat64);
}) != null);
assert (Array.find<Types.AuditEntry>(audit, func(entry) {
    entry.action == #derive and entry.generation == ?(1 : Nat64);
}) != null);

// If the trusted management adapter itself traps after dispatch, the refund
// is unknowable. Account the conservative gross reservation and still return
// a typed management failure.
accountingFake.throw_derive := true;
let finalizedBeforeAdapterThrow = finalizedCycleCalls;
expectError(
    await* accountingService.derive({
        app_id = "accounting_app";
        slot_id = "quota";
        generation = 1;
        expected_slot_uid = accountingSlot.slot_uid;
        transport_public_key = transportKey;
    }, owner, canister),
    #management_failure,
);
assert (
    finalizedCycleCalls == finalizedBeforeAdapterThrow + 1 and
    lastChargedCycles == Service.DERIVE_CYCLES
);
accountingFake.throw_derive := false;

// The generic registry is an additional live kill switch. Every paid await
// rechecks it before returning authority, while permanent cleanup stays
// available so disabling a capability cannot strand its slot.
let registryFake = FakeRegistry();
let registryAdapter = FakeAdapter();
let registryMemory = Memory.init();
let registryService = Service.Service(
    registryMemory,
    registryAdapter.value(),
    authorized,
    func(appId) { ?appScope(appId) },
    func(_) { true },
    registryFake.value(),
    cycleAccounting,
);
configure(
    registryService,
    #local,
    [declaration("registry_app", ["slot"])],
);
ignore expectSlot(await* registryService.reserve(
    { app_id = "registry_app"; slot_id = "slot" },
    owner,
    canisterActor,
));
assert (registryFake.records == 1);
assert (registryFake.last_operation == ?"reserve");
assert (registryFake.last_outcome == ?#ok);

registryAdapter.before_public_reply := ?(func () : async () {
    registryFake.setEnabled(false);
    registryFake.setEnabled(true);
});
expectError(
    await* registryService.publicKey(
        "registry_app",
        { slot = "slot"; generation = 1 },
        canister,
    ),
    #source_gone,
);
assert (registryFake.records == 2);
assert (registryFake.last_operation == ?"public_key");
assert (registryFake.last_outcome == ?#revoked);
assert (registryFake.enabled);

ignore expectPublicKey(await* registryService.publicKey(
    "registry_app",
    { slot = "slot"; generation = 1 },
    canister,
));
let registrySlot = requireSlot(registryMemory, "registry_app", "slot");
registryAdapter.before_derive_reply := ?(func () : async () {
    registryFake.setEnabled(false);
    registryFake.setEnabled(true);
});
expectError(
    await* registryService.derive({
        app_id = "registry_app";
        slot_id = "slot";
        expected_slot_uid = registrySlot.slot_uid;
        generation = 1;
        transport_public_key = transportKey;
    }, owner, canister),
    #source_gone,
);
assert (registryFake.records == 4);
assert (registryFake.last_operation == ?"derive");
assert (registryFake.last_outcome == ?#revoked);
assert (
    requireSlot(registryMemory, "registry_app", "slot").approximate_cycle_spend ==
    Service.DERIVE_CYCLES
);

registryFake.setEnabled(false);
expectError(
    registryService.rotate(
        { app_id = "registry_app"; slot_id = "slot" },
        owner,
    ),
    #disabled,
);
assert (registryFake.last_operation == ?"rotate");
assert (registryFake.last_outcome == ?#denied);
switch (registryService.retireSlot(
    { app_id = "registry_app"; slot_id = "slot" },
    owner,
)) {
    case (#ok(())) {};
    case (#err(_)) Runtime.trap("Expected cleanup while registry-disabled");
};
assert (registryFake.last_operation == ?"retire_slot");
assert (registryFake.last_outcome == ?#ok);
assert (Memory.get(registryMemory, appScope("registry_app"), "slot") == null);

let reserveRegistry = FakeRegistry();
let reserveRegistryAdapter = FakeAdapter();
let reserveRegistryMemory = Memory.init();
let reserveRegistryService = Service.Service(
    reserveRegistryMemory,
    reserveRegistryAdapter.value(),
    authorized,
    func(appId) { ?appScope(appId) },
    func(_) { true },
    reserveRegistry.value(),
    cycleAccounting,
);
configure(
    reserveRegistryService,
    #local,
    [declaration("reserve_registry", ["slot"])],
);
reserveRegistryAdapter.before_random_reply := ?(func () : async () {
    reserveRegistry.setEnabled(false);
    reserveRegistry.setEnabled(true);
});
expectError(
    await* reserveRegistryService.reserve(
        { app_id = "reserve_registry"; slot_id = "slot" },
        owner,
        canisterActor,
    ),
    #source_gone,
);
assert (
    Memory.get(reserveRegistryMemory, appScope("reserve_registry"), "slot") == null
);
assert (reserveRegistry.records == 1);
assert (reserveRegistry.last_operation == ?"reserve");
assert (reserveRegistry.last_outcome == ?#revoked);
assert (reserveRegistry.enabled);

// A reservation is still pre-dispatch until the durable derivation counter is
// recorded. If that local mutation discovers stale state, cancel the transfer
// reservation: no management-call base was incurred and no finalize is due.
let cancelMemory = Memory.init();
let cancelAdapter = FakeAdapter();
let cancelService = testService(
    cancelMemory,
    cancelAdapter.value(),
    authorized,
);
configure(cancelService, #local, [declaration("cancel_app", ["slot"])]);
ignore expectSlot(await* cancelService.reserve(
    { app_id = "cancel_app"; slot_id = "slot" },
    owner,
    canisterActor,
));
ignore expectPublicKey(await* cancelService.publicKey(
    "cancel_app",
    { slot = "slot"; generation = 1 },
    canister,
));
let cancelSlot = requireSlot(cancelMemory, "cancel_app", "slot");
let reservedBeforeCancel = reservedCycleCalls;
let committedBeforeCancel = committedCycleCalls;
let cancelledBeforeCancel = cancelledCycleCalls;
let finalizedBeforeCancel = finalizedCycleCalls;
let zeroBeforeCancel = zeroAttachedCycleCalls;
beforeCycleReserve := ?(func(
    scope : Types.AppScope,
    attached : Nat,
) : () {
    assert (scope == appScope("cancel_app"));
    assert (attached == Service.DERIVE_CYCLES);
    switch (Memory.retireSlot(
        cancelMemory,
        scope,
        "slot",
        #owner_retired,
        owner,
        1,
    )) {
        case (#ok(())) {};
        case (#err(_)) Runtime.trap("Expected pre-dispatch slot retirement");
    };
});
expectError(
    await* cancelService.derive({
        app_id = "cancel_app";
        slot_id = "slot";
        expected_slot_uid = cancelSlot.slot_uid;
        generation = 1;
        transport_public_key = transportKey;
    }, owner, canister),
    #source_gone,
);
switch (beforeCycleReserve) {
    case null {};
    case (?_) Runtime.trap("Expected the reserve hook to run");
};
assert (cancelAdapter.derive_calls == 0);
assert (
    reservedCycleCalls == reservedBeforeCancel + 1 and
    committedCycleCalls == committedBeforeCancel and
    cancelledCycleCalls == cancelledBeforeCancel + 1 and
    finalizedCycleCalls == finalizedBeforeCancel and
    zeroAttachedCycleCalls == zeroBeforeCancel and
    lastReservedCycles == Service.DERIVE_CYCLES and
    lastReservationCallCount == 1
);
