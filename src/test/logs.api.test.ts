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

test("POST /logs accepts a valid log", async () => {
  const { server, baseUrl } = await startServer();

  try {
    const response = await fetch(`${baseUrl}/logs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        logs: [
          {
            timestamp: new Date().toISOString(),
            level: "info",
            service: "api-test",
            message: "integration test log",
            attributes: {
              environment: "test",
              retries: 2,
              successful: true,
            },
          },
        ],
      }),
    });

    assert.equal(response.status, 200);

    const body = await response.json();

    assert.deepEqual(body, {
      accepted: 1,
      rejected: [],
    });
  } finally {
    await stopServer(server);
  }
});

test("POST /logs rejects invalid logs", async () => {
  const { server, baseUrl } = await startServer();

  try {
    const response = await fetch(`${baseUrl}/logs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        logs: [
          {
            timestamp: new Date().toISOString(),
            level: "invalid-level",
            service: "api-test",
            message: "this should be rejected",
          },
        ],
      }),
    });

    assert.equal(response.status, 400);

    const body = await response.json();

    assert.equal(body.accepted, 0);
    assert.equal(body.rejected.length, 1);
    assert.equal(body.rejected[0].index, 0);
    assert.equal(
      body.rejected[0].reason,
      "invalid level: 'invalid-level'",
    );
  } finally {
    await stopServer(server);
  }
});

test("POST /logs accepts valid logs and rejects invalid logs", async () => {
  const { server, baseUrl } = await startServer();

  try {
    const response = await fetch(`${baseUrl}/logs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        logs: [
          {
            timestamp: new Date().toISOString(),
            level: "info",
            service: "api-test",
            message: "valid log",
          },
          {
            timestamp: new Date().toISOString(),
            level: "not-a-level",
            service: "api-test",
            message: "invalid log",
          },
          {
            timestamp: new Date().toISOString(),
            level: "error",
            service: "api-test",
            message: "another valid log",
          },
        ],
      }),
    });

    assert.equal(response.status, 200);

    const body = await response.json();

    assert.equal(body.accepted, 2);
    assert.equal(body.rejected.length, 1);
    assert.equal(body.rejected[0].index, 1);
  } finally {
    await stopServer(server);
  }
});

test.after(async () => {
  await closeDb();
});

