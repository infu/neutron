import { collect } from "./collect_modules.js";
import { unpack, prepare_files } from "./install.js";
import { validate_neutron_conf } from "neutron-tools/src/validate_schema.js";

export async function get_app_details(neutron, pkg) {
  const unpacked = await unpack(pkg);
  console.log(unpacked);

  const neutronConfig = JSON.parse(
    new TextDecoder().decode(unpacked["neutron.json"])
  );

  let validate_result = validate_neutron_conf(neutronConfig);
  if (validate_result.errors.length > 0) {
    console.log("neutron.json validation errors:");
    for (let error of validate_result.errors) {
      console.log(error.stack);
    }
    throw new Error("Invalid neutron.json");
  }
  console.log("neutron.json valid");

  // Double check that the neutron.json id is valid
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
    unpacked,
    "mo/",
    isKernel ? "" : "app/" + urlName + "/"
  );
  console.log(files);

  let lib = collect();
  return { files, neutronConfig, lib };
}
