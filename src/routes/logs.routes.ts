import type { IncomingMessage, ServerResponse } from "node:http";
import { handlePostLogs,handleGetLogs } from "../handlers/logs.handler.js";

export async function handleLogsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
) {
  if (req.method === "GET" && req.url === "/logs") {
    await handleGetLogs(req, res);
    return true;
  }

  if (req.method === "POST" && req.url === "/logs") {
    await handlePostLogs(req, res);
    return true;
  }

  return false;
}