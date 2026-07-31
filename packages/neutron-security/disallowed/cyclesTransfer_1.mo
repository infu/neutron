module {
  func operation() : async () {};

  public func spend() : async () {
    await (with cycles = 1_000) operation()
  };
}
