import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Lets CLI scripts read .env.local the way `next dev` does. Variables already set in the
 * environment (CI, Render, an inline override) win, and deploys have no .env.local at all.
 */
export function loadLocalEnv(file: string = path.join(process.cwd(), ".env.local")): void {
  if (existsSync(file)) {
    process.loadEnvFile(file);
  }
}
