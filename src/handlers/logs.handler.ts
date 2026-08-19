import type { IncomingMessage, ServerResponse } from "node:http";
import { aggregate, ingestLogs, queryLogs } from "../services/logs.service.js";
import type { IngestResult } from "../services/logs.service.js";
import type {
  AggregateBucket,
  AggregateQuery,
  LogLevel,
  LogQuery,
} from "../logs/log.types.js";
import { LOG_LEVELS } from "../logs/log.types.js";
import { decodeCursor } from "../logs/log.cursor.js";

/** The query parameters shared by GET /logs and GET /logs/aggregate. */
type CommonFilters = Pick<
  LogQuery,
  "service" | "level" | "attributeFilters" | "messageQuery"
>;

type CommonFilterResult =
  | { ok: true; filters: CommonFilters }
  | { ok: false; error: string };


function badRequest(res: ServerResponse, error: string) {
  res.writeHead(400, {
    "Content-Type": "application/json",
  });

  res.end(JSON.stringify({ error }));
}

/**
 * Parses and validates the filters shared by GET /logs and GET /logs/aggregate:
 * service, level, message search (q) and attribute filters (attr.*). Both
 * endpoints route through this one function, so they accept the same inputs and
 * reject bad ones with the same messages by construction -- rather than by two
 * hand-written copies happening to stay in agreement.
 */
function parseCommonFilters(url: URL): CommonFilterResult {
  const filters: CommonFilters = {};

  const service = url.searchParams.get("service");

  if (service !== null) {
    filters.service = service;
  }

  const levelParam = url.searchParams.get("level");

  if (levelParam !== null) {
    if (!LOG_LEVELS.includes(levelParam as LogLevel)) {
      return { ok: false, error: `invalid level: '${levelParam}'` };
    }

    filters.level = levelParam as LogLevel;
  }

  const attributeFilters: Record<string, string> = {};

  for (const [key, value] of url.searchParams.entries()) {
    if (key.startsWith("attr.")) {
      const attributeName = key.slice(5);

      if (!attributeName) {
        return { ok: false, error: "attribute name cannot be empty" };
      }

      attributeFilters[attributeName] = value;
    }
  }

  if (Object.keys(attributeFilters).length > 0) {
    filters.attributeFilters = attributeFilters;
  }

  const q = url.searchParams.get("q");

  if (q !== null) {
    filters.messageQuery = q;
  }

  return { ok: true, filters };
}

export async function handleGetLogs(
  req: IncomingMessage,
  res: ServerResponse,
) {
  try {
    const url = new URL(req.url ?? "/logs", "http://localhost");

    const common = parseCommonFilters(url);

    if (!common.ok) {
      badRequest(res, common.error);
      return;
    }

    const sinceParam = url.searchParams.get("since");
    const untilParam = url.searchParams.get("until");

    const since = sinceParam ? new Date(sinceParam) : undefined;
    const until = untilParam ? new Date(untilParam) : undefined;

    if (sinceParam && Number.isNaN(since!.getTime())) {
      badRequest(res, "invalid since timestamp");
      return;
    }

    if (untilParam && Number.isNaN(until!.getTime())) {
      badRequest(res, "invalid until timestamp");
      return;
    }

    if (since && until && until < since) {
      badRequest(res, "until must not be earlier than since");
      return;
    }

    const limitParam = url.searchParams.get("limit");

    let limit = 100;

    if (limitParam !== null) {
      limit = Number(limitParam);

      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
        badRequest(res, "limit must be an integer between 1 and 1000");
        return;
      }
    }

    const cursorParam = url.searchParams.get("cursor");

    let cursor: LogQuery["cursor"];

    if (cursorParam) {
      try {
        const decoded = decodeCursor(cursorParam);

        cursor = {
          timestamp: new Date(decoded.timestamp),
          id: decoded.id,
        };
      } catch {
        badRequest(res, "invalid cursor");
        return;
      }
    }

    const query: LogQuery = {
      ...common.filters,
      limit,
    };

    if (since !== undefined) {
      query.since = since;
    }

    if (until !== undefined) {
      query.until = until;
    }

    if (cursor !== undefined) {
      query.cursor = cursor;
    }

    const result = await queryLogs(query);

    res.writeHead(200, {
      "Content-Type": "application/json",
    });

    res.end(JSON.stringify(result));
  } catch (error) {
    console.error("Failed to fetch logs:", error);

    res.writeHead(500, {
      "Content-Type": "application/json",
    });

    res.end(
      JSON.stringify({
        error: "internal server error",
      }),
    );
  }
}

const MAX_BODY_BYTES = 16 * 1024 * 1024; // 16 MiB

class PayloadTooLargeError extends Error {
  constructor() {
    super("request body exceeds the maximum allowed size");
    this.name = "PayloadTooLargeError";
  }
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    req.on("data", (chunk: Buffer) => {
      if (settled) {
        // Past the cap: keep reading but discard, so memory stays bounded
        // while the rest of the upload drains. Draining matters -- closing the
        // socket with the body half-read triggers a TCP reset that would wipe
        // out the 413 response before the client can read it.
        return;
      }

      size += chunk.length;

      if (size > MAX_BODY_BYTES) {
        settled = true;
        reject(new PayloadTooLargeError());
        return;
      }

      chunks.push(chunk);
    });

    req.on("end", () => {
      if (settled) {
        return;
      }

      settled = true;

      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
      } catch (error) {
        reject(error);
      }
    });

    // A dropped or client-aborted upload surfaces as an 'error' on the
    // request. Keep a listener attached for the whole request so it never
    // becomes an unhandled 'error' that crashes the process.
    req.on("error", (error) => {
      if (settled) {
        return;
      }

      settled = true;
      reject(error);
    });
  });
}

export async function handlePostLogs(
  req: IncomingMessage,
  res: ServerResponse,
) {
  
  let body: unknown;

  try {
    body = await readBody(req);
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      
      res.writeHead(413, {
        "Content-Type": "application/json",
        Connection: "close",
      });

      res.end(
        JSON.stringify({
          error: "request body exceeds the 16 MB limit",
        }),
      );

      return;
    }

    console.error("Failed to read request body:", error);

    res.writeHead(400, {
      "Content-Type": "application/json",
    });

    res.end(
      JSON.stringify({
        error: "invalid JSON body",
      }),
    );

    return;
  }

  if (
    typeof body !== "object" ||
    body === null ||
    !("logs" in body) ||
    !Array.isArray(body.logs)
  ) {
    res.writeHead(400, {
      "Content-Type": "application/json",
    });

    res.end(
      JSON.stringify({
        error: "request body must contain a logs array",
      }),
    );

    return;
  }

  let result: IngestResult;

  try {
    result = await ingestLogs(body.logs);
  } catch (error) {
    console.error("Failed to ingest logs:", error);

    res.writeHead(503, {
      "Content-Type": "application/json",
      "Retry-After": "1",
    });

    res.end(
      JSON.stringify({
        error: "log storage is unavailable",
      }),
    );

    return;
  }

  if (result.accepted === 0) {
    res.writeHead(400, {
      "Content-Type": "application/json",
    });

    res.end(JSON.stringify(result));

    return;
  }

  res.writeHead(200, {
    "Content-Type": "application/json",
  });

  res.end(JSON.stringify(result));
}

export async function handleAggregateLogs(
  req: IncomingMessage,
  res: ServerResponse,
) {
  try {
    const url = new URL(
      req.url ?? "/logs/aggregate",
      "http://localhost",
    );

    const sinceParam = url.searchParams.get("since");
    const untilParam = url.searchParams.get("until");
    const bucketParam = url.searchParams.get("bucket");
    const groupByParam = url.searchParams.get("group_by");

    if (!sinceParam || !untilParam || !bucketParam) {
      badRequest(res, "since, until, and bucket are required");
      return;
    }

    const since = new Date(sinceParam);
    const until = new Date(untilParam);

    if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime())) {
      badRequest(res, "invalid timestamp");
      return;
    }

    if (until <= since) {
      badRequest(res, "until must be later than since");
      return;
    }

    if (
      bucketParam !== "1m" &&
      bucketParam !== "5m" &&
      bucketParam !== "1h" &&
      bucketParam !== "1d"
    ) {
      badRequest(res, "invalid bucket");
      return;
    }

    if (
      groupByParam !== null &&
      groupByParam !== "service" &&
      groupByParam !== "level"
    ) {
      badRequest(res, "invalid groupBy");
      return;
    }

    const common = parseCommonFilters(url);

    if (!common.ok) {
      badRequest(res, common.error);
      return;
    }

    const query: AggregateQuery = {
      ...common.filters,
      since,
      until,
      bucket: bucketParam as AggregateBucket,
    };

    if (groupByParam === "service" || groupByParam === "level") {
      query.groupBy = groupByParam;
    }

    const result = await aggregate(query);

    res.writeHead(200, {
      "Content-Type": "application/json",
    });

    res.end(
      JSON.stringify({
        buckets: result,
      }),
    );
  } catch (error) {
    console.error("Failed to aggregate logs:", error);

    res.writeHead(500, {
      "Content-Type": "application/json",
    });

    res.end(
      JSON.stringify({
        error: "internal server error",
      }),
    );
  }
}