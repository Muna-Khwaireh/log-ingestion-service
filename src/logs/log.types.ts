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
  service?: string;
  level?: LogLevel;
  since?: Date;
  until?: Date;
  attributeFilters?: Record<string, string>;
  messageQuery?: string;
  limit: number;
  cursor?: {
    timestamp: Date;
    id: number;
  };
}

export type AggregateBucket = "1m" | "5m" | "1h" | "1d";

export type AggregateGroupBy = "service" | "level";

export interface AggregateQuery {
  since: Date;
  until: Date;
  bucket: AggregateBucket;
  groupBy?: AggregateGroupBy;
  service?: string;
  level?: LogLevel;
  attributeFilters?: Record<string, string>;
  messageQuery?: string;
}