import { createApp } from "./app.js";
import { closeDb } from "./db/index.js";
import {
  runRetention,
  type RetentionConfig,
} from "./retention/retention.service.js";

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

const PORT = numberFromEnv("PORT", 8080);

const retentionIntervalMs = numberFromEnv(
  "RETENTION_INTERVAL_MS",
  60 * 60 * 1000,
);

const shutdownTimeoutMs = numberFromEnv("SHUTDOWN_TIMEOUT_MS", 10_000);

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



let activeRetention: Promise<void> = Promise.resolve();

function triggerRetention() {
  activeRetention = runRetentionPass();
  return activeRetention;
}

await triggerRetention();

const server = createApp();

let retentionTimer: ReturnType<typeof setInterval> | undefined;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server is running on port ${PORT}`);

  retentionTimer = setInterval(() => {
    void triggerRetention();
  }, retentionIntervalMs);
});


let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  console.log(`Received ${signal}, shutting down gracefully`);

  
  const forceExit = setTimeout(() => {
    console.error(
      `Shutdown did not complete within ${shutdownTimeoutMs}ms, forcing exit`,
    );
    process.exit(1);
  }, shutdownTimeoutMs);
  forceExit.unref();

  if (retentionTimer) {
    clearInterval(retentionTimer);
  }

  try {
   
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections();
    });

   
    await activeRetention;

    await closeDb();

    clearTimeout(forceExit);
    console.log("Shutdown complete");
    process.exit(0);
  } catch (error) {
    console.error("Error during shutdown:", error);
    process.exit(1);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
