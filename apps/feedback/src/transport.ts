import { HttpAgent, type Identity } from "@dfinity/agent";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { bytes, unwrap, type Kernel } from "./store_state.ts";
import { CONTRACT, type Contract, type Method } from "./protocol.ts";
import { PROTOCOL_CANISTER, PROTOCOL_HOST } from "./config.ts";
export type QueryAgent = Pick<HttpAgent, "query">;
export async function makeAgent(identity: Identity): Promise<QueryAgent> {
  return HttpAgent.create({ host: PROTOCOL_HOST, identity });
}
export function makeTransport(input: { kernel: Kernel; agent: QueryAgent; contract?: Contract }) {
  const canister = Principal.fromText(PROTOCOL_CANISTER);
  const contract = input.contract ?? CONTRACT;
  function signature(name: string, update: boolean): Method {
    const method = contract[name];
    if (!method || method.update !== update) throw new Error(`Feedback does not expose ${name} as a ${update ? "write" : "read"}.`);
    return method;
  }
  function decode<T>(method: Method, value: unknown): T {
    return IDL.decode(method.returns, bytes(value))[0] as T;
  }
  return {
    async query<T>(name: string, args: unknown[] = []): Promise<T> {
      const method = signature(name, false);
      const result = await input.agent.query(canister, { methodName: name, arg: IDL.encode(method.args, args) });
      if (result.status !== "replied") throw new Error(`Feedback could not be read: ${result.reject_message}`);
      return decode<T>(method, result.reply.arg);
    },
    async update<T>(name: string, args: unknown[]): Promise<T> {
      const method = signature(name, true);
      // The backend pins both destination and zero attached cycles. Keeping
      // this exact kernel preserves the current Agent invocation's authority.
      const value = await input.kernel.updateSelf("feedback_call", [{ method: name, args: new Uint8Array(IDL.encode(method.args, args)) }], 0);
      return decode<T>(method, unwrap(value));
    },
  };
}
export type ProtocolTransport = ReturnType<typeof makeTransport>;
