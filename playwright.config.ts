import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./spec/e2e",
  fullyParallel: true,
  reporter: "list",
  use: {
    baseURL: "http://localhost:5173",
    trace: "on-first-retry",
    launchOptions: {
      args: ["--enable-features=FileSystemAccessAPI,FileSystemAccessAPIAllWorkers,OPFSDirectAccess"],
    },
  },
  webServer: {
    command: "pnpm dev",
    port: 5173,
    reuseExistingServer: true,
    timeout: 120_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
