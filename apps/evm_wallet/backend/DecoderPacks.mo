import Array "mo:core/Array";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Text "mo:core/Text";
import Sha256 "mo:sha2/Sha256";
import Memory "./memory/evm_decoders/v1";
import Hex "./evm/Hex";
import Json "./rpc/Json";

// These owner-imported documents only supply transaction descriptions. They
// have no signing privileges and never change the exact retained transactions.
module {
  public type Result<T> = { #ok : T; #err : Text };
  public type SetRequest = {
    id : Text; version : Text; name : Text;
    document_json : Text; sha256 : Text; enabled : Bool;
  };

  // Versions are canonical positive decimal integers so precedence is exact
  // across Motoko/JavaScript and never depends on lexical or floating ordering.
  func versionNumber(input : Text) : ?Nat {
    let ?number = Nat.fromText(input) else return null;
    if (number == 0 or Nat.toText(number) != input) return null;
    ?number;
  };

  func field(value : Json.Value, name : Text) : ?Text {
    let ?item = Json.field(value, name) else return null;
    Json.string(item);
  };

  func validId(input : Text) : Bool {
    let chars = input.chars();
    let ?first = chars.next() else return false;
    func alphanumeric(c : Char) : Bool = (c >= 'a' and c <= 'z') or (c >= '0' and c <= '9');
    if (not alphanumeric(first)) return false;
    for (c in chars) {
      if (not alphanumeric(c) and c != '.' and c != '_' and c != '-') return false;
    };
    true;
  };

  public func digest(document : Text) : Text {
    // Plain lower-case hexadecimal SHA-256, as used in package/source records.
    let encoded = Hex.encode(Sha256.fromBlob(#sha256, Text.encodeUtf8(document)));
    switch (Text.stripStart(encoded, #text("0x"))) { case (?value) value; case null encoded };
  };

  public class Store(mem : Memory.Mem) {
    public func list() : { packs : [Memory.Pack] } {
      { packs = Array.fromIter(Map.values(mem.packs)) };
    };

    public func set(request : SetRequest, now : Int) : Result<Memory.Pack> {
      let ?version = versionNumber(request.version) else return #err("Decoder pack version must be a positive decimal integer string");
      if (not validId(request.id)) return #err("Decoder pack id must match [a-z0-9][a-z0-9._-]*");
      if (request.name == "") return #err("Decoder pack name must not be empty");
      let document = switch (Json.parse(request.document_json)) {
        case (#err(error)) return #err("Invalid decoder JSON: " # error);
        case (#ok(value)) value;
      };
      switch (Json.field(document, "format")) {
        case (?#number(#int(1))) {};
        case (?#number(#float(1.0))) {};
        case (_) return #err("Unsupported decoder document format");
      };
      if (field(document, "description") == null) return #err("Decoder document description must be a string");
      if (field(document, "id") != ?request.id or field(document, "version") != ?request.version or field(document, "name") != ?request.name) {
        return #err("Decoder document id, version, and name must match the imported metadata");
      };
      let sha256 = digest(request.document_json);
      if (request.sha256 != sha256) return #err("Decoder document SHA-256 does not match its exact UTF-8 bytes");
      let previous = Map.get(mem.packs, Text.compare, request.id);
      switch (previous) {
        case (?pack) {
          let ?oldVersion = versionNumber(pack.version) else return #err("Stored decoder pack version is invalid");
          if (version < oldVersion) return #err("A decoder pack update must use a higher version");
          if (version == oldVersion and request.document_json != pack.document_json) return #err("Decoder pack content is immutable at the same id and version");
        };
        case null {};
      };
      let pack : Memory.Pack = {
        id = request.id; version = request.version; name = request.name;
        document_json = request.document_json; sha256; enabled = request.enabled;
        created_at = switch (previous) { case (?pack) pack.created_at; case null now };
        updated_at = now;
      };
      Map.add(mem.packs, Text.compare, request.id, pack);
      #ok(pack);
    };

    public func remove(id : Text) : Bool {
      let exists = Map.containsKey(mem.packs, Text.compare, id);
      Map.remove(mem.packs, Text.compare, id);
      exists;
    };
  };
};
