

import { ensurePartitions } from "../dist/retention/partitions.js";
import { closeDb } from "../dist/db/index.js";

const DAY_MS = 24 * 60 * 60 * 1000;

try {
  const created = await ensurePartitions({
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
} finally {
  await closeDb();
}
