import { getIC } from "../reducer/auth";
import { config } from "../config";
import plimit from "p-limit";
import { getNeutronCan } from "../reducer/auth.js";

export async function collect() {
  const can = await getNeutronCan();
  let list = await can.kernel_static_query({ list: { prefix: "/mo" } });

  const limit = plimit(10);
  const files = await Promise.all(
    list.map((path) =>
      limit(() =>
        fetch(path).then(async (x) => ({ path, content: await x.text() }))
      )
    )
  );

  return files;
}
