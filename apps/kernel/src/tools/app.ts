import {
  preparePackageInstall,
  type PreparePackageInstallOptions,
  type PreparedPackageInstall,
} from "neutron-compiler/src/install.js";

export type KernelAppDetails = {
  files: PreparedPackageInstall["files"];
  neutronConfig: PreparedPackageInstall["manifest"];
  lib: [];
  preparedPackage: PreparedPackageInstall;
};

export async function get_app_details(
  _neutron: unknown,
  pkg: Uint8Array,
  options: PreparePackageInstallOptions = {},
): Promise<KernelAppDetails> {
  const preparedPackage = preparePackageInstall(pkg, options);
  return {
    files: preparedPackage.files,
    neutronConfig: preparedPackage.manifest,
    lib: [],
    preparedPackage,
  };
}
