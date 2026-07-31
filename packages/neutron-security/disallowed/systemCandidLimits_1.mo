import Prim "mo:prim";

module {
  public func configure() : async* () {
    Prim.setCandidTypeLimits({ scalar = 1; bias = 0 });
    ignore Prim.getCandidLimits();
  };
};
