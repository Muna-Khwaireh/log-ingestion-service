import type { TransactionSql } from "postgres";

import { getClient } from "../db/index.js";



const PARTITION_PREFIX = "logs_p";

export function partitionName(start: Date) {
  const iso = start.toISOString();

  return (
    PARTITION_PREFIX +
    iso.slice(0, 4) +
    iso.slice(5, 7) +
    iso.slice(8, 10) +
    "t" +
    iso.slice(11, 13)
  );
}

/** Floors an instant to the start of the partition that contains it. Boundaries
 *  are measured from the epoch, so a 24 hour width lands on UTC midnight
 *  regardless of the server's timezone. */
export function partitionStart(instant: Date, widthMs: number) {
  return new Date(Math.floor(instant.getTime() / widthMs) * widthMs);
}

/** The lower bounds of every partition that must exist to cover the retention
 *  window plus some headroom into the future. */
export function requiredPartitionStarts(options: {
  now: Date;
  retentionDays: number;
  widthMs: number;
  ahead: number;
}) {
  const { now, retentionDays, widthMs, ahead } = options;

  const oldest = partitionStart(
    new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000),
    widthMs,
  );

  const newest = new Date(
    partitionStart(now, widthMs).getTime() + ahead * widthMs,
  );

  const starts: Date[] = [];

  for (
    let t = oldest.getTime();
    t <= newest.getTime();
    t += widthMs
  ) {
    starts.push(new Date(t));
  }

  return starts;
}

/** Runs one maintenance statement under a transaction-scoped lock_timeout, so a
 *  partition change can never sit in the lock queue ahead of ingestion. */
async function withLockTimeout<T>(
  lockTimeoutMs: number,
  run: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  return getClient().begin(async (tx) => {
    // set_config takes bind parameters where SET does not. The final argument
    // scopes the setting to this transaction.
    await tx`SELECT set_config('lock_timeout', ${`${lockTimeoutMs}ms`}, true)`;

    return run(tx);
  }) as Promise<T>;
}

/** Builds one maintenance statement server-side. The identifier and the bounds
 *  are quoted by PostgreSQL's own format(), so no SQL text is assembled from
 *  values here. */
async function execFormatted(
  tx: TransactionSql,
  rows: { ddl: string }[],
) {
  const row = rows[0];

  if (!row) {
    throw new Error("format() returned no statement");
  }

  await tx.unsafe(row.ddl);
}

export type PartitionInfo = {
  name: string;
  /** null for the default partition, which has no range and is never dropped. */
  upperBound: Date | null;
};

/**
 * Lists the partitions of "logs" with the exclusive upper bound of each.
 *
 * The bound is read back from the catalog rather than re-derived from the
 * partition name, so it stays correct even for a partition created by an
 * earlier configuration or by hand.
 *
 * It is rendered as an explicit UTC ISO-8601 string because this driver hands
 * back timestamptz as a bare string such as "2026-07-20 00:00:00+00", whose
 * interpretation would depend on the reader -- the same trap that shifted the
 * aggregation buckets before.
 */
export async function listPartitions(): Promise<PartitionInfo[]> {
  const rows = await getClient()<
    { name: string; upperBound: string | null }[]
  >`
    SELECT c.relname AS name,
           CASE
             WHEN pg_get_expr(c.relpartbound, c.oid) LIKE 'FOR VALUES FROM (%) TO (%)'
             THEN to_char(
                    split_part(
                      split_part(pg_get_expr(c.relpartbound, c.oid), 'TO (''', 2),
                      '''',
                      1
                    )::timestamptz AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS"Z"'
                  )
           END AS "upperBound"
    FROM pg_class c
    JOIN pg_inherits i ON i.inhrelid = c.oid
    WHERE i.inhparent = 'logs'::regclass
      AND c.relispartition
    ORDER BY 2 NULLS FIRST
  `;

  return rows.map((row) => ({
    name: row.name,
    upperBound: row.upperBound === null ? null : new Date(row.upperBound),
  }));
}

export type EnsurePartitionsResult = {
  created: string[];
  /** Partitions that could not be created, with the error that prevented it. */
  failed: { name: string; error: unknown }[];
};

/**
 * Creates any partition missing from the retention window. Existing partitions
 * are looked up first so a routine pass issues no DDL at all -- otherwise every
 * run would take an ACCESS EXCLUSIVE lock on "logs" once per partition just to
 * discover there was nothing to do.
 *
 * Failures are returned rather than only logged. A partition that cannot be
 * created is not fatal -- rows for that range land in the default partition and
 * stay queryable -- but it is a real degradation: those rows lose partition
 * pruning and can only be reclaimed by a row-by-row delete instead of a partition
 * drop. Reporting it lets the caller say so plainly instead of leaving the
 * service quietly slower with the reason buried in a log line.
 */
export async function ensurePartitions(options: {
  now: Date;
  retentionDays: number;
  widthMs: number;
  ahead: number;
  lockTimeoutMs: number;
}): Promise<EnsurePartitionsResult> {
  const starts = requiredPartitionStarts(options);

  const existing = new Set(
    (await listPartitions()).map((partition) => partition.name),
  );

  const created: string[] = [];
  const failed: EnsurePartitionsResult["failed"] = [];

  for (const start of starts) {
    const name = partitionName(start);

    if (existing.has(name)) {
      continue;
    }

    const end = new Date(start.getTime() + options.widthMs);

    try {
      await withLockTimeout(options.lockTimeoutMs, async (tx) => {
        // The statement text is built by PostgreSQL's own format(), so the
        // identifier and both bounds are quoted by the server rather than
        // concatenated here.
        await execFormatted(
          tx,
          await tx<{ ddl: string }[]>`
            SELECT format(
              'CREATE TABLE IF NOT EXISTS %I PARTITION OF logs FOR VALUES FROM (%L) TO (%L)',
              ${name}::text,
              ${start.toISOString()}::timestamptz,
              ${end.toISOString()}::timestamptz
            ) AS ddl
          `,
        );
      });

      created.push(name);
    } catch (error) {
      console.error(`Retention: could not create partition ${name}:`, error);
      failed.push({ name, error });
    }
  }

  return { created, failed };
}

/**
 * Drops every partition whose upper bound is at or below the cutoff, meaning it
 * cannot contain a single row still inside the retention window. The default
 * partition has no bound and is never dropped.
 */
export async function dropExpiredPartitions(options: {
  cutoff: Date;
  lockTimeoutMs: number;
}) {
  const expired = (await listPartitions()).filter(
    (partition) =>
      partition.upperBound !== null &&
      partition.upperBound.getTime() <= options.cutoff.getTime(),
  );

  const dropped: string[] = [];

  for (const partition of expired) {
    try {
      await withLockTimeout(options.lockTimeoutMs, async (tx) => {
        await execFormatted(
          tx,
          await tx<{ ddl: string }[]>`
            SELECT format('DROP TABLE IF EXISTS %I', ${partition.name}::text) AS ddl
          `,
        );
      });

      dropped.push(partition.name);
    } catch (error) {
      console.error(
        `Retention: could not drop partition ${partition.name}:`,
        error,
      );
    }
  }

  return dropped;
}
