import { and, desc, eq, gte, ilike, lt, or, sql } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { logs } from "../db/schema.js";
import type {
  AggregateQuery,
  LogQuery,
} from "../logs/log.types.js";export type NewLog = {
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

  await getDb().insert(logs).values(entries);
}

export async function getLogs(query: LogQuery) {
  const conditions = [];

  if (query.service) {
    conditions.push(eq(logs.service, query.service));
  }

  if (query.level) {
    conditions.push(eq(logs.level, query.level));
  }

  if (query.since) {
  conditions.push(gte(logs.timestamp, query.since));
}

if (query.until) {
  conditions.push(lt(logs.timestamp, query.until));
}

  if (query.messageQuery) {
    conditions.push(ilike(logs.message, `%${query.messageQuery}%`));
  }

  if (query.attributeFilters) {
  for (const [key, value] of Object.entries(query.attributeFilters)) {
    conditions.push(
      sql`${logs.attributes} @> ${JSON.stringify({ [key]: value })}::jsonb`,
    );
  }
}

  if (query.cursor) {
    conditions.push(
      or(
        lt(logs.timestamp, query.cursor.timestamp),
        and(
          eq(logs.timestamp, query.cursor.timestamp),
          lt(logs.id, query.cursor.id),
        ),
      ),
    );
  }

  const rows = await getDb()
    .select()
    .from(logs)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(logs.timestamp), desc(logs.id))
    .limit(query.limit + 1);

  return rows;
}

export async function aggregateLogs(query: AggregateQuery) {
  const conditions = [
    gte(logs.timestamp, query.since),
    lt(logs.timestamp, query.until),
  ];

  if (query.service) {
    conditions.push(eq(logs.service, query.service));
  }

  if (query.level) {
    conditions.push(eq(logs.level, query.level));
  }

  if (query.messageQuery) {
    conditions.push(ilike(logs.message, `%${query.messageQuery}%`));
  }

  if (query.attributeFilters) {
  for (const [key, value] of Object.entries(query.attributeFilters)) {
    conditions.push(
      sql`${logs.attributes} @> ${JSON.stringify({ [key]: value })}::jsonb`,
    );
  }
}

  const bucket = {
    "1m": "1 minute",
    "5m": "5 minutes",
    "1h": "1 hour",
    "1d": "1 day",
  }[query.bucket];

  const sinceIso = query.since.toISOString();

  const bucketStart = sql`
    date_bin(
      ${sql.raw(`INTERVAL '${bucket}'`)},
      ${logs.timestamp},
      ${sql.raw(`TIMESTAMP '${sinceIso.replace("T", " ").replace("Z", "")}'`)}
    )
  `;

  if (query.groupBy === "service") {
    return getDb()
      .select({
        start: bucketStart,
        group: logs.service,
        count: sql<number>`count(*)::int`,
      })
      .from(logs)
      .where(and(...conditions))
      .groupBy(sql`1`, logs.service)
      .orderBy(sql`1`);
  }

  if (query.groupBy === "level") {
    return getDb()
      .select({
        start: bucketStart,
        group: logs.level,
        count: sql<number>`count(*)::int`,
      })
      .from(logs)
      .where(and(...conditions))
      .groupBy(sql`1`, logs.level)
      .orderBy(sql`1`);
  }

  return getDb()
    .select({
      start: bucketStart,
      group: sql<string | null>`NULL`,
      count: sql<number>`count(*)::int`,
    })
    .from(logs)
    .where(and(...conditions))
    .groupBy(sql`1`)
    .orderBy(sql`1`);
}