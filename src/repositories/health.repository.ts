import { sql } from "drizzle-orm";
import { getDb } from "../db/index.js";

export async function pingDb(): Promise<void> {
  await getDb().execute(sql`SELECT 1`);
}
