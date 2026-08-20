import { insertLogs, type NewLog } from "../repositories/logs.repository.js";



function positiveIntFromEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);

  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * Upper bound on rows in a single COPY.
 *
 * This is a deadline budget, not just a memory bound: a flush has to finish
 * inside INGEST_FLUSH_TIMEOUT_MS at the write rate the database actually
 * sustains. Sized for a slow database -- at ~1,000 rows/s a flush this size
 * completes in about a second, leaving the timeout as a safety net rather than
 * something the steady state collides with. Oversizing it is worse than it
 * looks, because an abandoned flush rejects every request packed into it and
 * throws away the I/O it already spent.
 */
const MAX_FLUSH_ROWS = positiveIntFromEnv("INGEST_MAX_FLUSH_ROWS", 1_000);


const MAX_PENDING_ROWS = positiveIntFromEnv("INGEST_MAX_PENDING_ROWS", 25_000);


const MAX_PENDING_REQUESTS = positiveIntFromEnv(
  "INGEST_MAX_PENDING_REQUESTS",
  500,
);


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
