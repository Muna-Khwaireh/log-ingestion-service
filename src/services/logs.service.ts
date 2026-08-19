import type { AggregateQuery, LogQuery } from "../logs/log.types.js";
import {
  aggregateLogs,
  getLogs,
  insertLogs,
} from "../repositories/logs.repository.js";
import {
  validateLog,
  type ValidatedLog,
} from "../validation/logs.validation.js";
import { encodeCursor } from "../logs/log.cursor.js";

export type IngestResult = {
  accepted: number;
  rejected: {
    index: number;
    reason: string;
  }[];
};

export async function ingestLogs(
  entries: unknown[],
): Promise<IngestResult> {
  const validLogs: ValidatedLog[] = [];

  const rejected: IngestResult["rejected"] = [];

  for (const [index, entry] of entries.entries()) {
    const result = validateLog(entry);

    if (!result.valid) {
      rejected.push({
        index,
        reason: result.reason,
      });

      continue;
    }

    validLogs.push(result.value);
  }

  if (validLogs.length > 0) {
    await insertLogs(validLogs);
  }

  return {
    accepted: validLogs.length,
    rejected,
  };
}

export async function queryLogs(query: LogQuery) {
  const rows = await getLogs(query);

  const hasMore = rows.length > query.limit;
  const logs = hasMore ? rows.slice(0, query.limit) : rows;

  const lastLog = logs.at(-1);

const nextCursor =
  hasMore && lastLog
    ? encodeCursor(lastLog.timestamp, lastLog.id)
    : null;

  return {
    logs,
    next_cursor: nextCursor,
  };
}


export async function aggregate(query: AggregateQuery) {
  return aggregateLogs(query);
}