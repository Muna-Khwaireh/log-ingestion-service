import { sql } from "drizzle-orm";

import { getDb } from "../db/index.js";
import {
  dropExpiredPartitions,
  ensurePartitions,
} from "./partitions.js";

export type RetentionConfig = {
  retentionDays: number;
  partitionWidthMs: number;
  partitionsAhead: number;
  batchSize: number;
  lockTimeoutMs: number;
};

export type RetentionResult = {
  cutoff: Date;
  createdPartitions: string[];
  droppedPartitions: string[];
  deletedFromDefault: number;
};

export function retentionCutoff(retentionDays: number, now = new Date()) {
  return new Date(
    now.getTime() - retentionDays * 24 * 60 * 60 * 1000,
  );
}


export async function deleteExpiredFromDefault(
  cutoff: Date,
  batchSize: number,
  maxBatches = 100,
) {
  let deleted = 0;

  for (let batch = 0; batch < maxBatches; batch += 1) {
    const result = await getDb().execute(sql`
      DELETE FROM logs_default
      WHERE ctid IN (
        SELECT ctid
        FROM logs_default
        WHERE "timestamp" < ${cutoff.toISOString()}::timestamptz
        LIMIT ${batchSize}
      )
    `);

    deleted += result.count;

    if (result.count < batchSize) {
      break;
    }
  }

  return deleted;
}


export async function runRetention(
  config: RetentionConfig,
  now = new Date(),
): Promise<RetentionResult> {
  const cutoff = retentionCutoff(config.retentionDays, now);

  const createdPartitions = await ensurePartitions({
    now,
    retentionDays: config.retentionDays,
    widthMs: config.partitionWidthMs,
    ahead: config.partitionsAhead,
    lockTimeoutMs: config.lockTimeoutMs,
  });

  const droppedPartitions = await dropExpiredPartitions({
    cutoff,
    lockTimeoutMs: config.lockTimeoutMs,
  });

  const deletedFromDefault = await deleteExpiredFromDefault(
    cutoff,
    config.batchSize,
  );

  return {
    cutoff,
    createdPartitions,
    droppedPartitions,
    deletedFromDefault,
  };
}
