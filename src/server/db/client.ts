import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";

import { getDatabaseUrl } from "@/server/lib/env";

import * as schema from "./schema";

export type Database = NodePgDatabase<typeof schema>;

export interface DatabaseClient {
  pool: pg.Pool;
  db: Database;
}

export interface DatabaseClientOptions {
  maxConnections?: number;
}

export function createDatabaseClient(
  connectionString: string,
  { maxConnections = 10 }: DatabaseClientOptions = {},
): DatabaseClient {
  const pool = new pg.Pool({
    connectionString,
    max: maxConnections,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
  // An idle client can lose its connection (database restart, failover). Without a listener the
  // pool re-emits that as an unhandled 'error' event, which crashes the process.
  pool.on("error", (error) => {
    console.error("[db] idle client error:", error.message);
  });
  return { pool, db: drizzle({ client: pool, schema }) };
}

// Next.js dev re-evaluates modules on every reload; keeping the client on globalThis stops each
// reload from opening another pool.
const processGlobal = globalThis as typeof globalThis & { __fairholdDatabase?: DatabaseClient };

/** The process-wide client, created on first use from DATABASE_URL. */
export function getDatabaseClient(): DatabaseClient {
  processGlobal.__fairholdDatabase ??= createDatabaseClient(getDatabaseUrl());
  return processGlobal.__fairholdDatabase;
}

export function getDb(): Database {
  return getDatabaseClient().db;
}

export function getPool(): pg.Pool {
  return getDatabaseClient().pool;
}

export async function closeDatabaseClient(): Promise<void> {
  const client = processGlobal.__fairholdDatabase;
  processGlobal.__fairholdDatabase = undefined;
  await client?.pool.end();
}

/**
 * A dedicated connection for LISTEN, outside the pool: a pooled client goes back to the pool
 * after each query and its subscriptions go with it. The caller owns it and must end() it.
 */
export async function openListenConnection(
  connectionString: string = getDatabaseUrl(),
): Promise<pg.Client> {
  const client = new pg.Client({ connectionString, keepAlive: true });
  await client.connect();
  return client;
}
