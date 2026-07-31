module {
  type Settings = { count : Nat; cycles : Nat; title : Text };

  public func increment(settings : Settings) : Settings {
    { settings with cycles = settings.cycles + 1 }
  };
}
