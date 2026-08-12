import {
  LOG_LEVELS,
  type LogAttributes,
  type LogEntry,
} from "./log.types.js";

export type ValidationResult =
  | {
      valid: true;
      log: LogEntry;
    }
  | {
      valid: false;
      reason: string;
    };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function isValidAttributes(
  value: unknown,
): value is LogAttributes {
  if (value === undefined) {
    return true;
  }

  if (!isPlainObject(value)) {
    return false;
  }

  for (const attributeValue of Object.values(value)) {
    if (
      typeof attributeValue !== "string" &&
      typeof attributeValue !== "number" &&
      typeof attributeValue !== "boolean"
    ) {
      return false;
    }
  }

  return true;
}

export function validateLog(value: unknown): ValidationResult {
  if (!isPlainObject(value)) {
    return {
      valid: false,
      reason: "log entry must be an object",
    };
  }

  if (typeof value.timestamp !== "string") {
    return {
      valid: false,
      reason: "timestamp is required",
    };
  }

  const timestamp = new Date(value.timestamp);

  if (Number.isNaN(timestamp.getTime())) {
    return {
      valid: false,
      reason: "invalid timestamp",
    };
  }

  const fiveMinutesFromNow = Date.now() + 5 * 60 * 1000;

  if (timestamp.getTime() > fiveMinutesFromNow) {
    return {
      valid: false,
      reason: "timestamp is more than five minutes in the future",
    };
  }

  if (
    typeof value.level !== "string" ||
    !LOG_LEVELS.includes(value.level as (typeof LOG_LEVELS)[number])
  ) {
    return {
      valid: false,
      reason: `invalid level: '${String(value.level)}'`,
    };
  }

  if (
    typeof value.service !== "string" ||
    value.service.trim() === ""
  ) {
    return {
      valid: false,
      reason: "service must be a non-empty string",
    };
  }

  if (
    typeof value.message !== "string" ||
    value.message.trim() === ""
  ) {
    return {
      valid: false,
      reason: "message must be a non-empty string",
    };
  }

  if (!isValidAttributes(value.attributes)) {
    return {
      valid: false,
      reason: "attributes must be a flat object with string, number, or boolean values",
    };
  }

  return {
    valid: true,
    log: {
      timestamp: timestamp.toISOString(),
      level: value.level as LogEntry["level"],
      service: value.service,
      message: value.message,
      attributes: value.attributes ?? {},
    },
  };
}