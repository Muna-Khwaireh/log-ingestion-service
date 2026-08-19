import { insertLogs, type NewLog } from "../repositories/logs.repository.js";



function positiveIntFromEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);

  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/** Upper bound on rows in a single COPY, so one flush cannot grow unbounded. */
const MAX_FLUSH_ROWS = positiveIntFromEnv("INGEST_MAX_FLUSH_ROWS", 10_000);

/**
 * Rows allowed to sit unflushed before ingestion sheds load. This is the memory
 * guard: it bounds how much log data can be held in the 256 MB container.
 */
const MAX_PENDING_ROWS = positiveIntFromEnv("INGEST_MAX_PENDING_ROWS", 25_000);

/**
 * Requests allowed to sit unflushed before ingestion sheds load. This is the
 * latency guard, and it is deliberately separate from the row cap.
 *
 * A row-only cap silently changes meaning with batch size. Tuned against
 * 500-row batches, 25k rows is 50 queued requests; against the 10-row batches a
 * real client sends, the same number is 2,500 queued requests -- and every one
 * of them waits for all the others to drain. That is what turned a healthy row
 * budget into a p95 ingestion latency of nearly a minute under load.
 *
 * Queue depth in requests is what actually bounds latency, because each request
 * costs a database round trip regardless of how few rows it carries. Shedding
 * early is also faster for the client than a long wait: a shed request and a
 * timed-out request both count as not ingested, but a prompt 503 frees the
 * connection to try again instead of blocking it.
 */
const MAX_PENDING_REQUESTS = positiveIntFromEnv(
  "INGEST_MAX_PENDING_REQUESTS",
  500,
);

/**
 * How many flushes may be in flight. Each flush is one COPY, so this caps drain
 * rate at (concurrency / flush latency).
 *
 * Two is not a conservative guess -- it measured fastest. Raising it was tried
 * on the assumption that the database was being starved, and the numbers said
 * otherwise. Under small-batch load the application container is pinned at its
 * 0.5 CPU limit while PostgreSQL sits at 17-35%, so the bottleneck is
 * JavaScript, not the database, and extra concurrent flushes only add
 * bookkeeping to the thread that is already the constraint:
 *
 *   concurrency  2 -> 12,274 logs/s, p95 379 ms
 *   concurrency  8 -> 11,140 logs/s, p95 400 ms
 *   concurrency 16 ->  9,052 logs/s, p95 457 ms
 *
 * (batch=10, 256 concurrent writers, identical dataset.)
 */
const FLUSH_CONCURRENCY = positiveIntFromEnv("INGEST_FLUSH_CONCURRENCY", 2);

/** Raised when the buffer is saturated, so the handler can answer 503. */
export class IngestBufferFullError extends Error {
  constructor() {
    super("ingestion buffer is full");
    this.name = "IngestBufferFullError";
  }
}

type PendingBatch = {
  rows: NewLog[];
  resolve: () => void;
  reject: (error: unknown) => void;
};

const queue: PendingBatch[] = [];

let queuedRows = 0;
let activeFlushes = 0;

/** Takes whole requests off the queue up to the per-flush row cap. */
function takeBatches() {
  const batches: PendingBatch[] = [];

  let rows = 0;

  while (queue.length > 0) {
    const next = queue[0]!;

    // Always take at least one request, even if it alone exceeds the cap --
    // otherwise an oversized batch could never be flushed.
    if (batches.length > 0 && rows + next.rows.length > MAX_FLUSH_ROWS) {
      break;
    }

    queue.shift();
    batches.push(next);
    rows += next.rows.length;
  }

  queuedRows -= rows;

  return batches;
}

async function flushOnce() {
  const batches = takeBatches();

  if (batches.length === 0) {
    return;
  }

  const rows =
    batches.length === 1
      ? batches[0]!.rows
      : batches.flatMap((batch) => batch.rows);

  try {
    await insertLogs(rows);

    for (const batch of batches) {
      batch.resolve();
    }
  } catch (error) {
    // The whole COPY failed, so every request in it failed. Each one rejects
    // and its handler turns that into a 503 -- no request is told its logs were
    // stored when they were not.
    for (const batch of batches) {
      batch.reject(error);
    }
  }
}

function scheduleFlush() {
  while (activeFlushes < FLUSH_CONCURRENCY && queue.length > 0) {
    activeFlushes += 1;

    void flushOnce().finally(() => {
      activeFlushes -= 1;

      if (queue.length > 0) {
        scheduleFlush();
      }
    });
  }
}

/**
 * Queues rows for the next flush. The returned promise resolves once the COPY
 * carrying them has completed, and rejects if that COPY failed or if the buffer
 * is saturated.
 */
export function enqueueLogs(rows: NewLog[]): Promise<void> {
  if (rows.length === 0) {
    return Promise.resolve();
  }

  if (
    queuedRows + rows.length > MAX_PENDING_ROWS ||
    queue.length >= MAX_PENDING_REQUESTS
  ) {
    return Promise.reject(new IngestBufferFullError());
  }

  return new Promise<void>((resolve, reject) => {
    queue.push({ rows, resolve, reject });
    queuedRows += rows.length;

    scheduleFlush();
  });
}

/** Rows waiting to be flushed. Exposed for tests and diagnostics. */
export function pendingRowCount() {
  return queuedRows;
}

/**
 * Waits for everything currently buffered to be written. Called during
 * shutdown so a SIGTERM does not discard rows that have already been accepted
 * into the buffer.
 */
export async function drainIngestBuffer() {
  while (queue.length > 0 || activeFlushes > 0) {
    scheduleFlush();

    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
