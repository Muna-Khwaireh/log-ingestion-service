import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../app.js";
import { closeDb } from "../db/index.js";

async function startServer() {
  const server = createApp();

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("Server address is unavailable");
  }

  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function stopServer(
  server: ReturnType<typeof createApp>,
) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

test("GET /health returns 200 OK when the database is reachable", async () => {
  const { server, baseUrl } = await startServer();

  try {
    const response = await fetch(`${baseUrl}/health`);

    assert.equal(response.status, 200);
    assert.equal(await response.text(), "OK");
  } finally {
    await stopServer(server);
  }
});

test("GET /health returns 503 when the database is unreachable", async () => {
  const originalUrl = process.env.DATABASE_URL;

  // Drop the cached connection so the next getDb() picks up the bad URL.
  await closeDb();

  process.env.DATABASE_URL =
    "postgres://postgres:postgres@127.0.0.1:1/logs";

  const { server, baseUrl } = await startServer();

  try {
    const response = await fetch(`${baseUrl}/health`);

    assert.equal(response.status, 503);
    assert.equal(await response.text(), "Service Unavailable");
  } finally {
    await stopServer(server);
    await closeDb();

    if (originalUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalUrl;
    }
  }
});

test("GET /health returns 503 when DATABASE_URL is missing", async () => {
  const originalUrl = process.env.DATABASE_URL;

  await closeDb();

  delete process.env.DATABASE_URL;

  const { server, baseUrl } = await startServer();

  try {
    const response = await fetch(`${baseUrl}/health`);

    assert.equal(response.status, 503);
    assert.equal(await response.text(), "Service Unavailable");
  } finally {
    await stopServer(server);

    if (originalUrl !== undefined) {
      process.env.DATABASE_URL = originalUrl;
    }
  }
});
