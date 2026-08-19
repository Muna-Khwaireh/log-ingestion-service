import { and, desc, eq, gte, ilike, lt, or, sql } from "drizzle-orm";
import { once } from "node:events";
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


/**
 * Escapes a CSV field's contents. Every field is quoted unconditionally by the
 * caller, so the only character needing treatment is the quote itself.
 *
 * The common case -- a field containing no quote at all -- returns the original
 * string untouched rather than allocating a replacement. That matters more than
 * it looks: CPU profiling under small-batch load put the garbage collector at
 * roughly a quarter of all active CPU, so on this path allocation count is the
 * cost, not instruction count.
 */
function csvEscape(value: string) {
  return value.indexOf('"') === -1 ? value : value.replaceAll('"', '""');
}

/** Rows serialised per write, so a large flush never materialises the whole
 *  CSV payload in memory at once. */
const CSV_CHUNK_ROWS = 500;

/**
 * A COPY taking longer than this is logged with a per-phase breakdown.
 *
 * Under load, individual requests have been observed waiting far longer than
 * the queue depth can account for, with both containers close to idle -- the
 * signature of something blocking rather than something working. Timing the
 * phases separately is what distinguishes a slow commit from a starved
 * connection pool from socket backpressure.
 */
const SLOW_FLUSH_MS = (() => {
  const value = Number(process.env.INGEST_SLOW_FLUSH_MS);
  return Number.isInteger(value) && value > 0 ? value : 1_000;
})();

/**
 * Builds one CSV record as a single concatenation.
 *
 * The quotes and separators are folded into the expression instead of each
 * field being wrapped by a helper that returns its own string. The previous
 * shape allocated two intermediate strings per field -- ten per row -- purely
 * to add quotes that are constant.
 */
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

/**
 * Bulk-inserts with COPY, which is far cheaper per row than multi-row INSERT.
 *
 * The CSV is written in chunks rather than joined into one string: a flush can
 * carry tens of thousands of rows, and building the entire payload (plus the
 * array of per-row strings behind it) was a second full copy of the batch in a
 * 256 MB container. Backpressure from the socket is respected so a slow write
 * cannot make the buffer grow without bound.
 *
 * postgres.js finishes the writable only once PostgreSQL answers
 * CommandComplete, so awaiting it means the rows are committed, not merely
 * flushed to the socket.
 */
export async function insertLogs(entries: NewLog[]) {
  if (entries.length === 0) {
    return;
  }

  const startedAt = performance.now();

  // Phase 1 -- acquire. Covers waiting for a pooled connection and for
  // PostgreSQL to enter COPY mode.
  const stream = await getClient()`
    COPY logs ("timestamp", "level", "service", "message", "attributes")
    FROM STDIN WITH (FORMAT csv)
  `.writable();

  const acquiredAt = performance.now();

  let chunk = "";
  let drainMs = 0;

  for (let index = 0; index < entries.length; index += 1) {
    chunk += csvRow(entries[index]!);

    if ((index + 1) % CSV_CHUNK_ROWS === 0) {
      if (!stream.write(chunk)) {
        // Phase 2a -- socket backpressure. Timed separately because a stall
        // here means the server is not draining what we send, which is a very
        // different fault from a slow commit.
        const drainStart = performance.now();
        await once(stream, "drain");
        drainMs += performance.now() - drainStart;
      }

      chunk = "";
    }
  }

  if (chunk.length > 0) {
    stream.write(chunk);
  }

  const writtenAt = performance.now();

  stream.end();

  // Phase 3 -- commit. postgres.js settles this only on CommandComplete, so
  // this span is PostgreSQL executing and committing the COPY.
  await finished(stream);

  const total = performance.now() - startedAt;

  if (total >= SLOW_FLUSH_MS) {
    console.warn(
      `Slow COPY: ${Math.round(total)}ms for ${entries.length} rows ` +
        `(acquire ${Math.round(acquiredAt - startedAt)}ms, ` +
        `write ${Math.round(writtenAt - acquiredAt)}ms incl ${Math.round(drainMs)}ms drain, ` +
        `commit ${Math.round(performance.now() - writtenAt)}ms)`,
    );
  }
}

/**
 * Attribute values are compared as strings, so a stored number or boolean has
 * to match a query string: ?attr.retries=3 matches a stored 3 as well as "3".
 *
 * "->>" extracts the value as text, which renders jsonb numbers and booleans
 * the way the spec wants them compared. Plain "@>" containment cannot do this,
 * because jsonb containment is type-strict and would never match a stored
 * number against the string coming off the query string.
 *
 * The key-existence check is redundant for correctness, but it is GIN-indexable
 * where "->>" is not, so a selective key still narrows the scan through
 * idx_logs_attributes instead of forcing a sequential scan.
 */
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