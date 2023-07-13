import Debug "mo:base/Debug";
import Painless "./lib/Painless";
import Nat32 "mo:base/Nat32";
import Principal "mo:base/Principal";
import Text "mo:base/Text";

import Iter "mo:base/Iter";
import Nat "mo:base/Nat"; 
import Set "mo:motoko-hash-map/Set";
import Timer "mo:base/Timer"; 
// import AP "./apps";
import Cert "mo:certified-http";
import Int "mo:base/Int";
import Time "mo:base/Time";
import Bt "mo:stableheapbtreemap/BTree";
import Assets "./assets";
import Array "mo:base/Array";

module {
    let { phash } = Set;

    public type AuthSet = Set.Set<Principal>;

    // Memory
    public type Memory_kernel = {
        assets : Assets.Init;
        authorized : AuthSet;
        cert: Cert.CertifiedHttpMemory;
    };

    public func memory_kernel() : Memory_kernel {
        {
            assets = Assets.init();
            authorized = Set.new(phash);
            cert = Cert.init();
        };
    };
    

    public type StaticCmd = {
        #store_chunk: {key: Text; chunk_id:Nat; content: Blob};
        #store: {key: Text; val: File};
        #delete: {key: Text};
        #clear: {prefix: Text};
    };
    
    public type StaticCmdQuery = {
        #list: {prefix: Text};
    };


    public type File = {content: Blob; content_encoding:Text; content_type:Text; chunks: Nat};


    public class Init(mem:Memory_kernel) {
        let assets = Assets.use(mem.assets);

        let cert = Cert.CertifiedHttp(
            mem.cert
        );

        public func /*update*/kernel_authorized_add(id : Principal) : () {
            Set.add(mem.authorized, phash, id);
        };

        public func /*update*/kernel_authorized_rem(id : Principal) : () {
            ignore Set.remove(mem.authorized, phash, id);
        };

        public func /*internal*/is_authorized(id : Principal) : Bool {
            Set.has(mem.authorized, phash, id);
        };

        public func /*query:unauthorized*/kernel_check_authorized((),/*caller*/ caller:Principal) : Bool {
            Set.has(mem.authorized, phash, caller);
        };

        public func /*update*/kernel_static(cmd: StaticCmd) : () {
            switch(cmd) {
                case(#store_chunk(x)) {
                    cert.chunkedSend(x.key, x.chunk_id, x.content);
                };
                case(#store({key; val})) {
                    assert(val.chunks > 0);
                    
                    // Allows uploads of large certified files.
                    cert.chunkedStart(key, val.chunks, val.content, func(content: [Blob]) {
                        // when done
                        assets.db.insert({
                            id= key;
                            chunks= val.chunks;
                            content= content;
                            content_encoding= val.content_encoding;
                            content_type = val.content_type;
                        });
                    });
                   
                };
                case(#delete({key})) {
                    assets.pk.delete(key);
                    cert.delete(key);
                };
                case(#clear({prefix})) {
                    for ((k, idx) in assets.pk.findIter(prefix, prefix#"~", #fwd)) {
                        assets.db.deleteIdx(idx);
                        cert.delete(k);
                    };
                };
            };
        };

        public func /*query*/kernel_static_query(cmd: StaticCmdQuery) : [Text] {
            switch(cmd) {
                case(#list({prefix})) {
                    let res = assets.pk.findIdx(prefix, prefix#"~", #fwd, 3000); // max 3000
                    Array.map<(Text, Nat), Text>(res, func(x) { x.0 });
                };
            };
        };
        
        public func /*query:unauthorized*/http_request(request : Painless.Request, /*caller,this*/ caller:Principal, self: actor {http_request_streaming_callback : Painless.CallbackFunc;}) : Painless.Response {
            
            switch(assets.pk.get(request.url)) {
                case (null) { Painless.NotFound("Token not found"); };
                case (?f) {
                    Painless.Request(request, {
                        chunkFunc = func getChunk(key:Text, index:Nat) : Painless.Chunk {
                            if (f.chunks > 1) return #more(f.content[0]);
                            #end(f.content[0]);
                        };
                        cbFunc = self.http_request_streaming_callback;
                        headers = [
                            ("Content-type", f.content_type),
                            ("Content-encoding", f.content_encoding),
                            cert.certificationHeader(request.url)
                            // ("X-Frame-Options", "SAMEORIGIN") // Doesn't do anything
                        ]
                        }); //("Content-size", Nat32.toText(size)),("Content-type", contentType),("Cache-control", "public,max-age=31536000,immutable"), ("Access-Control-Allow-Origin","*")

                }
            }
        };
        
        public func /*query:unauthorized*/http_request_streaming_callback(token : Painless.Token) : Painless.Callback {
            Painless.Callback(token, {
                chunkFunc = func getChunk(key:Text, index:Nat) : Painless.Chunk {
                        switch(assets.pk.get(key)) {
                            case (null) #none();
                            case (?f) { 
                                if (f.chunks > index) return #more(f.content[index]);
                                #end(f.content[index]);
                                }
                        }
                    };
            });
        };

        let IC = actor "aaaaa-aa" : actor { // one shot
                install_code : {
                arg : [Nat8];
                wasm_module : [Nat8];
                mode : { #reinstall; #upgrade; #install };
                canister_id : Principal;
                } -> ();
        };

        public func /*update*/kernel_install_code(inp: {wasm: [Nat8]; candid: Text}, /*this*/ self: actor {}) : async () {
    
            IC.install_code({
                arg = [];
                wasm_module = inp.wasm;
                mode = #upgrade;
                canister_id = Principal.fromActor(self);
                });

        };


    };


/*---NEUTRON GENERATED BEGIN---*/

public type kernel_authorized_add_Input = (id : Principal);
public type kernel_authorized_add_Output = ();
    
public type kernel_authorized_rem_Input = (id : Principal);
public type kernel_authorized_rem_Output = ();
    
public type is_authorized_Input = (id : Principal);
public type is_authorized_Output = Bool;
    
public type kernel_check_authorized_Input = (());
public type kernel_check_authorized_Output = Bool;
    
public type kernel_static_Input = (cmd: StaticCmd);
public type kernel_static_Output = ();
    
public type kernel_static_query_Input = (cmd: StaticCmdQuery);
public type kernel_static_query_Output = [Text];
    
public type http_request_Input = (request : Painless.Request);
public type http_request_Output = Painless.Response;
    
public type http_request_streaming_callback_Input = (token : Painless.Token);
public type http_request_streaming_callback_Output = Painless.Callback;
    
public type kernel_install_code_Input = (inp: {wasm: [Nat8]; candid: Text});
public type kernel_install_code_Output = ();
    
/*---NEUTRON GENERATED END---*/
}
