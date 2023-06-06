import { exec, expose } from "neutron-tools";
import { getIC, getNeutronCan } from "./reducer/auth";
import { callRequest } from "./reducer/request";
import { store } from "./store";
import { config } from "./config";

expose("call", async ({ canister, method, args, did = false }) => {
  // TODO: check whitelisted
  let can =
    canister === config.neutron_id
      ? await getNeutronCan()
      : await getIC()(canister, did);
  return can[method](args);
});

expose("call_dialog", async ({ canister, method, args, did = false }) => {
  await store.dispatch(callRequest({ canister, method, args, did }));

  let can =
    canister === config.neutron_id
      ? await getNeutronCan()
      : await getIC()(canister, did);

  return can[method](args);
});
