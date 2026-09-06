import { defineConfig, devices } from "@playwright/test";

const PORT = 3000;
const BASE = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: BASE,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command:
      "npx tsx src/db/migrate.ts --reset && npx tsx src/db/seed.ts --force && npx next dev -p 3000",
    url: BASE,
    reuseExistingServer: false,
    timeout: 240000,
    env: {
      LLM_PROVIDER: "mock",
      DATABASE_PATH: "./data/e2e.db",
      SESSION_SECRET: "e2e-secret",
      APPROVAL_TTL_HOURS: "72",
    },
  },
});
