import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema.js";

let dbInstance: ReturnType<typeof drizzle<typeof schema>> | undefined;
let clientInstance: ReturnType<typeof postgres> | undefined;

function connect() {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }

  const client = postgres(connectionString);
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