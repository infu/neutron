import Nat32 "mo:base/Nat32";
import Principal "mo:base/Principal";
import Text "mo:base/Text";

import Iter "mo:base/Iter";
import Nat "mo:base/Nat";
import Map "mo:motoko-hash-map/Map";
import Set "mo:motoko-hash-map/Set";
import T "./types";
import ST "./static";

module {
    
    let { ihash; nhash; thash; phash; calcHash } = Map;

    type App = T.App;
    
    public type AppCmd = {#set: {key:Text; val: App}; #delete: {key: Text}};

    public func cmd(mem: T.Mem, cmd: AppCmd) : () {
        switch(cmd) {
            case(#set({key; val})) {
                Map.set(mem.apps, thash, key, val);
            };

            case(#delete({key})) {
                let ?app = Map.get(mem.apps, thash, key);

                ST.cmd(mem, #clear({prefix = app.path}));
                Map.delete(mem.apps, thash, key);
                
            };
        };
    };


}