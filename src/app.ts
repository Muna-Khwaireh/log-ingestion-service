import { createServer } from "node:http";
import { handleRoutes } from "./routes/index.js";

export function createApp() {
  return createServer(async (req, res) => {
    if (await handleRoutes(req, res)) {
      return;
    }

    res.writeHead(404, {
      "Content-Type": "text/plain",
    });

    res.end("Not Found");
  });
}