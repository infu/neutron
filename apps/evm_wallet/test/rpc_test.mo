import Json "../backend/rpc/Json";

persistent actor {
  public func run() : async Text {
    assert Json.quantityText("0x0") == #ok(0);
    assert Json.quantityText("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff") == #ok(2 ** 256 - 1);
    assert Json.parseQuantity("0x") == null;
    assert Json.parseQuantity("0x00") == null;
    assert Json.parseQuantity("-0x1") == null;
    assert Json.parseQuantity("0x1g") == null;
    assert Json.hexQuantity(2 ** 256 - 1) == "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    assert Json.parse("\"\\ud83d\\ude00\"") == #ok(#string("😀"));
    assert Json.parse("\"\\uD834\\uDD1E\"") == #ok(#string("𝄞"));
    assert Json.parse("\"\\\\ud800\"") == #ok(#string("\\ud800"));
    for (invalid in [
      "\"\\ud800\"", "\"\\udc00\"", "{\"a\":1,\"a\":2}",
      "{\"nested\":{\"a\":1,\"\\u0061\":2}}", "[1,]", "1e9999",
    ].vals()) {
      let #err(_) = Json.parse(invalid) else { assert false; loop {} };
    };
    let escaped : Json.Value = #object_([("a\"\\\n", #string("b\"\\\t")), ("n", #number(#int(2 ** 256 - 1)))]);
    assert Json.parse(Json.stringify(escaped)) == #ok(escaped);
    let #ok(feeHistory) = Json.parse("{\"gasUsedRatio\":[0.5,0.125]}") else { assert false; loop {} };
    assert Json.field(feeHistory, "gasUsedRatio") == ?#array([#number(#float(0.5)), #number(#float(0.125))]);

    // Browser observation envelopes still arrive as JSON. Missing, null,
    // duplicate and scalar fields must retain their distinct meanings.
    let #ok(receipt) = Json.parse("{\"transactionHash\":\"0x1234\",\"blockNumber\":null,\"status\":\"0x1\"}") else { assert false; loop {} };
    assert Json.field(receipt, "transactionHash") == ?#string("0x1234");
    assert Json.field(receipt, "blockNumber") == ?#null_;
    assert Json.field(receipt, "missing") == null;
    assert Json.field(#string("not an object"), "status") == null;
    assert Json.field(#object_([("status", #string("0x1")), ("status", #string("0x0"))]), "status") == null;
    assert Json.quantity(#string("0x1")) == #ok(1);
    let #err(_) = Json.quantity(#number(#int(1))) else { assert false; loop {} };
    assert Json.stringResult("null") == null;
    assert Json.stringResult("\"0x1234\"") == ?"0x1234";

    // Canonical object order never changes ordered log topics or loses fields.
    let #ok(nested) = Json.parse("{\"z\":1,\"a\":{\"y\":[\"0x2\",\"0x1\"],\"b\":3}}") else { assert false; loop {} };
    assert Json.stringify(Json.canonical(nested)) == "{\"a\":{\"b\":3,\"y\":[\"0x2\",\"0x1\"]},\"z\":1}";
    "EVM browser observation JSON preserves exact quantities, Unicode, escaping and object shapes";
  };
};
