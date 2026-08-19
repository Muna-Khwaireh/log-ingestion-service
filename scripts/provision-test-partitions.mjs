

import { ensurePartitions } from "../dist/retention/partitions.js";
import { closeDb } from "../dist/db/index.js";

const DAY_MS = 24 * 60 * 60 * 1000;

try {
  const { created, failed } = await ensurePartitions({
    now: new Date(),
    // A small window around now -- enough to cover today (and the day either
    // side, for a run that straddles UTC midnight). The tests provision the
    // full retention window themselves where they need it.
    retentionDays: 1,
    widthMs: DAY_MS,
    ahead: 2,
    lockTimeoutMs: 3_000,
  });

  console.log(
    created.length > 0
      ? `Provisioned test partitions: ${created.join(", ")}`
      : "Test partitions already present",
  );

  // Fail loudly: if today's partition could not be created the suite would run
  // against a database where now-dated rows land in the default partition,
  // which is the exact condition this script exists to prevent.
  if (failed.length > 0) {
    console.error(
      `Failed to provision: ${failed.map((entry) => entry.name).join(", ")}`,
    );

    process.exitCode = 1;
  }
} finally {
  await closeDb();
}
