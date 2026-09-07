// Persistent schema. Immutable after its first published release.
// Decoder documents are independent of custody, commands, and token evidence.
import Map "mo:core/Map";

module {
  public type Pack = {
    id : Text;
    version : Text;
    name : Text;
    document_json : Text;
    sha256 : Text;
    enabled : Bool;
    created_at : Int;
    updated_at : Int;
  };
  public type Mem = { packs : Map.Map<Text, Pack> };
  public func init() : Mem = { packs = Map.empty() };
};
