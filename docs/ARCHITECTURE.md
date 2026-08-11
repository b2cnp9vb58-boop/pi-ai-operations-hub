# Architecture

## One core, three authority levels

```text
Web console ────────┐
Telegram owner ─────┼── authenticated task API ── Control core ── Claude tool hook
WeChat read-only ───┘                                  │
                                                      SQLite audit store
```

The core is the only component that decides whether a message becomes a task. It stores task state before acknowledging a gateway, namespaces request identifiers by channel, and routes delivery only to the originating channel.

### Web and Telegram

Both are control channels. Telegram is designed to stay available when a reverse proxy, website, or desktop gateway fails. Its owner pairing accepts one private account only. A high-risk approval is bound to one owner, one task, and one canonical operation hash; it expires and cannot be reused.

### WeChat

WeChat is intentionally a read-only observer. Its gateway receives a separate client key and identity binding. The core permits it to poll only its own read-only result, and denies task submission, event inspection, cancellation, confirmation, and password routes. This separation remains in effect even if an AI prompt is malformed.

### Tool boundary

The Claude pre-tool hook sends every tool request to the core. Low-risk diagnostics can proceed. Unknown calls, destructive commands, credential paths, configuration changes, and multi-tool batches fail closed until a fresh high-risk approval is consumed.

### Data boundary

SQLite stores durable tasks, append-only events, pairing state, and conversation records. It must be outside the checkout with restricted filesystem permissions. Exports are sensitive operational records and must be treated as private data.
