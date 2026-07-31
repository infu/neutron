import List "mo:core/List";
import Nat "mo:core/Nat";
import Nat32 "mo:core/Nat32";
import Nat64 "mo:core/Nat64";
import Nat8 "mo:core/Nat8";
import Principal "mo:core/Principal";
import Catalog "../Catalog";
import Capabilities "../capabilities/Types";

module {
    let MAX_REFRESH_ENTRIES = 64;
    let HEX_DIGITS = [
        "0", "1", "2", "3", "4", "5", "6", "7",
        "8", "9", "a", "b", "c", "d", "e", "f",
    ];

    public type Result<T> = {
        #ok : T;
        #err : Text;
    };

    public type RequiredCall = {
        principal : Principal;
        method : Text;
    };

    public type PendingDeposit = {
        txid : Text;
        vout : Nat;
        value : Nat;
        confirmations : Nat;
        required_confirmations : Nat;
    };

    public type ProcessingDeposit = {
        txid : Text;
        vout : Nat;
        value : Nat;
    };

    public type MintedDeposit = {
        txid : Text;
        vout : Nat;
        value : Nat;
        minted_amount : Nat;
        block_index : Nat;
    };

    public type DepositIssueKind = {
        #value_too_small;
        #tainted;
        #quarantined;
    };

    public type DepositIssue = {
        txid : Text;
        vout : Nat;
        value : Nat;
        kind : DepositIssueKind;
        earliest_retry : ?Nat;
    };

    public type UtxoRefreshProgress = {
        pending_complete : Bool;
        current_confirmations : ?Nat;
        required_confirmations : ?Nat;
        pending : [PendingDeposit];
        processing : [ProcessingDeposit];
        minted : [MintedDeposit];
        issues : [DepositIssue];
    };

    type AccountArgs = {
        owner : ?Principal;
        subaccount : ?Blob;
    };

    type SolanaUpdateBalanceArgs = {
        subaccount : ?Blob;
    };

    type Utxo = {
        outpoint : { txid : Blob; vout : Nat32 };
        value : Nat64;
        height : Nat32;
    };

    type PendingUtxo = {
        outpoint : { txid : Blob; vout : Nat32 };
        value : Nat64;
        confirmations : Nat32;
    };

    type SuspendedUtxo = {
        utxo : Utxo;
        reason : { #ValueTooSmall; #Quarantined };
        earliest_retry : Nat64;
    };

    type UtxoStatus = {
        #ValueTooSmall : Utxo;
        #Tainted : Utxo;
        #Checked : Utxo;
        #Minted : {
            block_index : Nat64;
            minted_amount : Nat64;
            utxo : Utxo;
        };
    };

    type UtxoUpdateError = {
        #NoNewUtxos : {
            current_confirmations : ?Nat32;
            required_confirmations : Nat32;
            pending_utxos : ?[PendingUtxo];
            suspended_utxos : ?[SuspendedUtxo];
        };
        #AlreadyProcessing;
        #TemporarilyUnavailable : Text;
        #GenericError : { error_message : Text; error_code : Nat64 };
    };

    type UtxoUpdateResult = {
        #Ok : [UtxoStatus];
        #Err : UtxoUpdateError;
    };

    type SolanaUpdateResult = {
        #Ok;
        #Err : { #QueueFull };
    };

    public func requiredCalls(route : Catalog.NativeRoute) : [RequiredCall] {
        let minter = routeMinter(route);
        switch (route) {
            case (#ckbtc(_)) [
                { principal = minter; method = "get_btc_address" },
                { principal = minter; method = "update_balance" },
                { principal = minter; method = "retrieve_btc_with_approval" },
            ];
            case (#ckdoge(_)) [
                { principal = minter; method = "get_doge_address" },
                { principal = minter; method = "update_balance" },
                { principal = minter; method = "retrieve_doge_with_approval" },
            ];
            case (#cksol(_)) [
                { principal = minter; method = "update_balance" },
                { principal = minter; method = "withdraw" },
            ];
            // The ckETH minter discovers helper-contract deposits on its own.
            case (#cketh(_)) [
                { principal = minter; method = "withdraw_eth" },
            ];
            case (#ckerc20(value)) [
                { principal = minter; method = "eip_1559_transaction_price" },
                { principal = minter; method = "withdraw_erc20" },
                {
                    principal = Principal.fromText(value.cketh_ledger);
                    method = "icrc1_fee";
                },
                {
                    principal = Principal.fromText(value.cketh_ledger);
                    method = "icrc2_approve";
                },
            ];
        };
    };

    public func addressRequest(
        route : Catalog.NativeRoute,
        owner : Principal,
    ) : ?Capabilities.CallRequest {
        let method = switch (route) {
            case (#ckbtc(_)) "get_btc_address";
            case (#ckdoge(_)) "get_doge_address";
            case (_) return null;
        };
        let args : AccountArgs = {
            owner = ?owner;
            subaccount = null;
        };
        ?{
            canister = routeMinter(route);
            method;
            args = to_candid (args);
            cycles = 0;
        };
    };

    public func refreshRequest(
        route : Catalog.NativeRoute,
        owner : Principal,
    ) : ?Capabilities.CallRequest {
        let args = switch (route) {
            case (#ckbtc(_)) {
                let value : AccountArgs = {
                    owner = ?owner;
                    subaccount = null;
                };
                to_candid (value);
            };
            case (#ckdoge(_)) {
                let value : AccountArgs = {
                    owner = ?owner;
                    subaccount = null;
                };
                to_candid (value);
            };
            case (#cksol(_)) {
                let value : SolanaUpdateBalanceArgs = { subaccount = null };
                to_candid (value);
            };
            case (#cketh(_)) return null;
            case (#ckerc20(_)) return null;
        };
        ?{
            canister = routeMinter(route);
            method = "update_balance";
            args;
            cycles = 0;
        };
    };

    public func decodeAddress(result : Capabilities.CallResult) : Result<Text> {
        switch (result) {
            case (#err(error)) #err(callErrorText(error));
            case (#ok(reply)) {
                let decoded : ?Text = from_candid reply;
                switch (decoded) {
                    case (?address) {
                        if (address.size() == 0 or address.size() > 256) {
                            #err("Minter returned an invalid deposit address");
                        } else #ok(address);
                    };
                    case null #err("Minter returned an unexpected deposit address");
                };
            };
        };
    };

    public func decodeRefresh(
        route : Catalog.NativeRoute,
        result : Capabilities.CallResult,
    ) : Result<?UtxoRefreshProgress> {
        switch (result) {
            case (#err(error)) #err(callErrorText(error));
            case (#ok(reply)) {
                switch (route) {
                    case (#ckbtc(_)) decodeUtxoRefresh(reply);
                    case (#ckdoge(_)) decodeUtxoRefresh(reply);
                    case (#cksol(_)) decodeSolanaRefresh(reply);
                    case (#cketh(_)) #err("ckETH deposits are minter-scraped");
                    case (#ckerc20(_)) #err("ckERC20 deposits are minter-scraped");
                };
            };
        };
    };

    public func routeMinter(route : Catalog.NativeRoute) : Principal {
        let text = switch (route) {
            case (#ckbtc(value)) value.minter;
            case (#cketh(value)) value.minter;
            case (#ckerc20(value)) value.minter;
            case (#ckdoge(value)) value.minter;
            case (#cksol(value)) value.minter;
        };
        Principal.fromText(text);
    };

    func callErrorText(error : Capabilities.CallError) : Text {
        error.code # ": " # error.message;
    };

    func decodeUtxoRefresh(reply : Blob) : Result<?UtxoRefreshProgress> {
        let decoded : ?UtxoUpdateResult = from_candid reply;
        switch (decoded) {
            case null #err("Minter returned an unexpected update result");
            case (?#Ok(statuses)) {
                let processing = List.empty<ProcessingDeposit>();
                let minted = List.empty<MintedDeposit>();
                let issues = List.empty<DepositIssue>();
                var count = 0;
                for (status in statuses.vals()) {
                    if (count < MAX_REFRESH_ENTRIES) {
                        switch (status) {
                            case (#Checked(utxo)) {
                                List.add(processing, processingDeposit(utxo));
                            };
                            case (#Minted(value)) {
                                List.add(minted, {
                                    txid = txidText(value.utxo.outpoint.txid);
                                    vout = Nat32.toNat(value.utxo.outpoint.vout);
                                    value = Nat64.toNat(value.utxo.value);
                                    minted_amount = Nat64.toNat(value.minted_amount);
                                    block_index = Nat64.toNat(value.block_index);
                                });
                            };
                            case (#ValueTooSmall(utxo)) {
                                List.add(issues, depositIssue(utxo, #value_too_small, null));
                            };
                            case (#Tainted(utxo)) {
                                List.add(issues, depositIssue(utxo, #tainted, null));
                            };
                        };
                        count += 1;
                    };
                };
                #ok(?{
                    pending_complete = false;
                    current_confirmations = null;
                    required_confirmations = null;
                    pending = [];
                    processing = List.toArray(processing);
                    minted = List.toArray(minted);
                    issues = List.toArray(issues);
                });
            };
            // NoNewUtxos is also how the minter reports independently pending UTXOs.
            case (?#Err(#NoNewUtxos(info))) {
                let pending = List.empty<PendingDeposit>();
                let issues = List.empty<DepositIssue>();
                switch (info.pending_utxos) {
                    case null {};
                    case (?utxos) {
                        var count = 0;
                        for (utxo in utxos.vals()) {
                            if (count < MAX_REFRESH_ENTRIES) {
                                List.add(pending, {
                                    txid = txidText(utxo.outpoint.txid);
                                    vout = Nat32.toNat(utxo.outpoint.vout);
                                    value = Nat64.toNat(utxo.value);
                                    confirmations = Nat32.toNat(utxo.confirmations);
                                    required_confirmations = Nat32.toNat(info.required_confirmations);
                                });
                                count += 1;
                            };
                        };
                    };
                };
                switch (info.suspended_utxos) {
                    case null {};
                    case (?utxos) {
                        var count = 0;
                        for (suspended in utxos.vals()) {
                            if (count < MAX_REFRESH_ENTRIES) {
                                let kind = switch (suspended.reason) {
                                    case (#ValueTooSmall) #value_too_small;
                                    case (#Quarantined) #quarantined;
                                };
                                List.add(issues, depositIssue(
                                    suspended.utxo,
                                    kind,
                                    ?Nat64.toNat(suspended.earliest_retry),
                                ));
                                count += 1;
                            };
                        };
                    };
                };
                #ok(?{
                    pending_complete = true;
                    current_confirmations = switch (info.current_confirmations) {
                        case null null;
                        case (?value) ?Nat32.toNat(value);
                    };
                    required_confirmations = ?Nat32.toNat(info.required_confirmations);
                    pending = List.toArray(pending);
                    processing = [];
                    minted = [];
                    issues = List.toArray(issues);
                });
            };
            case (?#Err(#AlreadyProcessing)) #err("Minter is already checking this address");
            case (?#Err(#TemporarilyUnavailable(message))) #err(message);
            case (?#Err(#GenericError(error))) {
                #err("Minter error " # Nat64.toText(error.error_code) # ": " # error.error_message);
            };
        };
    };

    func decodeSolanaRefresh(reply : Blob) : Result<?UtxoRefreshProgress> {
        let decoded : ?SolanaUpdateResult = from_candid reply;
        switch (decoded) {
            case (?#Ok) #ok(null);
            case (?#Err(#QueueFull)) #err("ckSOL deposit monitoring is full");
            case null #err("ckSOL minter returned an unexpected update result");
        };
    };

    func processingDeposit(utxo : Utxo) : ProcessingDeposit {
        {
            txid = txidText(utxo.outpoint.txid);
            vout = Nat32.toNat(utxo.outpoint.vout);
            value = Nat64.toNat(utxo.value);
        };
    };

    func depositIssue(
        utxo : Utxo,
        kind : DepositIssueKind,
        earliestRetry : ?Nat,
    ) : DepositIssue {
        {
            txid = txidText(utxo.outpoint.txid);
            vout = Nat32.toNat(utxo.outpoint.vout);
            value = Nat64.toNat(utxo.value);
            kind;
            earliest_retry = earliestRetry;
        };
    };

    func txidText(value : Blob) : Text {
        var result = "";
        var count = 0;
        for (byte in value.values()) {
            if (count < 32) {
                let number = Nat8.toNat(byte);
                result := result # HEX_DIGITS[number / 16] # HEX_DIGITS[number % 16];
                count += 1;
            };
        };
        if (value.size() == 32) result else "invalid-" # Nat.toText(value.size()) # "-" # result;
    };
};
