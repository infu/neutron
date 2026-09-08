module {
  /// Match src/gas.ts. The reviewed/simulated maximum includes headroom for
  /// contract state changes before inclusion; explicit limits remain exact.
  public func automaticLimit(estimate : Nat) : Nat {
    if (estimate <= 21_000) estimate else estimate + (estimate + 4) / 5
  };
}
