import Nat32 "mo:base/Nat32";
import Principal "mo:base/Principal";
import Text "mo:base/Text";

import Iter "mo:base/Iter";
import Nat "mo:base/Nat";
import Map "mo:motoko-hash-map/Map";
import Set "mo:motoko-hash-map/Set";
import T "./types";
import Cert "mo:certified-http";


module {
    
    let { ihash; nhash; thash; phash; calcHash } = Map;

    type File = T.File;

    public type StaticCmd = {
        #store: {key: Text; val: File};
        #delete: {key: Text};
        #clear: {prefix: Text};
    };
    
    public type StaticCmdQuery = {
        #list: {prefix: Text};
    };

    public func cmd(mem: T.Mem, cmd: StaticCmd, cert: Cert.CertifiedHttp<Text>) : () {
        switch(cmd) {
            case(#store({key; val})) {
                Map.set(mem.files, thash, key, val);
                cert.put(key, val.content);
            };
            case(#delete({key})) {
                Map.delete(mem.files, thash, key);
                cert.delete(key);
            };
            case(#clear({prefix})) {
                Map.forEach<Text, File>(mem.files, func(key, value) {
                    if (Text.startsWith(key, #text prefix)) {
                         Map.delete(mem.files, thash, key);
                         cert.delete(key);
                    };
                });
            };
        };
    };

    public func cmd_query(mem: T.Mem, cmd: StaticCmdQuery) : [Text] {
        switch(cmd) {
            case(#list({prefix})) {
                Iter.toArray(Map.keys(
                    Map.filter<Text, File>(
                        mem.files, thash, func(key, value) { 
                                Text.startsWith(key, #text prefix)
                                })
                    ));
            };
        };
    };


}