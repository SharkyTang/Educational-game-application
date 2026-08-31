import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

/** Independent production export: shared-file HMR cannot interrupt a model download. */
export default defineConfig({
  ...base,
  testMatch: "**/equipment-library.spec.ts",
  workers: 1,
  outputDir: "./tmp/equipment-library-playwright",
  use: { ...base.use, baseURL: "http://127.0.0.1:4213" },
  webServer: {
    command: "npx vite build --outDir tmp/equipment-library-dist && npx vite preview --outDir tmp/equipment-library-dist --host 127.0.0.1 --port 4213 --strictPort",
    url: "http://127.0.0.1:4213",
    reuseExistingServer: false,
  },
});
