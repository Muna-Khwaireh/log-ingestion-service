import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../app.js";

test("GET /health returns 200 OK", async () => {
  const server = createApp();

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  try {
    const address = server.address();

if (!address || typeof address === "string") {
  throw new Error("Server address is unavailable");
}

const response = await fetch(
  `http://127.0.0.1:${address.port}/health`,
);

    assert.equal(response.status, 200);
    assert.equal(await response.text(), "OK");
  } finally {
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
});