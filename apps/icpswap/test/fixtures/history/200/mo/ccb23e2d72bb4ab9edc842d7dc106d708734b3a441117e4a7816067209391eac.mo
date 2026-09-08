import Prim "mo:⛔";
module {
  public func trap(errorMessage : Text) : None {
    Prim.trap errorMessage
  };
  public func unreachable() : None {
    trap("Runtime.unreachable()")
  };
  public func envVarNames<system>() : [Text] {
    return Prim.envVarNames<system>()
  };
  public func envVar<system>(name : Text) : ?Text {
    return Prim.envVar<system>(name)
  }
}
