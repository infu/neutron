// Persistent schema: keep this file immutable after release. Package imports are
// allowed; relative imports are forbidden so app-local types cannot drift.
import Map "mo:core/Map";

module {
    public type ContactKind = {
        #person;
        #self;
    };

    public type Destination = {
        #internet_computer : {
            owner : Principal;
            subaccount : ?Blob;
        };
        #bitcoin_mainnet : Text;
        #dogecoin_mainnet : Text;
        #ethereum_mainnet : Text;
        #solana_mainnet : Text;
    };

    public type Address = {
        id : Nat;
        address_label : ?Text;
        destination : Destination;
        preferred : Bool;
    };

    public type Contact = {
        id : Nat;
        revision : Nat;
        kind : ContactKind;
        name : Text;
        notes : Text;
        addresses : [Address];
        created_at : Int;
        updated_at : Int;
    };

    public type Mem = {
        var next_contact_id : Nat;
        var next_address_id : Nat;
        var revision : Nat;
        contacts : Map.Map<Nat, Contact>;
    };

    public func init() : Mem {
        {
            var next_contact_id = 1;
            var next_address_id = 1;
            var revision = 0;
            contacts = Map.empty<Nat, Contact>();
        };
    };
};
