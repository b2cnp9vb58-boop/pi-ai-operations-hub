# Pi AI Operations Hub

[中文文档](README.zh-CN.md) · [Architecture](docs/ARCHITECTURE.md) · [Deployment](docs/DEPLOYMENT.md) · [Security](SECURITY.md)

A self-hosted AI operations reference for Raspberry Pi and Debian-based Linux hosts. One durable control core serves three deliberately different channels:

- **Web console** — authenticated administrator control.
- **Telegram** — single-owner emergency control with an explicit confirmation gate for high-risk operations.
- **WeChat** — a read-only monitoring secretary. It can report system knowledge but cannot submit, modify, cancel, or approve control tasks.

The important idea is not “three bots”; it is **one operational brain with server-enforced authority boundaries**. Channel policy lives in the core service, not only in an AI prompt.

## What this repository includes

- Node.js 24+ control core with durable SQLite task, event, conversation, and approval records.
- Telegram owner pairing, idempotent updates, result delivery, and password-confirmed high-risk grants.
- WeChat gateway with separate identity binding and a read-only write guard.
- Web integration client and Claude pre-tool hook for policy enforcement before tool execution.
- systemd templates, health monitoring, recovery helpers, and a substantial Node test suite.
- English and Chinese deployment and architecture documents.

## What it intentionally excludes

This public reference contains **no** production domain, IP address, user account, chat history, grade-system code, Cloudflare configuration, token, API key, cookie, SSH key, database, or environment file.

## Security model

1. The core binds only to `127.0.0.1`; gateways authenticate to it with distinct client keys.
2. Telegram and the web console can create tasks. WeChat cannot create control tasks and cannot reach mutation routes.
3. Unknown, destructive, credential-related, or configuration-changing tool calls fail closed and require a fresh, single-use high-risk approval.
4. Gateway services run under dedicated unprivileged accounts; only the local core has the narrow privileges it needs.
5. Credentials belong in root-owned files under `/etc/pi-ai-operations-hub/`, never in this repository.

## Quick start

This repository is a reference implementation, not a one-command installer. Read the deployment guide before exposing any interface.

```bash
git clone https://github.com/<your-account>/pi-ai-operations-hub.git
cd pi-ai-operations-hub
node --test --test-concurrency=1
python3 -m unittest discover -s tests/portal -v
```

Then follow [Deployment](docs/DEPLOYMENT.md) to create service accounts, generate separate keys, configure the provider, install the systemd units, pair exactly one Telegram owner, and test a read-only WeChat query before enabling any control feature.

## Project status

The repository is published as an engineering reference for self-hosted operations. Deploy it only on a host you own and understand; review every allow-list and every systemd capability before use.

## License

[MIT](LICENSE)
