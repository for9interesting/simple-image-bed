const AUTH_TOKEN_KEY = "image_bed_auth_token";
const AUTH_EXPIRES_KEY = "image_bed_auth_expires";
const MAX_SIZE = 5 * 1024 * 1024;
const MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

const MSG = document.getElementById("msg");
const loginView = document.getElementById("loginView");
const uploadView = document.getElementById("uploadView");
const resultView = document.getElementById("resultView");
const otpInput = document.getElementById("otpInput");
const loginBtn = document.getElementById("loginBtn");
const fileInput = document.getElementById("fileInput");
const uploadBtn = document.getElementById("uploadBtn");
const logoutBtn = document.getElementById("logoutBtn");
const preview = document.getElementById("preview");
const rawUrlArea = document.getElementById("rawUrl");
const markdownArea = document.getElementById("markdown");
const copyRawBtn = document.getElementById("copyRawBtn");
const copyMdBtn = document.getElementById("copyMdBtn");

function setMsg(text, isError = false) {
  MSG.textContent = text;
  MSG.classList.toggle("error", isError);
}

function showLoggedIn(isLoggedIn) {
  loginView.classList.toggle("hidden", isLoggedIn);
  uploadView.classList.toggle("hidden", !isLoggedIn);
}

function sanitizeOtp(input) {
  return input.replace(/\D/g, "").slice(0, 6);
}

function getApiBase() {
  if (typeof CONFIG === "undefined" || !CONFIG.apiBase) {
    throw new Error("Missing CONFIG.apiBase, please check deployment config.");
  }
  let raw = String(CONFIG.apiBase).trim();
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("CONFIG.apiBase is invalid.");
  }
  if (!/^https?:$/i.test(parsed.protocol)) {
    throw new Error("CONFIG.apiBase must start with http:// or https://");
  }
  return parsed.origin;
}

function saveAuth(token, expiresAt) {
  localStorage.setItem(AUTH_TOKEN_KEY, token);
  localStorage.setItem(AUTH_EXPIRES_KEY, String(expiresAt));
}

function clearAuth() {
  localStorage.removeItem(AUTH_TOKEN_KEY);
  localStorage.removeItem(AUTH_EXPIRES_KEY);
}

function getAuthToken() {
  const token = localStorage.getItem(AUTH_TOKEN_KEY) || "";
  const expires = Number(localStorage.getItem(AUTH_EXPIRES_KEY) || "0");
  if (!token || !Number.isFinite(expires) || Date.now() >= expires) {
    clearAuth();
    return "";
  }
  return token;
}

function getExtByType(type) {
  if (type === "image/png") return "png";
  if (type === "image/webp") return "webp";
  if (type === "image/gif") return "gif";
  return "jpg";
}

function validateFile(file) {
  if (!file) return "请先选择图片";
  if (!MIME_TYPES.includes(file.type)) return "仅支持 png/jpg/jpeg/webp/gif";
  if (file.size > MAX_SIZE) return "文件超过 5MB";
  return null;
}

async function fileToBase64(file) {
  const buf = await file.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function apiPost(path, body, token = "") {
  const res = await fetch(`${getApiBase()}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });

  let data = {};
  try {
    data = await res.json();
  } catch {
    throw new Error(`接口异常（${res.status}）`);
  }
  if (!res.ok) {
    const reason = data.error || `请求失败（${res.status}）`;
    const detail = data.detail ? ` | detail: ${data.detail}` : "";
    const reqId = data.requestId ? ` | requestId: ${data.requestId}` : "";
    throw new Error(`${reason}${detail}${reqId}`);
  }
  return data;
}

async function loginWithOtp(otp) {
  const data = await apiPost("/api/login", { otp });
  saveAuth(data.sessionToken, data.expiresAt);
}

async function uploadImage(file, token) {
  const contentBase64 = await fileToBase64(file);
  return apiPost(
    "/api/upload",
    {
      fileName: file.name || `upload.${getExtByType(file.type)}`,
      mimeType: file.type,
      contentBase64
    },
    token
  );
}

async function copyText(text) {
  await navigator.clipboard.writeText(text);
}

loginBtn.addEventListener("click", async () => {
  try {
    const otp = sanitizeOtp(otpInput.value);
    if (otp.length !== 6) return setMsg("请输入 6 位 OTP", true);
    loginBtn.disabled = true;
    setMsg("验证中...");
    await loginWithOtp(otp);
    showLoggedIn(true);
    setMsg("验证成功，有效期 1 小时");
  } catch (e) {
    setMsg(e.message, true);
  } finally {
    loginBtn.disabled = false;
  }
});

logoutBtn.addEventListener("click", () => {
  clearAuth();
  resultView.classList.add("hidden");
  showLoggedIn(false);
  setMsg("已退出");
});

uploadBtn.addEventListener("click", async () => {
  try {
    const token = getAuthToken();
    if (!token) {
      showLoggedIn(false);
      return setMsg("登录状态已过期，请重新验证 OTP", true);
    }
    const file = fileInput.files && fileInput.files[0];
    const err = validateFile(file);
    if (err) return setMsg(err, true);
    uploadBtn.disabled = true;
    setMsg("上传中...");
    const result = await uploadImage(file, token);
    preview.src = result.rawUrl;
    rawUrlArea.value = result.rawUrl;
    markdownArea.value = result.markdown;
    resultView.classList.remove("hidden");
    setMsg("上传成功");
  } catch (e) {
    setMsg(e.message, true);
  } finally {
    uploadBtn.disabled = false;
  }
});

copyRawBtn.addEventListener("click", async () => {
  try {
    await copyText(rawUrlArea.value);
    setMsg("已复制 Raw URL");
  } catch {
    setMsg("复制失败，请手动复制", true);
  }
});

copyMdBtn.addEventListener("click", async () => {
  try {
    await copyText(markdownArea.value);
    setMsg("已复制 Markdown");
  } catch {
    setMsg("复制失败，请手动复制", true);
  }
});

otpInput.addEventListener("input", () => {
  otpInput.value = sanitizeOtp(otpInput.value);
});

try {
  getApiBase();
  showLoggedIn(Boolean(getAuthToken()));
  if (getAuthToken()) setMsg("已登录，可直接上传");
} catch (e) {
  showLoggedIn(false);
  setMsg(e.message, true);
}
