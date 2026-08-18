import { createApp } from "./app.js";
import {
  runRetention,
  type RetentionConfig,
} from "./retention/retention.service.js";

const PORT = 8080;

function numberFromEnv(name: string, fallback: number) {
  const raw = process.env[name];

  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isFinite(value) || value <= 0) {
    console.error(
      `${name}='${raw}' is not a positive number, using ${fallback}`,
    );

    return fallback;
  }

  return value;
}

const retentionIntervalMs = numberFromEnv(
  "RETENTION_INTERVAL_MS",
  60 * 60 * 1000,
);

const retentionConfig: RetentionConfig = {
  retentionDays: numberFromEnv("RETENTION_DAYS", 30),

 
  partitionWidthMs:
    numberFromEnv("RETENTION_PARTITION_HOURS", 24) * 60 * 60 * 1000,

  partitionsAhead: numberFromEnv("RETENTION_PARTITIONS_AHEAD", 2),

  batchSize: numberFromEnv("RETENTION_BATCH_SIZE", 10_000),

  lockTimeoutMs: numberFromEnv("RETENTION_LOCK_TIMEOUT_MS", 3_000),
};

async function runRetentionPass() {
  try {
    const result = await runRetention(retentionConfig);

    if (result.createdPartitions.length > 0) {
      console.log(
        `Retention created partitions: ${result.createdPartitions.join(", ")}`,
      );
    }

    if (result.droppedPartitions.length > 0) {
      console.log(
        `Retention dropped expired partitions: ${result.droppedPartitions.join(", ")}`,
      );
    }

    if (result.deletedFromDefault > 0) {
      console.log(
        `Retention deleted ${result.deletedFromDefault} out-of-window expired logs`,
      );
    }
  } catch (error) {
    console.error("Retention job failed:", error);
  }
}


await runRetentionPass();

const server = createApp();

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server is running on port ${PORT}`);

  setInterval(() => {
    void runRetentionPass();
  }, retentionIntervalMs);
});
