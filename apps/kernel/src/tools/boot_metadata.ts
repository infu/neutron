import {
  createJsonAsset,
  type AppRegistry,
  type StaticFileOperation,
} from "neutron-compiler/src/install.js";

export function createBootMetadataAssets({
  appConfig,
  canisterId,
}: {
  appConfig: AppRegistry;
  canisterId: string;
}): StaticFileOperation[] {
  return [
    createJsonAsset("/system/apps.json", appConfig),
    createJsonAsset("/pkg/id.json", { id: canisterId }),
  ];
}
