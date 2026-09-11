// Proprietary marketplace protocol. All rights reserved.
// Official wire projection and subaccount-helper ABI:
// https://github.com/dfinity/ic/tree/b75c0e59d0d6c1f8cd652f188eaf4f59dd41e83e/rs/ethereum/cketh/minter
import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Error "mo:core/Error";
import Nat8 "mo:core/Nat8";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Ledger "Ledger";

module {
    public type Result<T> = { #ok : T; #err : Text };
    public let ethereumChainId : Nat = 1;
    public let minterCanisterText : Text = "sv3dd-oaaaa-aaaar-qacoa-cai";
    public func minterCanister() : Principal { Principal.fromText(minterCanisterText) };
    public let ckusdcLedgerText : Text = "xevnm-gaaaa-aaaar-qafnq-cai";
    public func ckusdcLedger() : Principal { Principal.fromText(ckusdcLedgerText) };
    public let usdcAddress : Text = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
    public let usdcDecimals : Nat8 = 6;

    // Additional official record fields can evolve without changing this wire
    // projection. The current subaccount helper must be discovered from the
    // canonical minter; legacy helpers cannot address an invoice subaccount.
    public type Token = { erc20_contract_address : Text; ledger_canister_id : Principal };
    public type Info = {
        minter_address : ?Text;
        deposit_with_subaccount_helper_contract_address : ?Text;
        supported_ckerc20_tokens : ?[Token];
    };
    public type Interface = actor {
        get_minter_info : shared query () -> async Info;
        is_address_blocked : shared query Text -> async Bool;
    };
    public type Route = {
        chainId : Nat;
        minter : Principal;
        helper : Text;
        minterAddress : Text;
        token : Text;
        ledger : Principal;
        decimals : Nat8;
    };
    public type Client = {
        getInfo : Principal -> async* Result<Info>;
        isAddressBlocked : (Principal, Text) -> async* Result<Bool>;
        balanceOf : (Principal, Ledger.Account) -> async* Result<Nat>;
    };

    public func normalizeAddress(value : Text) : Result<Text> {
        let lower = Text.toLower(value);
        if (lower.size() != 42 or not Text.startsWith(lower, #text "0x")) {
            return #err("Ethereum addresses must contain 0x followed by 40 hexadecimal characters");
        };
        var index = 0;
        var nonzero = false;
        for (character in lower.chars()) {
            if (index >= 2) {
                if (not ((character >= '0' and character <= '9') or (character >= 'a' and character <= 'f'))) {
                    return #err("Ethereum addresses must contain 0x followed by 40 hexadecimal characters");
                };
                if (character != '0') nonzero := true;
            };
            index += 1;
        };
        if (not nonzero) return #err("The zero Ethereum address cannot receive or fund this deposit");
        #ok(lower);
    };

    public func validateInfo(info : Info) : Result<Route> {
        let ?helperText = info.deposit_with_subaccount_helper_contract_address
            else return #err("The official minter has no deposit helper supporting invoice subaccounts");
        let ?minterText = info.minter_address else return #err("The official minter did not report its Ethereum account");
        let helper = switch (normalizeAddress(helperText)) {
            case (#ok(address)) address;
            case (#err(error)) return #err("Invalid official deposit helper: " # error);
        };
        let minterAddress = switch (normalizeAddress(minterText)) {
            case (#ok(address)) address;
            case (#err(error)) return #err("Invalid official minter Ethereum account: " # error);
        };
        let ?tokens = info.supported_ckerc20_tokens
            else return #err("The official minter did not report supported ERC20 tokens");
        var matches = 0;
        for (entry in tokens.vals()) {
            if (Text.toLower(entry.erc20_contract_address) == usdcAddress) {
                if (entry.ledger_canister_id != ckusdcLedger()) return #err("The official USDC mapping does not target the canonical ckUSDC ledger");
                matches += 1;
            } else if (entry.ledger_canister_id == ckusdcLedger()) {
                return #err("The canonical ckUSDC ledger is mapped to a different Ethereum token");
            };
        };
        if (matches != 1) return #err("The official minter must report one unambiguous USDC to ckUSDC mapping");
        #ok({ chainId = ethereumChainId; minter = minterCanister(); helper; minterAddress;
            token = usdcAddress; ledger = ckusdcLedger(); decimals = usdcDecimals });
    };

    // Solidity bytes32 principal is a length byte, raw IC principal bytes, then
    // zero padding. It is not an account identifier, hash, or UTF-8 principal.
    public func principalWord(principal : Principal) : Blob {
        let bytes = Principal.toBlob(principal).toArray();
        Blob.fromArray(Array.tabulate<Nat8>(32, func(index) {
            if (index == 0) Nat8.fromNat(bytes.size())
            else if (index <= bytes.size()) bytes[index - 1]
            else 0;
        }));
    };

    public func discover(calls : Client) : async* Result<Route> {
        switch (await* calls.getInfo(minterCanister())) {
            case (#ok(info)) validateInfo(info);
            case (#err(error)) #err("Cannot read the official USDC deposit route: " # error);
        };
    };

    // The helper permits any payer to name a separate IC recipient. Do not
    // restrict sources to EOAs, the buyer's Neutron, or its EVM Wallet. The
    // minter's own blocklist is checked because it rejects those deposits even
    // when the helper transaction succeeded on Ethereum.
    public func verifyPayer(calls : Client, route : Route, payer : Text) : async* Result<Text> {
        if (route.minter != minterCanister()) return #err("Use the official Ethereum ckUSDC minter");
        let normalized = switch (normalizeAddress(payer)) {
            case (#ok(address)) address;
            case (#err(error)) return #err(error);
        };
        switch (await* calls.isAddressBlocked(minterCanister(), normalized)) {
            case (#ok(false)) #ok(normalized);
            case (#ok(true)) #err("The official ckUSDC minter does not accept deposits from this Ethereum address");
            case (#err(error)) #err("Cannot check whether the official minter accepts this Ethereum payer: " # error);
        };
    };

    // This proves an invoice's current ckUSDC funding, not Ethereum transaction
    // provenance. Final accounting still requires the saved ICRC-1 sweep result.
    public func invoiceBalance(calls : Client, owner : Principal, subaccount : Blob) : async* Result<Nat> {
        if (subaccount.size() != 32) return #err("An invoice subaccount must contain exactly 32 bytes");
        await* calls.balanceOf(ckusdcLedger(), { owner; subaccount = ?subaccount });
    };

    public func getInfo(minter : Principal) : async* Result<Info> {
        let target : Interface = actor (Principal.toText(minter));
        try { #ok(await target.get_minter_info()) }
        catch error { #err(Error.message(error)) };
    };
    public func isAddressBlocked(minter : Principal, address : Text) : async* Result<Bool> {
        let target : Interface = actor (Principal.toText(minter));
        try { #ok(await target.is_address_blocked(address)) }
        catch error { #err(Error.message(error)) };
    };
    public func balanceOf(ledger : Principal, account : Ledger.Account) : async* Result<Nat> {
        let target : Ledger.Interface = actor (Principal.toText(ledger));
        try { #ok(await target.icrc1_balance_of(account)) }
        catch error { #err(Error.message(error)) };
    };
    public func client() : Client { { getInfo; isAddressBlocked; balanceOf } };
}
