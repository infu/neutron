// TEST ONLY. Install the same Wasm at the ckUSDC ledger, ckETH ledger, and
// ckETH minter IDs in an isolated PocketIC instance. These scripted replies
// exercise the published Wallet actor; they do not prove external settlement.
import Array "mo:core/Array";
import Error "mo:core/Error";
import Nat "mo:core/Nat";
import Nat8 "mo:core/Nat8";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";

persistent actor Fixture {
    public type Account = { owner : Principal; subaccount : ?Blob };
    public type Value = { #Nat : Nat; #Int : Int; #Text : Text; #Blob : Blob };
    public type TransferArg = {
        from_subaccount : ?Blob; to : Account; amount : Nat; fee : ?Nat;
        memo : ?Blob; created_at_time : ?Nat64;
    };
    public type TransferError = {
        #BadFee : { expected_fee : Nat };
        #BadBurn : { min_burn_amount : Nat };
        #InsufficientFunds : { balance : Nat };
        #TooOld; #CreatedInFuture : { ledger_time : Nat64 };
        #TemporarilyUnavailable; #Duplicate : { duplicate_of : Nat };
        #GenericError : { error_code : Nat; message : Text };
    };
    public type ApproveArg = {
        from_subaccount : ?Blob; spender : Account; amount : Nat;
        expected_allowance : ?Nat; expires_at : ?Nat64; fee : ?Nat;
        memo : ?Blob; created_at_time : ?Nat64;
    };
    public type ApproveError = {
        #BadFee : { expected_fee : Nat };
        #InsufficientFunds : { balance : Nat };
        #AllowanceChanged : { current_allowance : Nat };
        #Expired : { ledger_time : Nat64 }; #TooOld;
        #CreatedInFuture : { ledger_time : Nat64 };
        #Duplicate : { duplicate_of : Nat }; #TemporarilyUnavailable;
        #GenericError : { error_code : Nat; message : Text };
    };
    public type EventSource = { transaction_hash : Text; log_index : Nat };
    public type Deposit = {
        transaction_hash : Text; block_number : Nat; log_index : Nat;
        from_address : Text; value : Nat; principal : Principal; subaccount : ?Blob;
    };
    public type Erc20Deposit = Deposit and { erc20_contract_address : Text };
    // The real minter has a non-optional, extensible payload variant. Returning
    // an optional here would fail to exercise Wallet's forward-compatible opt
    // projection when an unknown future variant appears alongside known ones.
    public type Payload = {
        #AcceptedDeposit : Deposit;
        #AcceptedErc20Deposit : Erc20Deposit;
        #MintedCkEth : { event_source : EventSource; mint_block_index : Nat };
        #MintedCkErc20 : {
            event_source : EventSource; erc20_contract_address : Text; mint_block_index : Nat;
        };
        #InvalidDeposit : { event_source : EventSource; reason : Text };
        #QuarantinedDeposit : { event_source : EventSource };
        #FutureUnknown : Text;
    };
    public type MinterEvent = { timestamp : Nat64; payload : Payload };
    public type Config = {
        symbol : Text; decimals : Nat8; fee : Nat; balance : Nat;
        lose_transfer_reply : Bool; lose_withdrawal_reply : Bool;
        native_status : { #pending; #submitted; #confirmed };
        events : [MinterEvent];
    };
    public type EthWithdrawalArg = {
        recipient : Text; amount : Nat; from_subaccount : ?Blob;
    };
    public type EthWithdrawalError = {
        #AmountTooLow : { min_withdrawal_amount : Nat };
        #InsufficientFunds : { balance : Nat };
        #InsufficientAllowance : { allowance : Nat };
        #RecipientAddressBlocked : { address : Text };
        #TemporarilyUnavailable : Text;
    };
    public type Erc20WithdrawalArg = {
        amount : Nat; ckerc20_ledger_id : Principal; recipient : Text;
        from_cketh_subaccount : ?Blob; from_ckerc20_subaccount : ?Blob;
    };
    public type LedgerError = {
        #InsufficientFunds : {
            balance : Nat; failed_burn_amount : Nat; token_symbol : Text; ledger_id : Principal;
        };
        #InsufficientAllowance : {
            allowance : Nat; failed_burn_amount : Nat; token_symbol : Text; ledger_id : Principal;
        };
        #AmountTooLow : {
            minimum_burn_amount : Nat; failed_burn_amount : Nat; token_symbol : Text; ledger_id : Principal;
        };
        #TemporarilyUnavailable : Text;
    };
    public type Erc20WithdrawalError = {
        #TokenNotSupported : { supported_tokens : [{
            ckerc20_token_symbol : Text; erc20_contract_address : Text; ledger_canister_id : Principal;
        }] };
        #RecipientAddressBlocked : { address : Text };
        #CkEthLedgerError : { error : LedgerError };
        #CkErc20LedgerError : { cketh_block_index : Nat; error : LedgerError };
        #TemporarilyUnavailable : Text;
    };
    public type WithdrawalStatus = {
        #NotFound; #Pending; #TxCreated;
        #TxSent : { transaction_hash : Text };
        #TxFinalized : {
            #Success : { transaction_hash : Text; effective_transaction_fee : ?Nat };
            #PendingReimbursement : { transaction_hash : Text };
            #Reimbursed : {
                transaction_hash : Text; reimbursed_amount : Nat; reimbursed_in_block : Nat;
            };
        };
    };
    public type BlockValue = {
        #Blob : Blob; #Text : Text; #Nat : Nat; #Int : Int;
        #Array : [BlockValue]; #Map : [(Text, BlockValue)];
    };
    public type BlockArg = { start : Nat; length : Nat };
    type Applied = { caller : Principal; args : Blob; block : Nat };
    type Approval = { account : Account; spender : Account; amount : Nat; expires_at : ?Nat64 };

    var config : Config = {
        symbol = "ckUSDC"; decimals = 6; fee = 10; balance = 1_000_000_000_000_000_000_000;
        lose_transfer_reply = false; lose_withdrawal_reply = false;
        native_status = #pending; events = [];
    };
    var transferArgs : [Blob] = [];
    var approveArgs : [Blob] = [];
    var withdrawalArgs : [Blob] = [];
    var withdrawalMethods : [Text] = [];
    var transfers : [Applied] = [];
    var approvals : [Applied] = [];
    var allowances : [Approval] = [];
    var withdrawalBlocks : [Nat] = [];

    public func fixture_configure(value : Config) : async () {
        // Updating a reply script must not erase evidence of prior effects.
        config := value;
    };

    public query func fixture_probe() : async {
        transfer_args : [Blob]; approve_args : [Blob]; withdrawal_args : [Blob];
        withdrawal_methods : [Text]; withdrawal_blocks : [Nat];
        transfer_calls : Nat; transfer_effects : Nat;
        approve_calls : Nat; approve_effects : Nat;
        withdrawal_calls : Nat; withdrawal_effects : Nat;
    } {
        {
            transfer_args = transferArgs; approve_args = approveArgs; withdrawal_args = withdrawalArgs;
            withdrawal_methods = withdrawalMethods; withdrawal_blocks = withdrawalBlocks;
            transfer_calls = transferArgs.size(); transfer_effects = transfers.size();
            approve_calls = approveArgs.size(); approve_effects = approvals.size();
            withdrawal_calls = withdrawalArgs.size(); withdrawal_effects = withdrawalBlocks.size();
        };
    };

    public shared ({ caller }) func fixture_checkpoint() : async () {
        assert caller == Principal.fromActor(Fixture);
    };

    public query func icrc1_fee() : async Nat { config.fee };
    public query func icrc1_decimals() : async Nat8 { config.decimals };
    public query func icrc1_symbol() : async Text { config.symbol };
    public query func icrc1_name() : async Text { "Scripted " # config.symbol };
    public query func icrc1_metadata() : async [(Text, Value)] {
        [
            ("icrc1:symbol", #Text(config.symbol)),
            ("icrc1:name", #Text("Scripted " # config.symbol)),
            ("icrc1:decimals", #Nat(Nat8.toNat(config.decimals))),
            ("icrc1:fee", #Nat(config.fee)),
        ];
    };
    public query func icrc1_balance_of(_account : Account) : async Nat { config.balance };

    public query func icrc2_allowance(args : { account : Account; spender : Account }) : async {
        allowance : Nat; expires_at : ?Nat64;
    } {
        var result = { allowance = 0 : Nat; expires_at = null : ?Nat64 };
        for (approval in allowances.vals()) {
            if (approval.account == args.account and approval.spender == args.spender) {
                result := { allowance = approval.amount; expires_at = approval.expires_at };
            };
        };
        result;
    };

    public shared ({ caller }) func icrc1_transfer(args : TransferArg) : async { #Ok : Nat; #Err : TransferError } {
        let bytes = to_candid (args);
        transferArgs := Array.concat(transferArgs, [bytes]);
        for (applied in transfers.vals()) {
            if (applied.caller == caller and applied.args == bytes) {
                return #Err(#Duplicate({ duplicate_of = applied.block }));
            };
        };
        let block = 10_000 + transfers.size();
        transfers := Array.concat(transfers, [{ caller; args = bytes; block }]);
        if (config.lose_transfer_reply) {
            config := { config with lose_transfer_reply = false };
            // An await commits all preceding state. Rejecting afterward loses
            // the reply while preserving the effect and exact retry evidence.
            await Fixture.fixture_checkpoint();
            throw Error.reject("Scripted transfer committed; reply lost");
        };
        #Ok(block);
    };

    public shared ({ caller }) func icrc2_approve(args : ApproveArg) : async { #Ok : Nat; #Err : ApproveError } {
        let bytes = to_candid (args);
        approveArgs := Array.concat(approveArgs, [bytes]);
        for (applied in approvals.vals()) {
            if (applied.caller == caller and applied.args == bytes) {
                return #Err(#Duplicate({ duplicate_of = applied.block }));
            };
        };
        let block = 30_000 + approvals.size();
        approvals := Array.concat(approvals, [{ caller; args = bytes; block }]);
        allowances := Array.concat(allowances, [{
            account = { owner = caller; subaccount = args.from_subaccount };
            spender = args.spender; amount = args.amount; expires_at = args.expires_at;
        }]);
        #Ok(block);
    };

    public query func get_minter_info() : async {
        minter_address : ?Text; smart_contract_address : ?Text;
        eth_helper_contract_address : ?Text; erc20_helper_contract_address : ?Text;
        deposit_with_subaccount_helper_contract_address : ?Text;
        supported_ckerc20_tokens : ?[{
            erc20_contract_address : Text; ledger_canister_id : Principal;
        }];
        cketh_ledger_id : ?Principal;
    } {
        {
            minter_address = ?"0x1111111111111111111111111111111111111111";
            smart_contract_address = null; eth_helper_contract_address = null;
            erc20_helper_contract_address = null;
            deposit_with_subaccount_helper_contract_address = ?"0x2222222222222222222222222222222222222222";
            supported_ckerc20_tokens = ?[{
                erc20_contract_address = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
                ledger_canister_id = Principal.fromText("xevnm-gaaaa-aaaar-qafnq-cai");
            }];
            cketh_ledger_id = ?Principal.fromText("ss2fx-dyaaa-aaaar-qacoq-cai");
        };
    };

    public query func get_events(args : { start : Nat64; length : Nat64 }) : async {
        events : [MinterEvent]; total_event_count : Nat64;
    } {
        let offset = if (args.start >= 50) Nat64.toNat(args.start - 50) else 0;
        let count = if (offset >= config.events.size()) 0 else Nat.min(Nat64.toNat(args.length), config.events.size() - offset);
        {
            events = Array.tabulate<MinterEvent>(count, func(index) { config.events[offset + index] });
            total_event_count = Nat64.fromNat(50 + config.events.size());
        };
    };

    public func withdraw_eth(args : EthWithdrawalArg) : async {
        #Ok : { block_index : Nat }; #Err : EthWithdrawalError;
    } {
        let block = recordWithdrawal("withdraw_eth", to_candid (args));
        await* maybeLoseWithdrawalReply();
        #Ok({ block_index = block });
    };

    public func withdraw_erc20(args : Erc20WithdrawalArg) : async {
        #Ok : { cketh_block_index : Nat; ckerc20_block_index : Nat }; #Err : Erc20WithdrawalError;
    } {
        let block = recordWithdrawal("withdraw_erc20", to_candid (args));
        await* maybeLoseWithdrawalReply();
        #Ok({ cketh_block_index = block; ckerc20_block_index = block + 100_000 });
    };

    func recordWithdrawal(method : Text, bytes : Blob) : Nat {
        withdrawalArgs := Array.concat(withdrawalArgs, [bytes]);
        withdrawalMethods := Array.concat(withdrawalMethods, [method]);
        let block = 20_000 + withdrawalBlocks.size();
        // Native minter calls do not carry an idempotency token. Every replay
        // is another effect; Wallet must leave a lost reply unresolved.
        withdrawalBlocks := Array.concat(withdrawalBlocks, [block]);
        block;
    };

    func maybeLoseWithdrawalReply() : async* () {
        if (config.lose_withdrawal_reply) {
            config := { config with lose_withdrawal_reply = false };
            await Fixture.fixture_checkpoint();
            throw Error.reject("Scripted withdrawal committed; reply lost");
        };
    };

    public query func eip_1559_transaction_price(_args : ?{ ckerc20_ledger_id : Principal }) : async {
        gas_limit : Nat; max_fee_per_gas : Nat; max_priority_fee_per_gas : Nat;
        max_transaction_fee : Nat; timestamp : ?Nat64;
    } {
        { gas_limit = 65_000; max_fee_per_gas = 2_000_000_000;
          max_priority_fee_per_gas = 1_000_000_000;
          max_transaction_fee = 130_000_000_000_000; timestamp = null };
    };

    public func retrieve_eth_status(block : Nat64) : async WithdrawalStatus {
        var found = false;
        for (recorded in withdrawalBlocks.vals()) if (recorded == Nat64.toNat(block)) found := true;
        if (not found) return #NotFound;
        let transaction_hash = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        switch (config.native_status) {
            case (#pending) #Pending;
            case (#submitted) #TxSent({ transaction_hash });
            case (#confirmed) #TxFinalized(#Success({ transaction_hash; effective_transaction_fee = ?42 }));
        };
    };

    public query func icrc3_get_blocks(_args : [BlockArg]) : async {
        log_length : Nat; blocks : [{ id : Nat; block : BlockValue }];
        archived_blocks : [{ args : [BlockArg] }];
    } {
        // A matching minter event is not enough: absence of the exact ledger
        // block must leave the mint unverified across the checked upgrade.
        { log_length = 1_000_000; blocks = []; archived_blocks = [] };
    };
};
