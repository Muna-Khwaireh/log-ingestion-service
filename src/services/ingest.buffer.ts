import { insertLogs, type NewLog } from "../repositories/logs.repository.js";



function positiveIntFromEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);

  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/** Upper bound on rows in a single COPY, so one flush cannot grow unbounded. */
const MAX_FLUSH_ROWS = positiveIntFromEnv("INGEST_MAX_FLUSH_ROWS", 10_000);

/**
 * Rows allowed to sit unflushed before ingestion sheds load.
 *
 * This is a latency bound as much as a memory guard. Measured drain rate is
 * roughly 39k rows/s, so ~25k rows is well under a second of backlog. Deeper
 * queues were measured to be actively worse: raising this to 100k turned shed
 * requests into 70-second waits and dropped throughput from 18k to 5k logs/s --
 * textbook bufferbloat. Past this point the writer is not keeping up, and 503 +
 * Retry-After is both faster for the client and safer than buffering until the
 * container is OOM-killed.
 */
const MAX_PENDING_ROWS = positiveIntFromEnv("INGEST_MAX_PENDING_ROWS", 25_000);

/**
 * How many flushes may be in flight. PostgreSQL has a single CPU here, so a
 * couple of overlapping COPYs is enough to keep it busy while the next CSV
 * payload is built; more would trade batching for contention.
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

  if (queuedRows + rows.length > MAX_PENDING_ROWS) {
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
