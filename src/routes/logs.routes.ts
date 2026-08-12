import type { IncomingMessage, ServerResponse } from "node:http";
import { handleGetLogs } from "../handlers/logs.handler.js";

export async function handleLogsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
) {
  if (req.method === "GET" && req.url === "/logs") {
    await handleGetLogs(req, res);
    return true;
  }

  return false;
}