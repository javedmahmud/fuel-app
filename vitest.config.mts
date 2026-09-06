import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Integration tests need a real Postgres and live in vitest.integration.config.mts
    // (npm run test:integration) instead — this is the config CI runs on every PR, and CI
    // doesn't have DATABASE_URL configured as a secret (a deliberate choice so far, not an
    // oversight — see the db-schema branch's commit message for the reasoning).
    exclude: ["**/*.integration.test.ts", "node_modules/**"],
    // Sprint 1's foundation branch has almost nothing to test yet — later branches
    // (feature/db-schema, feature/fuel-api-adapter, ...) add real coverage. Failing CI
    // for having no tests yet would defeat the point of wiring CI up early.
    passWithNoTests: true,
  },
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
    },
  },
});
