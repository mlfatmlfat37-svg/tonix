const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const USERS_FILE = path.join(__dirname, "users.json");

function loadUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
  } catch {
    return {};
  }
}

const PORT = Number(process.env.PORT) || 8080;
const GAME_PORT = 8765;
const ROOT = __dirname;

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".ico": "image/x-icon"
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);

  if (urlPath === "/health" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    });
    return res.end(JSON.stringify({ ok: true, service: "tonix-gateway", gamePort: GAME_PORT }));
  }

  const balanceMatch = urlPath.match(/^\/api\/wallet\/balance\/(\d+)$/);

  if (balanceMatch && req.method === "GET") {
    const telegramId = balanceMatch[1];
    const users = loadUsers();
    const user = users[telegramId];

    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    });

    if (!user) {
      return res.end(JSON.stringify({
        availableTON: 0,
        balanceTON: 0
      }));
    }

    return res.end(JSON.stringify({
      availableTON: Number(user.balance) || 0,
      balanceTON: Number(user.balance) || 0
    }));
  }

  // Proxy all application API calls to the Rocket backend.
  if (urlPath.startsWith("/api/")) {
    const options = {
      hostname: "127.0.0.1",
      port: GAME_PORT,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${GAME_PORT}` }
    };

    const proxy = http.request(options, upstreamRes => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    });

    proxy.on("error", err => {
      console.error("[API] proxy error:", err.message);
      if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Backend unavailable" }));
    });

    req.pipe(proxy);
    return;
  }

  if (urlPath === "/") urlPath = "/index.html";

  const filePath = path.join(ROOT, urlPath);

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA fallback: routes such as /developer, /statistics, /profile, etc.
      // should load the app instead of returning a 404.
      if (req.method === "GET" && !path.extname(urlPath)) {
        const indexFile = path.join(ROOT, "index.html");
        return fs.readFile(indexFile, (indexErr, indexData) => {
          if (indexErr) {
            res.writeHead(500);
            return res.end("Internal Server Error");
          }
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
          res.end(indexData);
        });
      }
      res.writeHead(404);
      return res.end("Not found");
    }

    res.writeHead(200, {
      "Content-Type": mime[path.extname(filePath).toLowerCase()] || "application/octet-stream"
    });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (!req.url.startsWith("/ws/ton-rocket")) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (client) => {
    wss.emit("connection", client, req);
    const upstream = new WebSocket(`ws://127.0.0.1:${GAME_PORT}/ws/ton-rocket`);
    upstream.on("open", () => {
      console.log("[WS] Upstream connected");
      client.on("message", msg => { if (upstream.readyState === WebSocket.OPEN) upstream.send(msg); });
      upstream.on("message", msg => { if (client.readyState === WebSocket.OPEN) client.send(msg); });
    });
    upstream.on("error", err => { console.error("[WS] Upstream error:", err.message); if (client.readyState === WebSocket.OPEN) client.close(); });
    client.on("error", err => console.error("[WS] Client error:", err.message));
    client.on("close", () => { if (upstream.readyState === WebSocket.OPEN) upstream.close(); });
    upstream.on("close", () => { if (client.readyState === WebSocket.OPEN) client.close(); });
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`XOX Gateway running at http://127.0.0.1:${PORT}`);
  console.log(`WebSocket proxy: /ws/ton-rocket -> localhost:${GAME_PORT}`);
});
