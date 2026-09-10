import { expect, test } from "bun:test";
import { Cbor } from "@dfinity/agent";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { observe } from "./run.ts";

test("the installed-browser observer decodes Playwright Buffer bodies without losing relays", () => {
  const owner = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");
  const protocol = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");
  const sender = Principal.selfAuthenticating(new Uint8Array(32).fill(3));
  let onRequest: (request: any) => void = () => { throw Error("No observer"); };
  const context = { on(name: string, handler: typeof onRequest) { if (name === "request") onRequest = handler; }, async route() {} };
  const runtime = { canisterId: owner.toText(), protocolId: protocol.toText(), relayMethod: "app_marketplace__marketplace_call" };
  const result = observe(context as any, runtime as any);
  const relay = IDL.Record({ canister: IDL.Principal, method: IDL.Text, args: IDL.Vec(IDL.Nat8), cycles: IDL.Nat });
  function request(canister: Principal, method: string, args: Uint8Array, kind: string, delegation = false) {
    const body = Buffer.from(Cbor.encode({ content: { request_type: kind, canister_id: canister.toUint8Array(), method_name: method, arg: args, sender: sender.toUint8Array(), ingress_expiry: 1234567890123456789n },
      ...(delegation ? { sender_delegation: [{ delegation: { pubkey: new Uint8Array(32), expiration: 1234567890123456789n, targets: [protocol.toUint8Array()] }, signature: new Uint8Array(64) }] } : {}),
    }));
    onRequest({ url: () => `http://localhost:8000/api/v2/canister/${canister}/` + kind, postDataBuffer: () => body });
  }
  request(owner, runtime.relayMethod, new Uint8Array(IDL.encode([relay], [{ canister: protocol, method: "read_delegate_set", args: new Uint8Array(), cycles: 1_000_000n }])), "call");
  request(protocol, "library_query", new Uint8Array(IDL.encode([], [])), "query", true);
  expect(result.errors).toEqual([]);
  expect([...result.relays.values()]).toEqual(["read_delegate_set"]);
  expect(result.privateQueries).toEqual([{ method: "library_query", canisterId: protocol.toText(), sender: sender.toText(), delegationTargets: [[protocol.toText()]] }]);
});
