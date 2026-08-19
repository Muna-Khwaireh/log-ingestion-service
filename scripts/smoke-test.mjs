

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = Number(process.env.SMOKE_PORT ?? 8080);
const externalBaseUrl = process.env.SMOKE_BASE_URL;
const baseUrl = (externalBaseUrl ?? `http://127.0.0.1:${PORT}`).replace(
  /\/+$/,
  "",
);

const READINESS_TIMEOUT_MS = 30_000;
const READINESS_INTERVAL_MS = 500;

/** @type {import("node:child_process").ChildProcess | undefined} */
let server;
let shuttingDown = false;
const serverOutput = [];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function recordOutput(buffer) {
  serverOutput.push(buffer.toString());
}

function dumpServerOutput() {
  if (serverOutput.length === 0) {
    return;
  }

  console.error("\n----- server output -----");
  console.error(serverOutput.join("").trimEnd());
  console.error("----- end server output -----");
}

function startServer() {
  if (externalBaseUrl) {
    console.log(`Probing existing server at ${baseUrl}`);
    return;
  }

  console.log(`Starting server: node dist/index.js (PORT=${PORT})`);

  server = spawn(process.execPath, ["dist/index.js"], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  server.stdout.on("data", recordOutput);
  server.stderr.on("data", recordOutput);

  server.on("exit", (code, signal) => {
    if (!shuttingDown) {
      console.error(
        `Server exited before the smoke test finished (code=${code}, signal=${signal})`,
      );
    }
  });
}

async function stopServer() {
  if (!server || server.exitCode !== null || server.signalCode !== null) {
    return;
  }

  shuttingDown = true;

  await new Promise((resolve) => {
    const hardKill = sleep(5_000).then(() => {
      if (server && server.exitCode === null && server.signalCode === null) {
        server.kill("SIGKILL");
      }
    });
    hardKill.catch(() => {});

    server.once("exit", () => resolve());
    server.kill("SIGTERM");
  });
}

async function waitForReady() {
  const deadline = Date.now() + READINESS_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (server && server.exitCode !== null) {
      throw new Error("Server process exited before it became ready");
    }

    try {
      const response = await fetch(`${baseUrl}/health`);

      if (response.status === 200) {
        return;
      }
    } catch {
      // Server not accepting connections yet; keep polling until the deadline.
    }

    await sleep(READINESS_INTERVAL_MS);
  }

  throw new Error(
    `Server was not ready (GET /health -> 200) within ${READINESS_TIMEOUT_MS}ms`,
  );
}

const checks = [];

async function check(name, fn) {
  try {
    await fn();
    checks.push({ name, ok: true });
    console.log(`  ok    ${name}`);
  } catch (error) {
    checks.push({ name, ok: false });
    console.log(`  FAIL  ${name} -> ${error.message}`);
  }
}

async function runChecks() {
  // Unique service so GET /logs can scope to this run rather than to whatever
  // else is in the database.
  const service = `smoke-${Date.now()}`;

  await check("GET /health returns 200 OK", async () => {
    const response = await fetch(`${baseUrl}/health`);
    assert(response.status === 200, `status ${response.status}`);

    const text = await response.text();
    assert(text === "OK", `body ${JSON.stringify(text)}`);
  });

  await check("POST /logs accepts a log", async () => {
    const response = await fetch(`${baseUrl}/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        logs: [
          {
            timestamp: new Date().toISOString(),
            level: "info",
            service,
            message: "smoke test log",
            attributes: { smoke: true },
          },
        ],
      }),
    });

    assert(response.status === 200, `status ${response.status}`);

    const body = await response.json();
    assert(body.accepted === 1, `accepted ${body.accepted}`);
  });

  await check("GET /logs returns a logs array", async () => {
    const response = await fetch(
      `${baseUrl}/logs?service=${encodeURIComponent(service)}&limit=10`,
    );

    assert(response.status === 200, `status ${response.status}`);

    const body = await response.json();
    assert(Array.isArray(body.logs), "response has no logs array");
  });

  await check("GET /logs/aggregate returns buckets", async () => {
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const until = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const response = await fetch(
      `${baseUrl}/logs/aggregate?since=${encodeURIComponent(
        since,
      )}&until=${encodeURIComponent(until)}&bucket=1h`,
    );

    assert(response.status === 200, `status ${response.status}`);

    const body = await response.json();
    assert(Array.isArray(body.buckets), "response has no buckets array");
  });
}

console.log(`Smoke test against ${baseUrl}\n`);

try {
  startServer();
  await waitForReady();
  await runChecks();
} catch (error) {
  console.error(`\nSmoke test could not run: ${error.message}`);
  checks.push({ name: "server startup", ok: false });
} finally {
  await stopServer();
}

const failed = checks.filter((entry) => !entry.ok);

if (failed.length > 0) {
  dumpServerOutput();
  console.error(
    `\nSmoke test FAILED: ${failed.length} of ${checks.length} check(s) did not pass.`,
  );
  process.exit(1);
}

console.log(
  `\nSmoke test passed: all ${checks.length} required endpoints are reachable.`,
);
