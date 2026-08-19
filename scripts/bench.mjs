

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, "").split("=");
    return [key, value ?? "true"];
  }),
);

const BASE_URL = args.url ?? "http://localhost:8080";
const DURATION_S = Number(args.duration ?? 30);
const BATCH_SIZE = Number(args.batch ?? 500);
const CONCURRENCY = Number(args.concurrency ?? 32);
const RUN_AGGREGATE = args.aggregate !== "false" && args["no-aggregate"] !== "true";

const SERVICES = Array.from({ length: 10 }, (_, i) => `service-${i}`);
const LEVELS = ["debug", "info", "warn", "error"];
const REGIONS = ["eu-west", "us-east", "ap-south"];

let counter = 0;

function makeBatch(size) {
  const logs = new Array(size);
  const now = Date.now();

  for (let i = 0; i < size; i += 1) {
    const n = counter++;

    logs[i] = {
      timestamp: new Date(now).toISOString(),
      level: LEVELS[n % 4],
      service: SERVICES[n % 10],
      message: `bench message ${n}`,
      attributes: {
        user_id: String(n % 1000),
        region: REGIONS[n % 3],
        retries: n % 4,
      },
    };
  }

  return JSON.stringify({ logs });
}

const latencies = [];
const statusCounts = new Map();

let accepted = 0;
let failed = 0;
let stop = false;

function recordStatus(status) {
  statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);
}

async function writer() {
  while (!stop) {
    const body = makeBatch(BATCH_SIZE);
    const started = performance.now();

    try {
      const response = await fetch(`${BASE_URL}/logs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });

      latencies.push(performance.now() - started);
      recordStatus(response.status);

      if (response.status === 200) {
        const result = await response.json();
        accepted += result.accepted ?? 0;
      } else {
        await response.text();
        failed += 1;
      }
    } catch (error) {
      latencies.push(performance.now() - started);
      recordStatus(`ERR:${error.cause?.code ?? error.message}`);
      failed += 1;
    }
  }
}

const aggregateLatencies = [];
let aggregateFailures = 0;

async function aggregateProbe() {
  while (!stop) {
    const until = new Date();
    const since = new Date(until.getTime() - 60 * 60 * 1000);

    const url =
      `${BASE_URL}/logs/aggregate?since=${encodeURIComponent(since.toISOString())}` +
      `&until=${encodeURIComponent(until.toISOString())}&bucket=1m&group_by=service`;

    const started = performance.now();

    try {
      const response = await fetch(url);
      await response.text();

      aggregateLatencies.push(performance.now() - started);

      if (response.status !== 200) {
        aggregateFailures += 1;
      }
    } catch {
      aggregateLatencies.push(performance.now() - started);
      aggregateFailures += 1;
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function fmt(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(0)} ms`;
}

console.log(
  `Benchmark: ${DURATION_S}s, batch=${BATCH_SIZE}, concurrency=${CONCURRENCY}, ` +
    `aggregate=${RUN_AGGREGATE}\nTarget: ${BASE_URL}\n`,
);

const startedAt = performance.now();

const workers = Array.from({ length: CONCURRENCY }, () => writer());
if (RUN_AGGREGATE) workers.push(aggregateProbe());

setTimeout(() => (stop = true), DURATION_S * 1000);

await Promise.all(workers);

const elapsedS = (performance.now() - startedAt) / 1000;
const requests = latencies.length;

console.log("INGESTION");
console.log(`  logs accepted        ${accepted.toLocaleString()}`);
console.log(`  throughput           ${Math.round(accepted / elapsedS).toLocaleString()} logs/s`);
console.log(`  requests             ${requests.toLocaleString()} (${(requests / elapsedS).toFixed(1)}/s)`);
console.log(`  failed requests      ${failed}`);
console.log(`  success rate         ${(((requests - failed) / Math.max(1, requests)) * 100).toFixed(2)}%`);
console.log(`  latency p50          ${fmt(percentile(latencies, 50))}`);
console.log(`  latency p95          ${fmt(percentile(latencies, 95))}`);
console.log(`  latency p99          ${fmt(percentile(latencies, 99))}`);
console.log(`  status mix           ${[...statusCounts].map(([k, v]) => `${k}=${v}`).join(" ")}`);

if (RUN_AGGREGATE) {
  console.log("\nAGGREGATE (1 req/s during ingestion)");
  console.log(`  requests             ${aggregateLatencies.length}`);
  console.log(`  failures             ${aggregateFailures}`);
  console.log(`  latency p50          ${fmt(percentile(aggregateLatencies, 50))}`);
  console.log(`  latency p95          ${fmt(percentile(aggregateLatencies, 95))}`);
}

console.log(`\nDuration               ${elapsedS.toFixed(1)}s`);
