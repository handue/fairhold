import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    // Tests never read .env.local. These placeholders keep them hermetic and keyless.
    env: {
      PAYMENTS_MODE: "simulated",
      GLIM_MODE: "recorded",
      ENGINE_ENABLED: "false",
      SESSION_SECRET: "test-only-".repeat(4),
      CRON_SECRET: "test-only-".repeat(4),
    },
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts", "src/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          // Connects to DATABASE_URL (default: the local server on port 54329) and gives each
          // test file its own freshly migrated database. See tests/helpers/database.ts.
          globalSetup: ["tests/helpers/global-setup.ts"],
          setupFiles: ["tests/helpers/integration-setup.ts"],
          hookTimeout: 30_000,
          testTimeout: 30_000,
        },
      },
    ],
  },
});
