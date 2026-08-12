import { and ,desc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { logs } from "../db/schema.js";
import type { LogQuery } from "../logs/log.types.js";

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

export async function getLogs(query: LogQuery) {
  const conditions = [];

  if (query.service) {
    conditions.push(eq(logs.service, query.service));
  }

  if (query.level) {
    conditions.push(eq(logs.level, query.level));
  }

  let selectStatement = db
    .select()
    .from(logs)
    .where(and(...conditions))
    .orderBy(desc(logs.timestamp))
    .$dynamic();

  if (query.limit !== undefined) {
    selectStatement = selectStatement.limit(query.limit);
  }

  if (query.offset !== undefined) {
    selectStatement = selectStatement.offset(query.offset);
  }

  return selectStatement;
}