import Runtime "mo:core/Runtime";

module {
  public func read() : ?Text {
    Runtime.envVar("NAME")
  };
}
