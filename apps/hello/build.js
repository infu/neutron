import esbuild from "esbuild";
import copyStaticFiles from "esbuild-copy-static-files";

const config = {
  entryPoints: ["./src/index.js"],
  outfile: "./dist/web/main.js",
  bundle: true,
  minify: true,
  external: [],
  format: "esm",
  jsx: "automatic",
  loader: { ".js": "jsx" },
  platform: "browser",
  plugins: [
    copyStaticFiles({
      src: "./public",
      dest: "./dist/web",
      dereference: true,
      errorOnExist: false,
      preserveTimestamps: true,
      recursive: true,
    }),
  ],
};

var args = process.argv.slice(2);

if (args[0] === "watch") {
  let ctx = await esbuild.context(config);
  await ctx.watch();

  console.log("Watching local files for changes...");
} else {
  esbuild.build(config).catch(() => process.exit(1));
}
