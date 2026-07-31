import Prim "mo:prim";

module {
  public let allocate = Prim.regionNew;
  public let grow = Prim.regionGrow;
  public let load = Prim.regionLoadNat8;
  public let store = Prim.regionStoreNat8;
}
