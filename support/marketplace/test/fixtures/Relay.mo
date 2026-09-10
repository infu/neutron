import IC "mo:core/InternetComputer";
import Principal "mo:core/Principal";

// PocketIC only: impersonates a cycle-paying Neutron without a Kernel build.
// This fixture is deliberately unrestricted and must never be deployed publicly.
persistent actor class Relay() = self {
    var gateOpen = true;
    var gateWaiters : Nat = 0;
    var gateTicks : Nat = 0;

    public shared func rawCall(target : Principal, method : Text, args : Blob, cycles : Nat) : async Blob {
        await (with cycles = cycles) IC.call(target, method, args)
    };

    public shared func resetGate() : async () { gateOpen := false };
    public shared func releaseGate() : async () { gateOpen := true };
    public shared query func gateStatus() : async { open : Bool; waiting : Nat; ticks : Nat } {
        { open = gateOpen; waiting = gateWaiters; ticks = gateTicks }
    };
    public shared func gateTick() : async () { gateTicks += 1 };

    // Advance PocketIC manually while a ledger awaits this method, then submit
    // releaseGate. Each self-call yields so other messages can be processed.
    public shared func wait() : async () {
        gateWaiters += 1;
        while (not gateOpen) { await self.gateTick() };
        gateWaiters -= 1;
    };
};
