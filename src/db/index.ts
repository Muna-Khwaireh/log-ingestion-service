import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema.js";

let dbInstance: ReturnType<typeof drizzle<typeof schema>> | undefined;
let clientInstance: ReturnType<typeof postgres> | undefined;

function positiveIntFromEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);

  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function connect() {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }

  // postgres.js defaults to a pool of 10. Under load the generator opens far
  // more concurrent requests than that, and every request that cannot get a
  // connection simply waits -- which showed up as p95 latencies of tens of
  // seconds while both containers sat almost idle. PostgreSQL only has 1 CPU
  // here, so the pool is widened rather than made unbounded: too many backends
  // would trade queueing for context switching.
  const client = postgres(connectionString, {
    max: positiveIntFromEnv("DATABASE_POOL_MAX", 24),

    // Never let a request block forever waiting for a backend; failing fast
    // lets the handler shed load with a 503 instead of holding the socket open
    // until the client times out.
    connect_timeout: positiveIntFromEnv("DATABASE_CONNECT_TIMEOUT_S", 10),
  });

  const db = drizzle(client, {
    schema,
  });

  clientInstance = client;
  dbInstance = db;

  return { client, db };
}

export function getDb() {
  return dbInstance ?? connect().db;
}


export function getClient() {
  return clientInstance ?? connect().client;
}

export async function closeDb() {
  if (clientInstance) {
    await clientInstance.end();
    clientInstance = undefined;
    dbInstance = undefined;
  }
}