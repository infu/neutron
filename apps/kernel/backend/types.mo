import Map "mo:motoko-hash-map/Map";


module {

    public type Mem = {
        files : FilesMap;
        apps  : AppsMap;
    };

    public type Store = {
        #v1 : Mem;
    };

    public type FilesMap = Map.Map<Text, File>;

    public type AppsMap = Map.Map<Text, App>;

    public type App = {name: Text; path: Text; ver: Text; installed: Bool;};


    public type File = {content: Blob; content_encoding:Text; content_type:Text};


}