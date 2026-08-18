import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema.js";

let dbInstance: ReturnType<typeof drizzle<typeof schema>> | undefined;
let clientInstance: ReturnType<typeof postgres> | undefined;

export function getDb() {
  if (dbInstance) {
    return dbInstance;
  }

  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }

  clientInstance = postgres(connectionString);

  dbInstance = drizzle(clientInstance, {
    schema,
  });

  return dbInstance;
}

export async function closeDb() {
  if (clientInstance) {
    await clientInstance.end();
    clientInstance = undefined;
    dbInstance = undefined;
  }
}