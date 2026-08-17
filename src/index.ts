import { createServer } from "node:http";
import { handleRoutes } from "./routes/index.js";
import { deleteExpiredLogs } from "./retention/retention.service.js";

const PORT = 8080;

const retentionDays = Number(
  process.env.RETENTION_DAYS ?? 30,
);

const retentionIntervalMs = Number(
  process.env.RETENTION_INTERVAL_MS ?? 60 * 60 * 1000,
);

const retentionBatchSize = Number(
  process.env.RETENTION_BATCH_SIZE ?? 10_000,
);

async function runRetention() {
  try {
    const deleted = await deleteExpiredLogs(
      retentionDays,
      retentionBatchSize,
    );

    if (deleted > 0) {
      console.log(`Retention deleted ${deleted} expired logs`);
    }
  } catch (error) {
    console.error("Retention job failed:", error);
  }
}

const server = createServer(async (req, res) => {
  if (await handleRoutes(req, res)) {
    return;
  }

  res.writeHead(404, {
    "Content-Type": "text/plain",
  });

  res.end("Not Found");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server is running on port ${PORT}`);

  void runRetention();

  setInterval(() => {
    void runRetention();
  }, retentionIntervalMs);
});