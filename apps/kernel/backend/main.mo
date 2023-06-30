import Debug "mo:base/Debug";
import Painless "./lib/Painless";
import Nat32 "mo:base/Nat32";
import Principal "mo:base/Principal";
import Text "mo:base/Text";

import Iter "mo:base/Iter";
import Nat "mo:base/Nat";
import Map "mo:motoko-hash-map/Map";
import Set "mo:motoko-hash-map/Set";
import AAA "./aaa_interface";
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
            // apps : T.AppsMap = Map.new(thash);
        };
    };
    
    // stable let authorized = Set.fromIter([_installer].vals(), phash);
    public type Input_kernel_authorized_add = Principal;
    public type Output_kernel_authorized_add = ();
    public func kernel_authorized_add(mem:T.Mem, id : Principal) : () {
  
        ignore Set.add(mem.authorized, phash, id);
    };

    public type Input_kernel_authorized_rem = Principal;
    public type Output_kernel_authorized_rem = ();
    public func kernel_authorized_rem(mem:T.Mem, id : Principal) : () {
        ignore Set.remove(mem.authorized, phash, id);
    };

    public type Input_is_authorized = Principal;
    public type Output_is_authorized = Bool;
    public func is_authorized(mem:T.Mem, id : Principal) : Bool {
        Set.has(mem.authorized, phash, id);
    };




    // Apps
    // public type Input_kernel_app =  AP.AppCmd;
    // public type Output_kernel_app = ();
    // public func kernel_app( mem:T.Mem, cmd:Input_kernel_app) : Output_kernel_app {
    //    AP.cmd(mem, cmd);
    // };

    // public type Input_kernel_app_list = ();
    // public type Output_kernel_app_list = [(Text, T.App)];
    // public func kernel_app_list( mem:T.Mem, req:Input_kernel_app_list) : Output_kernel_app_list {
    //     Map.toArray(mem.apps);
    // };

    // Static
    public type Input_kernel_static =  ST.StaticCmd;
    public type Output_kernel_static = ();
    public func kernel_static(mem:T.Mem, cmd: Input_kernel_static) : Output_kernel_static {
        ST.cmd(mem, cmd);
    };

    public type Input_kernel_static_query =  ST.StaticCmdQuery;
    public type Output_kernel_static_query = [Text];
    public func kernel_static_query( mem:T.Mem, cmd: Input_kernel_static_query) : Output_kernel_static_query {
        ST.cmd_query(mem, cmd);
    };
    
    // HTTP
    public type Input_http_request = Painless.Request;
    public type Output_http_request = Painless.Response;
    public func http_request( mem:T.Mem, cbFunc: Painless.CallbackFunc, request : Input_http_request) :  Output_http_request {
        switch(Map.get(mem.files, thash, request.url)) {
            case (null) { Painless.NotFound("Token not found"); };
            case (?f) { 
                Painless.Request(request, {
                    chunkFunc = func getChunk(key:Text, index:Nat) : Painless.Chunk {
                        #end(f.content)
                    };
                    cbFunc = cbFunc; //this.http_request_streaming_callback
                    headers = [
                        ("Content-type", f.content_type),
                        ("Content-encoding", f.content_encoding)
                    ]
                    }); //("Content-size", Nat32.toText(size)),("Content-type", contentType),("Cache-control", "public,max-age=31536000,immutable"), ("Access-Control-Allow-Origin","*")

            }
        }
    };
    
    public type Input_http_request_streaming_callback = Painless.Token;
    public type Output_http_request_streaming_callback = Painless.Callback;
    public func http_request_streaming_callback( mem:T.Mem, token : Input_http_request_streaming_callback) : Output_http_request_streaming_callback {
      Painless.Callback(token, {
          chunkFunc = func getChunk(key:Text, index:Nat) : Painless.Chunk {
                switch(Map.get(mem.files, thash,  key)) {
                    case (null) { #none() };
                    case (?f) { #end(f.content)}
                }
            };
      });
    };
    
    let IC = actor "aaaaa-aa" : AAA.Interface;

    public type Input_kernel_install_code = {wasm: [Nat8]; candid: Text};
    public type Output_kernel_install_code = ();
    public func kernel_install_code(mem:T.Mem, self: actor {}, inp: Input_kernel_install_code) : async () {
 
        // await UPGRADER.upgrade(inp.wasm);

        IC.install_code({
            arg = [];
            wasm_module = inp.wasm;
            mode = #upgrade;
            canister_id = Principal.fromActor(self);
            });
        ignore 3+3;

    };


   
    // let UPGRADER = actor "bkyz2-fmaaa-aaaaa-qaaaq-cai": actor {
    //     upgrade : shared (wasm: [Nat8]) -> async ();
    // };
   


    // public type ExtensionCanister =actor{
    //     nftanvil_use: shared ({
    //         token:TokenIdentifier;
    //         aid:AccountIdentifier;
    //         memo:Nft.Memo;
    //         useId: Text;
    //     }) -> async Result.Result<(), Text>
    // };
    // let test = actor("aaaaa-aaa"): actor { http_request_streaming_callback : shared () -> async () };


}
