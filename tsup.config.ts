import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  splitting: false,
  minify: false,
  // Keep heavy/runtime deps external so the SDK stays tree-shakeable and the
  // consumer resolves them (radiantjs is large; ws is Node-only; cbor-x ships
  // its own native/wasm paths).
  external: ["@radiant-core/radiantjs", "cbor-x", "ws"],
  outExtension({ format }) {
    return { js: format === "cjs" ? ".cjs" : ".js" };
  },
});
