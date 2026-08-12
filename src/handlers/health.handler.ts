import type { IncomingMessage, ServerResponse } from "node:http";

export function handleHealth(
  _req: IncomingMessage,
  res: ServerResponse,
) {
  res.writeHead(200, {
    "Content-Type": "text/plain",
  });

  res.end("OK");
}