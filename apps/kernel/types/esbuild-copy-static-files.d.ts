declare module "esbuild-copy-static-files" {
  import type { Plugin } from "esbuild";

  export default function copyStaticFiles(options: {
    src: string;
    dest: string;
    dereference?: boolean;
    errorOnExist?: boolean;
    filter?: RegExp;
    preserveTimestamps?: boolean;
    recursive?: boolean;
  }): Plugin;
}
