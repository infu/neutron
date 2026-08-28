declare module "*.wasm" {
  const url: string;
  export default url;
}

declare module "@jitl/quickjs-wasmfile-release-sync/wasm" {
  const url: string;
  export default url;
}
