import { collect } from "./collect_modules.js";
import { unpack, prepare_files } from "./install.js";
import { config } from "../config.js";

export async function get_app_details(neutron, pkg) {
  const unpacked = await unpack(pkg);
  console.log(unpacked);

  const neutronConfig = JSON.parse(
    new TextDecoder().decode(unpacked["neutron.json"])
  );

  console.log("App neutron config:", neutronConfig);
  const urlName = neutronConfig.id;
  if (
    typeof urlName !== "string" ||
    urlName.length < 4 ||
    urlName.length > 30 ||
    /[^a-z_0-9]/.test(urlName)
  ) {
    throw new Error("Invalid app name");
  }
  const isKernel = urlName === "kernel";

  let files = await prepare_files(
    neutron,
    unpacked,
    urlName,
    "mo/",
    isKernel ? "" : "app/" + urlName + "/",
    config.neutron_id
  );
  console.log(files);

  let lib = collect();
  return { files, neutronConfig, lib };
}
