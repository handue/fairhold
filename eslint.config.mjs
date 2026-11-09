import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Glim decides inside a mandate and code enforces it: Glim's modules can never reach PayPal, and
// src/server/glim cannot write to the database or call the engine's actions at all
// (docs/planning/glim-autopilot.md §5.6).
const NO_PAYPAL = [
  { group: ["@/server/paypal", "@/server/paypal/*"], message: "Glim and the plan writer never call PayPal." },
  { group: ["@paypal/*"], message: "Glim and the plan writer never call PayPal." },
];
const ENGINE_WRITES = [
  "placeBid",
  "setMaxBid",
  "createLimits",
  "removeLimit",
  "pauseLimits",
  "resumeLimits",
  "closeDueLots",
  "closeEvent",
  "startEngineTick",
  "createEngineTick",
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["src/server/plans/**", "src/server/chat/**"],
    rules: { "no-restricted-imports": ["error", { patterns: NO_PAYPAL }] },
  },
  {
    files: ["src/server/glim/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "pg", message: "Glim cannot touch the database; src/server/plans writes plans." },
            { name: "@/server/engine", importNames: ENGINE_WRITES, message: "Glim cannot bid; src/server/plans applies its decisions." },
          ],
          patterns: [
            ...NO_PAYPAL,
            { group: ["@/server/db", "@/server/db/*"], message: "Glim cannot touch the database; src/server/plans writes plans." },
            {
              group: [
                "@/server/engine/actions",
                "@/server/engine/closing",
                "@/server/engine/pg-store",
                "@/server/engine/tick",
                "@/server/engine/bidding-power",
              ],
              message: "Glim cannot bid; src/server/plans applies its decisions.",
            },
            { group: ["@/server/plans", "@/server/plans/*"], message: "The plan writer depends on Glim, not the other way round." },
          ],
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    // Side-by-side dev servers' build folders (NEXT_DIST_DIR=.next-<name>).
    ".next-*/**",
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
