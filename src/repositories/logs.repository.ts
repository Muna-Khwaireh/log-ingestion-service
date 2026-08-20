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

/**
 * Every jsonb value that could satisfy `attributes ->> key = value`.
 *
 * Filter values always arrive as strings, but attributes store strings, numbers
 * and booleans as their own jsonb types. `->>` renders whichever is stored as
 * text before comparing, so a stored number 42 matches the string "42". These
 * are the candidate jsonb forms that could render to `value`.
 */
function containmentCandidates(key: string, value: string) {
  const candidates: Record<string, string | number | boolean>[] = [
    { [key]: value },
  ];

  // Number rather than Number.parseFloat, which is too lax: it reads "42abc"
  // as 42. Number rejects that outright. The empty-string guard is separate
  // because Number("") is 0, which would otherwise add a candidate matching
  // every row stored as zero.
  //
  // This only has to be close: a value that is not really a number costs an
  // extra index probe that matches nothing, and one that over-matches (" 42 ",
  // "0x10") is caught by the recheck below.
  const asNumber = Number(value);

  if (value.trim() !== "" && Number.isFinite(asNumber)) {
    candidates.push({ [key]: asNumber });
  }

  if (value === "true" || value === "false") {
    candidates.push({ [key]: value === "true" });
  }

  return candidates;
}

/**
 * Attribute filters, as an index-searchable containment test plus an exact
 * recheck.
 *
 * The obvious spelling, `attributes ? key AND attributes ->> key = value`, is
 * correct but effectively unindexed: `?` tests only that the key is present, so
 * on log data where every row carries the key it selects every row and the
 * value comparison runs as a heap filter. Measured on 707k rows, the planner
 * ignored the GIN index entirely and filtered out 707,512 rows to return 8.
 *
 * Containment keys on the key and the value together, so the index narrows to
 * the matching rows. The candidate set is a superset of the true matches -- it
 * cannot distinguish a stored 42 from a stored 42.0, both of which contain the
 * number 42 -- so the original `->>` comparison is kept as a recheck and the
 * result stays exactly what it was before. The same query then plans as a
 * bitmap index scan returning 8 rows, at 0.7ms instead of 653ms.
 *
 * Containment requires the index to be built with `jsonb_path_ops`, which does
 * not support `?`; the opclass in the schema and this predicate go together.
 */
function attributeConditions(filters: Record<string, string>) {
  return Object.entries(filters).map(([key, value]) => {
    const candidates = containmentCandidates(key, value).map(
      (candidate) => sql`${logs.attributes} @> ${JSON.stringify(candidate)}::jsonb`,
    );

    return sql`(${or(...candidates)} AND ${logs.attributes} ->> ${key} = ${value})`;
  });
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