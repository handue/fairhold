/**
 * Postgres for integration tests. The Vitest global setup migrates one template database per
 * run; every integration test file then gets its own copy of it, so files can run in parallel
 * and never see each other's rows.
 *
 * In a test file:
 *
 *   import { getTestDatabase } from "../helpers/database";
 *   const { db, pool, url } = getTestDatabase();
 *
 * Code under test that calls getDb() reaches the same database, because the integration setup
 * points DATABASE_URL at it before the file is imported.
 */
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import pg from "pg";

import { createDatabaseClient, type DatabaseClient } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";

/** The admin database of the local server from `npm run db:start`; CI sets DATABASE_URL instead. */
export const DEFAULT_ADMIN_URL = "postgres://postgres:postgres@localhost:54329/postgres";

const NAME_PREFIX = "fh_test";
const STALE_NAME = /^fh_test_(\d+)_/;
/** Databases left behind by an interrupted run are dropped by a later run once this old. */
const STALE_AFTER_SECONDS = 6 * 60 * 60;

export interface TestDatabaseConfig {
  adminUrl: string;
  templateName: string;
  namePrefix: string;
}

declare module "vitest" {
  export interface ProvidedContext {
    testDatabase: TestDatabaseConfig;
  }
}

export interface TestDatabase extends DatabaseClient {
  name: string;
  url: string;
  dispose(): Promise<void>;
}

export function resolveAdminUrl(): string {
  return process.env.DATABASE_URL || DEFAULT_ADMIN_URL;
}

function urlForDatabase(serverUrl: string, name: string): string {
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

function redact(serverUrl: string): string {
  const url = new URL(serverUrl);
  if (url.password) url.password = "***";
  return url.toString();
}

async function withAdminClient<T>(adminUrl: string, run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: adminUrl });
  try {
    await client.connect();
  } catch (error) {
    throw new Error(
      `Cannot reach Postgres at ${redact(adminUrl)}. Run "npm run db:start", or set DATABASE_URL to a server you can create databases on.`,
      { cause: error },
    );
  }
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

async function dropDatabase(client: pg.Client, name: string): Promise<void> {
  await untilDisconnected(client, name);
  await client.query(`drop database if exists ${pg.escapeIdentifier(name)} with (force)`);
}

/**
 * pg's Pool.end() resolves once it has asked every connection to close, not once they are gone.
 * A forced drop in that gap terminates them, and a test's own pool without an error listener
 * then fails the run with an unhandled 57P01 (seen in CI on a 50-connection pool). The drop still
 * forces whatever is left after the timeout.
 */
async function untilDisconnected(client: pg.Client, name: string, timeoutMs = 5_000): Promise<void> {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; ) {
    const { rows } = await client.query<{ connected: number }>(
      "select count(*)::int as connected from pg_stat_activity where datname = $1",
      [name],
    );
    if ((rows[0]?.connected ?? 0) === 0) return;
    await sleep(20);
  }
}

async function listDatabases(client: pg.Client, prefix: string): Promise<string[]> {
  const result = await client.query<{ datname: string }>(
    "select datname from pg_database where starts_with(datname, $1)",
    [prefix],
  );
  return result.rows.map((row) => row.datname);
}

async function dropStaleDatabases(client: pg.Client): Promise<void> {
  const cutoff = Math.floor(Date.now() / 1000) - STALE_AFTER_SECONDS;
  for (const name of await listDatabases(client, `${NAME_PREFIX}_`)) {
    const createdAt = Number(STALE_NAME.exec(name)?.[1]);
    if (createdAt < cutoff) await dropDatabase(client, name);
  }
}

/** Global setup: creates this run's template database and applies every migration to it. */
export async function prepareTemplateDatabase(adminUrl: string): Promise<TestDatabaseConfig> {
  // Names carry their creation time so a later run can tell abandoned databases from live ones.
  const namePrefix = `${NAME_PREFIX}_${Math.floor(Date.now() / 1000)}_${randomBytes(3).toString("hex")}`;
  const templateName = `${namePrefix}_template`;

  await withAdminClient(adminUrl, async (client) => {
    await dropStaleDatabases(client);
    await client.query(`create database ${pg.escapeIdentifier(templateName)}`);
  });

  const template = createDatabaseClient(urlForDatabase(adminUrl, templateName), { maxConnections: 1 });
  try {
    await runMigrations(template.db);
  } finally {
    // CREATE DATABASE ... TEMPLATE fails while anyone is connected to the template.
    await template.pool.end();
  }
  return { adminUrl, templateName, namePrefix };
}

/** Global teardown: drops the template and every per-file database of this run. */
export async function dropRunDatabases({ adminUrl, namePrefix }: TestDatabaseConfig): Promise<void> {
  await withAdminClient(adminUrl, async (client) => {
    for (const name of await listDatabases(client, namePrefix)) {
      await dropDatabase(client, name);
    }
  });
}

export async function createTestDatabase(config: TestDatabaseConfig): Promise<TestDatabase> {
  const name = `${config.namePrefix}_${randomBytes(4).toString("hex")}`;
  await withAdminClient(config.adminUrl, async (client) => {
    await client.query(
      `create database ${pg.escapeIdentifier(name)} template ${pg.escapeIdentifier(config.templateName)}`,
    );
  });

  const url = urlForDatabase(config.adminUrl, name);
  const client = createDatabaseClient(url, { maxConnections: 4 });
  return {
    ...client,
    name,
    url,
    async dispose() {
      await client.pool.end();
      await withAdminClient(config.adminUrl, (admin) => dropDatabase(admin, name));
    },
  };
}

let current: TestDatabase | undefined;

/** Integration setup: creates this file's database and points DATABASE_URL at it. */
export async function attachTestDatabase(config: TestDatabaseConfig): Promise<TestDatabase> {
  current = await createTestDatabase(config);
  process.env.DATABASE_URL = current.url;
  return current;
}

/** The fresh database the current integration test file runs against. */
export function getTestDatabase(): TestDatabase {
  if (!current) {
    throw new Error("No test database: integration tests belong in tests/integration/.");
  }
  return current;
}
