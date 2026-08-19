import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";


const skip =
  process.platform === "win32"
    ? "POSIX signals are emulated on Windows; graceful shutdown runs on Linux/CI"
    : false;

test(
  "SIGTERM shuts the server down gracefully and exits 0",
  { skip, timeout: 30_000 },
  async () => {
    const entry = fileURLToPath(new URL("../index.js", import.meta.url));

    const child = spawn(process.execPath, [entry], {
      env: {
        ...process.env,
        PORT: "8110",
        
        DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:1/logs",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));

    const exited = new Promise<number | null>((resolve) =>
      child.on("exit", (code) => resolve(code)),
    );

    try {
      // Wait until it is accepting connections.
      const deadline = Date.now() + 15_000;
      while (
        !output.includes("Server is running") &&
        Date.now() < deadline
      ) {
        await sleep(100);
      }

      assert.ok(
        output.includes("Server is running"),
        `server never reported ready; output:\n${output}`,
      );

      child.kill("SIGTERM");

      const code = await exited;

      assert.equal(code, 0, `expected a clean exit; output:\n${output}`);
      assert.match(output, /Received SIGTERM/);
      assert.match(output, /Shutdown complete/);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
  },
);
