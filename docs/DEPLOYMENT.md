# Deployment guide

## Prerequisites

- Raspberry Pi OS or Debian-based Linux host you administer.
- Node.js 24+ and Python 3.12+.
- A Claude-compatible local CLI/provider configured outside this repository.
- A Telegram bot created through BotFather. Configure private-chat use only.
- A WeChat provider account if you intend to use the read-only gateway.

## 1. Prepare the host

Clone this repository into a non-sensitive release directory such as `/opt/pi-ai-operations-hub/releases/<version>`. Create `pi-control`, `pi-telegram`, and `pi-weixin` service accounts. Create `/var/lib/pi-ai-operations-hub/{core,shared,telegram,weixin}` with least-privilege ownership.

## 2. Generate configuration locally

Copy the variable names from [`.env.example`](../.env.example), but create three root-owned files instead:

```text
/etc/pi-ai-operations-hub/core.env
/etc/pi-ai-operations-hub/telegram.env
/etc/pi-ai-operations-hub/weixin.env
```

Use `umask 077`; each file must be owned by root and mode `0600`. Generate five independent random client keys. Do not reuse provider keys as internal client keys.

## 3. Install the units

Review the three templates in `systemd/`, replace only documented placeholder paths if your layout differs, and copy them to `/etc/systemd/system/`. Keep the core bound only to `127.0.0.1`; do not expose its port through Nginx, Cloudflare Tunnel, or a firewall rule.

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now pi-control-core.service telegram-control.service weixin-control.service
```

## 4. Pair and verify

Pair exactly one Telegram account from a private `/start` flow. Set the high-risk password through a local non-echo TTY prompt. Verify all of the following before normal use:

- an unpaired Telegram account is rejected;
- the paired owner can run a read-only diagnostic;
- a destructive request requires a new confirmation;
- WeChat can return a status report;
- WeChat cannot create, cancel, approve, or mutate a task;
- restarting the core preserves state without revealing credentials.

## 5. Operate safely

Keep the web console behind its own authentication layer. Rotate a token or client key immediately when it may have been exposed. Test Telegram recovery before relying on it during a real website outage.
