import { and, desc, eq, gte, ilike, lt, or, sql } from "drizzle-orm";
import { once } from "node:events";
import type { Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { getClient, getDb } from "../db/index.js";
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


function csvEscape(value: string) {
  return value.indexOf('"') === -1 ? value : value.replaceAll('"', '""');
}

const CSV_CHUNK_ROWS = 500;

function csvRow(entry: NewLog) {
  return (
    '"' +
    csvEscape(entry.timestamp.toISOString()) +
    '","' +
    csvEscape(entry.level) +
    '","' +
    csvEscape(entry.service) +
    '","' +
    csvEscape(entry.message) +
    '","' +
    csvEscape(JSON.stringify(entry.attributes)) +
    '"\n'
  );
}

const FLUSH_TIMEOUT_MS = (() => {
  const value = Number(process.env.INGEST_FLUSH_TIMEOUT_MS);
  return Number.isInteger(value) && value > 0 ? value : 10_000;
})();

/** Raised when a COPY exceeds FLUSH_TIMEOUT_MS and is abandoned. */
export class FlushTimeoutError extends Error {
  constructor(ms: number) {
    super(`ingest flush did not complete within ${ms}ms`);
    this.name = "FlushTimeoutError";
  }
}

async function copyRows(
  entries: NewLog[],
  onStream: (stream: Writable) => void,
) {
  const stream = await getClient()`
    COPY logs ("timestamp", "level", "service", "message", "attributes")
    FROM STDIN WITH (FORMAT csv)
  `.writable();

  onStream(stream);

  let chunk = "";

  for (let index = 0; index < entries.length; index += 1) {
    chunk += csvRow(entries[index]!);

    if ((index + 1) % CSV_CHUNK_ROWS === 0) {
      if (!stream.write(chunk)) {
        await once(stream, "drain");
      }

      chunk = "";
    }
  }

  if (chunk.length > 0) {
    stream.write(chunk);
  }

  stream.end();

  await finished(stream);
}

export async function insertLogs(entries: NewLog[]) {
  if (entries.length === 0) {
    return;
  }

  let stream: Writable | undefined;
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;

  const copy = copyRows(entries, (opened) => {
    stream = opened;
  });

  copy.catch(() => {});

  try {
    await Promise.race([
      copy,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new FlushTimeoutError(FLUSH_TIMEOUT_MS));
        }, FLUSH_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);

    if (timedOut) {
      console.error(
        `Ingest flush timed out after ${FLUSH_TIMEOUT_MS}ms; ` +
          `abandoning ${entries.length} rows and tearing down the connection`,
      );

     
      stream?.destroy(new Error("ingest flush timed out"));
    }
  }
}

function attributeConditions(filters: Record<string, string>) {
  return Object.entries(filters).map(
    ([key, value]) =>
      sql`(${logs.attributes} ? ${key} AND ${logs.attributes} ->> ${key} = ${value})`,
  );
}

function containsPattern(messageQuery: string) {
  return `%${messageQuery.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
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
    conditions.push(ilike(logs.message, containsPattern(query.messageQuery)));
  }

  if (query.attributeFilters) {
    conditions.push(...attributeConditions(query.attributeFilters));
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
    conditions.push(ilike(logs.message, containsPattern(query.messageQuery)));
  }

  if (query.attributeFilters) {
    conditions.push(...attributeConditions(query.attributeFilters));
  }

  const bucket = {
    "1m": "1 minute",
    "5m": "5 minutes",
    "1h": "1 hour",
    "1d": "1 day",
  }[query.bucket];


  
  const bucketStart = sql<string>`
    to_char(
      date_bin(
        ${bucket}::interval,
        ${logs.timestamp},
        ${query.since.toISOString()}::timestamptz
      ) AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
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