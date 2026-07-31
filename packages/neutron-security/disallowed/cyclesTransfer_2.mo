module {
  func operation() : async () {};

  public func forward() : async () {
    let context = { cycles = 1_000 };
    await (context with) operation()
  };
}
