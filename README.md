# Yahoo Validated

Headless Yahoo / AOL address checker. Playwright workers open the official create-account page, paste the username, and report whether the ID is already taken.

| | |
| --- | --- |
| API | `http://SERVER_IP:6100/verify` |
| Dashboard | `http://SERVER_IP:6100/dashboard` |
| HTTP status | Always **200** — read JSON `fail` and `validate` |
| Dashboard login | Asked at the end of `setup.sh` (username + password + confirm) |

Full install notes: **[SETUP.md](SETUP.md)**

---

## Install

```bash
git clone https://github.com/smsohagbd/yahoo-validated.git
cd yahoo-validated
sudo bash setup.sh
```

The script installs Node, Chromium, systemd service `yahoo_validated`, opens port **6100**, detects the server public IP, and prints:

- Verify URL with the real IP (not `0.0.0.0`)
- Dashboard URL
- API token
- Dashboard username / password

Chrome blocks port `6000` (`ERR_UNSAFE_PORT`). This app uses **6100**.

Update later:

```bash
cd yahoo-validated
git pull origin main
sudo bash setup.sh
```

---

## API

```http
POST /verify
Authorization: Bearer YOUR_TOKEN
Content-Type: application/json

{ "email": "someone@yahoo.com" }
```

### Success — address exists

```json
{
  "ok": true,
  "fail": false,
  "validate": true,
  "error": null,
  "message": "Address already exists"
}
```

### Success — address available

```json
{
  "ok": true,
  "fail": false,
  "validate": false,
  "error": null,
  "message": "Address does not exist yet"
}
```

### Fail (still HTTP 200)

```json
{
  "ok": false,
  "fail": true,
  "validate": false,
  "error": "blocked",
  "message": "Yahoo/AOL blocked the check (captcha or bot detection)",
  "retryable": true
}
```

Caller logic:

```javascript
const data = await res.json(); // always HTTP 200

if (data.fail) {
  // data.error + data.message
  // retry if data.retryable
} else if (data.validate) {
  // already exists
} else {
  // not taken
}
```

`error` values: `unauthorized`, `rate_limited`, `invalid_email`, `unsupported_provider`, `invalid_username`, `blocked`, `timeout`, `queue_timeout`, `proxy_failed`, `check_failed`.

Default rate limit: **30 requests / minute / IP**.

---

## Dashboard

Open `http://SERVER_IP:6100/dashboard` after login.

- Live totals, workers, queue, logs
- Single and bulk address test (max 50)
- Create / revoke API tokens
- HTTP, SOCKS5, and rotating proxies

---

## Service

```bash
sudo systemctl status yahoo_validated
sudo journalctl -u yahoo_validated -f
```

Logs file: `/opt/yahoo_validated/logs/app.log`
