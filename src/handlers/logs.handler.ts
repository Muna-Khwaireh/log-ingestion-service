import type { IncomingMessage, ServerResponse } from "node:http";
import { queryLogs } from "../services/logs.service.js";

export async function handleGetLogs(
  _req: IncomingMessage,
  res: ServerResponse,
) {
  try {
    const logs = await queryLogs();

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