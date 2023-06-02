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
// import AP "./apps";
import T "./types";


module {
    let { ihash; nhash; thash; phash; calcHash } = Map;

    // Memory
    public type Memory_kernel = T.Mem;
    public func memory_kernel() : Memory_kernel {
        {
            files : T.FilesMap = Map.new(thash);
            // apps : T.AppsMap = Map.new(thash);
        };
    };
    
    // Share function
    public type Input_hello_world = ();
    public type Output_hello_world = Text;
    public func hello_world(mem:T.Mem, req: Input_hello_world) : Output_hello_world {
        "Hello World";
    };

    // Use shared function
    public type Input_kernel_use_hello_world = ();
    public type Output_kernel_use_hello_world = Text;
    public func kernel_use_hello_world(mem:T.Mem, hello_world_func:Input_hello_world -> Output_hello_world, req: Input_kernel_use_hello_world) : Output_kernel_use_hello_world {
       hello_world_func();
    };

    // Apps
    public type Input_kernel_app =  AP.AppCmd;
    public type Output_kernel_app = ();
    public func kernel_app( mem:T.Mem, cmd:Input_kernel_app) : Output_kernel_app {
       AP.cmd(mem, cmd);
    };

    public type Input_kernel_app_list = ();
    public type Output_kernel_app_list = [(Text, T.App)];
    public func kernel_app_list( mem:T.Mem, req:Input_kernel_app_list) : Output_kernel_app_list {
        Map.toArray(mem.apps);
    };

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
    
    //

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
