import type { IncomingMessage, ServerResponse } from "node:http";
import { ingestLogs, queryLogs } from "../services/logs.service.js";
import type { IngestResult } from "../services/logs.service.js";
import type {
  LogLevel,
  LogQuery,
} from "../logs/log.types.js";
import { LOG_LEVELS } from "../logs/log.types.js";
import { decodeCursor } from "../logs/log.cursor.js";
import { aggregateLogs } from "../repositories/logs.repository.js";

export async function handleGetLogs(
  req: IncomingMessage,
  res: ServerResponse,
) {
  try {
    const url = new URL(
      req.url ?? "/logs",
      "http://localhost",
    );

    const service = url.searchParams.get("service") ?? undefined;

    const levelParam = url.searchParams.get("level");
    let level: LogLevel | undefined;

    if (levelParam !== null) {
      if (!LOG_LEVELS.includes(levelParam as LogLevel)) {
        res.writeHead(400, {
          "Content-Type": "application/json",
        });

        res.end(
          JSON.stringify({
            error: `invalid level: '${levelParam}'`,
          }),
        );

        return;
      }

      level = levelParam as LogLevel;
    }

    const sinceParam = url.searchParams.get("since");
    const untilParam = url.searchParams.get("until");

    const since = sinceParam
      ? new Date(sinceParam)
      : undefined;

    const until = untilParam
      ? new Date(untilParam)
      : undefined;

    if (sinceParam && Number.isNaN(since!.getTime())) {
      res.writeHead(400, {
        "Content-Type": "application/json",
      });

      res.end(
        JSON.stringify({
          error: "invalid since timestamp",
        }),
      );

      return;
    }

    if (untilParam && Number.isNaN(until!.getTime())) {
      res.writeHead(400, {
        "Content-Type": "application/json",
      });

      res.end(
        JSON.stringify({
          error: "invalid until timestamp",
        }),
      );

      return;
    }

    if (since && until && until < since) {
      res.writeHead(400, {
        "Content-Type": "application/json",
      });

      res.end(
        JSON.stringify({
          error: "until must not be earlier than since",
        }),
      );

      return;
    }

    const limitParam = url.searchParams.get("limit");

    let limit = 100;

    if (limitParam !== null) {
      limit = Number(limitParam);

      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 1000
      ) {
        res.writeHead(400, {
          "Content-Type": "application/json",
        });

        res.end(
          JSON.stringify({
            error: "limit must be an integer between 1 and 1000",
          }),
        );

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
        res.writeHead(400, {
          "Content-Type": "application/json",
        });

        res.end(
          JSON.stringify({
            error: "invalid cursor",
          }),
        );

        return;
      }
    }

    const attributeFilters: Record<string, string> = {};

    for (const [key, value] of url.searchParams.entries()) {
      if (key.startsWith("attr.")) {
        const attributeName = key.slice(5);

        if (!attributeName) {
          res.writeHead(400, {
            "Content-Type": "application/json",
          });

          res.end(
            JSON.stringify({
              error: "attribute name cannot be empty",
            }),
          );

          return;
        }

        attributeFilters[attributeName] = value;
      }
    }

    const q = url.searchParams.get("q") ?? undefined;

    const query: LogQuery = {
  limit,
};

if (service !== undefined) {
  query.service = service;
}

if (level !== undefined) {
  query.level = level;
}

if (since !== undefined) {
  query.since = since;
}

if (until !== undefined) {
  query.until = until;
}

if (Object.keys(attributeFilters).length > 0) {
  query.attributeFilters = attributeFilters;
}

if (q !== undefined) {
  query.messageQuery = q;
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
async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }

  const body = Buffer.concat(chunks).toString("utf-8");

  return JSON.parse(body);
}

export async function handlePostLogs(
  req: IncomingMessage,
  res: ServerResponse,
) {
  
  let body: unknown;

  try {
    body = await readBody(req);
  } catch (error) {
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
  res.writeHead(400, {
    "Content-Type": "application/json",
  });

  res.end(
    JSON.stringify({
      error: "since, until, and bucket are required",
    }),
  );

  return;
}

const since = new Date(sinceParam);
const until = new Date(untilParam);

if (
  Number.isNaN(since.getTime()) ||
  Number.isNaN(until.getTime())
) {
  res.writeHead(400, {
    "Content-Type": "application/json",
  });

  res.end(
    JSON.stringify({
      error: "invalid timestamp",
    }),
  );

  return;
}

if (until <= since) {
  res.writeHead(400, {
    "Content-Type": "application/json",
  });

  res.end(
    JSON.stringify({
      error: "until must be later than since",
    }),
  );

  return;
}

if (
  bucketParam !== "1m" &&
  bucketParam !== "5m" &&
  bucketParam !== "1h" &&
  bucketParam !== "1d"
) {
  res.writeHead(400, {
    "Content-Type": "application/json",
  });

  res.end(
    JSON.stringify({
      error: "invalid bucket",
    }),
  );

  return;
}

if (
  groupByParam !== null &&
  groupByParam !== "service" &&
  groupByParam !== "level"
) {
  res.writeHead(400, {
    "Content-Type": "application/json",
  });

  res.end(
    JSON.stringify({
      error: "invalid groupBy",
    }),
  );

  return;
}

const service = url.searchParams.get("service") ?? undefined;

const levelParam = url.searchParams.get("level");
let level: LogLevel | undefined;

if (levelParam !== null) {
  if (!LOG_LEVELS.includes(levelParam as LogLevel)) {
    res.writeHead(400, {
      "Content-Type": "application/json",
    });

    res.end(
      JSON.stringify({
        error: `invalid level: '${levelParam}'`,
      }),
    );

    return;
  }

  level = levelParam as LogLevel;
}

const q = url.searchParams.get("q") ?? undefined;

const attributeFilters: Record<string, string> = {};

for (const [key, value] of url.searchParams.entries()) {
  if (key.startsWith("attr.")) {
    const attributeName = key.slice(5);

    if (!attributeName) {
      res.writeHead(400, {
        "Content-Type": "application/json",
      });

      res.end(
        JSON.stringify({
          error: "attribute name cannot be empty",
        }),
      );

      return;
    }

    attributeFilters[attributeName] = value;
  }
}

    const result = await aggregateLogs({
  since,
  until,
  bucket: bucketParam as "1m" | "5m" | "1h" | "1d",
  ...(groupByParam === "service" || groupByParam === "level"
    ? { groupBy: groupByParam }
    : {}),
  ...(service !== undefined ? { service } : {}),
  ...(level !== undefined ? { level } : {}),
  ...(Object.keys(attributeFilters).length > 0
    ? { attributeFilters }
    : {}),
  ...(q !== undefined ? { messageQuery: q } : {}),
});

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