//@name=aaa
module {
    public type canister_id = Principal;
    public type wasm_module = [Nat8];

    public type log_visibility = {
        #controllers;
        #public_;
        #allowed_viewers : [Principal];
    };

    public type snapshot_visibility = {
        #controllers;
        #public_;
        #allowed_viewers : [Principal];
    };

    public type environment_variable = {
        name : Text;
        value : Text;
    };

    public type canister_settings = {
        controllers : ?[Principal];
        compute_allocation : ?Nat;
        memory_allocation : ?Nat;
        freezing_threshold : ?Nat;
        reserved_cycles_limit : ?Nat;
        log_visibility : ?log_visibility;
        snapshot_visibility : ?snapshot_visibility;
        wasm_memory_limit : ?Nat;
        wasm_memory_threshold : ?Nat;
        environment_variables : ?[environment_variable];
    };

    public type definite_canister_settings = {
        controllers : [Principal];
        compute_allocation : Nat;
        memory_allocation : Nat;
        freezing_threshold : Nat;
        reserved_cycles_limit : Nat;
        log_visibility : log_visibility;
        snapshot_visibility : snapshot_visibility;
        wasm_memory_limit : Nat;
        wasm_memory_threshold : Nat;
        environment_variables : [environment_variable];
    };

    public type create_canister_args = {
        settings : ?canister_settings;
        sender_canister_version : ?Nat64;
    };

    public type create_canister_result = {
        canister_id : canister_id;
    };

    public type update_settings_args = {
        canister_id : canister_id;
        settings : canister_settings;
        sender_canister_version : ?Nat64;
    };

    public type canister_install_mode = {
        #install;
        #reinstall;
        #upgrade : ?{
            skip_pre_upgrade : ?Bool;
            wasm_memory_persistence : ?{ #keep; #replace };
        };
    };

    public type install_code_args = {
        mode : canister_install_mode;
        canister_id : canister_id;
        wasm_module : wasm_module;
        arg : [Nat8];
        sender_canister_version : ?Nat64;
    };

    public type upload_chunk_args = {
        canister_id : canister_id;
        chunk : Blob;
    };

    public type chunk_hash = {
        hash : Blob;
    };

    public type install_chunked_code_args = {
        mode : canister_install_mode;
        target_canister : canister_id;
        store_canister : ?canister_id;
        chunk_hashes_list : [chunk_hash];
        wasm_module_hash : Blob;
        arg : [Nat8];
        sender_canister_version : ?Nat64;
    };

    public type clear_chunk_store_args = {
        canister_id : canister_id;
    };

    public type uninstall_code_args = {
        canister_id : canister_id;
        sender_canister_version : ?Nat64;
    };

    public type canister_status_args = {
        canister_id : canister_id;
    };

    public type memory_metrics = {
        wasm_memory_size : Nat;
        stable_memory_size : Nat;
        global_memory_size : Nat;
        wasm_binary_size : Nat;
        custom_sections_size : Nat;
        canister_history_size : Nat;
        wasm_chunk_store_size : Nat;
        snapshots_size : Nat;
    };

    public type query_stats = {
        num_calls_total : Nat;
        num_instructions_total : Nat;
        request_payload_bytes_total : Nat;
        response_payload_bytes_total : Nat;
    };

    // Focused current-IC subset used by access management and the trusted
    // resource overview. Additional status fields are ignored by Candid.
    public type canister_status_result = {
        // Current replicas return canister_version. Older local replicas used
        // version. Keeping both optional preserves structural decoding across
        // those versions while still allowing controller mutations to reject a
        // stale status snapshot.
        canister_version : ?Nat64;
        version : ?Nat64;
        settings : {
            controllers : [Principal];
            wasm_memory_limit : Nat;
        };
        memory_metrics : memory_metrics;
    };

    public type canister_id_args = {
        canister_id : canister_id;
    };

    public type provisional_create_canister_with_cycles_args = {
        amount : ?Nat;
        settings : ?canister_settings;
        specified_id : ?canister_id;
        sender_canister_version : ?Nat64;
    };

    public type provisional_create_canister_with_cycles_result = {
        canister_id : canister_id;
    };

    public type provisional_top_up_canister_args = {
        canister_id : canister_id;
        amount : Nat;
    };

    public type http_header = {
        name : Text;
        value : Text;
    };

    public type http_request_result = {
        status : Nat;
        headers : [http_header];
        body : Blob;
    };

    public type http_transform_args = {
        response : http_request_result;
        context : Blob;
    };

    public type http_transform = {
        function : shared query http_transform_args -> async http_request_result;
        context : Blob;
    };

    public type http_method = {
        #get;
        #head;
        #post;
        #put;
        #delete;
        #patch;
    };

    public type http_request_args = {
        url : Text;
        max_response_bytes : ?Nat64;
        method : http_method;
        headers : [http_header];
        body : ?Blob;
        transform : ?http_transform;
        is_replicated : ?Bool;
    };

    public type vetkd_curve = { #bls12_381_g2 };

    public type vetkd_key_id = {
        curve : vetkd_curve;
        name : Text;
    };

    public type vetkd_public_key_args = {
        canister_id : ?canister_id;
        context : Blob;
        key_id : vetkd_key_id;
    };

    public type vetkd_public_key_result = { public_key : Blob };

    public type vetkd_derive_key_args = {
        input : Blob;
        context : Blob;
        transport_public_key : Blob;
        key_id : vetkd_key_id;
    };

    public type vetkd_derive_key_result = { encrypted_key : Blob };

    public type ecdsa_curve = { #secp256k1 };

    public type ecdsa_key_id = {
        curve : ecdsa_curve;
        name : Text;
    };

    public type ecdsa_public_key_args = {
        canister_id : ?canister_id;
        derivation_path : [Blob];
        key_id : ecdsa_key_id;
    };

    public type ecdsa_public_key_result = {
        public_key : Blob;
        chain_code : Blob;
    };

    public type sign_with_ecdsa_args = {
        message_hash : Blob;
        derivation_path : [Blob];
        key_id : ecdsa_key_id;
    };

    public type sign_with_ecdsa_result = { signature : Blob };

    public type schnorr_algorithm = {
        #bip340secp256k1;
        #ed25519;
    };

    public type schnorr_key_id = {
        algorithm : schnorr_algorithm;
        name : Text;
    };

    public type schnorr_public_key_args = {
        canister_id : ?canister_id;
        derivation_path : [Blob];
        key_id : schnorr_key_id;
    };

    public type schnorr_public_key_result = {
        public_key : Blob;
        chain_code : Blob;
    };

    public type schnorr_aux = {
        #bip341 : { merkle_root_hash : Blob };
    };

    public type sign_with_schnorr_args = {
        message : Blob;
        derivation_path : [Blob];
        key_id : schnorr_key_id;
        aux : ?schnorr_aux;
    };

    public type sign_with_schnorr_result = { signature : Blob };

    // Focused binding used by Neutron. Add management methods here instead of
    // declaring another actor type at a call site.
    public type Interface = actor {
        canister_status : shared canister_status_args -> async canister_status_result;
        create_canister : shared create_canister_args -> async create_canister_result;
        delete_canister : shared canister_id_args -> async ();
        deposit_cycles : shared canister_id_args -> async ();
        ecdsa_public_key : shared ecdsa_public_key_args -> async ecdsa_public_key_result;
        http_request : shared http_request_args -> async http_request_result;
        // Neutron dispatches self-upgrades one-way. An awaited management call
        // would itself leave a callback that Motoko refuses to stabilize.
        install_code : shared install_code_args -> ();
        install_chunked_code : shared install_chunked_code_args -> ();
        upload_chunk : shared upload_chunk_args -> async chunk_hash;
        clear_chunk_store : shared clear_chunk_store_args -> async ();
        provisional_create_canister_with_cycles : shared provisional_create_canister_with_cycles_args -> async provisional_create_canister_with_cycles_result;
        provisional_top_up_canister : shared provisional_top_up_canister_args -> async ();
        raw_rand : shared () -> async Blob;
        schnorr_public_key : shared schnorr_public_key_args -> async schnorr_public_key_result;
        sign_with_ecdsa : shared sign_with_ecdsa_args -> async sign_with_ecdsa_result;
        sign_with_schnorr : shared sign_with_schnorr_args -> async sign_with_schnorr_result;
        start_canister : shared canister_id_args -> async ();
        stop_canister : shared canister_id_args -> async ();
        uninstall_code : shared uninstall_code_args -> async ();
        update_settings : shared update_settings_args -> async ();
        vetkd_public_key : shared vetkd_public_key_args -> async vetkd_public_key_result;
        vetkd_derive_key : shared vetkd_derive_key_args -> async vetkd_derive_key_result;
    };

    public let management : Interface = actor "aaaaa-aa";
};
