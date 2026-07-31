import {
  chunkBytes,
  preparePackageFiles,
  unpackNeutronPackage,
  uploadPreparedFiles,
  type KernelStaticWriter,
  type PreparedPackageFile,
  type UnpackedNeutronPackage,
} from "neutron-compiler/src/install.js";

export function unpack(pkg: Uint8Array): UnpackedNeutronPackage {
  return unpackNeutronPackage(pkg);
}

export const chunkfile = chunkBytes;

export async function prepare_files(
  pkg: UnpackedNeutronPackage,
  mo_prefix: string,
  app_prefix: string
): Promise<PreparedPackageFile[]> {
  return preparePackageFiles(pkg, {
    moPrefix: mo_prefix,
    appPrefix: app_prefix,
  });
}

export async function upload_files(
  neutron: KernelStaticWriter,
  files: PreparedPackageFile[]
): Promise<void> {
  await uploadPreparedFiles(neutron, files);
}
