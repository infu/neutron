import esbuild from "esbuild";
import copyStaticFiles from "esbuild-copy-static-files";
import { readFile, writeFile } from "node:fs/promises";
import { sassPlugin } from "esbuild-sass-plugin";

const names = ["main", "service", "tray"];
const options: esbuild.BuildOptions = {
  entryPoints: { main: "src/index.tsx", service: "src/service.ts", tray: "src/tray.tsx" },
  outdir: "dist/web",
  entryNames: "[name]",
  bundle: true,
  minify: true,
  format: "esm",
  jsx: "automatic",
  platform: "browser",
  plugins: [
    sassPlugin(),
    copyStaticFiles({ src: "public", dest: "dist/web", recursive: true }),
    { name: "local-react-diagnostics", setup(build) {
      build.onEnd(async ({ errors }) => {
        if (errors.length) return;
        for (const name of names) {
          const path = `dist/web/${name}.js`;
          const source = await readFile(path, "utf8");
          await writeFile(path, source.replaceAll("https://react.dev/errors/", "#react-error-"));
        }
      });
    } },
  ],
};
if (process.argv.includes("watch")) await (await esbuild.context(options)).watch();
else await esbuild.build(options);
