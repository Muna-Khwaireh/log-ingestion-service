import { sql } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { logs } from "../db/schema.js";

export async function deleteExpiredLogs(
  retentionDays: number,
  batchSize: number,
): Promise<number> {
  const cutoff = new Date(
    Date.now() - retentionDays * 24 * 60 * 60 * 1000,
  );

  const cutoffIso = cutoff.toISOString();

  const result = await getDb().execute(sql`
    DELETE FROM ${logs}
    WHERE id IN (
      SELECT id
      FROM ${logs}
      WHERE timestamp < ${cutoffIso}::timestamptz
      ORDER BY timestamp ASC
      LIMIT ${batchSize}
    )
  `);

  return result.count;
}