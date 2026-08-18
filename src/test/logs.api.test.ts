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


test("GET /logs compares attribute values as strings across JSON types", async () => {
  const { server, baseUrl } = await startServer();

  const service = `attr-types-${Date.now()}-${Math.round(Math.random() * 1e6)}`;

  try {
    const ingest = await fetch(`${baseUrl}/logs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        logs: [
          {
            timestamp: new Date().toISOString(),
            level: "info",
            service,
            message: "attribute type coverage",
            attributes: {
              retries: 3,
              successful: true,
              user_id: "42",
            },
          },
        ],
      }),
    });

    assert.equal(ingest.status, 200);

    const matchCount = async (filter: string) => {
      const response = await fetch(
        `${baseUrl}/logs?service=${service}&${filter}`,
      );

      assert.equal(response.status, 200);

      const body = (await response.json()) as { logs: unknown[] };

      return body.logs.length;
    };

    // Stored as a number and a boolean, filtered with strings off the query
    // string. Type-strict jsonb containment would return 0 for both.
    assert.equal(await matchCount("attr.retries=3"), 1);
    assert.equal(await matchCount("attr.successful=true"), 1);
    assert.equal(await matchCount("attr.user_id=42"), 1);

    // Values that genuinely differ must still not match.
    assert.equal(await matchCount("attr.retries=4"), 0);
    assert.equal(await matchCount("attr.successful=false"), 0);
    assert.equal(await matchCount("attr.user_id=43"), 0);
    assert.equal(await matchCount("attr.absent=3"), 0);
  } finally {
    await stopServer(server);
  }
});
