module {
  type Metrics = {
    callerInfoData : Blob;
    cyclesBalance : Nat;
    regionSize : Nat;
    setTimer : Text;
  };

  public let toActor = 1;
  public let sample = { call_raw = false; envVar = "local" };
  public func createActor(setTimer : Text) : Text { setTimer };
  public let cyclesBalancer = 1;
  public let regionalIndicator = "safe";
  public let stableMemoryBudget = 1024;
  public let call_rawish = false;
}
