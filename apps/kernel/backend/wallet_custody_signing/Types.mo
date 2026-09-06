import Caps "mo:neutron-capabilities";
import CapabilityTypes "../capabilities/Types";
import SigningTypes "../chain_key_signing/Types";

module {
    public type SlotDeclaration = {
        id : Text;
        algorithm : Caps.WalletCustodyAlgorithmV1;
        purpose : Text;
    };
    public type Declaration = { slots : [SlotDeclaration] };
    public type AppDeclaration = {
        app_scope : CapabilityTypes.AppScope;
        wallet_custody_signing : ?Declaration;
    };
    public type Capability = Caps.WalletCustodySigningV1;
    public type Memory = SigningTypes.Memory;
}
