import { build } from "esbuild";

const action = process.argv[2];
if (action !== "collect" && action !== "apply") {
  throw new Error("Usage: build.mjs collect|apply");
}

await build({
  entryPoints: [`packages/${action}/src/index.ts`],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  outfile: `dist/${action}/index.js`,
  minify: true,
  banner: {
    js: 'var import_meta_url = require("node:url").pathToFileURL(__filename).href;',
  },
  define: { "import.meta.url": "import_meta_url" },
  plugins: [
    {
      name: "runtime-package-metadata",
      setup(build) {
        // Both bundles live two directories below the shipped package.json.
        // Keep release-please version bumps independent of bundle generation.
        build.onResolve(
          { filter: /^\.\.\/\.\.\/\.\.\/package\.json$/ },
          () => ({
            path: "../../package.json",
            external: true,
          }),
        );
      },
    },
  ],
});
