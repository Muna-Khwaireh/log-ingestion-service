import type { IncomingMessage, ServerResponse } from "node:http";
import { handleHealthRoutes } from "./health.routes.js";
import { handleLogsRoutes } from "./logs.routes.js";

export async function handleRoutes(
  req: IncomingMessage,
  res: ServerResponse,
) {
  if (await handleHealthRoutes(req, res)) {
    return true;
  }

  if (await handleLogsRoutes(req, res)) {
    return true;
  }

  return false;
}