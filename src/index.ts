import { createServer } from "node:http";
import { handleRoutes } from "./routes/index.js";

const PORT = 8080;

const server = createServer(async (req, res) => {
  if (await handleRoutes(req, res)) {
    return;
  }

  res.writeHead(404, {
    "Content-Type": "text/plain",
  });

  res.end("Not Found");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server is running on port ${PORT}`);
});