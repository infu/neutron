import Prim "mo:prim";

module {
  public let physicalSize = Prim.rts_stable_memory_size;
  public let logicalSize = Prim.rts_logical_stable_memory_size;
}
