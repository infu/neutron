import esbuild from "esbuild";
import { sassPlugin } from "esbuild-sass-plugin";
// const neutronModules = {
//   name: "neutron-modules",
//   setup: function (build) {
//     build.onResolve({ filter: /^neutron-.*/ }, function (args) {
//       return {
//         path: args.path,
//         external: true,
//       };
//     });
//   },
// };

const config = {
  entryPoints: ["./src/index.js"],
  outfile: "./dist/web/main.js",
  bundle: true,
  minify: true,
  define: {
    global: "window",
  },
  format: "esm",
  jsx: "automatic",
  loader: { ".js": "jsx" },
  plugins: [sassPlugin()],
  platform: "browser",
};

var args = process.argv.slice(2);

if (args[0] === "watch") {
  let ctx = await esbuild.context({ ...config, minify: false });
  await ctx.watch();

  console.log("Watching local files for changes...");
} else {
  esbuild.build(config).catch(() => process.exit(1));
}
