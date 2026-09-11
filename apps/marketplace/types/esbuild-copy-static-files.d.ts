declare module "esbuild-copy-static-files" {
  import type { Plugin } from "esbuild";

  export type CopyStaticFilesOptions = {
    src: string;
    dest: string;
    dereference?: boolean;
    errorOnExist?: boolean;
    preserveTimestamps?: boolean;
    recursive?: boolean;
  };

  export default function copyStaticFiles(
    options: CopyStaticFilesOptions
  ): Plugin;
}
