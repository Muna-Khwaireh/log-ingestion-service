const TOTAL_LOGS = 100_000;
const BATCH_SIZE = 500;
const CONCURRENCY = 10;

const logs = Array.from({ length: TOTAL_LOGS }, (_, i) => ({
  timestamp: new Date().toISOString(),
  level: i % 10 === 0 ? "error" : "info",
  service: `service-${i % 10}`,
  message: `load test message ${i}`,
  attributes: {
    user_id: String(i % 1000),
    region: i % 2 === 0 ? "eu-west" : "us-east",
    retries: i % 4,
  },
}));

let nextIndex = 0;
let accepted = 0;
let rejected = 0;

async function worker() {
  while (true) {
    const start = nextIndex;

    if (start >= TOTAL_LOGS) {
      return;
    }

    nextIndex += BATCH_SIZE;

    const batch = logs.slice(start, start + BATCH_SIZE);

    const response = await fetch("http://localhost:8080/logs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ logs: batch }),
    });

    if (!response.ok) {
      console.error("Request failed:", response.status);
      continue;
    }

    const result = await response.json();

    accepted += result.accepted;
    rejected += result.rejected.length;
  }
}

const startTime = performance.now();

await Promise.all(
  Array.from({ length: CONCURRENCY }, () => worker()),
);

const elapsed = (performance.now() - startTime) / 1000;

console.log("");
console.log("===== LOAD TEST =====");
console.log(`Logs:       ${TOTAL_LOGS}`);
console.log(`Batch size: ${BATCH_SIZE}`);
console.log(`Concurrency:${CONCURRENCY}`);
console.log(`Accepted:   ${accepted}`);
console.log(`Rejected:   ${rejected}`);
console.log(`Time:       ${elapsed.toFixed(2)}s`);
console.log(`Rate:       ${(accepted / elapsed).toFixed(0)} logs/sec`);