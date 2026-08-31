import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

/** Isolated production build: concurrent source edits cannot reload an active export. */
export default defineConfig({
  ...base,
  testMatch: "**/product-library.spec.ts",
  workers: 1,
  outputDir: "./tmp/product-library-playwright",
  use: { ...base.use, baseURL: "http://127.0.0.1:4211" },
  webServer: {
    command: "npx vite build --outDir tmp/product-library-dist && npx vite preview --outDir tmp/product-library-dist --host 127.0.0.1 --port 4211 --strictPort",
    url: "http://127.0.0.1:4211",
    reuseExistingServer: false,
  },
});
