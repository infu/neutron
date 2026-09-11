import Minter "../../mo/EvmMinter";
import Rpc "../../mo/EvmRpc";

// Thin client wiring only: all parsing, budget checks and error handling use the
// production modules. This actor must never become part of a deployed package.
persistent actor class EvmClientHarness(rpcCanister : Principal) {
    public shared func observe(hash : Text, options : Rpc.Options) : async Rpc.Result<Rpc.Observation> {
        await* Rpc.read(rpcCanister, options, hash)
    };
    public shared func discover() : async Minter.Result<Minter.Route> {
        await* Minter.discover(Minter.client())
    };
    public shared func verifyPayer(route : Minter.Route, payer : Text) : async Minter.Result<Text> {
        await* Minter.verifyPayer(Minter.client(), route, payer)
    };
    public shared func balance(owner : Principal, subaccount : Blob) : async Minter.Result<Nat> {
        await* Minter.invoiceBalance(Minter.client(), owner, subaccount)
    };
};
