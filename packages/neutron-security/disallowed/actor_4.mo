module {
  public func invoke(value : actor { run : shared () -> async () }) : async () {
    await value.run()
  };
}
