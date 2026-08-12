import { desc } from "drizzle-orm";
import { db } from "../db/index.js";
import { logs } from "../db/schema.js";

export type NewLog = {
  timestamp: Date;
  level: string;
  service: string;
  message: string;
  attributes: Record<string, string | number | boolean>;
};

export async function insertLogs(entries: NewLog[]) {
  if (entries.length === 0) {
    return;
  }

  await db.insert(logs).values(entries);
}

export async function getLogs() {
  return db.select().from(logs).orderBy(desc(logs.timestamp));
}