import type { IncomingMessage, ServerResponse } from "node:http";
import { ingestLogs, queryLogs } from "../services/logs.service.js";
import type { LogQuery } from "../logs/log.types.js";

export async function handleGetLogs(
  req: IncomingMessage,
  res: ServerResponse,
) {
  try {
    const url = new URL(req.url ?? "/logs", "http://localhost");

    const query: LogQuery = {
      service: url.searchParams.get("service") ?? undefined,
      level: url.searchParams.get("level") as LogQuery["level"] ?? undefined,
      limit: url.searchParams.has("limit")
        ? Number(url.searchParams.get("limit"))
        : undefined,
      offset: url.searchParams.has("offset")
        ? Number(url.searchParams.get("offset"))
        : undefined,
    };

    const logs = await queryLogs(query);

    res.writeHead(200, {
      "Content-Type": "application/json",
    });

    res.end(JSON.stringify(logs));
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
  try {
    const body = await readBody(req);

    if (!Array.isArray(body)) {
      res.writeHead(400, {
        "Content-Type": "application/json",
      });

      res.end(
        JSON.stringify({
          error: "request body must be an array",
        }),
      );

      return;
    }

    const result = await ingestLogs(body);

    res.writeHead(201, {
      "Content-Type": "application/json",
    });

    res.end(JSON.stringify(result));
  } catch (error) {
    console.error("Failed to ingest logs:", error);

    res.writeHead(400, {
      "Content-Type": "application/json",
    });

    res.end(
      JSON.stringify({
        error: "invalid JSON body",
      }),
    );
  }
}