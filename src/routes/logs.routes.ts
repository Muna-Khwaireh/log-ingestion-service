import type { IncomingMessage, ServerResponse } from "node:http";
import { handlePostLogs,handleGetLogs } from "../handlers/logs.handler.js";

export async function handleLogsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
) {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (req.method === "GET" && url.pathname === "/logs") {
    await handleGetLogs(req, res);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/logs") {
    await handlePostLogs(req, res);
    return true;
  }

  return false;
}