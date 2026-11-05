/**
 * Local Postgres 16 for development and tests. The real Postgres binaries come from the
 * embedded-postgres npm package, and pg_ctl runs the server as a daemon that outlives this script.
 *
 *   npm run db:start    initdb on first run, start the daemon, create the app databases
 *   npm run db:stop     stop the daemon
 *   npm run db:status   report whether it is running (exit codes follow pg_ctl status)
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";

const DATA_DIR = path.join(process.cwd(), ".pgdata");
const LOG_FILE = path.join(DATA_DIR, "server.log");
const PORT = 54329;
const USER = "postgres";
const PASSWORD = "postgres";
const DATABASES = ["fairhold_dev", "fairhold_test"];

const PG_CTL_NOT_RUNNING = 3;
const PG_CTL_NO_DATA_DIR = 4;

interface PostgresBinaries {
  pg_ctl: string;
  initdb: string;
  postgres: string;
}

async function loadBinaries(): Promise<PostgresBinaries> {
  // embedded-postgres ships one optional package per platform holding the binaries.
  const binaries: unknown = await import(`@embedded-postgres/${process.platform}-${process.arch}`);
  return binaries as PostgresBinaries;
}

function pgCtl(binaries: PostgresBinaries, args: string[], stdio: "inherit" | "ignore" = "ignore") {
  const result = spawnSync(binaries.pg_ctl, [...args, `--pgdata=${DATA_DIR}`], { stdio });
  if (result.error) throw result.error;
  return result.status;
}

function isInitialized(): boolean {
  return existsSync(path.join(DATA_DIR, "PG_VERSION"));
}

function isRunning(binaries: PostgresBinaries): boolean {
  return pgCtl(binaries, ["status"]) === 0;
}

async function initialize(): Promise<void> {
  console.log(`Creating a new cluster in ${DATA_DIR}`);
  await new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    port: PORT,
    user: USER,
    password: PASSWORD,
    authMethod: "scram-sha-256",
    persistent: true,
    // npm skips the package's postinstall, which restores library symlinks on some platforms.
    autoRehydrateSymlinks: true,
    initdbFlags: ["--encoding=UTF8", "--locale=en_US.UTF-8"],
    onLog: () => {},
  }).initialise();
}

async function ensureDatabases(): Promise<void> {
  const client = new pg.Client({
    host: "localhost",
    port: PORT,
    user: USER,
    password: PASSWORD,
    database: "postgres",
  });
  await client.connect();
  try {
    for (const name of DATABASES) {
      const existing = await client.query("select 1 from pg_database where datname = $1", [name]);
      if (existing.rowCount === 0) {
        await client.query(`create database ${pg.escapeIdentifier(name)}`);
        console.log(`Created database ${name}`);
      }
    }
  } finally {
    await client.end();
  }
}

async function start(): Promise<void> {
  const binaries = await loadBinaries();
  if (!isInitialized()) await initialize();

  if (isRunning(binaries)) {
    console.log(`Postgres is already running on port ${PORT}.`);
  } else {
    const status = pgCtl(
      binaries,
      [
        "start",
        "--wait",
        "--timeout=60",
        `--log=${LOG_FILE}`,
        `--options=-p ${PORT} -c listen_addresses=localhost`,
      ],
      "inherit",
    );
    if (status !== 0) throw new Error(`pg_ctl start failed (exit ${status}); see ${LOG_FILE}`);
  }

  await ensureDatabases();
  console.log(`Ready: postgres://${USER}:${PASSWORD}@localhost:${PORT}/${DATABASES[0]}`);
}

async function stop(): Promise<void> {
  const binaries = await loadBinaries();
  if (!isInitialized() || !isRunning(binaries)) {
    console.log("Postgres is not running.");
    return;
  }
  const status = pgCtl(binaries, ["stop", "--wait", "--mode=fast"], "inherit");
  if (status !== 0) throw new Error(`pg_ctl stop failed (exit ${status})`);
}

async function status(): Promise<void> {
  const binaries = await loadBinaries();
  if (!isInitialized()) {
    console.log(`No cluster in ${DATA_DIR} yet. Run: npm run db:start`);
    process.exitCode = PG_CTL_NO_DATA_DIR;
  } else if (isRunning(binaries)) {
    console.log(`Running on localhost:${PORT} (data ${DATA_DIR}, log ${LOG_FILE})`);
  } else {
    console.log("Stopped. Run: npm run db:start");
    process.exitCode = PG_CTL_NOT_RUNNING;
  }
}

const commands = new Map([
  ["start", start],
  ["stop", stop],
  ["status", status],
]);
const command = commands.get(process.argv[2] ?? "");

if (!command) {
  console.error("Usage: tsx scripts/db.ts <start|stop|status>");
  process.exitCode = 2;
} else {
  command().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
