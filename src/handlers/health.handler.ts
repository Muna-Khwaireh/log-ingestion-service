import type { IncomingMessage, ServerResponse } from "node:http";
import { checkHealth } from "../services/health.service.js";

export async function handleHealth(
  _req: IncomingMessage,
  res: ServerResponse,
) {
  const result = await checkHealth();

  if (!result.healthy) {
    console.error("Health check failed:", result.error);

    res.writeHead(503, {
      "Content-Type": "text/plain",
      "Cache-Control": "no-store",
    });

    res.end("Service Unavailable");

    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/plain",
    "Cache-Control": "no-store",
  });

  res.end("OK");
}
