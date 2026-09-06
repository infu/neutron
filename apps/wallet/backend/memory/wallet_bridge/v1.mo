// Persistent schema: immutable after its first production release. No relative
// imports: outstanding deposits must survive app and browser upgrades verbatim.
import Map "mo:core/Map";
module {
    public type Source = { #external; #evm; #evm_agent : { app_id : Text; installation_uid : Text } };
    public type StepKind = { #reset_approval; #approval; #deposit };
    public type StepState = { #ready; #unknown; #submitted; #confirmed; #failed };
    public type Quote = {
        chain_id : Nat;
        ledger : Principal;
        minter : Principal;
        helper_address : Text;
        helper_mode : { #subaccount; #legacy };
        minter_address : Text;
        token_address : ?Text;
        recipient : Principal;
        principal_word : Text;
        subaccount_word : Text;
    };
    public type Step = {
        kind : StepKind;
        state : StepState;
        operation_id : ?Text;
        transaction_hash : ?Text;
        error : ?Text;
    };
    public type AcceptedDeposit = {
        log_index : Nat;
        block_number : Nat;
        event_index : Nat64;
    };
    public type Mint = {
        ledger_block_index : Nat;
        event_index : Nat64;
        verified_ledger : Bool;
    };
    public type Intent = {
        id : Blob;
        quote : Quote;
        source : Source;
        account : Text;
        amount : Nat;
        subaccount : ?Blob;
        steps : [Step];
        revision : Nat;
        created_at : Int;
        updated_at : Int;
        event_cursor : Nat64;
        accepted_deposit : ?AcceptedDeposit;
        mint : ?Mint;
        error : ?Text;
    };
    public type Mem = { intents : Map.Map<Blob, Intent> };
    public func init() : Mem { { intents = Map.empty<Blob, Intent>() } };
};
