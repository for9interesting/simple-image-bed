# Simple Image Bed

A Simple image bed deployed to Github Pages, Cloudflare Workers and Feishu(optional).

## What's included

- Frontend：GitHub Pages
- Backend：Cloudflare Worker
- Storage：GitHub repo `image-storage` branch
- CI/CD：
  - `.github/workflows/deploy-pages.yml`
  - `.github/workflows/deploy-worker.yml`
- Addtional: Feishu Bot
> Feishu doesn't seem to support cloudflare workers as callback server due to network connection failure. Use a VPS in that case to relay your request.

## How to Upload

1. Login: OTP->frontend page
2. Upload your image (<5MB)
3. Image uploaded to github, relative URL presented & ready to copy.

Or via Feishu:
1. Send image to your feishu bot.
2. Bot replies with an "uploading" status card immediately.
3. The same card is updated to final status:
   - success: includes the uploaded image link
   - failure: includes a short error reason
4. Done.

## What's needed for deployment

1. GitHub account; A Github repo.
2. Cloudflare account.
3. (For feishu): A feishu developer account.

## How to Deploy Project

### Local Setup
Under repository folder:

```bash
git checkout --orphan image-storage
git commit --allow-empty -m "init image storage branch"
git push origin image-storage
git checkout main
```
`image-storage` branch is for images only.

### Generate TOTP secret & QR Code

```bash
python scripts/gen_totp.py --account "your-name" --issuer "ImageBed"
```

Find these under `build/`:
- `totp-secret.txt`
- `otpauth-url.txt`
- `totp-qrcode.png`
- `qrcode-url.txt`

Save what's in `build/totp-secret.txt` that will later be used as `TOTP_SECRET`.

### Create GitHub Fine-grained PAT

on Github:
1. `Settings` -> `Developer settings` -> `Personal access tokens` -> `Fine-grained tokens`
2. Click on `Generate new token`
3. `Repository access` -> Current repo
4. `Permissions` enabled:
   - `Contents: Read and write`
5. Generate & Copy token.

This token will later be used as `GH_PAT` **for backend**.

### Setup Cloudflare Worker

#### Worker Variables

in Worker settings:

`Vars`：
- `GH_USER`：GitHub user name
- `GH_REPO`：repo name（如 `image-bed`）
- `GH_BRANCH`：`image-storage`
- `ALLOWED_ORIGIN`：
  - Example：`https://<USER>.github.io`
  - Multi：`https://<USER>.github.io,https://your-domain.com`

`Secrets`：
- `GH_PAT`: Generated previously.
- `TOTP_SECRET`: Generated previously.
- `SESSION_SIGNING_KEY`：Set a random string here.

#### Worker address

Should look like:

```txt
https://image-bed-backend.xxx.workers.dev
```

### Setup GitHub repo Secrets / Variables

Repo：`Settings` -> `Secrets and variables`

`Actions Secrets`：
- `CF_API_TOKEN`：Cloudflare API Token
- `CF_ACCOUNT_ID`：Cloudflare Account ID

`Actions Variables`：
- `PUBLIC_API_BASE`：Worker address.


### Trigger deployment

#### Enable Pages

1. Enter GitHub repo `Settings` -> `Pages`
2. `Source` -> `GitHub Actions`

As of now, uploading images via webpage should be ready. Test it on `https://xxx.github.io/image-bed/`.

### Deploy it to feishu robot

1. Become a feishu developer;
2. Create an app here: https://open.feishu.cn/app
3. Enter your *worker address* as event & callback url.
4. In app scopes/capabilities, ensure the bot can both send messages and edit messages (required for status card updates).
#### Cloudflare worker URL is not available?
You need a VPS. Deploy what's under folder vps/ to your VPS to relay api calls:

```bash
scp vps/relay-server.mjs root@<VPS_IP>:/opt/image-bed/vps/
scp vps/relay.env.example root@<VPS_IP>:/opt/image-bed/vps/relay.env
scp vps/feishu-relay.service root@<VPS_IP>:/etc/systemd/system/feishu-relay.service
```
On your VPS:

```bash
systemctl daemon-reload
systemctl enable feishu-relay
systemctl restart feishu-relay
systemctl status feishu-relay --no-pager
```
