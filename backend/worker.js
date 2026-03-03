const MAX_SIZE = 5 * 1024 * 1024;
const MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

export default {
  async fetch(request, env) {
    const cors = buildCorsHeaders(request, env.ALLOWED_ORIGIN || "*");
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    try {
      const url = new URL(request.url);
      if (url.pathname === "/api/health" && request.method === "GET") {
        return json({ ok: true }, 200, cors);
      }
      if (url.pathname === "/api/login" && request.method === "POST") {
        return await handleLogin(request, env, cors);
      }
      if (url.pathname === "/api/upload" && request.method === "POST") {
        return await handleUpload(request, env, cors);
      }
      return json({ error: "Not Found" }, 404, cors);
    } catch (err) {
      return json({ error: err.message || "Internal Error" }, 500, cors);
    }
  }
};

function buildCorsHeaders(request, allowListRaw) {
  const reqOrigin = normalizeOrigin(request.headers.get("Origin") || "");
  const allowed = String(allowListRaw || "*")
    .split(",")
    .map((v) => normalizeOrigin(v))
    .filter(Boolean);
  const allowAny = allowed.includes("*");
  const allowOrigin = allowAny
    ? "*"
    : (reqOrigin && allowed.includes(reqOrigin) ? reqOrigin : "");

  const headers = {
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
    "Content-Type": "application/json; charset=utf-8"
  };
  if (allowOrigin) headers["Access-Control-Allow-Origin"] = allowOrigin;

  return {
    ...headers
  };
}

function normalizeOrigin(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw === "*") return "*";
  let src = raw;
  if (!/^https?:\/\//i.test(src)) src = `https://${src}`;
  try {
    return new URL(src).origin;
  } catch {
    return "";
  }
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers });
}

async function parseJson(req) {
  try {
    return await req.json();
  } catch {
    throw new Error("Invalid JSON");
  }
}

function pickExt(type) {
  if (type === "image/png") return "png";
  if (type === "image/webp") return "webp";
  if (type === "image/gif") return "gif";
  return "jpg";
}

function buildPath(type) {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  return `${yyyy}/${mm}/${dd}/${crypto.randomUUID()}.${pickExt(type)}`;
}

function b64urlEncode(inputBytes) {
  const base64 = btoa(String.fromCharCode(...inputBytes));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function b64urlEncodeText(text) {
  return b64urlEncode(new TextEncoder().encode(text));
}

function b64urlDecodeToText(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (normalized.length % 4)) % 4;
  const b64 = normalized + "=".repeat(padLen);
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function hmacSha256(secret, msg) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return new Uint8Array(sig);
}

async function signSession(payload, signingKey) {
  const header = { alg: "HS256", typ: "JWT" };
  const head = b64urlEncodeText(JSON.stringify(header));
  const body = b64urlEncodeText(JSON.stringify(payload));
  const signed = `${head}.${body}`;
  const sig = b64urlEncode(await hmacSha256(signingKey, signed));
  return `${signed}.${sig}`;
}

async function verifySession(token, signingKey) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts;
  const signed = `${head}.${body}`;
  const expected = b64urlEncode(await hmacSha256(signingKey, signed));
  if (sig !== expected) return null;
  const payload = JSON.parse(b64urlDecodeToText(body));
  if (!payload.exp || Date.now() >= payload.exp) return null;
  return payload;
}

function base32ToBytes(base32) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = base32.toUpperCase().replace(/=+$/g, "").replace(/\s+/g, "");
  let bits = "";
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) throw new Error("Invalid base32 secret");
    bits += idx.toString(2).padStart(5, "0");
  }
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return new Uint8Array(out);
}

async function hmacSha1(keyBytes, msgBytes) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, msgBytes);
  return new Uint8Array(sig);
}

async function generateTotp(secret, offset = 0) {
  const key = base32ToBytes(secret);
  const counter = Math.floor(Date.now() / 1000 / 30) + offset;
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);
  const hmac = await hmacSha1(key, new Uint8Array(buf));
  const off = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[off] & 0x7f) << 24) | (hmac[off + 1] << 16) | (hmac[off + 2] << 8) | hmac[off + 3];
  return String(code % 1000000).padStart(6, "0");
}

async function verifyTotp(secret, otp) {
  for (const win of [-1, 0, 1]) {
    if ((await generateTotp(secret, win)) === otp) return true;
  }
  return false;
}

async function handleLogin(request, env, cors) {
  const body = await parseJson(request);
  const otp = String(body.otp || "").replace(/\D/g, "").slice(0, 6);
  if (otp.length !== 6) return json({ error: "OTP must be 6 digits" }, 400, cors);
  if (!env.TOTP_SECRET || !env.SESSION_SIGNING_KEY) return json({ error: "Server is not configured" }, 500, cors);
  const ok = await verifyTotp(env.TOTP_SECRET, otp);
  if (!ok) return json({ error: "Invalid OTP" }, 401, cors);
  const expiresAt = Date.now() + 60 * 60 * 1000;
  const sessionToken = await signSession({ exp: expiresAt, iat: Date.now() }, env.SESSION_SIGNING_KEY);
  return json({ sessionToken, expiresAt }, 200, cors);
}

async function handleUpload(request, env, cors) {
  const requestId = crypto.randomUUID();
  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) return json({ error: "Missing bearer token", requestId }, 401, cors);
  if (!env.SESSION_SIGNING_KEY) return json({ error: "Server is not configured", requestId }, 500, cors);
  const valid = await verifySession(token, env.SESSION_SIGNING_KEY);
  if (!valid) return json({ error: "Session expired or invalid", requestId }, 401, cors);

  const body = await parseJson(request);
  const mimeType = String(body.mimeType || "");
  const contentBase64 = String(body.contentBase64 || "");
  if (!MIME_TYPES.includes(mimeType)) return json({ error: "Unsupported image type", requestId }, 400, cors);
  if (!contentBase64) return json({ error: "Missing contentBase64", requestId }, 400, cors);

  let raw;
  try {
    raw = atob(contentBase64);
  } catch {
    return json({ error: "Invalid base64 content", requestId }, 400, cors);
  }
  if (raw.length > MAX_SIZE) return json({ error: "Image is larger than 5MB", requestId }, 400, cors);

  if (!env.GH_USER || !env.GH_REPO || !env.GH_BRANCH || !env.GH_PAT) {
    return json({ error: "GitHub env is not configured", requestId }, 500, cors);
  }

  const path = buildPath(mimeType);
  const apiPath = path.split("/").map(encodeURIComponent).join("/");
  const ghApi = `https://api.github.com/repos/${env.GH_USER}/${env.GH_REPO}/contents/${apiPath}`;
  let ghRes;
  try {
    ghRes = await fetch(ghApi, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${env.GH_PAT}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        message: `upload image ${path}`,
        content: contentBase64,
        branch: env.GH_BRANCH
      })
    });
  } catch {
    return json({ error: "Network error when calling GitHub API", requestId }, 502, cors);
  }
  if (!ghRes.ok) {
    let detail = "";
    try {
      const bodyText = await ghRes.text();
      detail = bodyText.slice(0, 500);
    } catch {
      detail = "";
    }
    return json({ error: `GitHub API failed: ${ghRes.status}`, detail, requestId }, 502, cors);
  }
  const rawUrl = `https://raw.githubusercontent.com/${env.GH_USER}/${env.GH_REPO}/${env.GH_BRANCH}/${path}`;
  return json({ rawUrl, markdown: `![](${rawUrl})`, path, requestId }, 200, cors);
}
