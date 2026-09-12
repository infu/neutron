// Disposable local integration fixture; never installed in a production Neutron.
import IC "mo:core/InternetComputer";
import Nat "mo:core/Nat";
persistent actor {
    var executed : [Nat] = [];
    public shared func forward(target : Principal, method : Text, args : Blob) : async Blob {
        await IC.call(target, method, args);
    };
    // Governance forwards the proposal's exact Candid payload to both methods.
    public shared func validate(value : Nat) : async { #Ok : Text; #Err : Text } {
        if (value == 0) #Err("Zero is deliberately rejected by the local validator")
        else #Ok("Set the local fixture value to " # Nat.toText(value));
    };
    public shared func execute(value : Nat) : async () { executed := [value] };
    public query func values() : async [Nat] { executed };
};
