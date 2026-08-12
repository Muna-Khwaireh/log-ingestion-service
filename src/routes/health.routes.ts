import type { IncomingMessage, ServerResponse } from "node:http";
import { handleHealth } from "../handlers/health.handler.js";

export function handleHealthRoutes(
  req: IncomingMessage,
  res: ServerResponse,
) {
  if (req.method === "GET" && req.url === "/health") {
    handleHealth(req, res);
    return true;
  }

  return false;
}