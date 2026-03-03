# 极简 GitHub 图床

本项目是一个可部署到 GitHub Pages 的图床页面，上传前需要 TOTP 验证。

## 1. 架构总览

- 前端：GitHub Pages（`index.html` + `app.ts` + `style.css`）
- 后端：Cloudflare Worker（`backend/worker.js`）
- 存储：GitHub 仓库 `image-storage` 分支
- CI/CD：
  - `.github/workflows/deploy-pages.yml`（部署前端）
  - `.github/workflows/deploy-worker.yml`（部署 Worker）

上传链路：
1. 用户在前端输入 OTP
2. 前端请求 Worker `/api/login`
3. Worker 校验 TOTP 成功后签发 1 小时会话 token
4. 前端上传图片到 Worker `/api/upload`
5. Worker 用 `GH_PAT` 上传到 `image-storage/YYYY/MM/DD/uuid.ext`
6. 前端展示 Raw URL 和 Markdown

## 2. 仓库结构

```txt
repo/
  index.html
  app.ts
  style.css
  config.example.ts
  scripts/gen_totp.py
  backend/worker.js
  backend/wrangler.toml
  .github/workflows/deploy-pages.yml
  .github/workflows/deploy-worker.yml
  README.md
```

## 3. 前置准备

你需要：
1. GitHub 账号和仓库（例如 `image-bed`）
2. Cloudflare 账号（用于 Worker）
3. Python 3（用于一键生成 TOTP secret + 二维码）

## 4. 创建存图分支

在仓库执行：

```bash
git checkout --orphan image-storage
git commit --allow-empty -m "init image storage branch"
git push origin image-storage
git checkout main
```

`image-storage` 分支只用于存图片。

## 5. 一键生成 TOTP Secret + 二维码

执行：

```bash
python scripts/gen_totp.py --account "your-name" --issuer "ImageBed"
```

会在 `build/` 生成（`build/` 已被 `.gitignore` 忽略）：
- `totp-secret.txt`
- `otpauth-url.txt`
- `totp-qrcode.png`
- `qrcode-url.txt`（二维码下载失败时兜底）

把 `build/totp-secret.txt` 的值保存好，后续作为 `TOTP_SECRET`。

## 6. 创建 GitHub Fine-grained PAT

GitHub 页面路径：
1. `Settings` -> `Developer settings` -> `Personal access tokens` -> `Fine-grained tokens`
2. 点击 `Generate new token`
3. `Repository access` 选当前仓库
4. `Permissions` 只给：
   - `Contents: Read and write`
5. 生成并复制 token

这个 token 仅用于后端变量 `GH_PAT`，不要放前端。

## 7. 配置 Cloudflare Worker

### 7.1 Worker 变量

在 Worker 设置中配置：

`Vars`（明文）：
- `GH_USER`：GitHub 用户名
- `GH_REPO`：仓库名（如 `image-bed`）
- `GH_BRANCH`：`image-storage`
- `ALLOWED_ORIGIN`：前端来源（建议精确到域名）
  - 示例：`https://<USER>.github.io`

`Secrets`（密文）：
- `GH_PAT`：第 6 步创建的 PAT
- `TOTP_SECRET`：第 5 步生成的 secret
- `SESSION_SIGNING_KEY`：随机长字符串（建议 32+ 字符）

### 7.2 Worker 地址

记下 Worker 域名，例如：

```txt
https://image-bed-api.xxx.workers.dev
```

## 8. 配置 GitHub 仓库 Secrets / Variables

仓库路径：`Settings` -> `Secrets and variables`

`Actions Secrets`：
- `CF_API_TOKEN`：Cloudflare API Token（允许部署 Worker）
- `CF_ACCOUNT_ID`：Cloudflare Account ID

`Actions Variables`：
- `PUBLIC_API_BASE`：Worker 地址（如上一步 URL）

说明：
- `PUBLIC_API_BASE` 是公开信息，可放变量
- `GH_PAT`、`TOTP_SECRET` 不会写入前端 Pages 产物

## 9. 启用并触发部署

### 9.1 启用 Pages

1. 进入 GitHub 仓库 `Settings` -> `Pages`
2. `Source` 选择 `GitHub Actions`

### 9.2 触发部署

推送 `main` 分支后：
- 前端自动跑 `deploy-pages.yml`
- 后端改动时自动跑 `deploy-worker.yml`

页面地址通常为：

```txt
https://<USER>.github.io/image-bed/
```

## 10. 首次验收清单（建议逐项验证）

1. 打开页面，输入 6 位 OTP 可成功登录
2. 上传 `png/jpg/jpeg/webp/gif` 成功
3. 上传超过 5MB 被拒绝
4. 上传非图片类型被拒绝
5. 成功后返回 Raw URL 与 Markdown，可复制
6. `image-storage` 分支中出现 `YYYY/MM/DD/uuid.ext`