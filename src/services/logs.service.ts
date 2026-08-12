import {  getLogs,insertLogs } from "../repositories/logs.repository.js";
import {
  validateLog,
  type ValidatedLog,
} from "../validation/logs.validation.js";

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

export async function queryLogs() {
  return getLogs();
}