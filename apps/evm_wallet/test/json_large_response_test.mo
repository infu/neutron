import Array "mo:core/Array";
import Text "mo:core/Text";
import Json "../backend/rpc/Json";

persistent actor {
  public func run() : async Text {
    // Full deployed code exposed the old text-rope equality trap. Retain the
    // underlying parser/serializer regression without a second RPC transport.
    let code = "0x" # Text.fromIter(Array.tabulate<Char>(49_152, func(_) { 'a' }).vals());
    let #ok(parsed) = Json.parse("{\"z\":\"\\ud83d\\ude00\",\"code\":\"" # code # "\"}") else { assert false; loop {} };
    let ?#string(parsedCode) = Json.field(parsed, "code") else { assert false; loop {} };
    assert Text.encodeUtf8(parsedCode) == Text.encodeUtf8(code);
    assert Json.field(parsed, "z") == ?#string("😀");
    let serialized = Json.stringify(Json.canonical(parsed));
    assert Text.encodeUtf8(serialized) == Text.encodeUtf8("{\"code\":\"" # code # "\",\"z\":\"😀\"}");
    let #ok(roundTrip) = Json.parse(serialized) else { assert false; loop {} };
    let ?#string(roundTripCode) = Json.field(roundTrip, "code") else { assert false; loop {} };
    assert Text.encodeUtf8(roundTripCode) == Text.encodeUtf8(code);

    // Do not truncate the end of large strings or collapse Unicode spellings.
    let different = code # "bb";
    let #ok(#string(other)) = Json.parse(Json.quote(different)) else { assert false; loop {} };
    assert Text.encodeUtf8(other) == Text.encodeUtf8(different);
    assert Text.encodeUtf8(other) != Text.encodeUtf8(parsedCode);
    "Large JSON bytecode and nested Unicode retain every UTF8 byte";
  };
};
