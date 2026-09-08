import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4201",
    // Per-action canvas screencasts can delay keyup long enough to overshoot
    // real 3D walking targets. Keep the action trace and failure screenshot.
    trace: { mode: "retain-on-failure", screenshots: false, snapshots: false },
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 4201 --strictPort",
    url: "http://127.0.0.1:4201",
    reuseExistingServer: false,
  },
  projects: [
    {
      name: "chromium-desktop",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
