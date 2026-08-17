import { test } from "node:test";
import assert from "node:assert/strict";
import { validateLog } from "../validation/logs.validation.js";

test("accepts a valid log", () => {
  const result = validateLog({
    timestamp: "2026-08-17T18:00:00.000Z",
    level: "info",
    service: "api",
    message: "request completed",
    attributes: {
      user_id: "42",
      retries: 3,
      cached: true,
    },
  });

  assert.equal(result.valid, true);
});

test("rejects an invalid log level", () => {
  const result = validateLog({
    timestamp: "2026-08-17T18:00:00.000Z",
    level: "critical",
    service: "api",
    message: "bad level",
  });

  assert.equal(result.valid, false);

  if (!result.valid) {
    assert.equal(result.reason, "invalid level: 'critical'");
  }
});

test("rejects a timestamp more than five minutes in the future", () => {
  const future = new Date(Date.now() + 6 * 60 * 1000);

  const result = validateLog({
    timestamp: future.toISOString(),
    level: "info",
    service: "api",
    message: "future log",
  });

  assert.equal(result.valid, false);
});

test("rejects nested attributes", () => {
  const result = validateLog({
    timestamp: "2026-08-17T18:00:00.000Z",
    level: "info",
    service: "api",
    message: "nested attributes",
    attributes: {
      user: {
        id: 42,
      },
    },
  });

  assert.equal(result.valid, false);

  if (!result.valid) {
    assert.equal(
      result.reason,
      "invalid attribute value for 'user'",
    );
  }
});

test("rejects array attributes", () => {
  const result = validateLog({
    timestamp: "2026-08-17T18:00:00.000Z",
    level: "info",
    service: "api",
    message: "array attributes",
    attributes: ["bad"],
  });

  assert.equal(result.valid, false);

  if (!result.valid) {
    assert.equal(
      result.reason,
      "attributes must be a flat object",
    );
  }
});

test("rejects empty service", () => {
  const result = validateLog({
    timestamp: "2026-08-17T18:00:00.000Z",
    level: "info",
    service: "   ",
    message: "test",
  });

  assert.equal(result.valid, false);
});

test("rejects empty message", () => {
  const result = validateLog({
    timestamp: "2026-08-17T18:00:00.000Z",
    level: "info",
    service: "api",
    message: "",
  });

  assert.equal(result.valid, false);
});

