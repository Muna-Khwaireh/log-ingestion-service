import {
  LOG_LEVELS,
  type LogLevel,
} from "../logs/log.types.js";

export type ValidatedLog = {
  timestamp: Date;
  level: LogLevel;
  service: string;
  message: string;
  attributes: Record<string, string | number | boolean>;
};

export type ValidationResult =
  | {
      valid: true;
      value: ValidatedLog;
    }
  | {
      valid: false;
      reason: string;
    };

export function validateLog(input: unknown): ValidationResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {
      valid: false,
      reason: "log entry must be an object",
    };
  }

  const log = input as Record<string, unknown>;

  // timestamp
  if (typeof log.timestamp !== "string") {
    return {
      valid: false,
      reason: "timestamp is required",
    };
  }

  const timestamp = new Date(log.timestamp);

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

  // level
  if (typeof log.level !== "string") {
    return {
      valid: false,
      reason: "level is required",
    };
  }

  if (!LOG_LEVELS.includes(log.level as LogLevel)) {
    return {
      valid: false,
      reason: `invalid level: '${log.level}'`,
    };
  }

  // service
  if (typeof log.service !== "string" || log.service.trim() === "") {
    return {
      valid: false,
      reason: "service must be a non-empty string",
    };
  }

  // message
  if (typeof log.message !== "string" || log.message.trim() === "") {
    return {
      valid: false,
      reason: "message must be a non-empty string",
    };
  }

  // attributes
  const attributes: Record<string, string | number | boolean> = {};

  if (log.attributes !== undefined) {
    if (
      typeof log.attributes !== "object" ||
      log.attributes === null ||
      Array.isArray(log.attributes)
    ) {
      return {
        valid: false,
        reason: "attributes must be a flat object",
      };
    }

    for (const [key, value] of Object.entries(
      log.attributes as Record<string, unknown>,
    )) {
      if (
        typeof value !== "string" &&
        typeof value !== "number" &&
        typeof value !== "boolean"
      ) {
        return {
          valid: false,
          reason: `invalid attribute value for '${key}'`,
        };
      }

      attributes[key] = value;
    }
  }

  return {
    valid: true,
    value: {
      timestamp,
      level: log.level as LogLevel,
      service: log.service,
      message: log.message,
      attributes,
    },
  };
}