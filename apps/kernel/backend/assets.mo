import Nat64 "mo:base/Nat64";
import Int32 "mo:base/Int32";
import Nat32 "mo:base/Nat32";
import Text "mo:base/Text";

import Vector "mo:vector";
import RXMDB "mo:rxmodb";
import PK "mo:rxmodb/primarykey";
import IDX "mo:rxmodb/index"; 

module {

public type PKKey = Text;


// Document Type
public type Doc = {
    id: PKKey;
    chunks: Nat;
    content: [Blob];
    content_encoding: Text;
    content_type: Text;
};


public type Init = { // All stable
    db : RXMDB.RXMDB<Doc>;
    pk : PK.Init<PKKey>;
};

public func init() : Init {
    return {
    db = RXMDB.init<Doc>();
    pk = PK.init<PKKey>(?32);
    };
};

public func pk_key(h : Doc) : PKKey = h.id;

public type Use = {
    db : RXMDB.Use<Doc>;
    pk : PK.Use<PKKey, Doc>;
};

public func use(init : Init) : Use {
    let obs = RXMDB.init_obs<Doc>(); // Observables for attachments

    // PK
    let pk_config : PK.Config<PKKey, Doc> = {
        db=init.db;
        obs;
        store=init.pk;
        compare=Text.compare;
        key=pk_key;
        regenerate=#no;
        };
    PK.Subscribe<PKKey, Doc>(pk_config); 

    return {
        db = RXMDB.Use<Doc>(init.db, obs);
        pk = PK.Use(pk_config);
    }

}


}