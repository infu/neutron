// The Taggr account key, kept in this app's own stable memory.
//
// Taggr identifies users by caller principal, so the Ed25519 key that signs the
// calls *is* the account. The resident background still holds that key while it
// runs and still makes every network call — nothing here talks to Taggr — but
// the durable copy lives in the Neutron rather than in one browser origin.
// Clearing site data used to destroy the account outright, because Taggr's own
// principal-change flow needs the old key to authorise a move.
//
// These methods are owner-authorized and listed in
// `capabilities.preapproved_self_calls`, so this app's own tile and background
// reach them without a per-call dialog and no other app can call them at all.
import Blob "mo:core/Blob";
import Text "mo:core/Text";
import Time "mo:core/Time";
import Memory "./memory/identity/v1";

module {
    /** Raw Ed25519 seed length. The public key and principal derive from it. */
    let SECRET_KEY_BYTES = 32;
    let MAX_CANISTER_CHARS = 64;
    let MAX_DOMAIN_CHARS = 64;

    public type StoredStateV1 = {
        secret_key : ?Blob;
        canister_id : ?Text;
        domain : ?Text;
        created_at : Int;
        updated_at : Int;
        revision : Nat;
    };

    public type WriteIdentityRequestV1 = {
        secret_key : Blob;
    };

    // A null `domain` follows whatever the deployment registered as canonical,
    // which is what an unconfigured installation does.
    public type WriteSettingsRequestV1 = {
        canister_id : Text;
        domain : ?Text;
    };

    public type WriteResultV1 = {
        #ok : StoredStateV1;
        #err : Text;
    };

    public type AppBackendEnvironment = {
        stable_memory : {
            identity : Memory.Mem;
        };
    };

    public class Init(env : AppBackendEnvironment) {
        let mem = env.stable_memory.identity;

        func snapshot() : StoredStateV1 {
            {
                secret_key = mem.secret_key;
                canister_id = mem.canister_id;
                domain = mem.domain;
                created_at = mem.created_at;
                updated_at = mem.updated_at;
                revision = mem.revision;
            };
        };

        func touch() {
            let now = Time.now();
            if (mem.created_at == 0) { mem.created_at := now };
            mem.updated_at := now;
            mem.revision += 1;
        };

        /// The whole restorable state in one query, so a cold background needs
        /// one round trip before it can sign anything.
        public func /*query*/ taggr_state_read(()) : StoredStateV1 {
            snapshot();
        };

        /// Concurrent cold browsers must adopt the same account. The first
        /// initialization stores its seed; later callers receive that seed.
        /// Explicit owner replacement still uses taggr_identity_write.
        public func /*update*/ taggr_identity_initialize(
            request : WriteIdentityRequestV1,
        ) : WriteResultV1 {
            if (Blob.size(request.secret_key) != SECRET_KEY_BYTES) {
                return #err("A Taggr key is " # debug_show (SECRET_KEY_BYTES) # " bytes");
            };
            if (mem.secret_key == null) {
                mem.secret_key := ?request.secret_key;
                touch();
            };
            #ok(snapshot());
        };

        /// Replaces the stored key. The caller is this app's own background,
        /// which has just generated or imported it.
        public func /*update*/ taggr_identity_write(
            request : WriteIdentityRequestV1,
        ) : WriteResultV1 {
            if (Blob.size(request.secret_key) != SECRET_KEY_BYTES) {
                return #err("A Taggr key is " # debug_show (SECRET_KEY_BYTES) # " bytes");
            };
            mem.secret_key := ?request.secret_key;
            touch();
            #ok(snapshot());
        };

        /// Forgets the key. The Taggr account it belonged to becomes
        /// unreachable from this installation, so the tile confirms first.
        public func /*update*/ taggr_identity_clear(()) : StoredStateV1 {
            mem.secret_key := null;
            touch();
            snapshot();
        };

        public func /*update*/ taggr_settings_write(
            request : WriteSettingsRequestV1,
        ) : WriteResultV1 {
            let canisterId = Text.trim(request.canister_id, #char ' ');
            if (canisterId.size() == 0 or canisterId.size() > MAX_CANISTER_CHARS) {
                return #err("That is not a canister id");
            };
            switch (request.domain) {
                case (?domain) {
                    if (domain.size() == 0 or domain.size() > MAX_DOMAIN_CHARS) {
                        return #err("A pinned feed domain must be 1 to " # debug_show (MAX_DOMAIN_CHARS) # " characters");
                    };
                };
                case null {};
            };
            mem.canister_id := ?canisterId;
            mem.domain := request.domain;
            touch();
            #ok(snapshot());
        };
    };

    /*---NEUTRON GENERATED BEGIN---*/

public type taggr_state_read_Input = (());
public type taggr_state_read_Output = StoredStateV1;

public type taggr_identity_initialize_Input = (request : WriteIdentityRequestV1,);
public type taggr_identity_initialize_Output = WriteResultV1;

public type taggr_identity_write_Input = (request : WriteIdentityRequestV1,);
public type taggr_identity_write_Output = WriteResultV1;

public type taggr_identity_clear_Input = (());
public type taggr_identity_clear_Output = StoredStateV1;

public type taggr_settings_write_Input = (request : WriteSettingsRequestV1,);
public type taggr_settings_write_Output = WriteResultV1;

/*---NEUTRON GENERATED END---*/
}
