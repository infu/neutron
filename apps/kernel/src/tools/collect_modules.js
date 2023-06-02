import { getIC } from "../reducer/auth";
import { config } from "../config";

export async function collect() {
  let ic = getIC();
  console.log({ ic });

  let can = await ic(config.neutron_id);
  console.log({ can });
  let list = await can.kernel_static_query({ list: { prefix: "/mo" } });
  console.log(list);
}
