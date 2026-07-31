import Blob "mo:core/Blob";
import Principal "mo:core/Principal";
import Set "mo:core/Set";
import SHA256 "mo:sha2/Sha256";
import Memory "../../backend/memory/activation/v1";
import Service "../../backend/activation/Service";

let installer = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");
let owner = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");
let other = Principal.fromText("rkp4c-7iaaa-aaaaa-aaaca-cai");
let token = Blob.fromArray([
    0, 1, 2, 3, 4, 5, 6, 7,
    8, 9, 10, 11, 12, 13, 14, 15,
    16, 17, 18, 19, 20, 21, 22, 23,
    24, 25, 26, 27, 28, 29, 30, 31,
]);
let hash = SHA256.fromBlob(#sha256, token);
let authorized = Set.empty<Principal>();
Set.add(authorized, Principal.compare, installer);
let memory = Memory.init();
let service = Service.Service(memory, authorized);

assert (service.set(hash, installer) == #ready);
assert (not Set.contains(authorized, Principal.compare, installer));
assert (service.set(hash, installer) == #ready);
assert (
    service.set(
        Blob.fromArray([
            1, 1, 2, 3, 4, 5, 6, 7,
            8, 9, 10, 11, 12, 13, 14, 15,
            16, 17, 18, 19, 20, 21, 22, 23,
            24, 25, 26, 27, 28, 29, 30, 31,
        ]),
        installer,
    ) == #already_set
);
assert (service.set(hash, other) == #already_set);
assert (
    service.use(
        Blob.fromArray([
            1, 1, 2, 3, 4, 5, 6, 7,
            8, 9, 10, 11, 12, 13, 14, 15,
            16, 17, 18, 19, 20, 21, 22, 23,
            24, 25, 26, 27, 28, 29, 30, 31,
        ]),
        owner,
    ) == #invalid
);
assert (service.use(token, owner) == #authorized);
assert (Set.contains(authorized, Principal.compare, owner));
assert (memory.hash == null);
assert (memory.setter == null);
assert (memory.consumed);
assert (service.use(token, owner) == #already_authorized);
assert (service.use(token, other) == #already_activated);
assert (service.set(hash, installer) == #already_activated);
assert (service.use(token, Principal.fromText("2vxsx-fae")) == #invalid);
