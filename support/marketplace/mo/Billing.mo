// All rights reserved. See ../LICENSE.
import Cycles "mo:core/Cycles";
import Nat "mo:core/Nat";
import Result "mo:core/Result";
import Runtime "mo:core/Runtime";
import Types "./Types";

module {
  public type Operation = { #update; #upload; #purchase; #withdraw; #grant };
  public type Quote = {
    feeVersion : Nat;
    processingCycles : Nat;
    storageCycles : Nat;
    totalCycles : Nat;
    processingBytes : Nat;
    newStorageBytes : Nat;
  };
  public type Error = { code : Text; message : Text };

  public func validSchedule(schedule : Types.FeeSchedule) : Bool {
    schedule.version > 0 and schedule.updateBase > 0 and
    schedule.updateByte > 0 and schedule.storageByteYear > 0 and
    schedule.purchase > 0 and schedule.withdraw > 0 and schedule.grant > 0 and
    schedule.xrc > 0;
  };

  public func quote(
    schedule : Types.FeeSchedule,
    operation : Operation,
    processingBytes : Nat,
    newStorageBytes : Nat,
  ) : Quote {
    let base = switch (operation) {
      case (#purchase) schedule.purchase;
      case (#withdraw) schedule.withdraw;
      case (#grant) schedule.grant;
      case (_) schedule.updateBase;
    };
    let processingCycles = base + processingBytes * schedule.updateByte;
    let storageCycles = newStorageBytes * schedule.storageByteYear;
    {
      feeVersion = schedule.version;
      processingCycles;
      storageCycles;
      totalCycles = processingCycles + storageCycles;
      processingBytes;
      newStorageBytes;
    };
  };

  // Invoke only after authenticating the caller, before work or dispatch. The
  // quote's byte counts are computed by the endpoint, never trusted from callers.
  public func accept<system>(charge : Quote, expectedVersion : Nat) : Result.Result<Nat, Error> {
    if (expectedVersion != charge.feeVersion) {
      return #err({ code = "cycle_fee_version"; message = "Review the current fixed cycle estimate before continuing." });
    };
    if (Cycles.available() < charge.totalCycles) {
      return #err({
        code = "cycles_required";
        message = "Attach at least " # Nat.toText(charge.totalCycles) # " cycles through your Neutron.";
      });
    };
    let accepted = Cycles.accept<system>(charge.totalCycles);
    // A balance-limit short acceptance must not commit a partial charge or start
    // the operation. A trap rolls back this message segment.
    if (accepted != charge.totalCycles) Runtime.trap("The protocol could not accept the complete cycle charge.");
    #ok(accepted);
  };
}
