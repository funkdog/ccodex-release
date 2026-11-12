// Isolated installer fixture: a previous bridge with one in-flight request.
// It binds only loopback and has no GitHub credentials or inference endpoint.
import http from "node:http";

let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  server.close(() => {
    // The IPC channel is otherwise enough to keep this fixture alive after
    // its listener has closed.
    if (process.connected) process.disconnect();
  });
  server.closeAllConnections();
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
      status: "ok",
      bridge: "codex-copilot",
      pid: process.pid,
      runtime: { sourceGeneration: "previous-isolated-generation" },
      activeRequests: 1,
    }));
    return;
  }
  if (req.method === "POST" && req.url === "/shutdown") {
    res.writeHead(200).end("fixture stopping");
    shutdown();
    return;
  }
  res.writeHead(404).end();
});
server.listen(0, "127.0.0.1", () => {
  process.stdout.write(`${server.address().port}\n`);
});
process.on("message", message => {
  if (message?.action === "shutdown") shutdown();
});
