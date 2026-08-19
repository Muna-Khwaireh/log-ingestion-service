import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
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

test("GET /logs treats LIKE metacharacters in q as literal text", async () => {
  const { server, baseUrl } = await startServer();

  const service = `like-escape-${Date.now()}-${Math.round(Math.random() * 1e6)}`;

  const entry = (message: string) => ({
    timestamp: new Date().toISOString(),
    level: "info",
    service,
    message,
  });

  try {
    const ingest = await fetch(`${baseUrl}/logs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        logs: [
          entry("order 1_ shipped"), // literal underscore
          entry("order 12 shipped"), // an unescaped _ would match this too
          entry("disk 90% full"), //   literal percent
          entry("disk 9000 full"), //  an unescaped % would match this too
          entry("path C:\\logs"), //   literal backslash
          entry("path C:Xlogs"), //    a bare \ would swallow the next char
        ],
      }),
    });

    assert.equal(ingest.status, 200);

    const search = async (q: string) => {
      const response = await fetch(
        `${baseUrl}/logs?service=${service}&q=${encodeURIComponent(q)}`,
      );

      assert.equal(response.status, 200);

      const body = (await response.json()) as {
        logs: { message: string }[];
      };

      return body.logs.map((log) => log.message).sort();
    };

   
    assert.deepEqual(await search("order 1_ shipped"), ["order 1_ shipped"]);

    
    assert.deepEqual(await search("disk 90%"), ["disk 90% full"]);

    
    assert.deepEqual(await search("C:\\logs"), ["path C:\\logs"]);

    
    assert.deepEqual(await search("shipped"), [
      "order 12 shipped",
      "order 1_ shipped",
    ]);
  } finally {
    await stopServer(server);
  }
});

test("GET /logs and /logs/aggregate validate shared filters identically", async () => {
  const { server, baseUrl } = await startServer();

  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const until = new Date().toISOString();

  
  const cases = [
    { query: "level=nope", error: "invalid level: 'nope'" },
    { query: "attr.=x", error: "attribute name cannot be empty" },
  ];

  try {
    for (const { query, error } of cases) {
      const get = await fetch(`${baseUrl}/logs?${query}`);
      const aggregate = await fetch(
        `${baseUrl}/logs/aggregate?since=${encodeURIComponent(
          since,
        )}&until=${encodeURIComponent(until)}&bucket=1h&${query}`,
      );

      assert.equal(get.status, 400, `GET /logs?${query}`);
      assert.deepEqual(await get.json(), { error });

      assert.equal(aggregate.status, 400, `GET /logs/aggregate ...&${query}`);
      assert.deepEqual(await aggregate.json(), { error });
    }
  } finally {
    await stopServer(server);
  }
});

test("concurrent batches are all durable once POST /logs returns 200", async () => {
  const { server, baseUrl } = await startServer();

  // Enough concurrent requests to be coalesced into shared flushes by the
  // group-commit buffer, which is exactly the case that must not lose rows.
  const BATCHES = 12;
  const PER_BATCH = 25;

  const service = `groupcommit-${Date.now()}-${Math.round(Math.random() * 1e6)}`;

  try {
    const responses = await Promise.all(
      Array.from({ length: BATCHES }, (_, batch) =>
        fetch(`${baseUrl}/logs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            logs: Array.from({ length: PER_BATCH }, (_, i) => ({
              timestamp: new Date().toISOString(),
              level: "info",
              service,
              message: `batch ${batch} entry ${i}`,
            })),
          }),
        }),
      ),
    );

    for (const response of responses) {
      assert.equal(response.status, 200);

      const body = (await response.json()) as { accepted: number };
      assert.equal(body.accepted, PER_BATCH);
    }

    // Read immediately, with no delay: a 200 must mean the rows are already
    // committed, not merely queued for a later flush.
    const query = await fetch(
      `${baseUrl}/logs?service=${service}&limit=1000`,
    );

    assert.equal(query.status, 200);

    const body = (await query.json()) as { logs: unknown[] };

    assert.equal(body.logs.length, BATCHES * PER_BATCH);
  } finally {
    await stopServer(server);
  }
});

test("POST /logs rejects malformed JSON as a client error", async () => {
  const { server, baseUrl } = await startServer();

  try {
    const response = await fetch(`${baseUrl}/logs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: "{ this is not json",
    });

    assert.equal(response.status, 400);

    assert.deepEqual(await response.json(), {
      error: "invalid JSON body",
    });
  } finally {
    await stopServer(server);
  }
});

test("POST /logs rejects a body larger than the limit with 413", { timeout: 30_000 }, async () => {
  const { server, baseUrl } = await startServer();

  // Comfortably past the 16 MiB cap, and deliberately not valid JSON: the size
  // guard has to fire before the body is ever handed to JSON.parse.
  const oversized = "x".repeat(17 * 1024 * 1024);

  try {
    const { status, body } = await new Promise<{
      status: number;
      body: string;
    }>((resolve) => {
      const request = http.request(
        `${baseUrl}/logs`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
        (response) => {
          const parts: Buffer[] = [];
          let done = false;

         
          const finish = () => {
            if (done) {
              return;
            }

            done = true;

            resolve({
              status: response.statusCode ?? 0,
              body: Buffer.concat(parts).toString("utf-8"),
            });
          };

          response.on("data", (part) => parts.push(Buffer.from(part)));
          response.on("end", finish);
          response.on("close", finish);
        },
      );

      // The server closes the connection the moment the cap trips, so the tail
      // of the upload fails to write. The 413 response has already been
      // received by then, so this write error is expected, not a failure.
      request.on("error", () => {});

      request.write(oversized);
      request.end();
    });

    assert.equal(status, 413);
    assert.deepEqual(JSON.parse(body), {
      error: "request body exceeds the 16 MB limit",
    });
  } finally {
    await stopServer(server);
  }
});

test("POST /logs reports a storage failure as 503, not as a client error", async () => {
  const originalUrl = process.env.DATABASE_URL;

  // Drop the cached connection so the next getDb() picks up the bad URL.
  await closeDb();

  process.env.DATABASE_URL =
    "postgres://postgres:postgres@127.0.0.1:1/logs";

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
            message: "storage is unreachable",
          },
        ],
      }),
    });

    
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), "1");

    assert.deepEqual(await response.json(), {
      error: "log storage is unavailable",
    });
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

test("POST /logs preserves messages containing COPY delimiters and quotes", async () => {
  const { server, baseUrl } = await startServer();

  const service = `copy-encoding-${Date.now()}-${Math.round(Math.random() * 1e6)}`;

  const messages = [
    "comma, separated",
    'double "quoted" text',
    "line one\nline two",
    "tab\tseparated",
    "backslash \ and \. terminator",
    "unicode ✓ accented ü",
  ];

  const note = 'has "quotes", commas\nand newlines';

  try {
    const ingest = await fetch(`${baseUrl}/logs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        logs: messages.map((message) => ({
          timestamp: new Date().toISOString(),
          level: "info",
          service,
          message,
          attributes: { note },
        })),
      }),
    });

    assert.equal(ingest.status, 200);

    const accepted = (await ingest.json()) as { accepted: number };

    assert.equal(accepted.accepted, messages.length);

    const response = await fetch(
      `${baseUrl}/logs?service=${service}&limit=50`,
    );

    assert.equal(response.status, 200);

    const body = (await response.json()) as {
      logs: { message: string; attributes: Record<string, string> }[];
    };

    assert.deepEqual(
      body.logs.map((log) => log.message).sort(),
      [...messages].sort(),
    );

    for (const log of body.logs) {
      assert.equal(log.attributes.note, note);
    }
  } finally {
    await stopServer(server);
  }
});
