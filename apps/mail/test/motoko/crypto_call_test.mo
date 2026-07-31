import Crypto "../../backend/crypto/Service";
import Memory "../../backend/memory/mail/v1";
import F "CryptoFixture";

let capability : Crypto.VetKeysPublic = {
    canister_principal = F.canister(1);
    slot = func(_id : Text) : ?Crypto.SlotSummary {
        ?F.summary(7, null, #enabled, F.holder());
    };
    public_key = func(
        request : { slot : Text; generation : Nat64 },
    ) : async* Crypto.PublicKeyResult {
        #ok(F.material(request.generation, true));
    };
};
let service = Crypto.Service(Memory.init(), capability);
switch (service.status()) {
    case (#err(#not_configured)) {};
    case (_) assert false;
};
