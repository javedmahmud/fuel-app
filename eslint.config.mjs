import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // The esbuild-bundled worker output — drizzle-orm/postgres/zod's own bundled source ends
    // up in here, which isn't ours to lint. CI never sees this (it lints before the build step
    // creates dist/), but a locally-lingering dist/ from a manual `npm run worker:build` run
    // was getting picked up here — found in practice, not hypothetical.
    "dist/**",
  ]),
]);

export default eslintConfig;
