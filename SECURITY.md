# Security Policy

## Supported use

This repository is designed for a host you own. It is not a hosted service and it must not be deployed with placeholder credentials or an internet-exposed core port.

## Required deployment rules

- Keep the core bound to `127.0.0.1`.
- Generate five independent 32+ character client keys: web, Telegram, admin, hook, and WeChat.
- Store secrets in root-owned `0600` files outside the checkout.
- Pair one Telegram owner in a private chat; disable group use in BotFather.
- Keep the WeChat gateway read-only at the core API boundary.
- Require a fresh confirmation for each high-risk operation.
- Review systemd permissions and supported tool paths before enabling any AI provider.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability or a leaked credential. Contact the maintainer privately with a minimal reproduction and redact all tokens, hostnames, personal data, and history exports.

If a credential is committed or sent to a third party, revoke and rotate it immediately; deleting a file or commit does not make the credential safe again.
