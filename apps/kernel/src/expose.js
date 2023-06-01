import { exec, expose } from "neutron-tools";
import { getIC } from "./reducer/auth";
import { callRequest } from "./reducer/request";
import { store } from "./store";

expose("call", async ({ canister, method, args }) => {
  let ic = getIC();
  let can = await ic(canister);
  return can[method](args);
});

expose("call_dialog", async ({ canister, method, args }) => {
  await store.dispatch(callRequest({ canister, method, args }));

  let ic = getIC();
  let can = await ic(canister);
  return can[method](args);
});
