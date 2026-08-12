export const LOG_LEVELS = [
  "debug",
  "info",
  "warn",
  "error",
] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export type LogAttributeValue = string | number | boolean;

export type LogAttributes = Record<string, LogAttributeValue>;

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  service: string;
  message: string;
  attributes?: LogAttributes;
}

export interface IngestLogsRequest {
  logs: unknown[];
}

export interface RejectedLog {
  index: number;
  reason: string;
}

export interface LogQuery {
  service?: string | undefined;
  level?: LogLevel | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}