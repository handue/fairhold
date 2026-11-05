import type { TestProject } from "vitest/node";

import { dropRunDatabases, prepareTemplateDatabase, resolveAdminUrl } from "./database";

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const config = await prepareTemplateDatabase(resolveAdminUrl());
  project.provide("testDatabase", config);
  return () => dropRunDatabases(config);
}
