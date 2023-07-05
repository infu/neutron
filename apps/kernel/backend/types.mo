import Map "mo:motoko-hash-map/Map";
import Set "mo:motoko-hash-map/Set";
import Cert "mo:certified-http";


module {

    public type Mem = {
        files : FilesMap;
        authorized : AuthSet;
        cert: Cert.CertifiedHttpMemory;
        // apps  : AppsMap;
    };

    // public type Store = {
    //     #v1 : Mem;
    // };

    public type FilesMap = Map.Map<Text, File>;
    public type AuthSet = Set.Set<Principal>;
    // public type AppsMap = Map.Map<Text, App>;

    // public type App = {name: Text; path: Text; ver: Text; installed: Bool;};


    public type File = {content: Blob; content_encoding:Text; content_type:Text};


}