import type { Config } from "drizzle-kit";

// `drizzle-kit generate` (the only command wired into package.json — see db:generate) diffs
// src/infrastructure/db/schema against the existing migration journal and needs no live DB
// connection. dbCredentials is only required for drizzle-kit commands this project doesn't
// use (push, pull, studio) — migrations are applied by our own script (db:migrate), per
// 14_DEPLOYMENT.md §14.5's "migrations run as a release step, not on application boot", which
// drizzle-kit's own migrate command doesn't model.
export default {
  schema: "./src/infrastructure/db/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
} satisfies Config;
