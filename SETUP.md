# Yahoo Validated — setup & how it works

This service checks whether a **Yahoo** or **AOL** address already exists by opening the official create-account page in a headless browser and reading the “Email not available” error.

Chrome blocks port `6000` (`ERR_UNSAFE_PORT`). The app listens on **6100**.

---

## Install (Linux)

```bash
git clone https://github.com/smsohagbd/yahoo-validated.git
cd yahoo-validated
sudo bash setup.sh
```

`setup.sh` does this, in order:

1. Installs Node.js 20 if needed, plus curl/openssl.
2. Creates system user `yahoo_validated`.
3. Copies the app to `/opt/yahoo_validated`.
4. Runs `npm install` and Playwright Chromium (headless).
5. Detects the **public server IP** (ipify / ifconfig.me, then local route).
6. Writes `/etc/yahoo_validated.env` — keeps an existing API token on re-run.
7. After the service is running, **asks for dashboard username, password, and confirm password** (required — this is the dashboard login).
8. Opens TCP **6100** on ufw / firewalld / iptables.
9. Enables systemd unit `yahoo_validated` and waits until `/health` answers.
10. Prints the real IP URLs, token, and dashboard login.

Re-run the same command after `git pull` to update. Token and dashboard login are kept.

Service commands:

```bash
sudo systemctl status yahoo_validated
sudo journalctl -u yahoo_validated -f
```

---

## URLs after install

Listen address stays `0.0.0.0:6100` so every interface can accept traffic. Printed URLs use the **detected IP**, not `0.0.0.0`.

| What | URL |
| --- | --- |
| Verify API | `http://SERVER_IP:6100/verify` |
| Dashboard | `http://SERVER_IP:6100/dashboard` |
| Health (no token) | `http://127.0.0.1:6100/health` |

If the dashboard opens on the server but not from your PC, open **6100/tcp** in the VPS/cloud security group as well.

---

## How a check works

1. Caller sends `POST /verify` with token + `{ "email": "user@yahoo.com" }`.
2. A warm Playwright worker (min 2, max 5) opens Yahoo or AOL create-account.
3. Only the username is pasted into **New Yahoo email**.
4. After ~1s, if **Email not available. Try entering a different one.** → `validate: true`.
5. If empty-space click + 2–3s shows no taken error → `validate: false`.
6. HTTP status is **always 200**. Read JSON `fail` and `validate`.

Supported domains include yahoo.com, ymail.com, rocketmail.com, aol.com, aim.com.

---

## API (Postman / your script)

`POST http://SERVER_IP:6100/verify`

Headers:

- `Authorization: Bearer TOKEN`
- `Content-Type: application/json`

Body:

```json
{ "email": "someone@yahoo.com" }
```

**Success — exists**

```json
{ "ok": true, "fail": false, "validate": true, "error": null, "message": "Address already exists" }
```

**Success — available**

```json
{ "ok": true, "fail": false, "validate": false, "error": null, "message": "Address does not exist yet" }
```

**Fail (still HTTP 200)**

```json
{ "ok": false, "fail": true, "validate": false, "error": "blocked", "message": "Yahoo/AOL blocked the check (captcha or bot detection)", "retryable": true }
```

Script logic:

```js
const data = await res.json();
if (data.fail) { /* see data.error + data.message; retry if data.retryable */ }
else if (data.validate) { /* already exists */ }
else { /* not taken */ }
```

`error` codes: `unauthorized`, `rate_limited`, `invalid_email`, `unsupported_provider`, `invalid_username`, `blocked`, `timeout`, `queue_timeout`, `proxy_failed`, `check_failed`.

Default rate limit: **30 requests / minute / client IP**.

---

## Dashboard

Login at `/dashboard`. From there you can:

- Watch totals, workers, queue, recent checks, and logs.
- **Test one** address or **bulk** (up to 50, one per line).
- **Create / revoke API tokens** (full token is shown only once).
- Add HTTP/HTTPS/SOCKS5 / rotational proxies.

The setup token in `/etc/yahoo_validated.env` stays valid and cannot be revoked from the UI. Extra tokens live in `/opt/yahoo_validated/data/tokens.json` (hashed).

Logs also go to `/opt/yahoo_validated/logs/app.log`.

---

## Proxies

Paste in the dashboard, one per line:

```
http://user:pass@host:port
socks5://user:pass@host:port
host:port:user:pass
rotate:http://user:pass@gate.provider.com:7777
```

`rotate:` (or the checkbox) opens a new browser context after each check so a rotating gateway can hand out a new IP.

---

## Files on the server

| Path | Role |
| --- | --- |
| `/opt/yahoo_validated` | App |
| `/etc/yahoo_validated.env` | Port, token, dashboard login, detected `SERVER_IP` |
| `/etc/systemd/system/yahoo_validated.service` | systemd unit |
| `/opt/yahoo_validated/data/` | proxies, tokens, metrics |
| `/opt/yahoo_validated/logs/app.log` | JSON logs |
