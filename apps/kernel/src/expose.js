import { exec, expose } from "neutron-tools";
import { getIC, getNeutronCan } from "./reducer/auth";
import { callRequest } from "./reducer/request";
import { store } from "./store";
import { neutron_id } from "./config";

expose("call", async ({ canister, method, args, did = false }) => {
  // TODO: check whitelisted

  if (neutron_id === canister) {
    let neutron = await getNeutronCan();
    return await neutron[method](args);
  } else {
    let can = await getIC()(canister, did);
    return can[method](args);
  }
});

expose("call_dialog", async ({ canister, method, args, did = false }) => {
  await store.dispatch(callRequest({ canister, method, args, did }));

  if (neutron_id === canister) {
    let neutron = await getNeutronCan();
    return await neutron[method](args);
  } else {
    let can = await getIC()(canister, did);
    return can[method](args);
  }
});
