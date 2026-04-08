const MAX_SIZE = 5 * 1024 * 1024;
const MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/bmp",
  "image/tiff",
  "image/x-icon",
  "image/vnd.microsoft.icon"
];
const FEISHU_API_BASE = "https://open.feishu.cn/open-apis";
let feishuTokenCache = { token: "", exp: 0 };

export default {
  async fetch(request, env, ctx) {
    const cors = buildCorsHeaders(request, env.ALLOWED_ORIGIN || "*");
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    try {
      const url = new URL(request.url);
      if (url.pathname === "/api/health" && request.method === "GET") {
        return json({
          ok: true,
          ghUser: env.GH_USER || "",
          ghRepo: env.GH_REPO || "",
          ghBranch: env.GH_BRANCH || "",
          hasGhPat: Boolean(env.GH_PAT),
          hasTotpSecret: Boolean(env.TOTP_SECRET),
          hasSessionKey: Boolean(env.SESSION_SIGNING_KEY),
          hasFeishuAppId: Boolean(env.FEISHU_APP_ID),
          hasFeishuAppSecret: Boolean(env.FEISHU_APP_SECRET),
          hasFeishuVerifyToken: Boolean(env.FEISHU_VERIFICATION_TOKEN)
        }, 200, cors);
      }
      if (url.pathname === "/api/login" && request.method === "POST") {
        return await handleLogin(request, env, cors);
      }
      if (url.pathname === "/api/feishu/callback" && request.method === "POST") {
        return await handleFeishuCallback(request, env, cors, ctx);
      }
      if (url.pathname === "/api/debug/github" && request.method === "GET") {
        return await handleDebugGithub(url, env, cors);
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
  if (type === "image/bmp") return "bmp";
  if (type === "image/tiff") return "tiff";
  if (type === "image/x-icon" || type === "image/vnd.microsoft.icon") return "ico";
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

  const uploaded = await uploadToGithub({ mimeType, contentBase64, env, requestId, cors });
  if (uploaded.error) return uploaded.error;
  const { rawUrl, path } = uploaded.data;
  return json({ rawUrl, markdown: `![](${rawUrl})`, path, requestId }, 200, cors);
}

async function uploadToGithub({ mimeType, contentBase64, env, requestId, cors }) {
  if (!env.GH_USER || !env.GH_REPO || !env.GH_BRANCH || !env.GH_PAT) {
    return { error: json({ error: "GitHub env is not configured", requestId }, 500, cors) };
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
        "User-Agent": "image-bed-worker/1.0",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        message: `upload image ${path}`,
        content: contentBase64,
        branch: env.GH_BRANCH
      })
    });
  } catch {
    return { error: json({ error: "Network error when calling GitHub API", requestId }, 502, cors) };
  }
  if (!ghRes.ok) {
    let detail = "";
    try {
      const bodyText = await ghRes.text();
      detail = bodyText.slice(0, 500);
    } catch {
      detail = "";
    }
    return { error: json({ error: `GitHub API failed: ${ghRes.status}`, detail, requestId }, 502, cors) };
  }

  const rawUrl = `https://raw.githubusercontent.com/${env.GH_USER}/${env.GH_REPO}/${env.GH_BRANCH}/${path}`;
  return { data: { rawUrl, path } };
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function detectMimeTypeByBytes(bytes) {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return "image/bmp";
  }
  if (
    bytes.length >= 4 &&
    ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) ||
      (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a))
  ) {
    return "image/tiff";
  }
  if (bytes.length >= 4 && bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0x00) {
    return "image/x-icon";
  }
  return "";
}

function normalizeMimeTypeFromFeishu(contentType, bytes) {
  const ct = String(contentType || "").split(";")[0].trim().toLowerCase();
  if (MIME_TYPES.includes(ct)) return ct;
  const guessed = detectMimeTypeByBytes(bytes);
  if (MIME_TYPES.includes(guessed)) return guessed;
  return "";
}

function parseJsonSafe(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function getFeishuTenantAccessToken(env) {
  const now = Date.now();
  if (feishuTokenCache.token && now < feishuTokenCache.exp - 30_000) {
    return feishuTokenCache.token;
  }
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) {
    throw new Error("Feishu env is not configured");
  }

  const res = await fetch(`${FEISHU_API_BASE}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      app_id: env.FEISHU_APP_ID,
      app_secret: env.FEISHU_APP_SECRET
    })
  });
  if (!res.ok) throw new Error(`Feishu token API failed: ${res.status}`);

  const data = await res.json();
  if (Number(data.code) !== 0 || !data.tenant_access_token) {
    throw new Error(`Feishu token API error: ${String(data.msg || data.message || data.code || "unknown")}`);
  }

  const expireSec = Number(data.expire || 7200);
  feishuTokenCache = {
    token: data.tenant_access_token,
    exp: now + Math.max(60, expireSec) * 1000
  };
  return feishuTokenCache.token;
}

async function readErrorText(resp) {
  try {
    return (await resp.text()).slice(0, 500);
  } catch {
    return "";
  }
}

async function downloadFeishuImageByMessageResource(messageId, imageKey, token) {
  const url = `${FEISHU_API_BASE}/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(imageKey)}?type=image`;
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) {
    const detail = await readErrorText(res);
    const logid = res.headers.get("x-tt-logid") || "";
    throw new Error(`Feishu message resource API failed: ${res.status}; logid=${logid}; detail=${detail}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

async function sendFeishuReplyText(messageId, text, token) {
  const url = `${FEISHU_API_BASE}/im/v1/messages/${encodeURIComponent(messageId)}/reply`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8"
    },
    body: JSON.stringify({
      msg_type: "text",
      content: JSON.stringify({ text })
    })
  });
  if (!res.ok) {
    const detail = await readErrorText(res);
    const logid = res.headers.get("x-tt-logid") || "";
    throw new Error(`Feishu reply API failed: ${res.status}; logid=${logid}; detail=${detail}`);
  }
  const data = await res.json().catch(() => ({}));
  if (Number(data.code || 0) !== 0) {
    throw new Error(`Feishu reply API error: ${String(data.msg || data.code || "unknown")}`);
  }
}

async function downloadFeishuImage(imageKey, messageId, token) {
  if (!messageId) throw new Error("Missing message_id for Feishu message resource API");
  const bytes = await downloadFeishuImageByMessageResource(messageId, imageKey, token);
  if (!bytes.length) throw new Error("Empty image data from Feishu");
  const mimeType = normalizeMimeTypeFromFeishu("", bytes);
  if (!mimeType) throw new Error("Unsupported image type from Feishu");
  return { bytes, mimeType };
}

async function handleFeishuCallback(request, env, cors, ctx) {
  const requestId = crypto.randomUUID();
  const raw = await request.text();
  const body = parseJsonSafe(raw);
  if (!body) return json({ error: "Invalid JSON", requestId }, 400, cors);

  if (body.type === "url_verification") {
    if (env.FEISHU_VERIFICATION_TOKEN && body.token !== env.FEISHU_VERIFICATION_TOKEN) {
      return json({ error: "Invalid verification token", requestId }, 403, cors);
    }
    return json({ challenge: String(body.challenge || "") }, 200, cors);
  }

  const header = body.header || {};
  const eventToken = String(header.token || body.token || "");
  if (env.FEISHU_VERIFICATION_TOKEN && eventToken !== env.FEISHU_VERIFICATION_TOKEN) {
    return json({ error: "Invalid event token", requestId }, 403, cors);
  }
  const eventType = String(header.event_type || (body.event || {}).type || "");
  if (eventType !== "im.message.receive_v1" && eventType !== "message") {
    return json({ code: 0, msg: "ignored", requestId }, 200, cors);
  }
  const senderType = String(((body.event || {}).sender || {}).sender_type || "");
  if (senderType === "app") {
    return json({ code: 0, msg: "ignored_self", requestId }, 200, cors);
  }

  const message = (body.event || {}).message || {};
  const messageId = String(message.message_id || "");
  if (!messageId) return json({ code: 0, msg: "missing_message_id", requestId }, 200, cors);
  const messageType = String(message.message_type || message.msg_type || "");
  if (messageType !== "image") {
    const task = processFeishuNonImageEvent({ messageId, env, requestId });
    if (ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(task);
    } else {
      void task;
    }
    return json({ code: 0, msg: "handled_non_image", requestId }, 200, cors);
  }

  const content = parseJsonSafe(String(message.content || ""));
  const imageKey = String((content || {}).image_key || message.image_key || "");
  if (!imageKey) return json({ code: 0, msg: "missing_image_key", requestId }, 200, cors);

  const task = processFeishuImageEvent({ imageKey, messageId, env, requestId });
  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(task);
  } else {
    void task;
  }
  return json({ code: 0, msg: "accepted", requestId }, 200, cors);
}

async function processFeishuNonImageEvent({ messageId, env, requestId }) {
  let feishuToken;
  try {
    feishuToken = await getFeishuTenantAccessToken(env);
  } catch (err) {
    console.error("feishu_get_token_failed_non_image", requestId, err?.message || err);
    return;
  }
  try {
    await sendFeishuReplyText(
      messageId,
      "Please send an image message. Supported types: png, jpg, jpeg, webp, gif, bmp, tiff, ico.",
      feishuToken
    );
  } catch (err) {
    console.error("feishu_reply_non_image_failed", requestId, err?.message || err);
  }
}

async function processFeishuImageEvent({ imageKey, messageId, env, requestId }) {
  let feishuToken;
  try {
    feishuToken = await getFeishuTenantAccessToken(env);
  } catch (err) {
    console.error("feishu_get_token_failed", requestId, err?.message || err);
    return;
  }

  let image;
  try {
    image = await downloadFeishuImage(imageKey, messageId, feishuToken);
  } catch (err) {
    console.error("feishu_download_image_failed", requestId, err?.message || err);
    try {
      await sendFeishuReplyText(messageId, "❌ Failed to upload image: unable to download the image from Feishu.", feishuToken);
    } catch (replyErr) {
      console.error("feishu_reply_download_failed", requestId, replyErr?.message || replyErr);
    }
    return;
  }
  if (image.bytes.length > MAX_SIZE) {
    console.error("feishu_image_too_large", requestId, image.bytes.length);
    try {
      await sendFeishuReplyText(messageId, "❌ Failed to upload image: file is larger than 5MB.", feishuToken);
    } catch (replyErr) {
      console.error("feishu_reply_too_large_failed", requestId, replyErr?.message || replyErr);
    }
    return;
  }

  const contentBase64 = bytesToBase64(image.bytes);
  const uploaded = await uploadToGithub({
    mimeType: image.mimeType,
    contentBase64,
    env,
    requestId,
    cors: { "Content-Type": "application/json; charset=utf-8" }
  });
  if (uploaded.error) {
    console.error("feishu_upload_github_failed", requestId);
    try {
      await sendFeishuReplyText(messageId, "❌ Failed to upload image to GitHub. Please try again later.", feishuToken);
    } catch (replyErr) {
      console.error("feishu_reply_upload_failed", requestId, replyErr?.message || replyErr);
    }
    return;
  }

  const { rawUrl, path } = uploaded.data;
  console.log("feishu_upload_ok", requestId, path, rawUrl);
  try {
    await sendFeishuReplyText(messageId, `✅ Successfully uploaded: ${rawUrl}`, feishuToken);
  } catch (replyErr) {
    console.error("feishu_reply_success_failed", requestId, replyErr?.message || replyErr);
  }
}

async function handleDebugGithub(url, env, cors) {
  const key = url.searchParams.get("key") || "";
  if (!env.DEBUG_KEY || key !== env.DEBUG_KEY) {
    return json({ error: "Forbidden" }, 403, cors);
  }
  if (!env.GH_PAT || !env.GH_USER || !env.GH_REPO) {
    return json({ error: "GitHub env is not configured" }, 500, cors);
  }

  const headers = {
    Authorization: `Bearer ${env.GH_PAT}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "image-bed-worker/1.0"
  };

  const out = {};

  const rateRes = await fetch("https://api.github.com/rate_limit", { headers });
  out.rateLimit = {
    status: rateRes.status,
    remaining: rateRes.headers.get("x-ratelimit-remaining"),
    reset: rateRes.headers.get("x-ratelimit-reset"),
    requestId: rateRes.headers.get("x-github-request-id")
  };
  try {
    const txt = await rateRes.text();
    out.rateLimit.body = txt.slice(0, 400);
  } catch {
    out.rateLimit.body = "";
  }

  const repoRes = await fetch(`https://api.github.com/repos/${env.GH_USER}/${env.GH_REPO}`, { headers });
  out.repo = {
    status: repoRes.status,
    remaining: repoRes.headers.get("x-ratelimit-remaining"),
    reset: repoRes.headers.get("x-ratelimit-reset"),
    requestId: repoRes.headers.get("x-github-request-id")
  };
  try {
    const txt = await repoRes.text();
    out.repo.body = txt.slice(0, 400);
  } catch {
    out.repo.body = "";
  }

  return json({ ok: true, timestamp: Date.now(), debug: out }, 200, cors);
}
