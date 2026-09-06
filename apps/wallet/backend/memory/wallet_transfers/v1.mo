// Persistent schema. Keep immutable after release; old Wallet roots are kept.
import Map "mo:core/Map";

module {
    public type Settlement = {
        checked_at : Int;
        status : {
            #pending : Text;
            #submitted : { transaction_hash : Text; message : Text };
            #confirmed : { transaction_hash : Text };
            #failed : Text;
            #unknown : Text;
        };
    };
    public type Step = {
        canister : Principal;
        method : Text;
        args : Blob;
        cycles : Nat;
        var outcome : {
            #started;
            #unknown : Text;
            #reply : Blob;
            #rejected : { code : Text; message : Text };
        };
    };

    public type Command = {
        request_id : Blob;
        intent : Blob;
        resolved : Blob;
        created_at : Nat64;
        ledger : Principal;
        native : Bool;
        minter : ?Principal;
        allowance_ledgers : [Principal];
        var updated_at : Int;
        var status : { #pending; #succeeded : Blob; #rejected : Text };
        var last_error : ?Text;
        // A ledger/minter burn receipt accepts the withdrawal; it does not
        // itself prove payment on the origin network.
        var settlement : ?Settlement;
        // Keep final receipts discoverable until a Wallet UI has received
        // them; browsers with opaque origins have no persistent local storage.
        var acknowledged : Bool;
        // Exact call arguments and successful replies survive browser reloads,
        // lost broker replies and compatible application upgrades.
        var calls : [Step];
    };

    public type Mem = {
        commands : Map.Map<Blob, Command>;
        // New funding calls keep caller-provided memos, so their ledger
        // timestamps supply a distinct identity even at one IC system time.
        var last_funding_created_at : Nat64;
    };
    public func init() : Mem = {
        commands = Map.empty<Blob, Command>();
        var last_funding_created_at = 0;
    };
};
