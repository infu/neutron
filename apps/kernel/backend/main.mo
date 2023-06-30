import Debug "mo:base/Debug";
import Painless "./lib/Painless";
import Nat32 "mo:base/Nat32";
import Principal "mo:base/Principal";
import Text "mo:base/Text";

import Iter "mo:base/Iter";
import Nat "mo:base/Nat";
import Map "mo:motoko-hash-map/Map";
import Set "mo:motoko-hash-map/Set";
import ST "./static";
import Timer "mo:base/Timer";
// import AP "./apps";
import T "./types";


module {
    let { ihash; nhash; thash; phash; calcHash } = Map;

    // Memory
    public type Memory_kernel = T.Mem;
    public func memory_kernel() : Memory_kernel {
        {
            files : T.FilesMap = Map.new(thash);
            authorized = Set.new(phash);
        };
    };
    

    public class Init(mem:T.Mem) {

        public func /*update*/kernel_authorized_add(id : Principal) : () {
            Set.add(mem.authorized, phash, id);
        };

        public func /*update*/kernel_authorized_rem(id : Principal) : () {
            ignore Set.remove(mem.authorized, phash, id);
        };

        public func /*internal*/is_authorized(id : Principal) : Bool {
            Set.has(mem.authorized, phash, id);
        };

        public func /*update*/kernel_static(cmd: ST.StaticCmd) : () {
            ST.cmd(mem, cmd);
        };

        public func /*query*/kernel_static_query(cmd: ST.StaticCmdQuery) : [Text] {
            ST.cmd_query(mem, cmd);
        };
        
        public func /*query*/http_request(request : Painless.Request, /*caller,this*/ caller:Principal, self: actor {http_request_streaming_callback : Painless.CallbackFunc;}) : Painless.Response {
            switch(Map.get(mem.files, thash, request.url)) {
                case (null) { Painless.NotFound("Token not found"); };
                case (?f) { 
                    Painless.Request(request, {
                        chunkFunc = func getChunk(key:Text, index:Nat) : Painless.Chunk {
                            #end(f.content)
                        };
                        cbFunc = self.http_request_streaming_callback;
                        headers = [
                            ("Content-type", f.content_type),
                            ("Content-encoding", f.content_encoding)
                        ]
                        }); //("Content-size", Nat32.toText(size)),("Content-type", contentType),("Cache-control", "public,max-age=31536000,immutable"), ("Access-Control-Allow-Origin","*")

                }
            }
        };
        
        public func /*query*/http_request_streaming_callback(token : Painless.Token) : Painless.Callback {
            Painless.Callback(token, {
                chunkFunc = func getChunk(key:Text, index:Nat) : Painless.Chunk {
                        switch(Map.get(mem.files, thash,  key)) {
                            case (null) { #none() };
                            case (?f) { #end(f.content) }
                        }
                    };
            });
        };
        
        let IC = actor "aaaaa-aa" : actor {
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
    
public type kernel_static_Input = (cmd: ST.StaticCmd);
public type kernel_static_Output = ();
    
public type kernel_static_query_Input = (cmd: ST.StaticCmdQuery);
public type kernel_static_query_Output = [Text];
    
public type http_request_Input = (request : Painless.Request);
public type http_request_Output = Painless.Response;
    
public type http_request_streaming_callback_Input = (token : Painless.Token);
public type http_request_streaming_callback_Output = Painless.Callback;
    
public type kernel_install_code_Input = (inp: {wasm: [Nat8]; candid: Text});
public type kernel_install_code_Output = ();
    
/*---NEUTRON GENERATED END---*/
}
