import Ledger "./lib/ledger";
import IC "./lib/IC";
import Result "mo:base/Result";
import Principal "mo:base/Principal";
import Blob "mo:base/Blob";
import Array "mo:base/Array";
import Nat32 "mo:base/Nat32";
import BTree "mo:stableheapbtreemap/BTree";
import Vector "mo:vector";
import Text "mo:base/Text";
import sha "./lib/sha";
import ICPL "./lib/ICPL";
import CMC "./lib/cmc";
import Neutron "./lib/neutron";

 actor class Self() = this {


    private let ledger : Ledger.Interface = actor ("ryjl3-tyaaa-aaaaa-aaaba-cai");
    private let cmc : CMC.Self = actor ("rkp4c-7iaaa-aaaaa-aaaca-cai");
    private let ic : IC.Self = actor ("aaaaa-aa");

    private type Authorized = Bool;
  
    stable let regs = BTree.init<Principal, (Principal, Authorized)>(?32); // 32 is the order, or the size of each BTree node  

    public type Asset = (Text, Neutron.File);

    stable var files = Vector.new<Asset>();
    stable var wasm : ?Blob = null;

    public query({caller}) func find() : async ?Principal {
         let ?x = BTree.get<Principal,(Principal, Authorized)>(regs, Principal.compare, caller) else return null;
         ?x.0;
    };

    public shared({caller}) func set_wasm(x : Blob) : async () {
        wasm := ?x;
    };

    public shared({caller}) func clear_files() : async () {
        files := Vector.new<Asset>();
    };

    public shared({caller}) func add_file(key : Text, f : Neutron.File) : async () {
        Vector.add<Asset>(files, (key, f));
    };

    public shared({caller}) func authorize(p : Principal) : async Result.Result<(), Text> {
       switch(BTree.get<Principal,(Principal, Authorized)>(regs, Principal.compare, caller)) {
            case (?(canister_id, authorized)) {
                //if (authorized == false) return #err("Already authorized");
                let neutron = actor(Principal.toText(canister_id)) : Neutron.Class;
                let resp = await neutron.kernel_authorized_add(p);

                ignore BTree.insert<Principal, (Principal, Authorized)>(regs, Principal.compare, caller, (canister_id, true));
                #ok();
            };
            case (null) {
                return #err("You don't have a canister");
            };
       };
    };

    // public shared({caller}) func uninstall() : async Result.Result<(), Text> {
    //         switch(BTree.get<Principal,Principal>(regs, Principal.compare, caller)) {
    //             case (?canister_id) {
    //                 await ic.uninstall_code({
    //                     canister_id; 
    //                 });

    //                 #ok();
    //             };
    //             case (null) return #err("No canister found");
    //         };
    // };


    public shared({caller}) func install( mode: { #reinstall; #upgrade; #install }) : async Result.Result<Principal, Text> {
        switch(BTree.get<Principal,(Principal, Authorized)>(regs, Principal.compare, caller)) {
            case (?(canister_id, authorized)) {
                let ?w = wasm else return #err("No wasm file");

                await ic.install_code({ arg = to_candid({installer = Principal.fromActor(this)}); wasm_module = w; mode; canister_id });
                
                // Set controller
                ic.update_settings({canister_id; settings = {
                    controllers = ?[Principal.fromActor(this), canister_id];
                    freezing_threshold = null;
                    memory_allocation = null;
                    compute_allocation = null;
                    }});

                let neutron = actor(Principal.toText(canister_id)) : Neutron.Class;

                // Upload files
                for ((key, val) in Vector.vals(files)) {
                    neutron.kernel_static(#store{key; val});
                };

                neutron.kernel_static(#store{key="/pkg/id.json"; val={
                    content = Blob.toArray(Text.encodeUtf8("{\"id\":\"" # Principal.toText(canister_id) #"\"}"));
                    content_type = "application/json";
                    content_encoding = "identity";
                    chunks = 1;
                }});

                ignore BTree.insert<Principal, (Principal, Authorized)>(regs, Principal.compare, caller, (canister_id, false));

                #ok(canister_id);
            };
            case (null) return #err("You don't have a canister");
        };
    };




    public shared({caller}) func create() : async Result.Result<Principal, Text> {
    
        switch(BTree.get<Principal,(Principal, Authorized)>(regs, Principal.compare, caller)) {
            case (null) ();
            case (?can) return #err("Already created");
        };
        let transitional_subaccount = ICPL.SubAccount.fromPrincipal(caller);
        let transitional_aid = ICPL.AccountIdentifier.fromPrincipal(Principal.fromActor(this), ?transitional_subaccount);

        let {e8s} = await ledger.account_balance({account = transitional_aid});

        assert(e8s >= 100_000);

        let cmc_account = ICPL.AccountIdentifier.fromPrincipal(Principal.fromText("rkp4c-7iaaa-aaaaa-aaaca-cai"), ?ICPL.SubAccount.fromPrincipal(Principal.fromActor(this)) ); //caller

        let resp = await ledger.transfer({
                memo = 1095062083;
                amount = {e8s = e8s - ICPL.FEE};
                fee = {e8s = ICPL.FEE};
                from_subaccount = ?transitional_subaccount;
                to = cmc_account;
                created_at_time = null;
            });
        
        switch(resp) {
            case (#Ok(blockIndex)) {

                let cmc_resp = await cmc.notify_create_canister({
                    controller = Principal.fromActor(this);
                    block_index = blockIndex;
                    subnet_type = null
                });

                switch(cmc_resp) {
                    case (#Ok(canister_id)) {
                        let idx = BTree.insert<Principal, (Principal, Authorized)>(regs, Principal.compare, caller, (canister_id, false));
                        return #ok(canister_id);
                    };
                    case (#Err(e)) {
                        return #err("CMC couldn't create a canister: " # debug_show(e))
                    };
                };

            };
            case (_) {
                return #err("Transfer to CMC failed")
            };
        };

        
    };


 }