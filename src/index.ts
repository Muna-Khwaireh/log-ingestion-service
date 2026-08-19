import { createApp } from "./app.js";
import { closeDb } from "./db/index.js";
import { drainIngestBuffer } from "./services/ingest.buffer.js";
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

    if (result.failedPartitions.length > 0) {
      // Loud on purpose. Ingestion keeps working -- these rows land in the
      // default partition -- but they lose partition pruning on reads and can
      // only be reclaimed by a row-by-row delete instead of a partition drop.
      // Silent degradation here is what makes it hard to diagnose later.
      console.error(
        `Retention could not create ${result.failedPartitions.length} partition(s): ` +
          `${result.failedPartitions.map((entry) => entry.name).join(", ")}. ` +
          `Logs in those ranges will be stored in the default partition, ` +
          `which is slower to query and slower to reclaim.`,
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

async function shutdown(reason: string, exitCode = 0) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  console.log(`${reason}, shutting down gracefully`);

  
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

    // Rows already accepted into the ingestion buffer must reach PostgreSQL
    // before the pool closes, or shutdown would drop writes whose requests are
    // still waiting on them.
    await drainIngestBuffer();

    await closeDb();

    clearTimeout(forceExit);
    console.log("Shutdown complete");
    process.exit(exitCode);
  } catch (error) {
    console.error("Error during shutdown:", error);
    process.exit(1);
  }
}

process.on("SIGTERM", () => void shutdown("Received SIGTERM"));
process.on("SIGINT", () => void shutdown("Received SIGINT"));

/**
 * A crash must not leave the process half-alive: still holding the port and the
 * connection pool while no longer serving requests. Node's default is to print
 * the error and exit immediately, which would abandon rows already accepted into
 * the ingestion buffer and leave the pool to time out server-side.
 *
 * These handlers instead run the same drain as a signal shutdown, then exit
 * non-zero so the failure is visible in container logs and exit status rather
 * than looking like a clean stop. Resuming normal operation is deliberately not
 * attempted: after an uncaught exception the process state is undefined, so the
 * only safe move is to finish outstanding work and let the restart policy bring
 * up a fresh instance. The force-exit timer in shutdown() bounds that attempt.
 */
process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
  void shutdown("Uncaught exception", 1);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
  void shutdown("Unhandled promise rejection", 1);
});
