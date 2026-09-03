import Nat "mo:core/Nat";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";
import Catalog "../Catalog";
import Capabilities "../capabilities/Types";
import Icrc "../icrc1/Client";

module {
    let MAX_NAT64 : Nat = 18_446_744_073_709_551_615;
    let ALLOWANCE_LIFETIME_NS : Nat64 = 600_000_000_000;

    public type Result<T> = {
        #ok : T;
        #err : Text;
    };

    public type BurnReceipt = {
        ledger : Principal;
        block_index : Nat;
        amount : Nat;
    };

    public type Receipt = {
        asset_burn : BurnReceipt;
        gas_burn : ?BurnReceipt;
    };

    public type ValidateDestination = () -> Result<()>;

    type UtxoWithdrawalArgs = {
        address : Text;
        amount : Nat64;
        from_subaccount : ?Blob;
    };

    type UtxoWithdrawalError = {
        #MalformedAddress : Text;
        #AlreadyProcessing;
        #AmountTooLow : Nat64;
        #InsufficientFunds : { balance : Nat64 };
        #InsufficientAllowance : { allowance : Nat64 };
        #TemporarilyUnavailable : Text;
        #GenericError : { error_message : Text; error_code : Nat64 };
    };

    type UtxoWithdrawalResult = {
        #Ok : { block_index : Nat64 };
        #Err : UtxoWithdrawalError;
    };

    type EthWithdrawalArgs = {
        recipient : Text;
        amount : Nat;
        from_subaccount : ?Blob;
    };

    type EthWithdrawalError = {
        #AmountTooLow : { min_withdrawal_amount : Nat };
        #InsufficientFunds : { balance : Nat };
        #InsufficientAllowance : { allowance : Nat };
        #RecipientAddressBlocked : { address : Text };
        #TemporarilyUnavailable : Text;
    };

    type EthWithdrawalResult = {
        #Ok : { block_index : Nat };
        #Err : EthWithdrawalError;
    };

    type SolWithdrawalArgs = {
        from_subaccount : ?Blob;
        amount : Nat64;
        address : Text;
    };

    type SolWithdrawalError = {
        #AlreadyProcessing;
        #ValueTooSmall : {
            minimum_withdrawal_amount : Nat64;
            withdrawal_amount : Nat64;
        };
        #MalformedAddress : Text;
        #InsufficientFunds : { balance : Nat64 };
        #InsufficientAllowance : { allowance : Nat64 };
        #TemporarilyUnavailable : Text;
    };

    type SolWithdrawalResult = {
        #Ok : { block_index : Nat64 };
        #Err : SolWithdrawalError;
    };

    type Eip1559TransactionPriceArg = {
        ckerc20_ledger_id : Principal;
    };

    type Eip1559TransactionPrice = {
        gas_limit : Nat;
        max_fee_per_gas : Nat;
        max_priority_fee_per_gas : Nat;
        max_transaction_fee : Nat;
        timestamp : ?Nat64;
    };

    type Erc20WithdrawalArgs = {
        amount : Nat;
        ckerc20_ledger_id : Principal;
        recipient : Text;
        from_cketh_subaccount : ?Blob;
        from_ckerc20_subaccount : ?Blob;
    };

    type CkErc20Token = {
        ckerc20_token_symbol : Text;
        erc20_contract_address : Text;
        ledger_canister_id : Principal;
    };

    type LedgerError = {
        #InsufficientFunds : {
            balance : Nat;
            failed_burn_amount : Nat;
            token_symbol : Text;
            ledger_id : Principal;
        };
        #InsufficientAllowance : {
            allowance : Nat;
            failed_burn_amount : Nat;
            token_symbol : Text;
            ledger_id : Principal;
        };
        #AmountTooLow : {
            minimum_burn_amount : Nat;
            failed_burn_amount : Nat;
            token_symbol : Text;
            ledger_id : Principal;
        };
        #TemporarilyUnavailable : Text;
    };

    type Erc20WithdrawalError = {
        #TokenNotSupported : { supported_tokens : [CkErc20Token] };
        #RecipientAddressBlocked : { address : Text };
        #CkEthLedgerError : { error : LedgerError };
        #CkErc20LedgerError : { cketh_block_index : Nat; error : LedgerError };
        #TemporarilyUnavailable : Text;
    };

    type Erc20WithdrawalResult = {
        #Ok : { cketh_block_index : Nat; ckerc20_block_index : Nat };
        #Err : Erc20WithdrawalError;
    };

    public func withdraw(
        route : Catalog.NativeRoute,
        ledger : Principal,
        address : Text,
        amount : Nat,
        ledgerFee : Nat,
        createdAt : Nat64,
        calls : Capabilities.BackendCalls,
        validateDestination : ValidateDestination,
    ) : async* Result<Receipt> {
        let minter = routeMinter(route);
        let expiresAt = createdAt + ALLOWANCE_LIFETIME_NS;
        switch (route) {
            case (#ckbtc(_)) {
                let ?amount64 = toNat64(amount) else {
                    return #err("ckBTC withdrawal amount is too large");
                };
                switch (await* approve(
                    ledger,
                    minter,
                    amount + ledgerFee,
                    ledgerFee,
                    createdAt,
                    expiresAt,
                    calls,
                )) {
                    case (#err(error)) return #err(error);
                    case (#ok(_)) {};
                };
                switch (validateDestination()) {
                    case (#err(error)) return #err(error);
                    case (#ok(())) {};
                };
                await* withdrawUtxo(
                    ledger,
                    minter,
                    "retrieve_btc_with_approval",
                    "ckBTC",
                    address,
                    amount64,
                    calls,
                );
            };
            case (#ckdoge(_)) {
                let ?amount64 = toNat64(amount) else {
                    return #err("ckDOGE withdrawal amount is too large");
                };
                switch (await* approve(
                    ledger,
                    minter,
                    amount + ledgerFee,
                    ledgerFee,
                    createdAt,
                    expiresAt,
                    calls,
                )) {
                    case (#err(error)) return #err(error);
                    case (#ok(_)) {};
                };
                switch (validateDestination()) {
                    case (#err(error)) return #err(error);
                    case (#ok(())) {};
                };
                await* withdrawUtxo(
                    ledger,
                    minter,
                    "retrieve_doge_with_approval",
                    "ckDOGE",
                    address,
                    amount64,
                    calls,
                );
            };
            case (#cketh(_)) {
                switch (await* approve(
                    ledger,
                    minter,
                    amount + ledgerFee,
                    ledgerFee,
                    createdAt,
                    expiresAt,
                    calls,
                )) {
                    case (#err(error)) return #err(error);
                    case (#ok(_)) {};
                };
                switch (validateDestination()) {
                    case (#err(error)) return #err(error);
                    case (#ok(())) {};
                };
                await* withdrawEth(ledger, minter, address, amount, calls);
            };
            case (#ckerc20(value)) {
                await* withdrawErc20(
                    ledger,
                    Principal.fromText(value.cketh_ledger),
                    minter,
                    address,
                    amount,
                    ledgerFee,
                    createdAt,
                    expiresAt,
                    calls,
                    validateDestination,
                );
            };
            case (#cksol(_)) {
                let ?amount64 = toNat64(amount) else {
                    return #err("ckSOL withdrawal amount is too large");
                };
                switch (await* approve(
                    ledger,
                    minter,
                    amount + ledgerFee,
                    ledgerFee,
                    createdAt,
                    expiresAt,
                    calls,
                )) {
                    case (#err(error)) return #err(error);
                    case (#ok(_)) {};
                };
                switch (validateDestination()) {
                    case (#err(error)) return #err(error);
                    case (#ok(())) {};
                };
                await* withdrawSol(ledger, minter, address, amount64, calls);
            };
        };
    };

    func withdrawErc20(
        ledger : Principal,
        ckethLedger : Principal,
        minter : Principal,
        address : Text,
        amount : Nat,
        ledgerFee : Nat,
        createdAt : Nat64,
        expiresAt : Nat64,
        calls : Capabilities.BackendCalls,
        validateDestination : ValidateDestination,
    ) : async* Result<Receipt> {
        let priceArgs : ?Eip1559TransactionPriceArg = ?{
            ckerc20_ledger_id = ledger;
        };
        let priceResult = await* calls.call({
            canister = minter;
            method = "eip_1559_transaction_price";
            args = to_candid (priceArgs);
            cycles = 0;
        });
        let gasAmount = switch (decodePrice(priceResult)) {
            case (#err(error)) return #err(error);
            case (#ok(price)) price.max_transaction_fee;
        };
        switch (validateDestination()) {
            case (#err(error)) return #err(error);
            case (#ok(())) {};
        };

        let ckethFee = switch (Icrc.decodeFee(await* calls.call(
            Icrc.feeRequest(ckethLedger),
        ))) {
            case (#err(error)) {
                return #err("Could not read the current ckETH fee: " # error);
            };
            case (#ok(fee)) fee;
        };
        switch (validateDestination()) {
            case (#err(error)) return #err(error);
            case (#ok(())) {};
        };

        switch (await* approve(
            ledger,
            minter,
            amount + ledgerFee,
            ledgerFee,
            createdAt,
            expiresAt,
            calls,
        )) {
            case (#err(error)) return #err(error);
            case (#ok(_)) {};
        };
        switch (validateDestination()) {
            case (#err(error)) return #err(error);
            case (#ok(())) {};
        };

        switch (await* approve(
            ckethLedger,
            minter,
            gasAmount + ckethFee,
            ckethFee,
            createdAt,
            expiresAt,
            calls,
        )) {
            case (#err(error)) return #err("Could not approve ckETH gas: " # error);
            case (#ok(_)) {};
        };
        switch (validateDestination()) {
            case (#err(error)) return #err(error);
            case (#ok(())) {};
        };

        let args : Erc20WithdrawalArgs = {
            amount;
            ckerc20_ledger_id = ledger;
            recipient = address;
            from_cketh_subaccount = null;
            from_ckerc20_subaccount = null;
        };
        switch (await* calls.call({
            canister = minter;
            method = "withdraw_erc20";
            args = to_candid (args);
            cycles = 0;
        })) {
            case (#err(error)) #err(callErrorText(error));
            case (#ok(reply)) decodeErc20(
                reply,
                ledger,
                amount,
                ckethLedger,
                gasAmount,
            );
        };
    };

    func approve(
        ledger : Principal,
        spender : Principal,
        amount : Nat,
        fee : Nat,
        createdAt : Nat64,
        expiresAt : Nat64,
        calls : Capabilities.BackendCalls,
    ) : async* Result<Nat> {
        let args = {
            from_subaccount = null;
            spender = { owner = spender; subaccount = null };
            amount;
            expected_allowance = null;
            expires_at = ?expiresAt;
            fee = ?fee;
            memo = null;
            created_at_time = ?createdAt;
        };
        switch (await* Icrc.executeApprove(calls, ledger, args)) {
            case (#ok(receipt)) #ok(receipt.block_index);
            case (#rejected(error)) #err(error);
            case (#unknown(error)) #err(
                "Could not determine whether the minter approval completed: " # error,
            );
        };
    };

    func withdrawUtxo(
        ledger : Principal,
        minter : Principal,
        method : Text,
        symbol : Text,
        address : Text,
        amount : Nat64,
        calls : Capabilities.BackendCalls,
    ) : async* Result<Receipt> {
        let args : UtxoWithdrawalArgs = {
            address;
            amount;
            from_subaccount = null;
        };
        switch (await* calls.call({
            canister = minter;
            method;
            args = to_candid (args);
            cycles = 0;
        })) {
            case (#err(error)) #err(callErrorText(error));
            case (#ok(reply)) {
                let decoded : ?UtxoWithdrawalResult = from_candid reply;
                switch (decoded) {
                    case (?#Ok(value)) {
                        #ok({
                            asset_burn = {
                                ledger;
                                block_index = Nat64.toNat(value.block_index);
                                amount = Nat64.toNat(amount);
                            };
                            gas_burn = null;
                        });
                    };
                    case (?#Err(error)) #err(utxoErrorText(symbol, error));
                    case null #err(symbol # " minter returned an unexpected withdrawal result");
                };
            };
        };
    };

    func withdrawEth(
        ledger : Principal,
        minter : Principal,
        address : Text,
        amount : Nat,
        calls : Capabilities.BackendCalls,
    ) : async* Result<Receipt> {
        let args : EthWithdrawalArgs = {
            recipient = address;
            amount;
            from_subaccount = null;
        };
        switch (await* calls.call({
            canister = minter;
            method = "withdraw_eth";
            args = to_candid (args);
            cycles = 0;
        })) {
            case (#err(error)) #err(callErrorText(error));
            case (#ok(reply)) {
                let decoded : ?EthWithdrawalResult = from_candid reply;
                switch (decoded) {
                    case (?#Ok(value)) {
                        #ok({
                            asset_burn = { ledger; block_index = value.block_index; amount };
                            gas_burn = null;
                        });
                    };
                    case (?#Err(error)) #err(ethErrorText(error));
                    case null #err("ckETH minter returned an unexpected withdrawal result");
                };
            };
        };
    };

    func withdrawSol(
        ledger : Principal,
        minter : Principal,
        address : Text,
        amount : Nat64,
        calls : Capabilities.BackendCalls,
    ) : async* Result<Receipt> {
        let args : SolWithdrawalArgs = {
            from_subaccount = null;
            amount;
            address;
        };
        switch (await* calls.call({
            canister = minter;
            method = "withdraw";
            args = to_candid (args);
            cycles = 0;
        })) {
            case (#err(error)) #err(callErrorText(error));
            case (#ok(reply)) {
                let decoded : ?SolWithdrawalResult = from_candid reply;
                switch (decoded) {
                    case (?#Ok(value)) {
                        #ok({
                            asset_burn = {
                                ledger;
                                block_index = Nat64.toNat(value.block_index);
                                amount = Nat64.toNat(amount);
                            };
                            gas_burn = null;
                        });
                    };
                    case (?#Err(error)) #err(solErrorText(error));
                    case null #err("ckSOL minter returned an unexpected withdrawal result");
                };
            };
        };
    };

    func decodePrice(result : Capabilities.CallResult) : Result<Eip1559TransactionPrice> {
        switch (result) {
            case (#err(error)) #err(callErrorText(error));
            case (#ok(reply)) {
                let decoded : ?Eip1559TransactionPrice = from_candid reply;
                switch (decoded) {
                    case (?price) #ok(price);
                    case null #err("ckETH minter returned an unexpected gas price");
                };
            };
        };
    };

    func decodeErc20(
        reply : Blob,
        assetLedger : Principal,
        assetAmount : Nat,
        gasLedger : Principal,
        gasAmount : Nat,
    ) : Result<Receipt> {
        let decoded : ?Erc20WithdrawalResult = from_candid reply;
        switch (decoded) {
            case (?#Ok(value)) {
                #ok({
                    asset_burn = {
                        ledger = assetLedger;
                        block_index = value.ckerc20_block_index;
                        amount = assetAmount;
                    };
                    gas_burn = ?{
                        ledger = gasLedger;
                        block_index = value.cketh_block_index;
                        amount = gasAmount;
                    };
                });
            };
            case (?#Err(error)) #err(erc20ErrorText(error));
            case null #err("ckETH minter returned an unexpected ERC-20 withdrawal result");
        };
    };

    func utxoErrorText(symbol : Text, error : UtxoWithdrawalError) : Text {
        switch (error) {
            case (#MalformedAddress(message)) "Invalid native address: " # message;
            case (#AlreadyProcessing) symbol # " minter is already processing a withdrawal";
            case (#AmountTooLow(minimum)) {
                "Amount is below the minimum withdrawal " # Nat64.toText(minimum);
            };
            case (#InsufficientFunds(value)) {
                "Insufficient funds; current balance is " # Nat64.toText(value.balance);
            };
            case (#InsufficientAllowance(value)) {
                "Minter allowance is too low: " # Nat64.toText(value.allowance);
            };
            case (#TemporarilyUnavailable(message)) message;
            case (#GenericError(value)) {
                "Minter error " # Nat64.toText(value.error_code) # ": " # value.error_message;
            };
        };
    };

    func ethErrorText(error : EthWithdrawalError) : Text {
        switch (error) {
            case (#AmountTooLow(value)) {
                "Amount is below the minimum withdrawal " #
                Nat.toText(value.min_withdrawal_amount);
            };
            case (#InsufficientFunds(value)) {
                "Insufficient ckETH; current balance is " # Nat.toText(value.balance);
            };
            case (#InsufficientAllowance(value)) {
                "ckETH minter allowance is too low: " # Nat.toText(value.allowance);
            };
            case (#RecipientAddressBlocked(_)) "The Ethereum destination is blocked";
            case (#TemporarilyUnavailable(message)) message;
        };
    };

    func solErrorText(error : SolWithdrawalError) : Text {
        switch (error) {
            case (#AlreadyProcessing) "ckSOL minter is already processing a withdrawal";
            case (#ValueTooSmall(value)) {
                "Amount is below the minimum withdrawal " #
                Nat64.toText(value.minimum_withdrawal_amount);
            };
            case (#MalformedAddress(_)) "Invalid Solana destination";
            case (#InsufficientFunds(value)) {
                "Insufficient ckSOL; current balance is " # Nat64.toText(value.balance);
            };
            case (#InsufficientAllowance(value)) {
                "ckSOL minter allowance is too low: " # Nat64.toText(value.allowance);
            };
            case (#TemporarilyUnavailable(message)) message;
        };
    };

    func erc20ErrorText(error : Erc20WithdrawalError) : Text {
        switch (error) {
            case (#TokenNotSupported(_)) "Token is not supported by the ckETH minter";
            case (#RecipientAddressBlocked(_)) "The Ethereum destination is blocked";
            case (#CkEthLedgerError(value)) {
                "ckETH gas payment failed: " # ledgerErrorText(value.error);
            };
            case (#CkErc20LedgerError(value)) {
                "Token withdrawal failed: " # ledgerErrorText(value.error);
            };
            case (#TemporarilyUnavailable(message)) message;
        };
    };

    func ledgerErrorText(error : LedgerError) : Text {
        switch (error) {
            case (#InsufficientFunds(value)) {
                "insufficient " # value.token_symbol # " balance " # Nat.toText(value.balance);
            };
            case (#InsufficientAllowance(value)) {
                value.token_symbol # " allowance is too low: " # Nat.toText(value.allowance);
            };
            case (#AmountTooLow(value)) {
                value.token_symbol # " burn is below " # Nat.toText(value.minimum_burn_amount);
            };
            case (#TemporarilyUnavailable(message)) message;
        };
    };

    func routeMinter(route : Catalog.NativeRoute) : Principal {
        let text = switch (route) {
            case (#ckbtc(value)) value.minter;
            case (#cketh(value)) value.minter;
            case (#ckerc20(value)) value.minter;
            case (#ckdoge(value)) value.minter;
            case (#cksol(value)) value.minter;
        };
        Principal.fromText(text);
    };

    func toNat64(value : Nat) : ?Nat64 {
        if (value > MAX_NAT64) null else ?Nat64.fromNat(value);
    };

    func callErrorText(error : Capabilities.CallError) : Text {
        error.code # ": " # error.message;
    };
};
