import { test } from "node:test";
import assert from "node:assert/strict";
import {
  encodeCursor,
  decodeCursor,
} from "../logs/log.cursor.js";

test("encodes and decodes a cursor", () => {
  const timestamp = new Date("2026-08-17T18:00:00.000Z");
  const id = 123;

  const cursor = encodeCursor(timestamp, id);
  const decoded = decodeCursor(cursor);

  assert.equal(decoded.timestamp, timestamp.toISOString());
  assert.equal(decoded.id, id);
});

test("rejects malformed cursor", () => {
  assert.throws(
    () => decodeCursor("not-a-valid-cursor"),
    /invalid cursor/,
  );
});

test("rejects cursor with invalid id", () => {
  const cursor = Buffer.from(
    JSON.stringify({
      timestamp: "2026-08-17T18:00:00.000Z",
      id: "123",
    }),
  ).toString("base64url");

  assert.throws(
    () => decodeCursor(cursor),
    /invalid cursor/,
  );
});

test("rejects cursor with invalid timestamp", () => {
  const cursor = Buffer.from(
    JSON.stringify({
      timestamp: "not-a-date",
      id: 123,
    }),
  ).toString("base64url");

  assert.throws(
    () => decodeCursor(cursor),
    /invalid cursor/,
  );
});
