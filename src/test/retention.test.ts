import assert from "node:assert/strict";
import test from "node:test";

import { closeDb, getClient } from "../db/index.js";
import { insertLogs } from "../repositories/logs.repository.js";
import {
  dropExpiredPartitions,
  ensurePartitions,
  listPartitions,
  partitionName,
  partitionStart,
  requiredPartitionStarts,
} from "../retention/partitions.js";
import {
  deleteExpiredFromDefault,
  retentionCutoff,
  runRetention,
} from "../retention/retention.service.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const config = {
  retentionDays: 30,
  partitionWidthMs: DAY_MS,
  partitionsAhead: 2,
  batchSize: 10_000,
  lockTimeoutMs: 3_000,
};


const ANCIENT = new Date("2019-05-05T12:34:56.000Z");
const ARCHAIC = new Date("2011-11-11T11:11:11.000Z");

async function countAt(timestamp: Date) {
  const rows = await getClient()<{ count: string }[]>`
    SELECT count(*)::text AS count FROM logs WHERE "timestamp" = ${timestamp.toISOString()}::timestamptz
  `;

  return Number(rows[0]?.count ?? "0");
}

async function partitionOf(timestamp: Date) {
  const rows = await getClient()<{ partition: string }[]>`
    SELECT tableoid::regclass::text AS partition
    FROM logs WHERE "timestamp" = ${timestamp.toISOString()}::timestamptz LIMIT 1
  `;

  return rows[0]?.partition ?? null;
}

test("partition boundaries are UTC and independent of the server timezone", () => {
  const start = partitionStart(
    new Date("2026-08-18T23:59:59.999Z"),
    DAY_MS,
  );

  assert.equal(start.toISOString(), "2026-08-18T00:00:00.000Z");
  assert.equal(partitionName(start), "logs_p20260818t00");

  // A six hour width must land on a six hour boundary, not on local midnight.
  const sixHourly = partitionStart(
    new Date("2026-08-18T14:20:00.000Z"),
    6 * 60 * 60 * 1000,
  );

  assert.equal(sixHourly.toISOString(), "2026-08-18T12:00:00.000Z");
  assert.equal(partitionName(sixHourly), "logs_p20260818t12");
});

test("the required partition set covers the whole retention window plus headroom", () => {
  const now = new Date("2026-08-18T09:00:00.000Z");

  const starts = requiredPartitionStarts({
    now,
    retentionDays: 30,
    widthMs: DAY_MS,
    ahead: 2,
  });

  // 30 days back, today, and two ahead.
  assert.equal(starts.length, 33);
  assert.equal(starts[0]?.toISOString(), "2026-07-19T00:00:00.000Z");
  assert.equal(starts.at(-1)?.toISOString(), "2026-08-20T00:00:00.000Z");

  // Nothing inside the window is left uncovered.
  const cutoff = retentionCutoff(30, now);
  assert.ok(starts[0]!.getTime() <= cutoff.getTime());
});

test("ensurePartitions is idempotent, so a routine pass issues no DDL", async () => {
  const now = new Date();

  await ensurePartitions({
    now,
    retentionDays: config.retentionDays,
    widthMs: config.partitionWidthMs,
    ahead: config.partitionsAhead,
    lockTimeoutMs: config.lockTimeoutMs,
  });

  const created = await ensurePartitions({
    now,
    retentionDays: config.retentionDays,
    widthMs: config.partitionWidthMs,
    ahead: config.partitionsAhead,
    lockTimeoutMs: config.lockTimeoutMs,
  });

  assert.deepEqual(created, []);
});

test("expired logs are removed by dropping their partition, not by deleting rows", async () => {
  const start = partitionStart(ANCIENT, DAY_MS);
  const name = partitionName(start);

  try {
    // A partition covering the old log, created exactly as maintenance would.
    await ensurePartitions({
      now: ANCIENT,
      retentionDays: 0,
      widthMs: DAY_MS,
      ahead: 0,
      lockTimeoutMs: config.lockTimeoutMs,
    });

    await insertLogs([
      {
        timestamp: ANCIENT,
        level: "info",
        service: "retention-test",
        message: "log inside an expired partition",
        attributes: { case: "expired" },
      },
    ]);

    // The write path must route into the partition, not the default one.
    assert.equal(await partitionOf(ANCIENT), name);
    assert.equal(await countAt(ANCIENT), 1);

    const dropped = await dropExpiredPartitions({
      cutoff: new Date(ANCIENT.getTime() + DAY_MS),
      lockTimeoutMs: config.lockTimeoutMs,
    });

    assert.ok(
      dropped.includes(name),
      `expected ${name} to be dropped, got ${dropped.join(", ") || "nothing"}`,
    );

    assert.equal(await countAt(ANCIENT), 0);

    const remaining = await listPartitions();
    assert.equal(
      remaining.some((partition) => partition.name === name),
      false,
    );
  } finally {
    await getClient().unsafe(`DROP TABLE IF EXISTS ${name}`);
  }
});

test("a partition still inside the retention window is never dropped", async () => {
  const now = new Date();

  await ensurePartitions({
    now,
    retentionDays: config.retentionDays,
    widthMs: config.partitionWidthMs,
    ahead: config.partitionsAhead,
    lockTimeoutMs: config.lockTimeoutMs,
  });

  const current = partitionName(partitionStart(now, DAY_MS));

  const dropped = await dropExpiredPartitions({
    cutoff: retentionCutoff(config.retentionDays, now),
    lockTimeoutMs: config.lockTimeoutMs,
  });

  assert.equal(dropped.includes(current), false);

  const partitions = await listPartitions();

  assert.ok(
    partitions.some((partition) => partition.name === current),
    "the partition receiving current writes must survive retention",
  );
});

test("logs outside every partition range are stored, then swept by the cutoff", async () => {
  // No partition covers this timestamp, so the row must land in the default
  // partition rather than failing the whole batch.
  await insertLogs([
    {
      timestamp: ARCHAIC,
      level: "warn",
      service: "retention-test",
      message: "log with no matching partition",
      attributes: { case: "default" },
    },
  ]);

  assert.equal(await partitionOf(ARCHAIC), "logs_default");
  assert.equal(await countAt(ARCHAIC), 1);

  const deleted = await deleteExpiredFromDefault(
    new Date(ARCHAIC.getTime() + DAY_MS),
    config.batchSize,
  );

  assert.ok(deleted >= 1);
  assert.equal(await countAt(ARCHAIC), 0);
});

test("a full retention pass keeps the window covered and reports what it did", async () => {
  const result = await runRetention(config);

  assert.ok(result.cutoff instanceof Date);

  const partitions = await listPartitions();

  // Every partition that survives must still be able to hold unexpired rows.
  for (const partition of partitions) {
    if (partition.upperBound === null) {
      continue;
    }

    assert.ok(
      partition.upperBound.getTime() > result.cutoff.getTime(),
      `${partition.name} is fully expired but was not dropped`,
    );
  }

  // The default partition is a permanent safety net and is never dropped.
  assert.ok(
    partitions.some((partition) => partition.name === "logs_default"),
  );
});

test.after(async () => {
  await closeDb();
});
