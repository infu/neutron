import esbuild from "esbuild";

let ctx = await esbuild.context({
  entryPoints: ["./src/index.js"],
  outfile: "./dist/main.js",
  bundle: true,
  external: [],
  format: "esm",
  jsx: "automatic",
  loader: { ".js": "jsx" },
  platform: "browser",
});
await ctx.watch();

console.log("Watching local files for changes...");
