import { defineConfig } from "vite";

export default defineConfig({
  // Isolated review copies can share node_modules, but must not overwrite one
  // another's Babylon module cache (loader registration depends on identity).
  cacheDir: "tmp/vite",
  server: {
    port: 4173,
  },
  preview: {
    port: 4173,
  },
  build: {
    target: "es2022",
    sourcemap: false,
  },
});
