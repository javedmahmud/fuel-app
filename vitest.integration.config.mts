import { defineConfig } from "vitest/config";

// Integration tests need a real Postgres and are NOT run by CI or by plain `npm test` — run
// them locally against the real staging database, without ever typing the credential
// yourself:
//
//   railway run -- npm run test:integration
//
// railway run injects DATABASE_URL into this one process only; it's never written to a file
// or pasted anywhere. Whether to eventually wire this into CI (which would mean adding
// DATABASE_URL as a GitHub Actions secret) is a deliberate decision left open, not an
// oversight — see the db-schema branch's commit message.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.integration.test.ts"],
    // Integration tests share one real database and must not run concurrently against it —
    // sequential execution matters more here than speed.
    fileParallelism: false,
    // No DB reachable = nothing to test. Fail loudly rather than silently reporting green.
    passWithNoTests: false,
  },
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
    },
  },
});
