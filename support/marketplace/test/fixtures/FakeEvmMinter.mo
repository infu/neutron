import Array "mo:core/Array";
import Error "mo:core/Error";
import Text "mo:core/Text";
import Minter "../../mo/EvmMinter";

// PocketIC only. No Ethereum mutations or minting are implemented. The default
// addresses are test values; only the USDC/ckUSDC mapping is canonical.
persistent actor class FakeEvmMinter() {
    var info : Minter.Info = {
        minter_address = ?"0x1111111111111111111111111111111111111111";
        deposit_with_subaccount_helper_contract_address = ?"0x2d39863d30758f2c6c6cd3fb26b1d0e825eb16fa";
        supported_ckerc20_tokens = ?[{ erc20_contract_address = Minter.usdcAddress; ledger_canister_id = Minter.ckusdcLedger() }];
    };
    var blockedAddresses : [Text] = [];
    var infoError : ?Text = null;
    var blockedError : ?Text = null;

    public shared func setInfo(value : Minter.Info) : async () { info := value };
    public shared func setBlocked(values : [Text]) : async () { blockedAddresses := Array.map<Text, Text>(values, Text.toLower) };
    public shared func setErrors(value : { info : ?Text; blocked : ?Text }) : async () {
        infoError := value.info;
        blockedError := value.blocked;
    };
    public shared query func get_minter_info() : async Minter.Info {
        switch (infoError) { case (?message) throw Error.reject(message); case null info }
    };
    public shared query func is_address_blocked(address : Text) : async Bool {
        switch (blockedError) { case (?message) throw Error.reject(message); case null {} };
        Array.find<Text>(blockedAddresses, func(value) { value == Text.toLower(address) }) != null
    };
};
