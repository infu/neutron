import Timer "mo:base/Timer";
import AAA "./aaa_interface";

actor {
    let IC = actor "aaaaa-aa" : AAA.Interface;

    public shared({caller}) func upgrade(wasm: [Nat8]) : async () {
        ignore IC.install_code({
            arg = [];
            wasm_module = wasm;
            mode = #upgrade;
            canister_id = caller;
            });
    }
}