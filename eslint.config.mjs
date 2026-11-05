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
    // Generated or local-only output, and the read-only design files.
    ".pgdata/**",
    "drizzle/**",
    "coverage/**",
    "playwright-report/**",
    "test-results/**",
    "mockups/**",
  ]),
]);

export default eslintConfig;
