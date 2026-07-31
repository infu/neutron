import Blob "mo:core/Blob";
import Nat8 "mo:core/Nat8";
import Principal "mo:core/Principal";
import Set "mo:core/Set";
import SHA256 "mo:sha2/Sha256";
import Memory "../memory/activation/v1";

module {
    let TOKEN_BYTES : Nat = 32;

    public type Request = {
        #set : Blob;
        #use : Blob;
    };

    public type Result = {
        #ready;
        #authorized;
        #already_authorized;
        #already_set;
        #already_activated;
        #invalid;
    };

    public class Service(
        mem : Memory.Mem,
        authorized : Set.Set<Principal>,
    ) {
        public func set(hash : Blob, caller : Principal) : Result {
            if (hash.size() != TOKEN_BYTES or Principal.isAnonymous(caller)) {
                return #invalid;
            };
            if (mem.consumed) return #already_activated;

            switch (mem.hash, mem.setter) {
                case (null, null) {
                    mem.hash := ?hash;
                    mem.setter := ?caller;
                    // The compiler grants the installer initial kernel
                    // authorization. Arming ownership retires that bootstrap
                    // authority in the same message that stores the hash.
                    Set.remove(authorized, Principal.compare, caller);
                    #ready;
                };
                case (?currentHash, ?setter) {
                    if (
                        Principal.equal(setter, caller) and
                        constantTimeEqual(currentHash, hash)
                    ) {
                        #ready;
                    } else {
                        #already_set;
                    };
                };
                case (_) #already_set;
            };
        };

        public func use(token : Blob, caller : Principal) : Result {
            if (token.size() != TOKEN_BYTES or Principal.isAnonymous(caller)) {
                return #invalid;
            };
            if (mem.consumed) {
                if (Set.contains(authorized, Principal.compare, caller)) {
                    return #already_authorized;
                };
                return #already_activated;
            };

            let ?expected = mem.hash else return #invalid;
            let supplied = SHA256.fromBlob(#sha256, token);
            if (not constantTimeEqual(expected, supplied)) return #invalid;

            let alreadyAuthorized = Set.contains(
                authorized,
                Principal.compare,
                caller,
            );

            // There is deliberately no await in this transition. A trap rolls
            // back the authorization addition and activation deletion
            // together, so the bearer token cannot be consumed halfway.
            if (not alreadyAuthorized) {
                Set.add(authorized, Principal.compare, caller);
            };
            mem.hash := null;
            mem.setter := null;
            mem.consumed := true;
            if (alreadyAuthorized) #already_authorized else #authorized;
        };
    };

    public func constantTimeEqual(left : Blob, right : Blob) : Bool {
        if (left.size() != right.size()) return false;
        let a = Blob.toArray(left);
        let b = Blob.toArray(right);
        var difference : Nat8 = 0;
        var index = 0;
        while (index < a.size()) {
            difference := Nat8.bitor(
                difference,
                Nat8.bitxor(a[index], b[index]),
            );
            index += 1;
        };
        difference == 0;
    };
};
