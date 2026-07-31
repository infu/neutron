export type PreparedPackageFile = {
  path: string;
  content: Uint8Array;
};

export const KERNEL_CANDID_PACKAGE_PATH = "pkg/neutron.did";
export const KERNEL_STABLE_TYPES_PACKAGE_PATH = "pkg/neutron.most";

export function withKernelCandid<T extends PreparedPackageFile>(
  files: T[],
  candid: Uint8Array,
): PreparedPackageFile[] {
  return [
    ...files.filter(({ path }) => path !== KERNEL_CANDID_PACKAGE_PATH),
    { path: KERNEL_CANDID_PACKAGE_PATH, content: candid },
  ];
}

export function withKernelBuildMetadata<T extends PreparedPackageFile>(
  files: T[],
  candid: Uint8Array,
  stableTypes: Uint8Array,
): PreparedPackageFile[] {
  return [
    ...files.filter(
      ({ path }) =>
        path !== KERNEL_CANDID_PACKAGE_PATH &&
        path !== KERNEL_STABLE_TYPES_PACKAGE_PATH,
    ),
    { path: KERNEL_CANDID_PACKAGE_PATH, content: candid },
    { path: KERNEL_STABLE_TYPES_PACKAGE_PATH, content: stableTypes },
  ];
}
