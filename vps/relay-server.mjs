import http from "node:http";

const PORT = Number(process.env.PORT || 8080);
const BIND = process.env.BIND || "0.0.0.0";
const FEISHU_VERIFICATION_TOKEN = String(process.env.FEISHU_VERIFICATION_TOKEN || "");
const WORKER_FEISHU_CALLBACK_URL = String(process.env.WORKER_FEISHU_CALLBACK_URL || "").trim();
const RELAY_TIMEOUT_MS = Number(process.env.RELAY_TIMEOUT_MS || 15000);

if (!WORKER_FEISHU_CALLBACK_URL) {
  console.error("Missing WORKER_FEISHU_CALLBACK_URL");
  process.exit(1);
}

function json(res, status, data) {
  const text = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text)
  });
  res.end(text);
}

function readRawBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("Body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function parseJsonSafe(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function validateToken(token) {
  if (!FEISHU_VERIFICATION_TOKEN) return true;
  return token === FEISHU_VERIFICATION_TOKEN;
}

async function relayToWorker(rawBody) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RELAY_TIMEOUT_MS);
  try {
    const res = await fetch(WORKER_FEISHU_CALLBACK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: rawBody,
      signal: ctrl.signal
    });
    const txt = await res.text().catch(() => "");
    if (!res.ok) {
      console.error("relay_failed_status", res.status, txt.slice(0, 300));
      return;
    }
    console.log("relay_ok_status", res.status, txt.slice(0, 300));
  } catch (err) {
    console.error("relay_failed_error", err?.message || err);
  } finally {
    clearTimeout(timer);
  }
}

const server = http.createServer(async (req, res) => {
  const method = req.method || "";
  const path = (req.url || "").split("?")[0];

  if (method === "GET" && path === "/api/health") {
    return json(res, 200, {
      ok: true,
      hasVerifyToken: Boolean(FEISHU_VERIFICATION_TOKEN),
      workerUrl: WORKER_FEISHU_CALLBACK_URL
    });
  }

  if (!(method === "POST" && path === "/api/feishu/callback")) {
    return json(res, 404, { error: "Not Found" });
  }

  let rawBody = "";
  try {
    rawBody = await readRawBody(req);
  } catch (err) {
    return json(res, 400, { error: err?.message || "Invalid body" });
  }

  const body = parseJsonSafe(rawBody);
  if (!body) return json(res, 400, { error: "Invalid JSON" });
  const eventType = String((body.header || {}).event_type || (body.event || {}).type || body.type || "");
  console.log("incoming_event", eventType || "unknown");

  if (body.type === "url_verification") {
    if (!validateToken(String(body.token || ""))) {
      return json(res, 403, { error: "Invalid verification token" });
    }
    return json(res, 200, { challenge: String(body.challenge || "") });
  }

  const token = String((body.header || {}).token || "");
  if (!validateToken(token)) {
    return json(res, 403, { error: "Invalid event token" });
  }

  json(res, 200, { code: 0, msg: "accepted" });
  void relayToWorker(rawBody);
});

server.listen(PORT, BIND, () => {
  console.log(`feishu-relay listening on ${BIND}:${PORT}`);
});
