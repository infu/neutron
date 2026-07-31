import Ledger "./lib/ledger";
import IC "./lib/IC";
import Array "mo:core/Array";
import Result "mo:core/Result";
import Principal "mo:core/Principal";
import Blob "mo:core/Blob";
import Error "mo:core/Error";
import Int "mo:core/Int";
import List "mo:core/List";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Nat64 "mo:core/Nat64";
import Prim "mo:prim";
import Set "mo:core/Set";
import Text "mo:core/Text";
import Time "mo:core/Time";
import Sha256 "mo:sha2/Sha256";
import ICPL "./lib/ICPL";
import CMC "./lib/cmc";
import Neutron "./lib/neutron";

persistent actor class Self<system>(installTargetSubnet : Principal) = this {
    private transient let ledger : Ledger.Interface =
        actor ("ryjl3-tyaaa-aaaaa-aaaba-cai");
    private transient let cmc : CMC.Self =
        actor ("rkp4c-7iaaa-aaaaa-aaaca-cai");
    private transient let ic : IC.Self = actor ("aaaaa-aa");
    private let targetSubnet : Principal = do {
        assert(not Principal.isAnonymous(installTargetSubnet));
        assert(installTargetSubnet != Principal.fromText("aaaaa-aa"));
        installTargetSubnet
    };

    private let MINIMUM_DEPOSIT_E8S : Nat64 = 200_000_000;
    private let CREATE_CANISTER_MEMO : Nat64 = 1_095_062_083;
    private let MAX_STARTER_WASM_CHUNKS : Nat = 100;
    private let MAX_STARTER_WASM_BYTES : Nat = 100 * 1024 * 1024;
    private let MAX_STARTER_WASM_CHUNK_BYTES : Nat = 1_800_000;
    private let MAX_STARTER_FILES : Nat = 20_000;
    private let MAX_STARTER_FILE_CHUNKS : Nat = 20_000;
    private let MAX_STARTER_BACKEND_CALL_TARGETS : Nat = 2_048;

    public type Asset = (Text, Neutron.File);
    public type AssetChunk = (Text, Nat, Blob);
    public type RuntimeConfigTemplate = {
        // The created canister principal is inserted between every segment.
        // This covers every canister-bound field in runtime-config.json
        // without accepting an untrusted principal from the browser.
        segments : [Text];
    };
    public type StarterUploadSpec = {
        deployment_id : Text;
        app_ids : [Text];
        wasm_chunks : Nat;
        wasm_bytes : Nat;
        wasm_sha256 : Blob;
        files : Nat;
        file_chunks : Nat;
        runtime_config_template : RuntimeConfigTemplate;
        backend_call_target_principals : [Principal];
    };
    public type StarterInfo = {
        revision : Nat;
        deployment_id : Text;
        app_ids : [Text];
        wasm_bytes : Nat;
        wasm_sha256 : Blob;
        files : Nat;
        file_chunks : Nat;
        backend_call_target_principals : [Principal];
    };
    private type CommittedStarter = {
        info : StarterInfo;
        wasm : Blob;
        runtime_config_template : RuntimeConfigTemplate;
        files : [Asset];
        file_chunks : [AssetChunk];
        initialize_publication_entropy : Bool;
    };
    private type StarterUpload = {
        epoch : Nat;
        spec : StarterUploadSpec;
    };

    public type Stage = {
        #awaiting_payment;
        #transferring;
        #notifying_cmc;
        #created;
        #installed;
        #controlled;
        #assets_seeded;
        #activated;
        #complete;
    };

    public type ProvisioningStatus = {
        stage : Stage;
        canister_id : ?Principal;
    };

    public query func dispenser_target_subnet() : async Principal {
        targetSubnet
    };

    private type Transfer = {
        amount : Nat64;
        fee : Nat64;
        created_at_time : Nat64;
    };

    private type Phase = {
        #awaiting_payment;
        #transferring : Transfer;
        #notifying_cmc : Ledger.BlockIndex;
        #created : Principal;
        #installed : Principal;
        #controlled : Principal;
        #assets_seeded : Principal;
        #activated : Principal;
        #complete : Principal;
    };

    private type Registration = {
        activation_hash : Blob;
        starter_revision : ?Nat;
        starter : ?CommittedStarter;
        phase : Phase;
    };

    // This Core collection state is intentionally the schema for a fresh
    // dispenser deployment. It is not upgrade-compatible with the retired
    // BTree/vector registry.
    let regs = Map.empty<Principal, Registration>();
    var next_starter_revision : Nat = 0;
    var current_starter : ?CommittedStarter = null;
    var next_starter_upload_epoch : Nat = 0;
    var starter_upload : ?StarterUpload = null;
    var staged_wasm_chunks = Map.empty<Nat, Blob>();
    var staged_files = List.empty<Asset>();
    var staged_file_chunks = List.empty<AssetChunk>();

    // In-flight calls are serialized per ephemeral provisioning identity.
    // Durable phases handle browser/network retries and canister restarts.
    private transient let active = Set.empty<Principal>();

    public query ({ caller }) func status() : async ProvisioningStatus {
        switch (Map.get(regs, Principal.compare, caller)) {
            case null {
                { stage = #awaiting_payment; canister_id = null };
            };
            case (?registration) statusFromPhase(registration.phase);
        };
    };

    public query ({ caller }) func find() : async ?Principal {
        let ?registration = Map.get(regs, Principal.compare, caller) else {
            return null;
        };
        switch (registration.phase) {
            case (#complete(canisterId)) ?canisterId;
            case (_) null;
        };
    };

    public query func starter() : async ?StarterInfo {
        switch (current_starter) {
            case null null;
            case (?committed) ?committed.info;
        };
    };

    public shared ({ caller }) func begin_starter_upload(
        spec : StarterUploadSpec,
    ) : async Nat {
        await assertDispenserController(caller);
        switch (starterUploadSpecError(spec)) {
            case null {};
            case (?message) {
                throw Error.reject(message);
            };
        };
        let epoch = next_starter_upload_epoch + 1;
        next_starter_upload_epoch := epoch;
        starter_upload := ?{ epoch; spec };
        staged_wasm_chunks := Map.empty<Nat, Blob>();
        staged_files := List.empty<Asset>();
        staged_file_chunks := List.empty<AssetChunk>();
        epoch;
    };

    public shared ({ caller }) func add_starter_wasm_chunk(
        epoch : Nat,
        index : Nat,
        content : Blob,
    ) : async () {
        await assertDispenserController(caller);
        let ?upload = starter_upload else {
            throw Error.reject("No starter upload is active");
        };
        if (upload.epoch != epoch) {
            throw Error.reject(
                "Starter upload epoch does not match the active upload"
            );
        };
        let spec = upload.spec;
        if (index >= spec.wasm_chunks) {
            throw Error.reject("Starter Wasm chunk index is out of range");
        };
        if (
            content.size() == 0 or
            content.size() > MAX_STARTER_WASM_CHUNK_BYTES
        ) {
            throw Error.reject("Starter Wasm chunk has an invalid size");
        };
        Map.add(staged_wasm_chunks, Nat.compare, index, content);
    };

    public shared ({ caller }) func add_starter_file(
        epoch : Nat,
        key : Text,
        file : Neutron.File,
    ) : async () {
        await assertDispenserController(caller);
        let ?upload = starter_upload else {
            throw Error.reject("No starter upload is active");
        };
        if (upload.epoch != epoch) {
            throw Error.reject(
                "Starter upload epoch does not match the active upload"
            );
        };
        let spec = upload.spec;
        if (List.size(staged_files) >= spec.files) {
            throw Error.reject("Starter upload contains too many files");
        };
        List.add<Asset>(staged_files, (key, file));
    };

    public shared ({ caller }) func add_starter_file_chunk(
        epoch : Nat,
        key : Text,
        chunkId : Nat,
        content : Blob,
    ) : async () {
        await assertDispenserController(caller);
        let ?upload = starter_upload else {
            throw Error.reject("No starter upload is active");
        };
        if (upload.epoch != epoch) {
            throw Error.reject(
                "Starter upload epoch does not match the active upload"
            );
        };
        let spec = upload.spec;
        if (List.size(staged_file_chunks) >= spec.file_chunks) {
            throw Error.reject("Starter upload contains too many file chunks");
        };
        List.add<AssetChunk>(
            staged_file_chunks,
            (key, chunkId, content),
        );
    };

    public shared ({ caller }) func commit_starter_upload(
        epoch : Nat
    ) : async () {
        await assertDispenserController(caller);
        let ?upload = starter_upload else {
            throw Error.reject("No starter upload is active");
        };
        if (upload.epoch != epoch) {
            throw Error.reject(
                "Starter upload epoch does not match the active upload"
            );
        };
        let spec = upload.spec;
        if (Map.size(staged_wasm_chunks) != spec.wasm_chunks) {
            throw Error.reject("Starter Wasm upload is incomplete");
        };
        if (List.size(staged_files) != spec.files) {
            throw Error.reject("Starter file upload is incomplete");
        };
        if (List.size(staged_file_chunks) != spec.file_chunks) {
            throw Error.reject("Starter file-chunk upload is incomplete");
        };
        for (index in Nat.range(0, spec.wasm_chunks)) {
            switch (Map.get(staged_wasm_chunks, Nat.compare, index)) {
                case null {
                    throw Error.reject("Starter Wasm upload has a missing chunk");
                };
                case (?_) {};
            };
        };
        let chunkArrays = Array.tabulate<[Nat8]>(
            spec.wasm_chunks,
            func(index) {
                let ?chunk = Map.get(
                    staged_wasm_chunks,
                    Nat.compare,
                    index,
                ) else {
                    // The complete range was checked immediately above.
                    return [];
                };
                Blob.toArray(chunk);
            },
        );
        let committedWasm = Blob.fromArray(
            Array.join<Nat8>(chunkArrays.values())
        );
        if (committedWasm.size() != spec.wasm_bytes) {
            throw Error.reject("Starter Wasm byte length does not match");
        };
        if (Sha256.fromBlob(#sha256, committedWasm) != spec.wasm_sha256) {
            throw Error.reject("Starter Wasm SHA-256 does not match");
        };

        // Publish one immutable payload together. Registrations that have
        // reached the paid transfer boundary retain their exact payload even
        // when a controller commits a later starter.
        let revision = next_starter_revision + 1;
        let info = {
            revision;
            deployment_id = spec.deployment_id;
            app_ids = spec.app_ids;
            wasm_bytes = spec.wasm_bytes;
            wasm_sha256 = spec.wasm_sha256;
            files = spec.files;
            file_chunks = spec.file_chunks;
            backend_call_target_principals =
                spec.backend_call_target_principals;
        };
        let committed = {
            info;
            wasm = committedWasm;
            runtime_config_template = spec.runtime_config_template;
            files = List.toArray(staged_files);
            file_chunks = List.toArray(staged_file_chunks);
            initialize_publication_entropy = true;
        };
        next_starter_revision := revision;
        current_starter := ?committed;
        starter_upload := null;
        staged_wasm_chunks := Map.empty<Nat, Blob>();
        staged_files := List.empty<Asset>();
        staged_file_chunks := List.empty<AssetChunk>();
    };

    public shared ({ caller }) func provision(
        activationHash : Blob,
    ) : async Result.Result<Principal, Text> {
        if (Principal.isAnonymous(caller)) {
            return #err("A signing provisioning identity is required");
        };
        if (activationHash.size() != 32) {
            return #err("Activation hash must be exactly 32 bytes");
        };
        if (Set.contains(active, Principal.compare, caller)) {
            return #err("Provisioning is already in progress for this identity");
        };

        Set.add(active, Principal.compare, caller);
        let result = try {
            await advance(caller, activationHash);
        } catch (cause) {
            #err(
                "Provisioning paused and can be resumed safely: " #
                Error.message(cause)
            );
        };
        Set.remove(active, Principal.compare, caller);
        result;
    };

    private func advance(
        caller : Principal,
        activationHash : Blob,
    ) : async Result.Result<Principal, Text> {
        let registration = switch (
            Map.get(regs, Principal.compare, caller)
        ) {
            case null {
                let created = {
                    activation_hash = activationHash;
                    starter_revision = null;
                    starter = null;
                    phase = #awaiting_payment;
                };
                created;
            };
            case (?existing) {
                if (existing.activation_hash != activationHash) {
                    return #err(
                        "This provisioning identity is already bound to a different activation code"
                    );
                };
                existing;
            };
        };

        switch (registration.phase) {
            case (#awaiting_payment) {
                // Capture the current committed payload before any external
                // await. An unpaid caller does not retain it. A paid retry
                // reuses its prior binding instead of observing a replacement.
                let committedStarter = switch (
                    boundStarter(registration)
                ) {
                    case (?bound) bound;
                    case null {
                        let ?candidate = current_starter else {
                            return #err(
                                "No committed Neutron starter is configured"
                            );
                        };
                        candidate;
                    };
                };
                let transitionalSubaccount =
                    ICPL.SubAccount.fromPrincipal(caller);
                let transitionalAccount =
                    ICPL.AccountIdentifier.fromPrincipal(
                        Principal.fromActor(this),
                        ?transitionalSubaccount,
                    );
                let { e8s } = await ledger.account_balance({
                    account = transitionalAccount;
                });
                if (e8s < MINIMUM_DEPOSIT_E8S) {
                    return #err(
                        "Deposit account needs at least 2 ICP before provisioning"
                    );
                };
                let fee = (await ledger.transfer_fee({})).transfer_fee.e8s;
                if (fee >= e8s) {
                    return #err("ICP ledger fee exceeds the deposit balance");
                };
                let transfer = {
                    amount = e8s - fee;
                    fee;
                    created_at_time = Nat64.fromNat(Int.abs(Time.now()));
                };
                let boundRegistration = {
                    registration with
                    starter_revision = ?committedStarter.info.revision;
                    starter = ?committedStarter;
                };
                setPhase(
                    caller,
                    boundRegistration,
                    #transferring(transfer),
                );
                await advance(caller, activationHash);
            };
            case (#transferring(transfer)) {
                let subaccount = ICPL.SubAccount.fromPrincipal(caller);
                let cmcAccount = ICPL.AccountIdentifier.fromPrincipal(
                    Principal.fromText("rkp4c-7iaaa-aaaaa-aaaca-cai"),
                    ?ICPL.SubAccount.fromPrincipal(Principal.fromActor(this)),
                );
                let response = await ledger.transfer({
                    memo = CREATE_CANISTER_MEMO;
                    amount = { e8s = transfer.amount };
                    fee = { e8s = transfer.fee };
                    from_subaccount = ?subaccount;
                    to = cmcAccount;
                    created_at_time = ?{
                        timestamp_nanos = transfer.created_at_time;
                    };
                });
                let blockIndex = switch (response) {
                    case (#Ok(index)) index;
                    case (#Err(#TxDuplicate({ duplicate_of }))) duplicate_of;
                    case (#Err(error)) {
                        switch (error) {
                            case (#BadFee(_)) {
                                setPhase(
                                    caller,
                                    registration,
                                    #awaiting_payment,
                                );
                            };
                            case (#InsufficientFunds(_)) {
                                setPhase(
                                    caller,
                                    registration,
                                    #awaiting_payment,
                                );
                            };
                            case (#TxTooOld(_)) {
                                setPhase(
                                    caller,
                                    registration,
                                    #awaiting_payment,
                                );
                            };
                            case (#TxCreatedInFuture) {};
                            case (#TxDuplicate(_)) {};
                        };
                        return #err(
                            "ICP ledger transfer failed: " # debug_show(error)
                        );
                    };
                };
                setPhase(
                    caller,
                    registration,
                    #notifying_cmc(blockIndex),
                );
                await advance(caller, activationHash);
            };
            case (#notifying_cmc(blockIndex)) {
                switch (await cmc.notify_create_canister({
                    controller = Principal.fromActor(this);
                    block_index = blockIndex;
                    subnet_type = null;
                    subnet_selection = ?#Subnet({ subnet = targetSubnet });
                    settings = null;
                })) {
                    case (#Ok(canisterId)) {
                        setPhase(
                            caller,
                            registration,
                            #created(canisterId),
                        );
                        await advance(caller, activationHash);
                    };
                    case (#Err(#Processing)) {
                        #err(
                            "The CMC is still creating the canister; retry provisioning shortly"
                        );
                    };
                    case (#Err(error)) {
                        #err(
                            "CMC could not create the canister: " #
                            debug_show(error)
                        );
                    };
                };
            };
            case (#created(canisterId)) {
                let ?starter = boundStarter(registration) else {
                    return #err(
                        "Provisioning registration lost its committed starter"
                    );
                };
                if (containsPrincipal(
                    starter.info.backend_call_target_principals,
                    canisterId,
                )) {
                    return #err(
                        "Starter backend-call reservation targets the created Neutron canister"
                    );
                };
                let current = await ic.canister_status({
                    canister_id = canisterId;
                });
                switch (current.module_hash) {
                    case null {
                        await ic.install_code({
                            arg = to_candid();
                            wasm_module = starter.wasm;
                            mode = #install;
                            canister_id = canisterId;
                            sender_canister_version = ?Prim.canisterVersion();
                        });
                    };
                    // A lost install reply is resumed only when the observed
                    // module is the exact Wasm bound to this registration.
                    case (?moduleHash) {
                        if (moduleHash != starter.info.wasm_sha256) {
                            return #err(
                                "Created Neutron has an unexpected Wasm module"
                            );
                        };
                    };
                };
                setPhase(
                    caller,
                    registration,
                    #installed(canisterId),
                );
                await advance(caller, activationHash);
            };
            case (#installed(canisterId)) {
                let ?starter = boundStarter(registration) else {
                    return #err(
                        "Provisioning registration lost its committed starter"
                    );
                };
                switch (await installedModuleError(canisterId, starter)) {
                    case null {};
                    case (?message) return #err(message);
                };
                await updateControllers(
                    canisterId,
                    [Principal.fromActor(this), canisterId],
                );
                setPhase(
                    caller,
                    registration,
                    #controlled(canisterId),
                );
                await advance(caller, activationHash);
            };
            case (#controlled(canisterId)) {
                let ?starter = boundStarter(registration) else {
                    return #err(
                        "Provisioning registration lost its committed starter"
                    );
                };
                switch (await installedModuleError(canisterId, starter)) {
                    case null {};
                    case (?message) return #err(message);
                };
                let neutron =
                    actor (Principal.toText(canisterId)) : Neutron.Class;
                for ((key, value) in starter.files.vals()) {
                    ignore await neutron.kernel_static(#store({
                        key;
                        val = value;
                    }));
                };
                for (
                    (key, chunkId, content) in starter.file_chunks.vals()
                ) {
                    ignore await neutron.kernel_static(#store_chunk({
                        key;
                        chunk_id = chunkId;
                        content = Blob.toArray(content);
                    }));
                };
                ignore await neutron.kernel_static(#store({
                    key = "/system/runtime-config.json";
                    val = {
                        content = Blob.toArray(
                            Text.encodeUtf8(
                                renderRuntimeConfig(
                                    starter.runtime_config_template,
                                    canisterId,
                                )
                            )
                        );
                        content_type = "application/json";
                        content_encoding = "identity";
                        chunks = 1;
                    };
                }));
                ignore await neutron.kernel_static(#store({
                    key = "/pkg/id.json";
                    val = {
                        content = Blob.toArray(
                            Text.encodeUtf8(
                                "{\"id\":\"" #
                                Principal.toText(canisterId) #
                                "\"}"
                            )
                        );
                        content_type = "application/json";
                        content_encoding = "identity";
                        chunks = 1;
                    };
                }));
                if (starter.initialize_publication_entropy) {
                    switch (
                        await neutron.kernel_publication_entropy_initialize(null)
                    ) {
                        case (#ok(_)) {};
                        case (#err(#randomness_failed)) {
                            return #err(
                                "Neutron publication entropy could not be initialized"
                            );
                        };
                    };
                };
                releaseStarterAtAssetsSeeded(
                    caller,
                    registration,
                    canisterId,
                );
                await advance(caller, activationHash);
            };
            case (#assets_seeded(canisterId)) {
                let neutron =
                    actor (Principal.toText(canisterId)) : Neutron.Class;
                switch (
                    await neutron.kernel_activation(
                        #set(registration.activation_hash)
                    )
                ) {
                    case (#ready) {
                        setPhase(
                            caller,
                            registration,
                            #activated(canisterId),
                        );
                        await advance(caller, activationHash);
                    };
                    case (#invalid) {
                        #err("Neutron rejected the activation hash");
                    };
                    case (#already_set) {
                        #err(
                            "Neutron was already armed with another activation code"
                        );
                    };
                    case (#already_activated) {
                        #err("Neutron activation was already consumed");
                    };
                    case (#authorized) {
                        #err("Unexpected activation response");
                    };
                    case (#already_authorized) {
                        #err("Unexpected activation response");
                    };
                };
            };
            case (#activated(canisterId)) {
                // The setter was removed from kernel authorization by #set.
                // This final settings update also removes the shared dispenser
                // as an IC controller, leaving only the Neutron itself.
                //
                // Inspect first because an earlier update_settings may have
                // committed even if its response never reached this callback.
                // Once removed, the dispenser cannot repeat that call, but it
                // can still observe the controller list with canister_info.
                let current = await ic.canister_info({
                    canister_id = canisterId;
                    num_requested_changes = ?0;
                });
                if (not controllersEqual(current.controllers, [canisterId])) {
                    if (not controllersEqual(
                        current.controllers,
                        [Principal.fromActor(this), canisterId],
                    )) {
                        return #err(
                            "Neutron controllers changed before the ownership handoff completed"
                        );
                    };
                    await updateControllers(canisterId, [canisterId]);
                };
                completeRegistration(caller, registration, canisterId);
                #ok(canisterId);
            };
            case (#complete(canisterId)) #ok(canisterId);
        };
    };

    private func setPhase(
        caller : Principal,
        registration : Registration,
        phase : Phase,
    ) : () {
        Map.add(
            regs,
            Principal.compare,
            caller,
            { registration with phase },
        );
    };

    private func completeRegistration(
        caller : Principal,
        registration : Registration,
        canisterId : Principal,
    ) : () {
        Map.add(
            regs,
            Principal.compare,
            caller,
            {
                registration with
                phase = #complete(canisterId);
            },
        );
    };

    private func releaseStarterAtAssetsSeeded(
        caller : Principal,
        registration : Registration,
        canisterId : Principal,
    ) : () {
        Map.add(
            regs,
            Principal.compare,
            caller,
            {
                registration with
                // The remaining activation/controller handoff needs no
                // starter bytes. Keep only its durable revision and allow the
                // immutable payload to be reclaimed after its last seeding.
                starter = null;
                phase = #assets_seeded(canisterId);
            },
        );
    };

    private func boundStarter(
        registration : Registration
    ) : ?CommittedStarter {
        switch (registration.starter, registration.starter_revision) {
            case (?starter, ?revision) {
                if (starter.info.revision == revision) ?starter else null;
            };
            case (_) null;
        };
    };

    private func installedModuleError(
        canisterId : Principal,
        starter : CommittedStarter,
    ) : async ?Text {
        let current = await ic.canister_status({
            canister_id = canisterId;
        });
        switch (current.module_hash) {
            case (?moduleHash) {
                if (moduleHash == starter.info.wasm_sha256) {
                    null;
                } else {
                    ?"Provisioned Neutron has an unexpected Wasm module";
                };
            };
            case null {
                ?"Provisioned Neutron has no installed Wasm module";
            };
        };
    };

    private func renderRuntimeConfig(
        template : RuntimeConfigTemplate,
        canisterId : Principal,
    ) : Text {
        let principal = Principal.toText(canisterId);
        var rendered = "";
        var first = true;
        for (segment in template.segments.vals()) {
            if (first) {
                rendered := segment;
                first := false;
            } else {
                rendered := rendered # principal # segment;
            };
        };
        rendered;
    };

    private func statusFromPhase(phase : Phase) : ProvisioningStatus {
        switch (phase) {
            case (#awaiting_payment) {
                { stage = #awaiting_payment; canister_id = null };
            };
            case (#transferring(_)) {
                { stage = #transferring; canister_id = null };
            };
            case (#notifying_cmc(_)) {
                { stage = #notifying_cmc; canister_id = null };
            };
            case (#created(id)) {
                { stage = #created; canister_id = ?id };
            };
            case (#installed(id)) {
                { stage = #installed; canister_id = ?id };
            };
            case (#controlled(id)) {
                { stage = #controlled; canister_id = ?id };
            };
            case (#assets_seeded(id)) {
                { stage = #assets_seeded; canister_id = ?id };
            };
            case (#activated(id)) {
                { stage = #activated; canister_id = ?id };
            };
            case (#complete(id)) {
                { stage = #complete; canister_id = ?id };
            };
        };
    };

    private func updateControllers(
        canisterId : Principal,
        controllers : [Principal],
    ) : async () {
        await ic.update_settings({
            canister_id = canisterId;
            sender_canister_version = ?Prim.canisterVersion();
            settings = {
                controllers = ?controllers;
                freezing_threshold = null;
                memory_allocation = null;
                compute_allocation = null;
                reserved_cycles_limit = null;
                log_visibility = null;
                snapshot_visibility = null;
                wasm_memory_limit = null;
                wasm_memory_threshold = null;
                environment_variables = null;
            };
        });
    };

    private func controllersEqual(
        left : [Principal],
        right : [Principal],
    ) : Bool {
        if (left.size() != right.size()) return false;
        for (principal in left.vals()) {
            if (not containsPrincipal(right, principal)) return false;
        };
        true;
    };

    private func containsPrincipal(
        principals : [Principal],
        target : Principal,
    ) : Bool {
        for (principal in principals.vals()) {
            if (Principal.equal(principal, target)) return true;
        };
        false;
    };

    private func starterUploadSpecError(
        spec : StarterUploadSpec
    ) : ?Text {
        if (
            spec.deployment_id.size() == 0 or
            spec.deployment_id.size() > 128
        ) {
            return ?"Starter deployment id is invalid";
        };
        if (
            spec.app_ids.size() == 0 or
            spec.app_ids.size() > 256 or
            spec.app_ids[0] != "kernel"
        ) {
            return ?"Starter package id list is invalid";
        };
        if (
            spec.wasm_chunks == 0 or
            spec.wasm_chunks > MAX_STARTER_WASM_CHUNKS or
            spec.wasm_bytes == 0 or
            spec.wasm_bytes > MAX_STARTER_WASM_BYTES or
            spec.wasm_sha256.size() != 32
        ) {
            return ?"Starter Wasm metadata is invalid";
        };
        if (
            spec.files == 0 or
            spec.files > MAX_STARTER_FILES or
            spec.file_chunks > MAX_STARTER_FILE_CHUNKS
        ) {
            return ?"Starter file metadata is invalid";
        };
        if (spec.runtime_config_template.segments.size() == 0) {
            return ?"Runtime configuration template needs at least one segment";
        };
        if (
            spec.backend_call_target_principals.size() >
            MAX_STARTER_BACKEND_CALL_TARGETS
        ) {
            return ?"Starter backend-call target list is too large";
        };
        let seenBackendCallTargets = Set.empty<Principal>();
        for (principal in spec.backend_call_target_principals.vals()) {
            if (
                Principal.isAnonymous(principal) or
                Principal.toText(principal) == "aaaaa-aa" or
                not Set.insert(
                    seenBackendCallTargets,
                    Principal.compare,
                    principal,
                )
            ) {
                return ?"Starter backend-call target list is invalid";
            };
        };
        null;
    };

    private func assertDispenserController(caller : Principal) : async () {
        let selfPrincipal = Principal.fromActor(this);
        // Unlike canister_status, canister_info may be called by any canister.
        // That lets this canister inspect its real controller list without
        // requiring the dispenser itself to be one of its own controllers.
        let current = await ic.canister_info({
            canister_id = selfPrincipal;
            num_requested_changes = ?0;
        });
        if (containsPrincipal(current.controllers, caller)) return;
        throw Error.reject(
            "Only a dispenser controller can change the starter payload"
        );
    };
};
