import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
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
